import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as publicWriterSurface from '../index.js'
import type { WriterLeaseAuthority as PublicWriterLeaseAuthority } from '../index.js'
import {
  acquireWriterLease,
  assertEpochCurrent,
  CorruptEpochStateError,
  deriveWriterLeaseFreshness,
  EPOCH_FILE,
  heartbeatLease,
  incarnationFormat,
  isLeaseStale,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
  MUTATION_LOCK_BUSY_TIMEOUT_MS,
  MUTATION_LOCK_TAKEOVER_MS,
  readCurrentEpoch,
  readWriterLease,
  refreshWriterLeaseAuthority,
  releaseLease,
  resolveProcessIncarnation,
  withCurrentWriterAuthority,
  WRITER_AUTHORITY_DB_FILE,
  WriterAuthorityLostError,
  type WriterAuthorityLostReason,
  type WriterLease,
} from '../lease/writer-lease.js'
import { RESOLVE_TS_SOURCE_HOOK } from '../lease/__tests__/source-import-hook.js'

const WRITER_LEASE_MODULE_URL = new URL('../lease/writer-lease.ts', import.meta.url).href
/**
 * 2026-10-03 (quick 261003-mqc): `writer-lease.ts` now imports the shared knowledge-root
 * containment check, so a child loading it from source resolves its `.js` specifiers to `.ts`.
 */
const LEASE_SOURCE_CHILD_ARGV = [
  '--experimental-strip-types', '--input-type=module',
  '--import', `data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCE_HOOK)}`,
]

/** WR-04 crash seam: the acquired path publishes the epoch before it publishes the lease. */
type AcquireWithEpochSeam = (
  knowledgeRoot: string,
  hooks: {
    afterEpochRewrite?: () => void
    mutationLockTakeoverMs?: number
  },
) => ReturnType<typeof acquireWriterLease>

const acquireWithEpochSeam = acquireWriterLease as AcquireWithEpochSeam

/**
 * W-05 observation seam: report every process-incarnation resolution the escalation path performs.
 *
 * Mirrors the `mutationLockTakeoverMs` / `acquireDeadlineMs` idiom — a test-only observer that
 * never replaces the production resolver, so the count being asserted is the count production pays.
 */
type AcquireWithIncarnationObserver = (
  knowledgeRoot: string,
  hooks: {
    acquireDeadlineMs?: number
    mutationLockTakeoverMs?: number
    onProcessIncarnationResolved?: (pid: number) => void
  },
) => ReturnType<typeof acquireWriterLease>

const acquireWithIncarnationObserver = acquireWriterLease as AcquireWithIncarnationObserver

function elapsedMs(startedAtNs: bigint): number {
  return Number(process.hrtime.bigint() - startedAtNs) / 1e6
}

/** The kernel's own view of a pid's state, read without going through the module under test. */
function processState(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'state='], {
      encoding: 'utf8',
    }).trim().charAt(0)
  } catch {
    return ''
  }
}

async function waitForConditionInTest(
  predicate: () => boolean,
  timeoutMs: number,
  describeWhat = 'condition',
): Promise<void> {
  const startedAtNs = process.hrtime.bigint()
  while (!predicate()) {
    if (elapsedMs(startedAtNs) >= timeoutMs) {
      throw new Error(`${describeWhat} not reached within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function waitForFileInTest(file: string, timeoutMs: number): Promise<void> {
  return waitForConditionInTest(() => existsSync(file), timeoutMs, `file ${file}`)
}

/**
 * Wait for a subprocess-written pid file to hold a COMPLETE value, then answer it (395-17).
 *
 * 395-15's discipline applied to the read site it did not reach: a marker another process writes
 * is ready when its CONTENT parses, never when its inode appears. `writeFileSync` in the child is
 * create-then-write at the syscall level, so a reader that waits on `existsSync` can and does
 * observe zero bytes — and `Number(''.trim())` is `0`, which is why the failure spelled itself
 * `bad orphan pid: 0`. That value is unreachable from any COMPLETED write: the child writes
 * `String(child.pid)`, which is either a positive integer or the string `undefined`. Measured on
 * the same writer schedule under contention: the inode shape faulted 3000/3000, this one 0/3000.
 *
 * The deadline names the path AND the last thing the file held, so a genuine red — a child that
 * really never wrote — reads as itself rather than as a bare timeout.
 */
async function waitForPidFileInTest(file: string, timeoutMs: number): Promise<number> {
  let lastSeen = '<file absent>'
  let pid = 0
  try {
    await waitForConditionInTest(
      () => {
        if (!existsSync(file)) return false
        lastSeen = readFileSync(file, 'utf8').trim()
        if (lastSeen === '') return false
        const candidate = Number(lastSeen)
        if (!Number.isSafeInteger(candidate) || candidate <= 0) return false
        pid = candidate
        return true
      },
      timeoutMs,
      `a complete pid in ${file}`,
    )
  } catch (error) {
    // RETHROWN RATHER THAN INTERPOLATED EARLY: the last read is only known once the loop has run,
    // so the message is composed here instead of in the argument, where it would always say
    // `<file absent>`.
    throw new Error(`${(error as Error).message} — last read: ${JSON.stringify(lastSeen)}`)
  }
  return pid
}

function spawnLeaseAcquirer(
  knowledgeRoot: string,
  stallInsideLockMs: number,
  mutationLockTakeoverMs = MUTATION_LOCK_TAKEOVER_MS,
): ChildProcessWithoutNullStreams {
  const source = `
    const { acquireWriterLease } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const outcome = acquireWriterLease(process.env.AGENT_QA_LEASE_TEST_ROOT, {
      afterMutationLockAcquired: () => {
        process.stdout.write('locked\\n');
        Atomics.wait(wait, 0, 0, Number(process.env.AGENT_QA_LEASE_TEST_STALL_MS));
      },
      mutationLockTakeoverMs: Number(process.env.AGENT_QA_LEASE_TEST_TAKEOVER_MS),
    });
    process.stdout.write(JSON.stringify(outcome) + '\\n');
  `
  return spawn(
    process.execPath,
    [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
    {
      env: {
        ...process.env,
        AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
        AGENT_QA_LEASE_TEST_STALL_MS: String(stallInsideLockMs),
        AGENT_QA_LEASE_TEST_TAKEOVER_MS: String(mutationLockTakeoverMs),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

function spawnAuthorityHolder(
  knowledgeRoot: string,
  permitFile: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const source = `
    const { existsSync } = await import('node:fs');
    const {
      acquireWriterLease,
      releaseLease,
      withCurrentWriterAuthority,
    } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const acquired = acquireWriterLease(process.env.AGENT_QA_LEASE_TEST_ROOT);
    if (acquired.kind !== 'acquired') throw new Error('holder did not acquire');
    withCurrentWriterAuthority(
      process.env.AGENT_QA_LEASE_TEST_ROOT,
      { leaseId: acquired.leaseId, epoch: acquired.epoch },
      () => process.stdout.write('mutated\\n'),
      {
        afterFinalAuthorityCompare: () => {
          process.stdout.write('inside\\n');
          while (!existsSync(process.env.AGENT_QA_LEASE_TEST_PERMIT)) {
            Atomics.wait(wait, 0, 0, 10);
          }
        },
      },
    );
    releaseLease({
      knowledgeRoot: process.env.AGENT_QA_LEASE_TEST_ROOT,
      leaseId: acquired.leaseId,
    });
    process.stdout.write('done\\n');
  `
  return spawn(
    process.execPath,
    [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
    {
      env: {
        ...process.env,
        AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
        AGENT_QA_LEASE_TEST_PERMIT: permitFile,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

function spawnClaimedLeaseAcquirer(
  knowledgeRoot: string,
  permitFile: string,
): ChildProcessWithoutNullStreams {
  const source = `
    const { existsSync } = await import('node:fs');
    const { acquireWriterLease } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const outcome = acquireWriterLease(process.env.AGENT_QA_LEASE_TEST_ROOT, {
      afterMutationLockClaimed: () => {
        process.stdout.write('claimed\\n');
        while (!existsSync(process.env.AGENT_QA_LEASE_TEST_PERMIT)) {
          Atomics.wait(wait, 0, 0, 10);
        }
      },
    });
    process.stdout.write(JSON.stringify(outcome) + '\\n');
  `
  return spawn(
    process.execPath,
    [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
    {
      env: {
        ...process.env,
        AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
        AGENT_QA_LEASE_TEST_PERMIT: permitFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

/**
 * An unrelated process that merely occupies a pid.
 *
 * CR-04's threat is a crashed owner whose pid is later handed to a stranger. This child never
 * touches the authority store, so anything that reaches it arrived purely because a durable row
 * still names its pid.
 */
function spawnIdleSurrogate(exitPermitFile: string): ChildProcessWithoutNullStreams {
  const source = `
    const { existsSync } = await import('node:fs');
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    process.stdout.write('surrogate-alive\\n');
    while (!existsSync(process.env.AGENT_QA_LEASE_TEST_EXIT_PERMIT)) {
      Atomics.wait(wait, 0, 0, 10);
    }
  `
  return spawn(
    process.execPath,
    [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
    {
      env: { ...process.env, AGENT_QA_LEASE_TEST_EXIT_PERMIT: exitPermitFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

/**
 * Occupy the authority store's write transaction without claiming the lock through the module.
 *
 * The start permit exists so the test can seed a row naming THIS child's pid before the child
 * takes the write lock; the release permit ends the transaction and the child then exits.
 */
function spawnAuthorityDbBlocker(
  dbPath: string,
  startPermitFile: string,
  releasePermitFile: string,
): ChildProcessWithoutNullStreams {
  const source = `
    const { existsSync } = await import('node:fs');
    const { DatabaseSync } = await import('node:sqlite');
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    while (!existsSync(process.env.AGENT_QA_LEASE_TEST_START_PERMIT)) {
      Atomics.wait(wait, 0, 0, 10);
    }
    const db = new DatabaseSync(process.env.AGENT_QA_LEASE_TEST_DB);
    db.exec('PRAGMA busy_timeout = 250');
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('blocking\\n');
    while (!existsSync(process.env.AGENT_QA_LEASE_TEST_RELEASE_PERMIT)) {
      Atomics.wait(wait, 0, 0, 10);
    }
    db.exec('ROLLBACK');
    db.close();
  `
  return spawn(
    process.execPath,
    [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
    {
      env: {
        ...process.env,
        AGENT_QA_LEASE_TEST_DB: dbPath,
        AGENT_QA_LEASE_TEST_START_PERMIT: startPermitFile,
        AGENT_QA_LEASE_TEST_RELEASE_PERMIT: releasePermitFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

function collectStdout(child: ChildProcessWithoutNullStreams): () => string {
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  return () => output
}

function lastJsonLine(text: string): unknown {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return JSON.parse(lines[lines.length - 1] ?? '')
}

function processIsAliveInTest(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Read the OS-reported start time of a pid WITHOUT going through the module under test.
 *
 * The incarnation guard must be anchored outside the lock module's own vocabulary, so these cases
 * compare the recorded token against an independently observed kernel fact rather than against the
 * module's own helper.
 */
function observedProcessStartToken(pid: number): string {
  if (process.platform === 'linux') {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)
    const starttime = fields[19]
    if (starttime === undefined) throw new Error(`no starttime field for pid ${pid}`)
    return starttime
  }
  const observed = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
  }).trim()
  if (observed === '') throw new Error(`no start time reported for pid ${pid}`)
  return observed
}

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (!output.includes(expected)) return
      child.stdout.off('data', onData)
      resolve()
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (!output.includes(expected)) reject(new Error(`lease child exited ${code}: ${output}`))
    })
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`lease child exited ${code}: ${stderr}`))
    })
  })
}

function observeExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
}

describe('writer lease acquire, heartbeat, release, and stale self-heal (CUR-03/CUR-04)', () => {
  let root: string
  let knowledgeRoot: string
  let now: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-lease-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  })

  afterEach(() => {
    now.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function leaseOnDisk(): WriterLease {
    return JSON.parse(readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8')) as WriterLease
  }

  it('acquires a clean root at epoch one and returns the fresh holder on a second acquire', () => {
    const acquired = acquireWriterLease(knowledgeRoot)

    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') throw new Error('expected acquired writer lease')
    expect(acquired.epoch).toBe(1)
    expect(acquired.leaseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8').trim()).toBe('1')
    expect(leaseOnDisk()).toEqual({
      leaseId: acquired.leaseId,
      pid: process.pid,
      epoch: 1,
      heartbeatAtMs: 1_000_000,
    })

    const held = acquireWriterLease(knowledgeRoot)

    expect(held).toEqual({ kind: 'held', holder: leaseOnDisk() })
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8').trim()).toBe('1')
  })

  it('reclaims a fresh-looking holder whose recorded epoch no longer matches disk (WR-04)', () => {
    const first = acquireWriterLease(knowledgeRoot)
    expect(first.kind).toBe('acquired')
    if (first.kind !== 'acquired') throw new Error('expected first acquired writer lease')
    const phantom = leaseOnDisk()
    writeFileSync(join(knowledgeRoot, EPOCH_FILE), '2\n', 'utf8')

    const outcome = acquireWriterLease(knowledgeRoot)

    expect(outcome.kind).toBe('acquired')
    if (outcome.kind !== 'acquired') throw new Error('expected epoch-invalid holder reclaim')
    expect(outcome.epoch).toBe(3)
    expect(outcome.reclaimed).toEqual(phantom)
    expect(leaseOnDisk()).toMatchObject({ leaseId: outcome.leaseId, epoch: 3 })
  })

  it('recovers promptly from a crash between the epoch rewrite and the lease publication', () => {
    const first = acquireWriterLease(knowledgeRoot)
    expect(first.kind).toBe('acquired')
    if (first.kind !== 'acquired') throw new Error('expected first acquired writer lease')
    const outgoing = leaseOnDisk()
    now.mockReturnValue(1_000_000 + LEASE_HEARTBEAT_TTL_MS)

    expect(() => acquireWithEpochSeam(knowledgeRoot, {
      afterEpochRewrite: () => {
        /**
         * The epoch is already durable at 2 while the lease still names epoch 1. The outgoing
         * holder's bytes are re-stamped fresh to model the worst reachable torn state: a
         * phantom holder that no TTL sweep will ever classify as stale.
         */
        writeFileSync(
          join(knowledgeRoot, LEASE_FILE),
          `${JSON.stringify({ ...outgoing, heartbeatAtMs: Date.now() })}\n`,
          'utf8',
        )
        throw new Error('crash between epoch and lease publication')
      },
    })).toThrow(/crash between epoch and lease publication/)

    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8').trim()).toBe('2')
    expect(leaseOnDisk()).toMatchObject({ leaseId: first.leaseId, epoch: 1 })
    // Prompt by construction: the recovery never sleeps and never resolves a holder's process.
    const resolved: number[] = []
    const waits = vi.spyOn(Atomics, 'wait')
    let waitCalls: number
    let contender: ReturnType<typeof acquireWriterLease>
    try {
      contender = acquireWriterLease(knowledgeRoot, {
        mutationLockTakeoverMs: 0,
        onProcessIncarnationResolved: (pid) => { resolved.push(pid) },
      })
    } finally {
      waitCalls = waits.mock.calls.length
      waits.mockRestore()
    }

    expect(contender).toMatchObject({ kind: 'acquired', epoch: 3 })
    expect(waitCalls, 'Atomics.wait calls during the contender acquire').toBe(0)
    expect(resolved, 'process incarnations resolved during the contender acquire').toEqual([])
  })

  it('still returns a fresh epoch-matching holder immediately under a zero takeover bound', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') throw new Error('expected acquired writer lease')
    const startedAtNs = process.hrtime.bigint()

    const held = acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: 0 })

    expect(held).toEqual({ kind: 'held', holder: leaseOnDisk() })
    expect(elapsedMs(startedAtNs)).toBeLessThan(250)
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8').trim()).toBe('1')
  })

  it('reclaims a stale holder with a new lease id and a bumped epoch', () => {
    const first = acquireWriterLease(knowledgeRoot)
    expect(first.kind).toBe('acquired')
    if (first.kind !== 'acquired') throw new Error('expected first acquired writer lease')
    const staleLease = {
      ...leaseOnDisk(),
      heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
    }
    writeFileSync(join(knowledgeRoot, LEASE_FILE), `${JSON.stringify(staleLease)}\n`, 'utf8')

    const reclaimed = acquireWriterLease(knowledgeRoot)

    expect(reclaimed.kind).toBe('acquired')
    if (reclaimed.kind !== 'acquired') throw new Error('expected reclaimed writer lease')
    expect(reclaimed.epoch).toBe(2)
    expect(reclaimed.leaseId).not.toBe(first.leaseId)
    expect(reclaimed.reclaimed).toEqual(staleLease)
    expect(leaseOnDisk()).toMatchObject({
      leaseId: reclaimed.leaseId,
      pid: process.pid,
      epoch: 2,
      heartbeatAtMs: 1_000_000,
    })
  })

  it('refreshes only the matching holder and releases only its lease file', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') throw new Error('expected acquired writer lease')

    expect(
      heartbeatLease({ knowledgeRoot, leaseId: '00000000-0000-4000-8000-000000000000' }),
    ).toEqual({ kind: 'refused', reason: 'lease-id-mismatch', holder: leaseOnDisk() })

    now.mockReturnValue(1_005_000)
    const heartbeat = heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })

    expect(heartbeat).toEqual({ kind: 'heartbeated', holder: leaseOnDisk() })
    expect(leaseOnDisk()).toEqual({
      leaseId: acquired.leaseId,
      pid: process.pid,
      epoch: acquired.epoch,
      heartbeatAtMs: 1_005_000,
    })
    expect(
      releaseLease({
        knowledgeRoot,
        leaseId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual({ kind: 'refused', reason: 'lease-id-mismatch', holder: leaseOnDisk() })
    expect(releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })).toEqual({
      kind: 'released',
    })
    expect(existsSync(join(knowledgeRoot, LEASE_FILE))).toBe(false)
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8').trim()).toBe('1')
  })

  it('classifies malformed lease bytes as stale and self-heals over them', () => {
    mkdirSync(knowledgeRoot, { recursive: true })
    writeFileSync(join(knowledgeRoot, EPOCH_FILE), '7\n', 'utf8')
    writeFileSync(join(knowledgeRoot, LEASE_FILE), 'not-json\n', 'utf8')

    expect(isLeaseStale(undefined, Date.now())).toBe(true)
    expect(isLeaseStale({ heartbeatAtMs: 'not-a-number' }, Date.now())).toBe(true)

    const acquired = acquireWriterLease(knowledgeRoot)

    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') throw new Error('expected self-healed writer lease')
    expect(acquired.epoch).toBe(8)
    expect(leaseOnDisk()).toMatchObject({ leaseId: acquired.leaseId, epoch: 8 })
  })

  it('treats the heartbeat TTL boundary as stale and rejects relative roots', () => {
    const lease: WriterLease = {
      leaseId: '00000000-0000-4000-8000-000000000000',
      pid: 1,
      epoch: 1,
      heartbeatAtMs: 10_000,
    }

    expect(isLeaseStale(lease, 10_000 + LEASE_HEARTBEAT_TTL_MS - 1)).toBe(false)
    expect(isLeaseStale(lease, 10_000 + LEASE_HEARTBEAT_TTL_MS)).toBe(true)
    expect(() => acquireWriterLease('relative/agent-qa-knowledge')).toThrow(
      /knowledgeRoot must be absolute/,
    )
  })

  it('reads only missing epoch state as zero and fails closed on malformed bytes', () => {
    expect(readCurrentEpoch(knowledgeRoot)).toBe(0)

    mkdirSync(knowledgeRoot, { recursive: true })
    writeFileSync(join(knowledgeRoot, EPOCH_FILE), 'not-an-integer\n', 'utf8')

    expect(() => readCurrentEpoch(knowledgeRoot)).toThrow(CorruptEpochStateError)
  })

  it('accepts the current holder epoch at the mutation boundary', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') throw new Error('expected acquired writer lease')

    expect(assertEpochCurrent({ knowledgeRoot, epoch: acquired.epoch })).toEqual({
      current: true,
    })
  })

  it('fresh-reads a competing reclaim and refuses the original holder without throwing', () => {
    const original = acquireWriterLease(knowledgeRoot)
    expect(original.kind).toBe('acquired')
    if (original.kind !== 'acquired') throw new Error('expected original writer lease')
    writeFileSync(
      join(knowledgeRoot, LEASE_FILE),
      `${JSON.stringify({
        ...leaseOnDisk(),
        heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
      })}\n`,
      'utf8',
    )

    const competitor = acquireWriterLease(knowledgeRoot)

    expect(competitor.kind).toBe('acquired')
    if (competitor.kind !== 'acquired') throw new Error('expected competing writer lease')
    expect(competitor.epoch).toBe(2)
    expect(assertEpochCurrent({ knowledgeRoot, epoch: original.epoch })).toEqual({
      current: false,
      observedEpoch: 2,
    })
    expect(assertEpochCurrent({ knowledgeRoot, epoch: competitor.epoch })).toEqual({
      current: true,
    })
  })
})

describe('fresh writer authority heartbeat and epoch fencing', () => {
  let root: string
  let knowledgeRoot: string
  let now: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-authority-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
  })

  afterEach(() => {
    now.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function acquireAuthority(): PublicWriterLeaseAuthority {
    const acquired = acquireWriterLease(knowledgeRoot)
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') throw new Error('expected acquired writer lease')
    return { knowledgeRoot, leaseId: acquired.leaseId, epoch: acquired.epoch }
  }

  function expectAuthorityLoss(
    invoke: () => unknown,
    reason: WriterAuthorityLostReason,
    observedEpoch: number,
  ): void {
    try {
      invoke()
      throw new Error('expected writer authority loss')
    } catch (error) {
      expect(error).toBeInstanceOf(WriterAuthorityLostError)
      expect(error).toMatchObject({
        name: 'WriterAuthorityLostError',
        reason,
        observedEpoch,
      })
    }
  }

  it('exports the authority guard only from the main writer surface', () => {
    expect(refreshWriterLeaseAuthority).toBeTypeOf('function')
    expect(WriterAuthorityLostError).toBeTypeOf('function')
    expect(publicWriterSurface).toHaveProperty('refreshWriterLeaseAuthority')
    expect(publicWriterSurface).toHaveProperty('WriterAuthorityLostError')
  })

  it('heartbeats the exact current holder and returns the same authority', () => {
    const authority = acquireAuthority()
    now.mockReturnValue(2_005_000)

    expect(refreshWriterLeaseAuthority(authority)).toEqual(authority)
    expect(
      JSON.parse(readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8')),
    ).toMatchObject({
      leaseId: authority.leaseId,
      epoch: authority.epoch,
      heartbeatAtMs: 2_005_000,
    })
  })

  it('rejects a reclaimed epoch before heartbeat', () => {
    const authority = acquireAuthority()
    const staleLease = {
      ...JSON.parse(readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8')),
      heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
    }
    writeFileSync(join(knowledgeRoot, LEASE_FILE), `${JSON.stringify(staleLease)}\n`, 'utf8')
    const competitor = acquireWriterLease(knowledgeRoot)
    expect(competitor.kind).toBe('acquired')

    expectAuthorityLoss(
      () => refreshWriterLeaseAuthority(authority),
      'epoch-mismatch-before-heartbeat',
      2,
    )
  })

  it.each([
    {
      name: 'mismatched lease id',
      prepare: (authority: PublicWriterLeaseAuthority) => ({
        ...authority,
        leaseId: '00000000-0000-4000-8000-000000000000',
      }),
      reason: 'lease-id-mismatch' as const,
    },
    {
      name: 'missing lease',
      prepare: (authority: PublicWriterLeaseAuthority) => {
        expect(releaseLease(authority)).toEqual({ kind: 'released' })
        return authority
      },
      reason: 'lease-missing' as const,
    },
    {
      name: 'malformed lease',
      prepare: (authority: PublicWriterLeaseAuthority) => {
        writeFileSync(join(knowledgeRoot, LEASE_FILE), 'not-json\n', 'utf8')
        return authority
      },
      reason: 'lease-malformed' as const,
    },
  ])('normalizes a $name refusal into the typed authority-lost error', ({ prepare, reason }) => {
    const authority = prepare(acquireAuthority())

    expectAuthorityLoss(
      () => refreshWriterLeaseAuthority(authority),
      reason,
      authority.epoch,
    )
  })

  it('rechecks the epoch after heartbeat and catches a reclaim race', () => {
    const authority = acquireAuthority()
    now.mockImplementationOnce(() => {
      writeFileSync(join(knowledgeRoot, EPOCH_FILE), '2\n', 'utf8')
      return 2_005_000
    })

    expectAuthorityLoss(
      () => refreshWriterLeaseAuthority(authority),
      'epoch-mismatch-after-heartbeat',
      2,
    )
  })
})

describe('writer lease mutation lock ownership', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-lock-owner-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('waits behind a live held transaction until the original acquisition completes', async () => {
    const first = spawnLeaseAcquirer(knowledgeRoot, 6_500)
    await waitForOutput(first, 'locked\n')

    const second = spawnLeaseAcquirer(knowledgeRoot, 0)
    let secondExited = false
    second.once('exit', () => { secondExited = true })
    await new Promise((resolve) => setTimeout(resolve, 5_500))

    expect(secondExited).toBe(false)
    await Promise.all([waitForExit(first), waitForExit(second)])
    const authorityDb = new DatabaseSync(
      join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE),
      { readOnly: true },
    )
    try {
      expect(
        authorityDb.prepare('SELECT * FROM mutation_lock WHERE id = 1').get(),
      ).toBeUndefined()
    } finally {
      authorityDb.close()
    }
    expect(JSON.parse(readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8'))).toMatchObject({
      pid: first.pid,
      epoch: 1,
    })
  }, 10_000)

  it('short-circuits a fresh lease without killing its held-section owner', async () => {
    const permitFile = join(root, 'fresh-holder.permit')
    const holder = spawnAuthorityHolder(knowledgeRoot, permitFile)
    const holderExit = observeExit(holder)
    await waitForOutput(holder, 'inside\n')

    const startedAtMs = Date.now()
    const contender = acquireWriterLease(knowledgeRoot, {
      mutationLockTakeoverMs: 0,
    })

    expect(contender).toMatchObject({
      kind: 'held',
      holder: { pid: holder.pid, epoch: 1 },
    })
    expect(Date.now() - startedAtMs).toBeLessThan(250)
    expect(holder.exitCode).toBeNull()
    expect(holder.signalCode).toBeNull()

    writeFileSync(permitFile, 'resume\n', 'utf8')
    expect(await holderExit).toMatchObject({ code: 0, signal: null })
    expect(existsSync(join(knowledgeRoot, LEASE_FILE))).toBe(false)
  }, 10_000)

  it('kills and verifies the exact stale held-section owner before takeover', async () => {
    const permitFile = join(root, 'stale-holder.permit')
    const holder = spawnAuthorityHolder(knowledgeRoot, permitFile)
    const holderExit = observeExit(holder)
    await waitForOutput(holder, 'inside\n')
    const staleLease = JSON.parse(
      readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8'),
    ) as WriterLease
    writeFileSync(
      join(knowledgeRoot, LEASE_FILE),
      `${JSON.stringify({
        ...staleLease,
        heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
      })}\n`,
      'utf8',
    )

    const contender = spawnLeaseAcquirer(knowledgeRoot, 0, 0)
    const contenderExit = waitForExit(contender)
    expect(await holderExit).toMatchObject({ code: null, signal: 'SIGKILL' })
    await contenderExit

    expect(JSON.parse(
      readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8'),
    )).toMatchObject({
      pid: contender.pid,
      epoch: 2,
    })
  }, 15_000)

  it('CAS-takes a live crash row after its deadline and rejects the late original', async () => {
    const permitFile = join(root, 'claimed-holder.permit')
    const original = spawnClaimedLeaseAcquirer(knowledgeRoot, permitFile)
    const originalExit = observeExit(original)
    await waitForOutput(original, 'claimed\n')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const replacement = spawnLeaseAcquirer(knowledgeRoot, 0, 25)
    await waitForExit(replacement)
    writeFileSync(permitFile, 'resume\n', 'utf8')
    const refused = await originalExit

    expect(refused.code).not.toBe(0)
    expect(refused.signal).toBeNull()
    expect(refused.stderr).toContain('MutationLockGenerationLostError')
    expect(JSON.parse(
      readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8'),
    )).toMatchObject({
      pid: replacement.pid,
      epoch: 1,
    })
  }, 10_000)
})

/**
 * CR-01 + CR-03: one three-valued freshness derivation, and a beat the mutation lock cannot starve.
 *
 * The two live together because they are the same mechanism change: freshness is derived from the
 * disk epoch and the lease TTL alone, and the heartbeat writes `.lease` directly. There is no
 * second freshness channel for an unreadable epoch to be laundered through, and no contention
 * state for the beat to diverge into.
 */
describe('three-valued freshness and the lock-free heartbeat (CR-01/CR-03)', () => {
  let root: string
  let knowledgeRoot: string

  /** chmod is advisory for uid 0, so the unreadable-epoch input domain cannot be produced there. */
  const canMakeFilesUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-tristate-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    try {
      chmodSync(join(knowledgeRoot, EPOCH_FILE), 0o600)
    } catch {
      // The leg either never made it unreadable or already restored it.
    }
    rmSync(root, { recursive: true, force: true })
  })

  function leaseFile(): string {
    return join(knowledgeRoot, LEASE_FILE)
  }

  function leaseOnDisk(): WriterLease {
    return JSON.parse(readFileSync(leaseFile(), 'utf8')) as WriterLease
  }

  function ageLeaseOnDisk(ageMs: number): WriterLease {
    const aged = { ...leaseOnDisk(), heartbeatAtMs: Date.now() - ageMs }
    writeFileSync(leaseFile(), `${JSON.stringify(aged)}\n`, 'utf8')
    return aged
  }

  /** Occupy the authority database exactly as a long governed mutation does. */
  function holdAuthorityTransaction(): () => void {
    const db = new DatabaseSync(join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE))
    db.exec('PRAGMA busy_timeout = 250')
    db.exec('BEGIN IMMEDIATE')
    return () => {
      try {
        db.exec('ROLLBACK')
      } finally {
        db.close()
      }
    }
  }

  /**
   * The CR-01 rejecting corpus, drawn from OUTSIDE the guard's own assumption.
   *
   * The previous derivation only ever answered a boolean, so an unreadable `.epoch` — EACCES, EIO,
   * EMFILE, not corrupt bytes — produced the same value a genuinely expired lease produces. Both
   * directions of that collapse are asserted here: over a fresh lease AND over a TTL-stale one the
   * answer is `unknown`, so nothing inside the derivation resolves it toward either boolean.
   */
  it.runIf(canMakeFilesUnreadable)(
    'answers unknown for an unreadable epoch over both a fresh and a stale lease (CR-01)',
    () => {
      const acquired = acquireWriterLease(knowledgeRoot)
      if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
      const lease = leaseOnDisk()
      const nowMs = Date.now()

      // Accepting control: the same lease, the same clock, a readable epoch.
      expect(deriveWriterLeaseFreshness(knowledgeRoot, lease, nowMs)).toMatchObject({
        kind: 'fresh',
      })

      chmodSync(join(knowledgeRoot, EPOCH_FILE), 0o000)

      const overFresh = deriveWriterLeaseFreshness(knowledgeRoot, lease, nowMs)
      expect(overFresh.kind).toBe('unknown')
      expect(overFresh.kind).not.toBe('fresh')
      expect(overFresh.kind).not.toBe('reclaimable')
      if (overFresh.kind !== 'unknown') throw new Error('expected an unknown verdict')
      expect(overFresh.error).toBeInstanceOf(CorruptEpochStateError)
      expect(overFresh.error.reason).toBe('unreadable')

      // The immortal-phantom-holder shape the falsification table rejects: an unreadable epoch
      // must not fall through to the TTL rule in EITHER direction.
      const stale = { ...lease, heartbeatAtMs: nowMs - LEASE_HEARTBEAT_TTL_MS - 1 }
      const overStale = deriveWriterLeaseFreshness(knowledgeRoot, stale, nowMs)
      expect(overStale.kind).toBe('unknown')
      expect(overStale.kind).not.toBe('fresh')
      expect(overStale.kind).not.toBe('reclaimable')
    },
  )

  it('names a superseded epoch and an aged-out lease reclaimable, and neither of them fresh', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    const lease = leaseOnDisk()
    const nowMs = Date.now()

    expect(deriveWriterLeaseFreshness(knowledgeRoot, lease, nowMs)).toEqual({ kind: 'fresh' })
    expect(deriveWriterLeaseFreshness(
      knowledgeRoot,
      { ...lease, heartbeatAtMs: nowMs - LEASE_HEARTBEAT_TTL_MS },
      nowMs,
    )).toEqual({ kind: 'reclaimable' })

    writeFileSync(join(knowledgeRoot, EPOCH_FILE), `${lease.epoch + 1}\n`, 'utf8')
    expect(deriveWriterLeaseFreshness(knowledgeRoot, lease, nowMs)).toEqual({
      kind: 'reclaimable',
    })
  })

  /**
   * The beat is independent of hosted work BY CONSTRUCTION, and the evidence is file bytes.
   *
   * The old renewal path answered a third outcome here and published freshness somewhere else, so
   * a contender reading `.lease` saw a holder ageing out while the module reported it healthy.
   * Asserting the on-disk heartbeat rules that divergence out: there is one place freshness lives.
   */
  it('heartbeats a held-transaction root without entering the mutation lock (CR-03)', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    const before = ageLeaseOnDisk(5_000)

    const release = holdAuthorityTransaction()
    try {
      expect(heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })).toMatchObject({
        kind: 'heartbeated',
      })
    } finally {
      release()
    }

    expect(leaseOnDisk().heartbeatAtMs).toBeGreaterThan(before.heartbeatAtMs)
  }, 15_000)

  it('refuses a foreign lease id under a held transaction and writes nothing (CR-03)', () => {
    const superseded = acquireWriterLease(knowledgeRoot)
    if (superseded.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    expect(releaseLease({ knowledgeRoot, leaseId: superseded.leaseId })).toEqual({
      kind: 'released',
    })
    const replacement = acquireWriterLease(knowledgeRoot)
    if (replacement.kind !== 'acquired') throw new Error('expected a replacement writer lease')
    const bytesBefore = readFileSync(leaseFile())

    const release = holdAuthorityTransaction()
    try {
      expect(heartbeatLease({ knowledgeRoot, leaseId: superseded.leaseId })).toMatchObject({
        kind: 'refused',
        reason: 'lease-id-mismatch',
      })
    } finally {
      release()
    }

    expect(readFileSync(leaseFile())).toEqual(bytesBefore)
  }, 15_000)

  it('refuses a superseded-epoch holder under a held transaction and writes nothing (W-01)', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    const lease = leaseOnDisk()
    writeFileSync(join(knowledgeRoot, EPOCH_FILE), `${lease.epoch + 1}\n`, 'utf8')
    const bytesBefore = readFileSync(leaseFile())

    const release = holdAuthorityTransaction()
    try {
      expect(heartbeatLease({ knowledgeRoot, leaseId: lease.leaseId })).toMatchObject({
        kind: 'refused',
        reason: 'stale-epoch',
        observedEpoch: lease.epoch + 1,
      })
    } finally {
      release()
    }

    expect(readFileSync(leaseFile())).toEqual(bytesBefore)
  }, 15_000)

  it.runIf(canMakeFilesUnreadable)(
    'refuses an unreadable-epoch beat by name and writes nothing (CR-01)',
    () => {
      const acquired = acquireWriterLease(knowledgeRoot)
      if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
      const bytesBefore = readFileSync(leaseFile())
      chmodSync(join(knowledgeRoot, EPOCH_FILE), 0o000)

      expect(heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })).toMatchObject({
        kind: 'refused',
        reason: 'corrupt-epoch-state',
        error: { reason: 'unreadable' },
      })
      expect(readFileSync(leaseFile())).toEqual(bytesBefore)
    },
  )

  /**
   * The decisive CR-01 direction at the escalation gate, driven at the process level.
   *
   * An unreadable `.epoch` used to collapse to "not fresh", which is the same value a genuinely
   * expired lease produces, so a healthy holder inside its own governed mutation became a SIGKILL
   * target on a read error. The refusal must be typed and the holder must be untouched: no signal,
   * no lease rewrite, no epoch rewrite.
   */
  it.runIf(canMakeFilesUnreadable)(
    'refuses instead of escalating when the epoch turns unreadable over a live holder (CR-01)',
    async () => {
      const permitFile = join(root, 'unreadable-epoch-holder.permit')
      const holder = spawnAuthorityHolder(knowledgeRoot, permitFile)
      const holderExit = observeExit(holder)
      await waitForOutput(holder, 'inside\n')
      if (holder.pid === undefined) throw new Error('holder never started')
      const leaseBytesBefore = readFileSync(leaseFile())
      chmodSync(join(knowledgeRoot, EPOCH_FILE), 0o000)

      try {
        expect(acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: 0 })).toMatchObject({
          kind: 'refused',
          reason: 'corrupt-epoch-state',
        })
        expect(holder.exitCode).toBeNull()
        expect(holder.signalCode).toBeNull()
        expect(processIsAliveInTest(holder.pid)).toBe(true)
        expect(readFileSync(leaseFile())).toEqual(leaseBytesBefore)
      } finally {
        chmodSync(join(knowledgeRoot, EPOCH_FILE), 0o600)
      }

      writeFileSync(permitFile, 'resume\n', 'utf8')
      expect(await holderExit).toMatchObject({ code: 0, signal: null })
    },
    25_000,
  )

  /**
   * The accepting control for the leg above: the same escalation schedule, minus the one fact that
   * makes the epoch unreadable. A guard that refused every contender would satisfy the rejecting
   * direction on its own.
   */
  it('still reclaims a TTL-stale epoch-valid holder with no lock contention (accepting control)', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    const stale = ageLeaseOnDisk(LEASE_HEARTBEAT_TTL_MS + 5_000)

    expect(acquireWriterLease(knowledgeRoot)).toMatchObject({
      kind: 'acquired',
      epoch: stale.epoch + 1,
      reclaimed: stale,
    })
  })
})

/**
 * CR-04: the mutation-lock row's generation token authenticates the ROW, not the process that
 * currently occupies the recorded pid. After a crash plus pid reuse, escalation would otherwise be
 * a local arbitrary-process-termination primitive.
 *
 * The lock table's shape is written out literally here on purpose: these cases pin the durable
 * contract a contender reads, independently of whatever the module names its own column.
 */
const LEGACY_MUTATION_LOCK_TABLE = `
  CREATE TABLE IF NOT EXISTS mutation_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation_token TEXT NOT NULL,
    pid INTEGER NOT NULL CHECK (pid > 0),
    acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0)
  ) STRICT
`

/** A token no live process can ever report: the recorded owner is provably not this pid's tenant. */
const DEAD_OWNER_INCARNATION = `${incarnationFormat(
  resolveProcessIncarnation(process.pid) ?? '',
)}:incarnation-of-a-process-that-already-died`

describe('mutation-lock owner process incarnation (CR-04)', () => {
  let root: string
  let knowledgeRoot: string
  const spawned: ChildProcessWithoutNullStreams[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-incarnation-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // Already gone; the leg's own assertions own the outcome.
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  function track(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
    spawned.push(child)
    return child
  }

  function authorityDbPath(): string {
    return join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE)
  }

  function mutationLockColumnNames(): string[] {
    const db = new DatabaseSync(authorityDbPath(), { readOnly: true })
    try {
      return (
        db.prepare("SELECT name FROM pragma_table_info('mutation_lock')").all() as {
          name: string
        }[]
      ).map((column) => column.name)
    } finally {
      db.close()
    }
  }

  function readMutationLockRow(): Record<string, unknown> | undefined {
    const db = new DatabaseSync(authorityDbPath(), { readOnly: true })
    try {
      return db.prepare('SELECT * FROM mutation_lock WHERE id = 1').get() as
        | Record<string, unknown>
        | undefined
    } finally {
      db.close()
    }
  }

  function seedMutationLockRow(row: {
    pid: number
    acquiredAtMs: number
    generationToken: string
    incarnation?: string | null
    legacyShape?: boolean
  }): void {
    mkdirSync(knowledgeRoot, { recursive: true })
    const db = new DatabaseSync(authorityDbPath())
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(LEGACY_MUTATION_LOCK_TABLE)
      const columns = (
        db.prepare("SELECT name FROM pragma_table_info('mutation_lock')").all() as {
          name: string
        }[]
      ).map((column) => column.name)
      if (row.legacyShape === true) {
        db.prepare(`
          INSERT OR REPLACE INTO mutation_lock (id, generation_token, pid, acquired_at_ms)
          VALUES (1, ?, ?, ?)
        `).run(row.generationToken, row.pid, row.acquiredAtMs)
        return
      }
      if (!columns.includes('incarnation')) {
        db.exec('ALTER TABLE mutation_lock ADD COLUMN incarnation TEXT')
      }
      db.prepare(`
        INSERT OR REPLACE INTO mutation_lock (id, generation_token, pid, acquired_at_ms, incarnation)
        VALUES (1, ?, ?, ?, ?)
      `).run(row.generationToken, row.pid, row.acquiredAtMs, row.incarnation ?? null)
    } finally {
      db.close()
    }
  }

  /** Occupy the authority store exactly as a long governed mutation does, from this process. */
  function holdAuthorityTransaction(): () => void {
    const db = new DatabaseSync(authorityDbPath())
    db.exec('PRAGMA busy_timeout = 250')
    db.exec('BEGIN IMMEDIATE')
    let open = true
    return () => {
      if (!open) return
      open = false
      try {
        db.exec('ROLLBACK')
      } finally {
        db.close()
      }
    }
  }

  function leaseOnDisk(): WriterLease {
    return JSON.parse(readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8')) as WriterLease
  }

  it('exports a process-incarnation helper anchored on the OS-reported start time', () => {
    const surface = publicWriterSurface as unknown as Record<string, unknown>
    expect(surface.resolveProcessIncarnation).toBeTypeOf('function')
    const resolve = surface.resolveProcessIncarnation as (pid: number) => string | undefined

    const own = resolve(process.pid)
    expect(own).toBeTypeOf('string')
    expect(own).toContain(observedProcessStartToken(process.pid))
    expect(resolve(-1)).toBeUndefined()
    expect(resolve(0)).toBeUndefined()
    expect(resolve(2 ** 30)).toBeUndefined()
  })

  it('leaves an unrelated process occupying a reused pid unsignaled while the row is reclaimed', async () => {
    const exitPermit = join(root, 'surrogate.exit')
    const surrogate = track(spawnIdleSurrogate(exitPermit))
    const surrogateExit = observeExit(surrogate)
    await waitForOutput(surrogate, 'surrogate-alive\n')
    if (surrogate.pid === undefined) throw new Error('surrogate never started')

    seedMutationLockRow({
      pid: surrogate.pid,
      acquiredAtMs: Date.now() - 60_000,
      generationToken: 'crashed-original-generation',
      incarnation: DEAD_OWNER_INCARNATION,
    })

    // A transient third-party writer is what pushes the contender onto the escalation path at all.
    const releaseBlockingWrite = holdAuthorityTransaction()
    const contender = track(spawnLeaseAcquirer(knowledgeRoot, 0, 0))
    const contenderStdout = collectStdout(contender)
    const contenderExit = observeExit(contender)
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_000))

      expect(surrogate.signalCode).toBeNull()
      expect(surrogate.exitCode).toBeNull()
      expect(processIsAliveInTest(surrogate.pid)).toBe(true)
    } finally {
      releaseBlockingWrite()
    }

    expect(await contenderExit).toMatchObject({ code: 0, signal: null })
    expect(lastJsonLine(contenderStdout())).toMatchObject({ kind: 'acquired', epoch: 1 })
    expect(processIsAliveInTest(surrogate.pid)).toBe(true)
    expect(surrogate.signalCode).toBeNull()

    writeFileSync(exitPermit, 'exit\n', 'utf8')
    expect(await surrogateExit).toMatchObject({ code: 0, signal: null })
  }, 40_000)

  it('refuses to escalate against an unattributed lock row and never signals its live owner', async () => {
    const startPermit = join(root, 'blocker.start')
    const releasePermit = join(root, 'blocker.release')
    mkdirSync(knowledgeRoot, { recursive: true })
    const blocker = track(
      spawnAuthorityDbBlocker(authorityDbPath(), startPermit, releasePermit),
    )
    const blockerExit = observeExit(blocker)
    if (blocker.pid === undefined) throw new Error('blocker never started')

    seedMutationLockRow({
      pid: blocker.pid,
      acquiredAtMs: Date.now() - 60_000,
      generationToken: 'unattributed-generation',
      incarnation: null,
    })
    writeFileSync(startPermit, 'start\n', 'utf8')
    await waitForOutput(blocker, 'blocking\n')

    const contender = track(spawnLeaseAcquirer(knowledgeRoot, 0, 0))
    const contenderStdout = collectStdout(contender)
    const contenderExit = observeExit(contender)
    await new Promise((resolve) => setTimeout(resolve, 4_000))

    expect(blocker.signalCode).toBeNull()
    expect(blocker.exitCode).toBeNull()
    expect(contender.exitCode).toBeNull()

    writeFileSync(releasePermit, 'release\n', 'utf8')
    expect(await blockerExit).toMatchObject({ code: 0, signal: null })
    expect(await contenderExit).toMatchObject({ code: 0, signal: null })
    expect(lastJsonLine(contenderStdout())).toMatchObject({ kind: 'acquired', epoch: 1 })
  }, 40_000)

  it('records the claimant own start-time token and still kills the exact stale held-section owner', async () => {
    const permitFile = join(root, 'incarnation-control.permit')
    const holder = track(spawnAuthorityHolder(knowledgeRoot, permitFile))
    const holderExit = observeExit(holder)
    await waitForOutput(holder, 'inside\n')
    if (holder.pid === undefined) throw new Error('holder never started')

    const claimed = readMutationLockRow()
    expect(claimed).toMatchObject({ pid: holder.pid })
    expect(String(claimed?.incarnation ?? '')).toContain(observedProcessStartToken(holder.pid))

    writeFileSync(
      join(knowledgeRoot, LEASE_FILE),
      `${JSON.stringify({
        ...leaseOnDisk(),
        heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
      })}\n`,
      'utf8',
    )

    const contender = track(spawnLeaseAcquirer(knowledgeRoot, 0, 0))
    const contenderExit = observeExit(contender)
    expect(await holderExit).toMatchObject({ code: null, signal: 'SIGKILL' })
    expect(await contenderExit).toMatchObject({ code: 0, signal: null })
    expect(leaseOnDisk()).toMatchObject({ pid: contender.pid, epoch: 2 })
  }, 25_000)

  it('fires no takeover one clock step before the deadline and reclaims exactly at it', async () => {
    const bound = 12_000
    const frozenMs = 4_000_000
    const exitPermit = join(root, 'boundary.exit')
    const surrogate = track(spawnIdleSurrogate(exitPermit))
    const surrogateExit = observeExit(surrogate)
    await waitForOutput(surrogate, 'surrogate-alive\n')
    if (surrogate.pid === undefined) throw new Error('surrogate never started')

    mkdirSync(knowledgeRoot, { recursive: true })
    writeFileSync(join(knowledgeRoot, EPOCH_FILE), '1\n', 'utf8')
    const staleLease: WriterLease = {
      leaseId: '11111111-1111-4111-8111-111111111111',
      pid: surrogate.pid,
      epoch: 1,
      heartbeatAtMs: frozenMs - LEASE_HEARTBEAT_TTL_MS,
    }
    writeFileSync(join(knowledgeRoot, LEASE_FILE), `${JSON.stringify(staleLease)}\n`, 'utf8')

    // Both clocks are pinned so the deadline comparison is exact rather than drift-tolerant.
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(frozenMs)
    const lockClock = vi.spyOn(Date.prototype, 'getTime').mockReturnValue(frozenMs)
    try {
      seedMutationLockRow({
        pid: surrogate.pid,
        acquiredAtMs: frozenMs - bound + 1,
        generationToken: 'boundary-generation',
        incarnation: DEAD_OWNER_INCARNATION,
      })

      expect(acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: bound })).toEqual({
        kind: 'held',
        holder: staleLease,
      })

      seedMutationLockRow({
        pid: surrogate.pid,
        acquiredAtMs: frozenMs - bound,
        generationToken: 'boundary-generation',
        incarnation: DEAD_OWNER_INCARNATION,
      })

      expect(
        acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: bound }),
      ).toMatchObject({ kind: 'acquired', epoch: 2, reclaimed: staleLease })
    } finally {
      lockClock.mockRestore()
      wallClock.mockRestore()
    }

    expect(surrogate.signalCode).toBeNull()
    expect(processIsAliveInTest(surrogate.pid)).toBe(true)
    writeFileSync(exitPermit, 'exit\n', 'utf8')
    expect(await surrogateExit).toMatchObject({ code: 0, signal: null })
  }, 25_000)

  it('upgrades a pre-incarnation authority store and leaves its inherited row unattributed', async () => {
    const exitPermit = join(root, 'legacy.exit')
    const surrogate = track(spawnIdleSurrogate(exitPermit))
    const surrogateExit = observeExit(surrogate)
    await waitForOutput(surrogate, 'surrogate-alive\n')
    if (surrogate.pid === undefined) throw new Error('surrogate never started')

    seedMutationLockRow({
      pid: surrogate.pid,
      acquiredAtMs: Date.now(),
      generationToken: 'legacy-generation',
      legacyShape: true,
    })
    expect(mutationLockColumnNames()).not.toContain('incarnation')

    writeFileSync(join(knowledgeRoot, EPOCH_FILE), '1\n', 'utf8')
    const staleLease: WriterLease = {
      leaseId: '22222222-2222-4222-8222-222222222222',
      pid: surrogate.pid,
      epoch: 1,
      heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS - 1,
    }
    writeFileSync(join(knowledgeRoot, LEASE_FILE), `${JSON.stringify(staleLease)}\n`, 'utf8')

    expect(acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: 60_000 })).toEqual({
      kind: 'held',
      holder: staleLease,
    })
    expect(mutationLockColumnNames()).toContain('incarnation')
    expect(readMutationLockRow()?.incarnation).toBeNull()
    expect(surrogate.signalCode).toBeNull()

    let claimedRow: Record<string, unknown> | undefined
    const acquired = acquireWriterLease(knowledgeRoot, {
      mutationLockTakeoverMs: 0,
      afterMutationLockAcquired: () => { claimedRow = readMutationLockRow() },
    })

    expect(acquired).toMatchObject({ kind: 'acquired', epoch: 2 })
    expect(claimedRow).toMatchObject({ pid: process.pid })
    expect(String(claimedRow?.incarnation ?? '')).toContain(
      observedProcessStartToken(process.pid),
    )
    expect(surrogate.signalCode).toBeNull()
    expect(processIsAliveInTest(surrogate.pid)).toBe(true)

    writeFileSync(exitPermit, 'exit\n', 'utf8')
    expect(await surrogateExit).toMatchObject({ code: 0, signal: null })
  }, 25_000)

  /**
   * W-06: the schema upgrade is an unserialized check-then-ALTER, so two daemons starting against
   * one legacy store can both decide the column is missing.
   *
   * The race is driven deterministically rather than hoped for: the winner holds the write
   * transaction, this process enters the upgrade and blocks inside `ALTER` (its busy timeout is
   * 2 s), and the winner adds the column and commits INSIDE that window. The loser then wakes,
   * re-prepares against the new schema, and gets `duplicate column name` — an error `isSqliteBusy`
   * does not match, so before the fix it escaped as a raw SqliteError and killed a starting daemon.
   *
   * The `elapsedMs` assertion is the leg's own precondition, not decoration: an upgrade that
   * returned promptly never blocked, which means the window was missed and the case proved nothing.
   */
  it('completes a schema upgrade that loses the ALTER race to another connection (W-06)', async () => {
    seedMutationLockRow({
      pid: process.pid,
      acquiredAtMs: Date.now() - 600_000,
      generationToken: 'pre-upgrade-generation',
      legacyShape: true,
    })
    expect(mutationLockColumnNames()).not.toContain('incarnation')

    const winnerHoldMs = 1_500
    const winner = track(spawn(
      process.execPath,
      [...LEASE_SOURCE_CHILD_ARGV, '--eval', `
        const { DatabaseSync } = await import('node:sqlite');
        const { writeFileSync } = await import('node:fs');
        const db = new DatabaseSync(process.env.AGENT_QA_LEASE_TEST_DB);
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('BEGIN IMMEDIATE');
        writeFileSync(process.env.AGENT_QA_LEASE_TEST_HOLD_MARKER, 'holding\\n', 'utf8');
        const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        Atomics.wait(wait, 0, 0, Number(process.env.AGENT_QA_LEASE_TEST_HOLD_MS));
        db.exec('ALTER TABLE mutation_lock ADD COLUMN incarnation TEXT');
        db.exec('COMMIT');
        db.close();
      `],
      {
        env: {
          ...process.env,
          AGENT_QA_LEASE_TEST_DB: authorityDbPath(),
          AGENT_QA_LEASE_TEST_HOLD_MARKER: join(root, 'upgrade-winner.holding'),
          AGENT_QA_LEASE_TEST_HOLD_MS: String(winnerHoldMs),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ))
    const winnerExit = observeExit(winner)
    await waitForFileInTest(join(root, 'upgrade-winner.holding'), 15_000)

    const startedAtNs = process.hrtime.bigint()
    const loser = acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: 0 })
    const blockedForMs = elapsedMs(startedAtNs)

    expect(blockedForMs).toBeGreaterThan(winnerHoldMs * 0.6)
    expect(loser.kind).not.toBe('refused')
    expect(mutationLockColumnNames()).toContain('incarnation')
    expect(await winnerExit).toMatchObject({ code: 0, signal: null })

    // The postcondition the upgrade exists for: both connections now transact normally.
    expect(acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: 0 }).kind).not.toBe('refused')
  }, 40_000)

  /**
   * The other half of W-06, and the one the duplicate-column case cannot reach: the catch must be
   * a CLASSIFIER, not a swallow.
   *
   * Found by probing my own control — a `catch { }` that discards every ALTER failure passes the
   * race case above, because that case only ever asks whether the benign error was tolerated. Here
   * the upgrade fails for a reason that is NOT benign (the write lock is held past the whole
   * acquisition budget), and the difference is observable: keeping the error's meaning yields the
   * typed unreclaimable refusal, while discarding it lets the flow proceed onto a table that still
   * has no `incarnation` column and die there with a raw SQL logic error.
   */
  it('keeps a non-duplicate upgrade failure meaningful instead of swallowing it (W-06)', () => {
    seedMutationLockRow({
      pid: process.pid,
      acquiredAtMs: Date.now() - 600_000,
      generationToken: 'unupgradable-generation',
      legacyShape: true,
    })
    expect(mutationLockColumnNames()).not.toContain('incarnation')

    const blocker = new DatabaseSync(authorityDbPath())
    blocker.exec('PRAGMA busy_timeout = 250')
    blocker.exec('BEGIN IMMEDIATE')
    try {
      expect(
        acquireWithIncarnationObserver(knowledgeRoot, {
          acquireDeadlineMs: 3_000,
          mutationLockTakeoverMs: 0,
        }),
      ).toMatchObject({ kind: 'refused', reason: 'mutation-lock-unreclaimable' })
      // The upgrade genuinely did not happen, and the flow reported that rather than assuming it.
      expect(mutationLockColumnNames()).not.toContain('incarnation')
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  }, 40_000)

  /** A repeated upgrade over an already-upgraded store stays a no-op (the cheap half of W-06). */
  it('leaves an already-upgraded store untouched when the upgrade runs again (W-06)', () => {
    seedMutationLockRow({
      pid: process.pid,
      acquiredAtMs: Date.now() - 600_000,
      generationToken: 'already-upgraded-generation',
      incarnation: null,
    })
    expect(mutationLockColumnNames()).toContain('incarnation')

    for (let round = 0; round < 3; round += 1) {
      expect(acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: 0 }).kind).not.toBe(
        'refused',
      )
    }
    expect(mutationLockColumnNames().filter((name) => name === 'incarnation')).toHaveLength(1)
  }, 25_000)
})

/**
 * W-05: what an escalated takeover COSTS the caller that asked for the lock.
 *
 * Both legs use the one shape that makes the post-signal wait genuinely run: an owner whose parent
 * never reaps it. `SIGKILL` cannot be survived, but a killed child of a process that never returns
 * to its event loop stays an unreaped zombie, and `kill(pid, 0)` keeps answering "alive" for as
 * long as that parent lives. This is not a contrived shape — a daemon spinning synchronously on its
 * main thread is precisely the V-02 finding this phase reproduced, and its children are precisely
 * these zombies.
 */
describe('escalation cost and budget on the acquisition hot path (W-05)', () => {
  let root: string
  let knowledgeRoot: string
  const spawned: ChildProcessWithoutNullStreams[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-escalation-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
  })

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // Already gone; the leg's own assertions own the outcome.
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  function track(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
    spawned.push(child)
    return child
  }

  function authorityDbPath(): string {
    return join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE)
  }

  /**
   * Spawn a mutation-lock owner whose parent will never reap it.
   *
   * The nanny blocks in `Atomics.wait` forever, so libuv never runs the loop iteration that would
   * `waitpid` the dead grandchild. Returns the grandchild's pid — the owner the lock row names.
   */
  async function spawnNonReapingOwner(): Promise<number> {
    const pidFile = join(root, 'orphan.pid')
    track(spawn(
      process.execPath,
      [...LEASE_SOURCE_CHILD_ARGV, '--eval', `
        const { spawn } = await import('node:child_process');
        const { writeFileSync } = await import('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        writeFileSync(process.env.AGENT_QA_LEASE_TEST_PID_FILE, String(child.pid), 'utf8');
        const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        Atomics.wait(wait, 0, 0, 300000);
      `],
      {
        env: { ...process.env, AGENT_QA_LEASE_TEST_PID_FILE: pidFile },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ))
    const pid = await waitForPidFileInTest(pidFile, 15_000)
    // The owner must be attributable, or the escalation refuses and never reaches the wait at all.
    await waitForConditionInTest(() => processState(pid) === 'S' || processState(pid) === 'R', 15_000)
    return pid
  }

  /** Seed a lock row naming `pid` with the incarnation the pid genuinely reports right now. */
  function seedAttributedOwnerRow(pid: number, generationToken: string): void {
    const resolve = (publicWriterSurface as unknown as Record<string, unknown>)
      .resolveProcessIncarnation as (candidate: number) => string | undefined
    const incarnation = resolve(pid)
    if (incarnation === undefined) throw new Error(`pid ${pid} is not attributable`)
    const db = new DatabaseSync(authorityDbPath())
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          generation_token TEXT NOT NULL,
          pid INTEGER NOT NULL CHECK (pid > 0),
          acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
          incarnation TEXT
        ) STRICT
      `)
      db.prepare(`
        INSERT OR REPLACE INTO mutation_lock
          (id, generation_token, pid, acquired_at_ms, incarnation)
        VALUES (1, ?, ?, ?, ?)
      `).run(generationToken, pid, Date.now() - 600_000, incarnation)
    } finally {
      db.close()
    }
  }

  /** Occupy the store's write transaction so the claim is forced onto the escalation path. */
  function holdAuthorityTransaction(): () => void {
    const db = new DatabaseSync(authorityDbPath())
    db.exec('PRAGMA busy_timeout = 250')
    db.exec('BEGIN IMMEDIATE')
    let open = true
    return () => {
      if (!open) return
      open = false
      try {
        db.exec('ROLLBACK')
      } finally {
        db.close()
      }
    }
  }

  it.runIf(process.platform !== 'win32')(
    'charges the post-signal exit wait to the acquisition budget instead of adding to it (W-05)',
    async () => {
      const orphanPid = await spawnNonReapingOwner()
      seedAttributedOwnerRow(orphanPid, 'never-reaped-generation')
      const releaseBlockingWrite = holdAuthorityTransaction()

      try {
        const source = `
          const { acquireWriterLease } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
          const startedAtNs = process.hrtime.bigint();
          const outcome = acquireWriterLease(process.env.AGENT_QA_LEASE_TEST_ROOT, {
            acquireDeadlineMs: 2000,
            mutationLockTakeoverMs: 0,
          });
          const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
          process.stdout.write(JSON.stringify({
            kind: outcome.kind,
            reason: outcome.reason,
            attempts: outcome.attempts,
            elapsedMs,
          }) + '\\n');
        `
        const contender = track(spawn(
          process.execPath,
          [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
          {
            env: { ...process.env, AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ))
        const contenderStdout = collectStdout(contender)
        expect(await observeExit(contender)).toMatchObject({ code: 0, signal: null })
        const outcome = lastJsonLine(contenderStdout()) as { kind: string; elapsedMs: number }

        expect(outcome).toMatchObject({ kind: 'refused', reason: 'mutation-lock-unreclaimable' })
        // The escalation genuinely reached the signal AND the target genuinely never exited: an
        // external kernel fact, not the module's own account of what it did.
        expect(processState(orphanPid)).toBe('Z')
        // The refusal must arrive on the caller's budget. An unbudgeted wait adds the full
        // MUTATION_LOCK_TERMINATION_TIMEOUT_MS (5 s) on top of the 2 s deadline.
        expect(outcome.elapsedMs).toBeLessThan(5_000)
      } finally {
        releaseBlockingWrite()
      }
    },
    90_000,
  )

  it.runIf(process.platform !== 'win32')(
    'resolves the owner incarnation once per escalated attempt, never inside the exit wait (W-05)',
    async () => {
      const orphanPid = await spawnNonReapingOwner()
      seedAttributedOwnerRow(orphanPid, 'resolution-count-generation')
      const releaseBlockingWrite = holdAuthorityTransaction()

      try {
        const resolvedPids: number[] = []
        const outcome = acquireWithIncarnationObserver(knowledgeRoot, {
          acquireDeadlineMs: 8_000,
          mutationLockTakeoverMs: 0,
          onProcessIncarnationResolved: (pid) => { resolvedPids.push(pid) },
        })

        if (outcome.kind !== 'refused' || outcome.reason !== 'mutation-lock-unreclaimable') {
          throw new Error(`expected an unreclaimable refusal, received ${outcome.kind}`)
        }
        expect(processState(orphanPid)).toBe('Z')
        const ownerResolutions = resolvedPids.filter((pid) => pid === orphanPid)
        // The 386-31 mandate: the identity is re-read immediately before every signal decision.
        expect(ownerResolutions.length).toBeGreaterThanOrEqual(1)
        // ...and nowhere else. The exit wait polls kill(pid, 0); moving incarnation resolution
        // into that loop turns one shell fork per attempt into one per 10 ms poll.
        expect(ownerResolutions.length).toBeLessThanOrEqual(outcome.attempts)
      } finally {
        releaseBlockingWrite()
      }
    },
    90_000,
  )
})

/**
 * V-02: the acquisition retry loop must end, and the bound must be anchored OUTSIDE the lease
 * vocabulary it is arbitrating.
 *
 * The verifier reproduced an unbounded synchronous spin here with two probes. Both are converted
 * below into rejecting tests, and both keep their adversary ALIVE for the entire observation
 * window — a probe whose blocker dies early proves nothing about a bound. The contender runs in a
 * child process so a still-defective build fails as "no outcome within the watchdog" rather than
 * hanging the suite, which is exactly how the verifier had to observe it (SIGKILL at 25 s / 100 s).
 */
describe('writer lease acquisition deadline against an unreclaimable owner (V-02)', () => {
  let root: string
  let knowledgeRoot: string
  const spawned: ChildProcessWithoutNullStreams[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-deadline-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
  })

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // Already gone; the leg's own assertions own the outcome.
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  function track(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
    spawned.push(child)
    return child
  }

  interface ContenderOutcome {
    kind: string
    reason?: string
    message?: string
    attempts?: number
    waitedMs?: number
    elapsedMs: number
  }

  /**
   * Acquire in a child so an unbounded build is observable as a watchdog miss.
   *
   * The child reports the acquisition's own diagnostics AND its independently measured wall-clock
   * elapsed time, so "returned" and "returned within the bound" are separate assertions rather
   * than one claim resting on the module's own accounting.
   */
  function spawnBoundedContender(
    acquireDeadlineMs: number,
  ): ChildProcessWithoutNullStreams {
    const source = `
      const { acquireWriterLease } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
      const startedAtNs = process.hrtime.bigint();
      const outcome = acquireWriterLease(process.env.AGENT_QA_LEASE_TEST_ROOT, {
        acquireDeadlineMs: Number(process.env.AGENT_QA_LEASE_TEST_DEADLINE_MS),
      });
      const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
      process.stdout.write(JSON.stringify({
        kind: outcome.kind,
        reason: outcome.reason,
        message: outcome.error === undefined ? undefined : outcome.error.message,
        attempts: outcome.attempts,
        waitedMs: outcome.waitedMs,
        elapsedMs,
      }) + '\\n');
    `
    return track(spawn(
      process.execPath,
      [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
      {
        env: {
          ...process.env,
          AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
          AGENT_QA_LEASE_TEST_DEADLINE_MS: String(acquireDeadlineMs),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ))
  }

  /** Fail as a missed watchdog rather than as a suite hang when the loop is still unbounded. */
  function awaitContenderOutcome(
    child: ChildProcessWithoutNullStreams,
    watchdogMs: number,
  ): Promise<ContenderOutcome> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        reject(new Error(
          `contender produced no acquisition outcome within ${watchdogMs}ms `
          + '(the retry loop is unbounded)',
        ))
      }, watchdogMs)
      timer.unref()
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
        if (!stdout.includes('\n')) return
        clearTimeout(timer)
        resolve(JSON.parse(stdout.split('\n')[0] ?? '') as ContenderOutcome)
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (stdout.includes('\n')) return
        clearTimeout(timer)
        reject(new Error(`contender exited ${code} with no outcome: ${stderr}`))
      })
    })
  }

  function authorityDbPath(): string {
    return join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE)
  }

  function seedUnattributedMutationLockRow(pid: number): void {
    const db = new DatabaseSync(authorityDbPath())
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          generation_token TEXT NOT NULL,
          pid INTEGER NOT NULL CHECK (pid > 0),
          acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
          incarnation TEXT
        ) STRICT
      `)
      db.prepare(`
        INSERT OR REPLACE INTO mutation_lock
          (id, generation_token, pid, acquired_at_ms, incarnation)
        VALUES (1, ?, ?, ?, NULL)
      `).run('unattributable-generation', pid, Date.now())
    } finally {
      db.close()
    }
  }

  /** Keep the published lease genuinely fresh from another process for the observation window. */
  function spawnLeaseBeater(leaseId: string): ChildProcessWithoutNullStreams {
    const source = `
      const { readFileSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const file = join(process.env.AGENT_QA_LEASE_TEST_ROOT, '.lease');
      const leaseId = process.env.AGENT_QA_LEASE_TEST_LEASE_ID;
      const write = () => {
        const lease = JSON.parse(readFileSync(file, 'utf8'));
        if (lease.leaseId !== leaseId) return;
        writeFileSync(
          file,
          JSON.stringify({ ...lease, heartbeatAtMs: Date.now() }) + '\\n',
          'utf8',
        );
      };
      write();
      process.stdout.write('beating\\n');
      setInterval(write, 200);
    `
    return track(spawn(
      process.execPath,
      [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
      {
        env: {
          ...process.env,
          AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
          AGENT_QA_LEASE_TEST_LEASE_ID: leaseId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ))
  }

  it('refuses by name within the deadline against an unattributable live lock owner (Probe A)', async () => {
    const startPermit = join(root, 'probe-a.start')
    const releasePermit = join(root, 'probe-a.release')
    const blocker = track(spawnAuthorityDbBlocker(authorityDbPath(), startPermit, releasePermit))
    if (blocker.pid === undefined) throw new Error('probe A blocker never started')

    // A NULL-incarnation row naming the live blocker: unattributable, so escalation must refuse,
    // and no lease file exists, so the busy-catch has no `held` exit either.
    seedUnattributedMutationLockRow(blocker.pid)
    writeFileSync(startPermit, 'go\n', 'utf8')
    await waitForOutput(blocker, 'blocking\n')

    const contender = spawnBoundedContender(2_000)
    const outcome = await awaitContenderOutcome(contender, 30_000)

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'mutation-lock-unreclaimable',
    })
    expect(outcome.message).toContain('mutation-lock-unreclaimable')
    expect(outcome.attempts).toBeGreaterThan(0)
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(2_000)
    expect(outcome.elapsedMs).toBeLessThan(25_000)
    // The whole point of refusing rather than escalating: the unattributable owner is untouched.
    expect(blocker.exitCode).toBeNull()
    expect(blocker.signalCode).toBeNull()
    expect(processIsAliveInTest(blocker.pid)).toBe(true)

    writeFileSync(releasePermit, 'release\n', 'utf8')
  }, 60_000)

  it('refuses by name within the deadline against a beaten epoch-invalid lease (Probe B)', async () => {
    const permitFile = join(root, 'probe-b.permit')
    const holder = track(spawnAuthorityHolder(knowledgeRoot, permitFile))
    await waitForOutput(holder, 'inside\n')
    if (holder.pid === undefined) throw new Error('probe B holder never started')

    const lease = JSON.parse(
      readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8'),
    ) as WriterLease
    // The verifier's decisive shape, carried across the mechanism change: the published lease
    // names a superseded epoch while a live writer keeps beating it, so the epoch-strict
    // busy-catch will never accept it as `held` and only the deadline can end the wait.
    writeFileSync(join(knowledgeRoot, EPOCH_FILE), `${lease.epoch + 1}\n`, 'utf8')
    const renewer = spawnLeaseBeater(lease.leaseId)
    await waitForOutput(renewer, 'beating\n')

    const contender = spawnBoundedContender(2_000)
    const outcome = await awaitContenderOutcome(contender, 30_000)

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'mutation-lock-unreclaimable',
    })
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(2_000)
    expect(outcome.elapsedMs).toBeLessThan(25_000)
    // Both adversaries held the state for the entire window and neither was signalled.
    expect(holder.exitCode).toBeNull()
    expect(holder.signalCode).toBeNull()
    expect(renewer.exitCode).toBeNull()
    expect(renewer.signalCode).toBeNull()
    expect(processIsAliveInTest(holder.pid)).toBe(true)

    writeFileSync(permitFile, 'resume\n', 'utf8')
  }, 60_000)

  it('still acquires when the blocking owner releases before the deadline (accepting control)', async () => {
    const startPermit = join(root, 'control.start')
    const releasePermit = join(root, 'control.release')
    // No unattributable row here: the owner is merely SLOW, not unreclaimable. This is the exact
    // schedule of Probe A minus the one fact that makes escalation impossible.
    const blocker = track(spawnAuthorityDbBlocker(authorityDbPath(), startPermit, releasePermit))
    writeFileSync(startPermit, 'go\n', 'utf8')
    await waitForOutput(blocker, 'blocking\n')

    const contender = spawnBoundedContender(20_000)
    const releaseTimer = setTimeout(() => {
      writeFileSync(releasePermit, 'release\n', 'utf8')
    }, 1_500)
    releaseTimer.unref()

    const outcome = await awaitContenderOutcome(contender, 40_000)

    // The deadline is an exit for the unreclaimable case only; a bound that refuses a recoverable
    // owner would be a blanket refusal, which is the wrong fix wearing the right shape.
    expect(outcome.kind).toBe('acquired')
    expect(outcome.elapsedMs).toBeLessThan(20_000)
  }, 60_000)
})

/**
 * WR-04: the `ps` fork on the pre-signal path is the last wait beneath the acquisition deadline
 * that could outlive it.
 *
 * The guard-REJECTING input domain is a process table that will not answer: these legs hand the
 * child's code under test, through the test-only `psExecutable` seam, a `ps` that sleeps far past
 * any budget, which is the one input class the cap exists to refuse. The accepting control hands
 * it a pass-through to `/bin/ps`, so the only difference between "no signal" and "SIGKILL" is
 * whether the resolution returned inside its cap.
 *
 * Platform bound, stated rather than hidden: `resolveProcessIncarnation` reads `/proc/<pid>/stat`
 * on Linux and forks `ps` everywhere else POSIX. The residual being closed therefore only EXISTS
 * on the `ps` hosts, and so does its rejecting corpus. Windows resolves to `undefined` outright.
 */
const runsPsIncarnation = process.platform !== 'win32' && process.platform !== 'linux'
const itOnPsHosts = runsPsIncarnation ? it : it.skip

describe('budget-capped process-incarnation resolution on the escalation path (WR-04)', () => {
  let root: string
  let knowledgeRoot: string
  let shadowDir: string
  const spawnedHere: ChildProcessWithoutNullStreams[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-ps-cap-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    shadowDir = join(root, 'shadow-bin')
    mkdirSync(knowledgeRoot, { recursive: true })
    mkdirSync(shadowDir, { recursive: true })
  })

  afterEach(() => {
    for (const child of spawnedHere.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // Already gone; the leg's own assertions own the outcome.
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  function track(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
    spawnedHere.push(child)
    return child
  }

  /** Write the `ps` the child hands its code under test; the parent keeps the real one. */
  function shadowPs(body: string): void {
    const file = join(shadowDir, 'ps')
    writeFileSync(file, body, 'utf8')
    chmodSync(file, 0o755)
  }

  function realPsPath(): string {
    return '/bin/ps'
  }

  function spawnWithShadowedPs(
    source: string,
    env: Record<string, string>,
  ): ChildProcessWithoutNullStreams {
    return track(spawn(
      process.execPath,
      [...LEASE_SOURCE_CHILD_ARGV, '--eval', source],
      {
        env: {
          ...process.env,
          ...env,
          AGENT_QA_LEASE_TEST_PS: join(shadowDir, 'ps'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ))
  }

  function authorityDbPath(): string {
    return join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE)
  }

  /** Seed a lock row naming `pid` with the incarnation the REAL `ps` reports for it right now. */
  function seedAttributedOwnerRow(pid: number, generationToken: string): void {
    const incarnation = resolveProcessIncarnation(pid)
    if (incarnation === undefined) throw new Error(`pid ${pid} is not attributable`)
    const db = new DatabaseSync(authorityDbPath())
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          generation_token TEXT NOT NULL,
          pid INTEGER NOT NULL CHECK (pid > 0),
          acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
          incarnation TEXT
        ) STRICT
      `)
      db.prepare(`
        INSERT OR REPLACE INTO mutation_lock
          (id, generation_token, pid, acquired_at_ms, incarnation)
        VALUES (1, ?, ?, ?, ?)
      `).run(generationToken, pid, Date.now() - 600_000, incarnation)
    } finally {
      db.close()
    }
  }

  /** Occupy the store's write transaction so the claim is forced onto the escalation path. */
  function holdAuthorityTransaction(): () => void {
    const db = new DatabaseSync(authorityDbPath())
    db.exec('PRAGMA busy_timeout = 250')
    db.exec('BEGIN IMMEDIATE')
    let open = true
    return () => {
      if (!open) return
      open = false
      try {
        db.exec('ROLLBACK')
      } finally {
        db.close()
      }
    }
  }

  const CONTENDER_SOURCE = `
    const { acquireWriterLease } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
    const startedAtNs = process.hrtime.bigint();
    const outcome = acquireWriterLease(process.env.AGENT_QA_LEASE_TEST_ROOT, {
      acquireDeadlineMs: 4000,
      mutationLockTakeoverMs: 0,
      psExecutable: process.env.AGENT_QA_LEASE_TEST_PS,
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
    process.stdout.write(JSON.stringify({
      kind: outcome.kind,
      reason: outcome.reason,
      elapsedMs,
    }) + '\\n');
  `

  itOnPsHosts(
    'caps one ps fork at the budget it was handed and reports the pid unverifiable (WR-04)',
    async () => {
      // The rejecting input: a process table that never answers. Without the cap this fork runs to
      // completion and the caller's whole deadline is spent inside a single resolution.
      shadowPs('#!/bin/sh\nexec /bin/sleep 30\n')
      const source = `
        const { resolveProcessIncarnation } = await import(
          ${JSON.stringify(WRITER_LEASE_MODULE_URL)}
        );
        const startedAtNs = process.hrtime.bigint();
        const resolved = resolveProcessIncarnation(
          Number(process.env.AGENT_QA_LEASE_TEST_PID),
          250,
          process.env.AGENT_QA_LEASE_TEST_PS,
        );
        const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
        process.stdout.write(JSON.stringify({ resolved: resolved ?? null, elapsedMs }) + '\\n');
      `
      const child = spawnWithShadowedPs(source, {
        AGENT_QA_LEASE_TEST_PID: String(process.pid),
      })
      const output = collectStdout(child)
      expect(await observeExit(child)).toMatchObject({ code: 0, signal: null })

      const observed = lastJsonLine(output()) as { resolved: string | null; elapsedMs: number }
      // Fail-closed through the SAME funnel every other failure uses: no default token, no retry.
      expect(observed.resolved).toBeNull()
      expect(observed.elapsedMs).toBeLessThan(500)
    },
    60_000,
  )

  itOnPsHosts(
    'delivers no signal when the process table cannot answer inside the budget (WR-04)',
    async () => {
      const exitPermit = join(root, 'surrogate.exit')
      const surrogate = track(spawnIdleSurrogate(exitPermit))
      await waitForOutput(surrogate, 'surrogate-alive\n')
      if (surrogate.pid === undefined) throw new Error('surrogate never started')

      // Attributed with the REAL ps, so the row is escalatable by every other measure: the only
      // thing standing between this owner and a SIGKILL is whether its identity can be re-read.
      seedAttributedOwnerRow(surrogate.pid, 'ps-timeout-generation')
      const releaseBlockingWrite = holdAuthorityTransaction()
      shadowPs('#!/bin/sh\nexec /bin/sleep 30\n')

      try {
        const contender = spawnWithShadowedPs(CONTENDER_SOURCE, {
          AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
        })
        const output = collectStdout(contender)
        expect(await observeExit(contender)).toMatchObject({ code: 0, signal: null })
        const outcome = lastJsonLine(output()) as { kind: string; elapsedMs: number }

        expect(outcome).toMatchObject({ kind: 'refused', reason: 'mutation-lock-unreclaimable' })
        // The refusal arrived on the caller's own budget rather than on the shadow's 30 s sleep.
        expect(outcome.elapsedMs).toBeLessThan(15_000)
        // And the owner it could not verify was never a target — an OS fact, read with the real ps.
        expect(processIsAliveInTest(surrogate.pid)).toBe(true)
        expect(processState(surrogate.pid)).not.toBe('Z')
        expect(surrogate.exitCode).toBeNull()
        expect(surrogate.signalCode).toBeNull()
      } finally {
        releaseBlockingWrite()
        writeFileSync(exitPermit, 'go\n', 'utf8')
      }
    },
    90_000,
  )

  itOnPsHosts(
    'withholds the signal on an exhausted budget too, where the cap sits on its floor (WR-04)',
    async () => {
      const exitPermit = join(root, 'surrogate.exit')
      const surrogate = track(spawnIdleSurrogate(exitPermit))
      await waitForOutput(surrogate, 'surrogate-alive\n')
      if (surrogate.pid === undefined) throw new Error('surrogate never started')

      seedAttributedOwnerRow(surrogate.pid, 'ps-floor-generation')
      const releaseBlockingWrite = holdAuthorityTransaction()
      shadowPs('#!/bin/sh\nexec /bin/sleep 30\n')

      try {
        // A deadline shorter than the store's own busy timeout, so the claim spends the ENTIRE
        // budget before escalation begins and the cap can only be its pinned floor. The floor is
        // an allowance to look, never a licence to signal — this is its rejecting case.
        const source = CONTENDER_SOURCE.replace('acquireDeadlineMs: 4000', 'acquireDeadlineMs: 900')
        const contender = spawnWithShadowedPs(source, {
          AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
        })
        const output = collectStdout(contender)
        expect(await observeExit(contender)).toMatchObject({ code: 0, signal: null })

        expect(lastJsonLine(output())).toMatchObject({
          kind: 'refused',
          reason: 'mutation-lock-unreclaimable',
        })
        expect(processIsAliveInTest(surrogate.pid)).toBe(true)
        expect(processState(surrogate.pid)).not.toBe('Z')
        expect(surrogate.signalCode).toBeNull()
      } finally {
        releaseBlockingWrite()
        writeFileSync(exitPermit, 'go\n', 'utf8')
      }
    },
    90_000,
  )

  itOnPsHosts(
    'still resolves and kills the exact owner through a pass-through ps shadow (accepting control)',
    async () => {
      const exitPermit = join(root, 'surrogate.exit')
      const surrogate = track(spawnIdleSurrogate(exitPermit))
      await waitForOutput(surrogate, 'surrogate-alive\n')
      if (surrogate.pid === undefined) throw new Error('surrogate never started')

      seedAttributedOwnerRow(surrogate.pid, 'ps-passthrough-generation')
      const releaseBlockingWrite = holdAuthorityTransaction()
      // The same ps seam, the same escalation, the same row — differing only in whether the
      // process table answers. A cap that refused this input would be a blanket refusal.
      shadowPs(`#!/bin/sh\nexec ${realPsPath()} "$@"\n`)
      const surrogateExited = observeExit(surrogate)

      try {
        const contender = spawnWithShadowedPs(CONTENDER_SOURCE, {
          AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
        })
        const output = collectStdout(contender)
        expect(await observeExit(contender)).toMatchObject({ code: 0, signal: null })
        expect(lastJsonLine(output())).toMatchObject({ kind: 'refused' })

        expect(await surrogateExited).toMatchObject({ code: null, signal: 'SIGKILL' })
      } finally {
        releaseBlockingWrite()
        writeFileSync(exitPermit, 'go\n', 'utf8')
      }
    },
    90_000,
  )

  /**
   * The OWN-pid fork, which round 5 found still spending the deadline on a bare constant.
   *
   * The three legs below are all driven from a CHILD process, deliberately and not for isolation
   * hygiene: `ownProcessIncarnation` memoises at module scope, so in this suite's own process the
   * question "did this claim fork `ps`?" has already been answered by whichever leg ran first.
   * 386-46 measured exactly that trap (its deviation 2) and left the finding at
   * `writer-lease.test.ts`'s leg-B comment. A fresh child is the only fixture that can still
   * produce the value under test, so every assertion here reads a first-claim/second-claim pair
   * inside one child rather than a count accumulated across sibling tests.
   *
   * What is read is the on-disk `mutation_lock` row's `incarnation` column, sampled at
   * `afterMutationLockClaimed` (the claim is committed and the held transaction has not begun),
   * because that column is the artifact a contender's `verifyMutationLockOwnerIdentity` actually
   * consults. An assertion about the memo would be an assertion about this module's bookkeeping;
   * an assertion about the row is an assertion about whether this daemon stays escalatable.
   */
  const OWN_INCARNATION_CHILD_PRELUDE = `
    const { existsSync } = await import('node:fs');
    const { DatabaseSync } = await import('node:sqlite');
    const {
      acquireWriterLease,
      withCurrentWriterAuthority,
    } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
    const root = process.env.AGENT_QA_LEASE_TEST_ROOT;
    const dbPath = process.env.AGENT_QA_LEASE_TEST_DB;
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const readLockIncarnation = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 0 });
      try {
        const row = db.prepare(
          'SELECT pid, incarnation FROM mutation_lock WHERE id = 1'
        ).get();
        if (row === undefined) return null;
        return { pid: Number(row.pid), incarnation: row.incarnation ?? null };
      } finally {
        db.close();
      }
    };
    const awaitPermit = () => {
      while (!existsSync(process.env.AGENT_QA_LEASE_TEST_PERMIT)) {
        Atomics.wait(wait, 0, 0, 10);
      }
    };
  `

  interface OwnIncarnationChildReport {
    readonly pid: number
    readonly row1: { pid: number; incarnation: string | null } | null
    readonly row2: { pid: number; incarnation: string | null } | null
    readonly phase1Resolutions?: number[]
    readonly phase2Resolutions?: number[]
    readonly claimedElapsedMs?: number
    readonly kind?: string
  }

  /**
   * Spawn the child, resolve its incarnation with the REAL `ps` while it is still alive, release it.
   *
   * The parent's own `ps` is untouched by the shadow, so the expected token is an OS fact obtained
   * without going through the code under test — which is what makes "a real token" checkable
   * rather than merely "some non-null string" (the prohibition forbids a fabricated or default
   * token, and only an externally-anchored comparison can see the difference).
   */
  async function runOwnIncarnationChild(source: string): Promise<{
    report: OwnIncarnationChildReport
    expectedIncarnation: string
  }> {
    const permitFile = join(root, 'own-incarnation.permit')
    const child = spawnWithShadowedPs(source, {
      AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
      AGENT_QA_LEASE_TEST_DB: authorityDbPath(),
      AGENT_QA_LEASE_TEST_PERMIT: permitFile,
    })
    const output = collectStdout(child)
    await waitForOutput(child, 'started\n')
    if (child.pid === undefined) throw new Error('child never started')
    const expectedIncarnation = resolveProcessIncarnation(child.pid)
    if (expectedIncarnation === undefined) {
      throw new Error(`child pid ${child.pid} is not attributable to the parent's ps`)
    }
    writeFileSync(permitFile, 'go\n', 'utf8')
    expect(await observeExit(child)).toMatchObject({ code: 0, signal: null })
    return {
      report: lastJsonLine(output()) as OwnIncarnationChildReport,
      expectedIncarnation,
    }
  }

  itOnPsHosts(
    'retries a timed-out own-pid resolution on a later claim and attributes the row (round-5 regression 2)',
    async () => {
      // Phase 1's rejecting input: a process table that will not answer inside the cap, so the
      // claimant genuinely cannot prove its own incarnation and writes an unattributed row.
      shadowPs('#!/bin/sh\nexec /bin/sleep 30\n')
      const source = `${OWN_INCARNATION_CHILD_PRELUDE}
        process.stdout.write('started\\n');
        awaitPermit();
        let row1 = null;
        let row2 = null;
        const acquired = acquireWriterLease(root, {
          psExecutable: process.env.AGENT_QA_LEASE_TEST_PS,
          afterMutationLockClaimed: () => { row1 = readLockIncarnation(); },
        });
        if (acquired.kind !== 'acquired') {
          throw new Error('phase 1 did not acquire: ' + acquired.kind);
        }
        // The process table recovers (no seam). Nothing else about this process changed — same
        // pid, same start time, same module instance — so a second incarnation-less row can only
        // mean the first miss was remembered as an answer.
        withCurrentWriterAuthority(
          root,
          { leaseId: acquired.leaseId, epoch: acquired.epoch },
          () => {},
          { afterMutationLockClaimed: () => { row2 = readLockIncarnation(); } },
        );
        process.stdout.write(JSON.stringify({ pid: process.pid, row1, row2 }) + '\\n');
      `
      const { report, expectedIncarnation } = await runOwnIncarnationChild(source)

      // Phase 1 is the premise, not the property: the miss really happened.
      expect(report.row1).toEqual({ pid: report.pid, incarnation: null })
      // Phase 2 is the property. On the unmodified tree this is still `null` for the rest of the
      // process's life, and every one of its rows is `unverifiable` to every contender.
      expect(report.row2).toEqual({ pid: report.pid, incarnation: expectedIncarnation })
      // Anchored to the OS, so a retry that invented or defaulted a token would fail here rather
      // than pass a non-null check (the plan's prohibition, asserted).
      expect(expectedIncarnation.startsWith('ps-lstart-utc:')).toBe(true)
    },
    90_000,
  )

  itOnPsHosts(
    'caps the own-pid fork with the acquisition budget rather than the bare constant (round-5 regression 1)',
    async () => {
      shadowPs('#!/bin/sh\nexec /bin/sleep 30\n')
      // 400 ms is below PROCESS_INCARNATION_PS_TIMEOUT_MS and above PROCESS_INCARNATION_PS_FLOOR_MS,
      // so the clamp is the caller's remainder and nothing else. The bound asserted below is 2x
      // that deadline: the bare constant cannot fit inside it, the clamped cap cannot exceed it.
      const source = `${OWN_INCARNATION_CHILD_PRELUDE}
        process.stdout.write('started\\n');
        awaitPermit();
        let row1 = null;
        let claimedElapsedMs = null;
        const startedAtNs = process.hrtime.bigint();
        const outcome = acquireWriterLease(root, {
          acquireDeadlineMs: 400,
          psExecutable: process.env.AGENT_QA_LEASE_TEST_PS,
          afterMutationLockClaimed: () => {
            claimedElapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
            row1 = readLockIncarnation();
          },
        });
        process.stdout.write(JSON.stringify({
          pid: process.pid,
          kind: outcome.kind,
          claimedElapsedMs,
          row1,
          row2: null,
        }) + '\\n');
      `
      const { report } = await runOwnIncarnationChild(source)

      expect(report.kind).toBe('acquired')
      expect(report.claimedElapsedMs).toBeLessThan(800)
      // Fail-closed, and stated as an assertion rather than left implicit: an expired cap buys no
      // permission. The row records no incarnation, so this claimant's own row is unescalatable
      // until it can prove its identity — which the leg above shows it may later do.
      expect(report.row1).toEqual({ pid: report.pid, incarnation: null })
    },
    90_000,
  )

  itOnPsHosts(
    'still memoises a RESOLVED own incarnation and forks once per process (accepting control)',
    async () => {
      // The same ps seam and the same two claims, differing only in whether the process table
      // answers. A retryable sentinel that also retried the hit path would pay a `ps` fork on every
      // governed mutation for the life of the daemon; this is the leg that would catch it.
      shadowPs(`#!/bin/sh\nexec ${realPsPath()} "$@"\n`)
      const source = `${OWN_INCARNATION_CHILD_PRELUDE}
        process.stdout.write('started\\n');
        awaitPermit();
        let row1 = null;
        let row2 = null;
        const resolved = [];
        const observe = (pid) => { resolved.push(pid); };
        const acquired = acquireWriterLease(root, {
          onProcessIncarnationResolved: observe,
          psExecutable: process.env.AGENT_QA_LEASE_TEST_PS,
          afterMutationLockClaimed: () => { row1 = readLockIncarnation(); },
        });
        if (acquired.kind !== 'acquired') {
          throw new Error('phase 1 did not acquire: ' + acquired.kind);
        }
        const phase1Resolutions = resolved.splice(0);
        withCurrentWriterAuthority(
          root,
          { leaseId: acquired.leaseId, epoch: acquired.epoch },
          () => {},
          {
            onProcessIncarnationResolved: observe,
            psExecutable: process.env.AGENT_QA_LEASE_TEST_PS,
            afterMutationLockClaimed: () => { row2 = readLockIncarnation(); },
          },
        );
        const phase2Resolutions = resolved.splice(0);
        process.stdout.write(JSON.stringify({
          pid: process.pid,
          row1,
          row2,
          phase1Resolutions,
          phase2Resolutions,
        }) + '\\n');
      `
      const { report, expectedIncarnation } = await runOwnIncarnationChild(source)

      // The observer is honest here precisely because the module state is fresh: the first claim
      // pays exactly one own-pid fork...
      expect(report.phase1Resolutions).toEqual([report.pid])
      // ...and the second pays none, which is the memo still doing its job on the hit path.
      expect(report.phase2Resolutions).toEqual([])
      // A control that reaches a real answer, not one satisfiable by a resolver that gives up.
      expect(report.row1).toEqual({ pid: report.pid, incarnation: expectedIncarnation })
      expect(report.row2).toEqual({ pid: report.pid, incarnation: expectedIncarnation })
    },
    90_000,
  )
})

/**
 * WR-05: store contention on the owner read is a typed absence, not daemon death.
 *
 * The rejecting input is a store nobody can read: `readCommittedMutationLockOwner` opens read-only
 * with `timeout: 0`, and both of its callers publish its answer as part of a promise — the
 * busy-catch's `MutationLockBusyError`, and the acquisition deadline's typed
 * `mutation-lock-unreclaimable` refusal. A raw `SqliteError` from that read reached neither: it
 * propagated straight out of `acquireWriterLease`.
 */
describe('store contention during acquisition diagnostics (WR-05)', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-busy-read-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * Create the authority store in ROLLBACK-JOURNAL mode, which is the shape that can lock readers
   * out at all: `openWriterAuthorityDb` sets WAL, but it must first reach a store it can write to,
   * and a store created before that pragma landed (or by a contender that lost the race to it) is
   * still journalled. Under `BEGIN EXCLUSIVE` every reader — including a read-only connection —
   * gets `SQLITE_BUSY`.
   */
  function seedJournalledAuthorityStore(): string {
    const dbPath = join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE)
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA journal_mode = DELETE')
      db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          generation_token TEXT NOT NULL,
          pid INTEGER NOT NULL CHECK (pid > 0),
          acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
          incarnation TEXT
        ) STRICT
      `)
    } finally {
      db.close()
    }
    return dbPath
  }

  it('refuses by name instead of throwing when the authority store is too busy to read (WR-05)', () => {
    const dbPath = seedJournalledAuthorityStore()
    const blocker = new DatabaseSync(dbPath)
    blocker.exec('PRAGMA busy_timeout = 0')
    blocker.exec('BEGIN EXCLUSIVE')

    try {
      const outcome = acquireWriterLease(knowledgeRoot, {
        acquireDeadlineMs: 500,
        mutationLockTakeoverMs: 0,
      })

      // The promise both callers already publish: a busy store is no attributable owner, and the
      // refusal is the typed one by name rather than an uncaught SqliteError.
      expect(outcome).toMatchObject({
        kind: 'refused',
        reason: 'mutation-lock-unreclaimable',
      })
      if (outcome.kind !== 'refused' || outcome.reason !== 'mutation-lock-unreclaimable') {
        throw new Error(`expected an unreclaimable refusal, received ${outcome.kind}`)
      }
      expect(outcome.observedOwner).toBeUndefined()
      expect(outcome.error.message).toContain('no mutation-lock owner was readable')
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  }, 60_000)

  it('still reads the committed owner once the store is readable again (accepting control)', () => {
    const dbPath = seedJournalledAuthorityStore()
    const seeded = new DatabaseSync(dbPath)
    try {
      seeded.prepare(`
        INSERT OR REPLACE INTO mutation_lock
          (id, generation_token, pid, acquired_at_ms, incarnation)
        VALUES (1, ?, ?, ?, ?)
      `).run('readable-owner-generation', process.pid, Date.now(), null)
    } finally {
      seeded.close()
    }
    // Contended in exactly the same place, but by a transaction readers may cross: the diagnostics
    // must name the owner here, or the busy classification above would be indistinguishable from
    // an unconditional `undefined`.
    const blocker = new DatabaseSync(dbPath)
    blocker.exec('PRAGMA busy_timeout = 0')
    blocker.exec('BEGIN IMMEDIATE')

    try {
      const outcome = acquireWriterLease(knowledgeRoot, {
        acquireDeadlineMs: 500,
        mutationLockTakeoverMs: 60_000,
      })

      expect(outcome).toMatchObject({
        kind: 'refused',
        reason: 'mutation-lock-unreclaimable',
      })
      if (outcome.kind !== 'refused' || outcome.reason !== 'mutation-lock-unreclaimable') {
        throw new Error(`expected an unreclaimable refusal, received ${outcome.kind}`)
      }
      expect(outcome.observedOwner).toMatchObject({
        pid: process.pid,
        generationToken: 'readable-owner-generation',
        incarnationAttributed: false,
      })
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  }, 60_000)
})

/**
 * IN-04: the lease module's public export surface carries no fallow symbols.
 *
 * A symbol exported from the package index and imported by nobody is a claim the package makes
 * about its own contract that no consumer has ever tested. The two named residuals are checked
 * from OUTSIDE the module that defines them — through the package index itself — so the assertion
 * is about the surface rather than about the file.
 */
describe('writer lease public export surface (IN-04)', () => {
  it('publishes no unreachable acquisition-refusal symbols', () => {
    const surface = publicWriterSurface as unknown as Record<string, unknown>
    expect(surface.ACQUIRE_WRITER_LEASE_DEADLINE_MS).toBeUndefined()
    expect(surface.WriterLeaseUnreclaimableError).toBeUndefined()
    // ...and the refusal is still fully legible without them: the outcome carries the error
    // instance and its `reason` literal, which is what every rendering call site reads.
    expect(surface.acquireWriterLease).toBeTypeOf('function')
    expect(surface.deriveWriterLeaseFreshness).toBeTypeOf('function')
  })
})

/**
 * Round-5 CR-01: the sibling authority file gets the third value the epoch file already has.
 *
 * `.epoch` cannot be read -> `CorruptEpochStateError('unreadable')` -> `{kind:'unknown'}` -> every
 * consumer refuses. `.lease` could not be read, and answered `malformed` — the value a file full
 * of garbage bytes produces, which every consumer reads as *"nobody holds authority"*. The verifier
 * ran the difference as a controlled two-process differential and one leg ended with a live,
 * healthy, transaction-holding process dead of SIGKILL. That differential is this block.
 *
 * The corpus is drawn from OUTSIDE the guard's own assumption in the exact way the sibling-input
 * law names: the `chmod 0o000` primitive was already in this file six times and every one of them
 * targeted `EPOCH_FILE`. Here it targets `LEASE_FILE`.
 */
describe('the unreadable lease read and every consumer that names it (round-5 CR-01)', () => {
  let root: string
  let knowledgeRoot: string

  /** chmod is advisory for uid 0, so the unreadable-lease input domain cannot be produced there. */
  const canMakeFilesUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-unreadable-lease-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    try {
      chmodSync(join(knowledgeRoot, LEASE_FILE), 0o600)
    } catch {
      // The leg either never made it unreadable or already restored it.
    }
    rmSync(root, { recursive: true, force: true })
  })

  function leaseFile(): string {
    return join(knowledgeRoot, LEASE_FILE)
  }

  function epochFile(): string {
    return join(knowledgeRoot, EPOCH_FILE)
  }

  function leaseOnDisk(): WriterLease {
    return JSON.parse(readFileSync(leaseFile(), 'utf8')) as WriterLease
  }

  interface LiveHolder {
    readonly child: ChildProcessWithoutNullStreams
    readonly pid: number
    readonly exit: ReturnType<typeof observeExit>
    readonly permitFile: string
    readonly lease: WriterLease
  }

  /**
   * A real second OS process, inside `withCurrentWriterAuthority`, holding the mutation lock.
   *
   * Freshness is asserted BEFORE the discriminator is applied, so neither leg of the differential
   * can be explained by an aged-out or epoch-invalid lease: the two legs see the same bytes, the
   * same holder and the same verdict, and differ only in whether one file can be opened.
   */
  async function startLiveHolder(name: string): Promise<LiveHolder> {
    const permitFile = join(root, `${name}.permit`)
    const child = spawnAuthorityHolder(knowledgeRoot, permitFile)
    const exit = observeExit(child)
    await waitForOutput(child, 'inside\n')
    if (child.pid === undefined) throw new Error('holder never started')
    const lease = leaseOnDisk()
    expect(deriveWriterLeaseFreshness(knowledgeRoot, lease, Date.now())).toEqual({ kind: 'fresh' })
    return { child, pid: child.pid, exit, permitFile, lease }
  }

  function releaseLiveHolder(holder: LiveHolder): ReturnType<typeof observeExit> {
    writeFileSync(holder.permitFile, 'resume\n', 'utf8')
    return holder.exit
  }

  /**
   * The read itself, at the boundary the derivation's own W-01 note puts the guard at.
   *
   * ENOENT is the only read failure that is evidence of absence; bytes that WERE read and failed
   * to parse are still `malformed`; everything else is `unreadable` and carries its errno. The
   * `existsSync` fallback the previous implementation used is what degraded an EMFILE read into
   * `absent` under fd exhaustion — the file handle it needs is the one that just ran out.
   */
  it.runIf(canMakeFilesUnreadable)(
    'answers unreadable with its errno for a lease file that exists and cannot be opened',
    () => {
      expect(readWriterLease(knowledgeRoot)).toEqual({ kind: 'absent' })

      const acquired = acquireWriterLease(knowledgeRoot)
      if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
      // Accepting control: the same bytes, readable.
      expect(readWriterLease(knowledgeRoot)).toMatchObject({ kind: 'parsed' })

      chmodSync(leaseFile(), 0o000)
      const unreadable = readWriterLease(knowledgeRoot)
      expect(unreadable.kind).toBe('unreadable')
      expect(unreadable.kind).not.toBe('malformed')
      expect(unreadable.kind).not.toBe('absent')
      if (unreadable.kind !== 'unreadable') throw new Error('expected an unreadable lease read')
      expect(unreadable.code).toBe('EACCES')
      chmodSync(leaseFile(), 0o600)

      // Read-and-failed-to-parse stays malformed: the two are different facts about the same file.
      writeFileSync(leaseFile(), 'not-json\n', 'utf8')
      expect(readWriterLease(knowledgeRoot)).toEqual({ kind: 'malformed' })
      writeFileSync(leaseFile(), `${JSON.stringify({ nope: true })}\n`, 'utf8')
      expect(readWriterLease(knowledgeRoot)).toEqual({ kind: 'malformed' })
    },
  )

  /**
   * Leg A — the accepting control, and it is a control that can fail.
   *
   * A guard that refused every contender would satisfy leg B on its own. This leg proves the
   * fixture reaches a real answer: the same second-process holder, the same zero takeover bound,
   * the same deadline, answering `held` with the owner untouched.
   */
  it('answers held for a readable-lease second-process holder and leaves it alive (leg A)', async () => {
    const holder = await startLiveHolder('differential-leg-a')
    const epochBefore = readFileSync(epochFile())

    const contender = acquireWriterLease(knowledgeRoot, {
      mutationLockTakeoverMs: 0,
      acquireDeadlineMs: 4_000,
    })

    expect(contender).toMatchObject({
      kind: 'held',
      holder: { leaseId: holder.lease.leaseId, epoch: holder.lease.epoch },
    })
    expect(readFileSync(epochFile())).toEqual(epochBefore)
    expect(processIsAliveInTest(holder.pid)).toBe(true)
    expect(holder.child.signalCode).toBeNull()

    expect(await releaseLiveHolder(holder)).toMatchObject({ code: 0, signal: null })
  }, 25_000)

  /**
   * Leg B — the rejecting direction, discriminated from leg A by exactly one `chmod`.
   *
   * Round 5 observed `{kind:'acquired', epoch:2}` here (spot-check 2) and, at the escalation
   * surface, the owner dead of SIGKILL (spot-check 3b). Both consequences are asserted against:
   * the typed refusal, `.epoch` byte-identical (nothing was minted), and the owner exiting on its
   * own release permit with no signal.
   */
  it.runIf(canMakeFilesUnreadable)(
    'refuses by name and leaves an unreadable-lease second-process holder untouched (leg B)',
    async () => {
      const holder = await startLiveHolder('differential-leg-b')
      const epochBefore = readFileSync(epochFile())
      const leaseBytesBefore = readFileSync(leaseFile())

      chmodSync(leaseFile(), 0o000)
      const startedAtNs = process.hrtime.bigint()
      try {
        const contender = acquireWriterLease(knowledgeRoot, {
          mutationLockTakeoverMs: 0,
          acquireDeadlineMs: 4_000,
        })
        const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6
        expect(contender).toMatchObject({
          kind: 'refused',
          reason: 'unreadable-lease-state',
          code: 'EACCES',
        })
        /**
         * The PRE-LOCK gate specifically, and not merely the outcome a deeper gate would also
         * produce. A contender that reaches the mutation lock at all pays the store's busy timeout
         * before it can be turned away, so refusing inside that bound is the evidence that this
         * one never reached the contention surface — and therefore never reached the escalation
         * gate underneath it. The bound is the module's own constant rather than a tuned number,
         * so retuning the timeout cannot silently make this vacuous.
         *
         * The obvious alternative — counting `onProcessIncarnationResolved` — was written first
         * and measured vacuous: `ownProcessIncarnation` memoises process-wide, so by the time this
         * leg runs in a full-file suite the hook can never fire again. It reddened under `m3` when
         * run alone and not when run with its siblings, which is a control that reports the order
         * tests happen to execute in rather than the property under test.
         */
        expect(elapsedMs).toBeLessThan(MUTATION_LOCK_BUSY_TIMEOUT_MS)
        expect(readFileSync(epochFile())).toEqual(epochBefore)
        expect(processIsAliveInTest(holder.pid)).toBe(true)
        expect(holder.child.signalCode).toBeNull()
      } finally {
        chmodSync(leaseFile(), 0o600)
      }

      expect(readFileSync(leaseFile())).toEqual(leaseBytesBefore)
      expect(await releaseLiveHolder(holder)).toMatchObject({ code: 0, signal: null })
    },
    25_000,
  )

  /**
   * The escalation veto, PINNED — WINDOWS #46 inverted into a reachable failing case.
   *
   * 386-43 removed this veto entirely and reddened 0 of 111 cases, because every corpus contender
   * reached escalation through `acquireWriterLease`, whose pre-check dominates it. The
   * production-reachable path that does NOT pass through that pre-check is a fenced-out writer
   * retrying its commit: `withCurrentWriterAuthority` claims the mutation lock before it reads any
   * lease at all. Under a chmod-000 `.lease` that contender is one `leasePermitsEscalation`
   * verdict away from SIGKILLing a live holder, so the veto is the last lease guard on this path
   * and this leg is what makes it evidence.
   */
  it.runIf(canMakeFilesUnreadable)(
    'never signals a live mutation-lock owner reached without the acquisition pre-check (veto pin)',
    async () => {
      const holder = await startLiveHolder('escalation-veto-pin')

      chmodSync(leaseFile(), 0o000)
      let thrown: unknown
      try {
        withCurrentWriterAuthority(
          knowledgeRoot,
          { leaseId: holder.lease.leaseId, epoch: holder.lease.epoch },
          () => 'committed',
          { mutationLockTakeoverMs: 0 },
        )
      } catch (error) {
        thrown = error
      } finally {
        chmodSync(leaseFile(), 0o600)
      }

      expect(thrown).toBeInstanceOf(WriterAuthorityLostError)
      expect(processIsAliveInTest(holder.pid)).toBe(true)
      expect(holder.child.signalCode).toBeNull()
      expect(await releaseLiveHolder(holder)).toMatchObject({ code: 0, signal: null })
    },
    25_000,
  )

  /**
   * The fail-safe consumers the type change flushes out.
   *
   * None of them may write, and none of them may remove, a file it could not read. The evidence is
   * the bytes: `.lease` is byte-identical after all three refusals.
   */
  it.runIf(canMakeFilesUnreadable)(
    'refuses an unreadable-lease beat, release and authority re-read by name and writes nothing',
    () => {
      const acquired = acquireWriterLease(knowledgeRoot)
      if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
      const bytesBefore = readFileSync(leaseFile())

      chmodSync(leaseFile(), 0o000)
      try {
        expect(heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })).toMatchObject({
          kind: 'refused',
          reason: 'lease-unreadable',
        })
        expect(releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })).toMatchObject({
          kind: 'refused',
          reason: 'lease-unreadable',
        })

        let thrown: unknown
        try {
          withCurrentWriterAuthority(
            knowledgeRoot,
            { leaseId: acquired.leaseId, epoch: acquired.epoch },
            () => 'committed',
          )
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(WriterAuthorityLostError)
        expect((thrown as WriterAuthorityLostError).reason).toBe('lease-unreadable')
      } finally {
        chmodSync(leaseFile(), 0o600)
      }

      expect(existsSync(leaseFile())).toBe(true)
      expect(readFileSync(leaseFile())).toEqual(bytesBefore)
    },
  )
})

/**
 * The third member of the authority input set: the writer-authority DB itself.
 *
 * Round 5's headline lesson is that a guard reading N files of the same class needs its
 * fault-injection primitive applied to EVERY member, not to whichever one the round happened to be
 * reasoning about. `chmod 0o000` had been applied to `EPOCH_FILE` six times and to `LEASE_FILE`
 * never, and the gap was the defect. The remaining members of the set this module reads on the
 * authority path are the SQLite store under `WRITER_AUTHORITY_DB_FILE` (here) and the CLI's
 * `daemon.json` (in `packages/cli/src/__tests__/daemon-host.test.ts`).
 *
 * The store is a different KIND of input from the two text files: it is not parsed by this module
 * at all, it is opened by SQLite, so the question is not "what value does the read return" but
 * "what does an open failure do to a contender that was about to mint authority". The fail-safe
 * direction is the assertion — refusal or a thrown error, never `{kind:'acquired'}` — rather than
 * a specific arm, because the honest answer today is a rethrow (`isSqliteBusy` matches only
 * locked/busy, and an unopenable file is neither) and pinning the arm rather than the direction
 * would convert a future typed refusal into a test failure for no reason.
 */
describe('the writer-authority DB as an unreadable authority input (386-47)', () => {
  let root: string
  let knowledgeRoot: string
  const spawnedHere: ChildProcessWithoutNullStreams[] = []

  /** chmod is advisory for uid 0, so the unopenable-store input domain cannot be produced there. */
  const canMakeFilesUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-unreadable-db-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
  })

  afterEach(() => {
    try {
      chmodSync(authorityDbFile(), 0o600)
    } catch {
      // The leg either never made it unreadable or already restored it.
    }
    for (const child of spawnedHere.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // Already gone; the leg's own assertions own the outcome.
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  function authorityDbFile(): string {
    return join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE)
  }

  it.runIf(canMakeFilesUnreadable)(
    'never mints authority over a live holder when the writer-authority DB cannot be opened',
    async () => {
      // Create the store and the epoch through production, then hand the published lease to a real
      // second process and age it out. The contender therefore has genuine recovery input: its only
      // remaining obstacle is a store it cannot open.
      const seeded = acquireWriterLease(knowledgeRoot)
      if (seeded.kind !== 'acquired') throw new Error(`seed did not acquire: ${seeded.kind}`)
      expect(existsSync(authorityDbFile())).toBe(true)

      const exitPermit = join(root, 'surrogate.exit')
      const holder = spawnIdleSurrogate(exitPermit)
      spawnedHere.push(holder)
      await waitForOutput(holder, 'surrogate-alive\n')
      if (holder.pid === undefined) throw new Error('holder never started')

      const leaseFile = join(knowledgeRoot, LEASE_FILE)
      const epochFile = join(knowledgeRoot, EPOCH_FILE)
      writeFileSync(leaseFile, `${JSON.stringify({
        leaseId: seeded.leaseId,
        pid: holder.pid,
        epoch: seeded.epoch,
        heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS * 10,
      })}\n`, 'utf8')
      const epochBefore = readFileSync(epochFile)
      const leaseBytesBefore = readFileSync(leaseFile)

      chmodSync(authorityDbFile(), 0o000)
      let outcome: unknown
      let thrown: unknown
      try {
        outcome = acquireWriterLease(knowledgeRoot, {
          mutationLockTakeoverMs: 0,
          acquireDeadlineMs: 4_000,
        })
      } catch (error) {
        thrown = error
      } finally {
        chmodSync(authorityDbFile(), 0o600)
      }

      // The direction, not the arm: whichever way it resolves, it is not an acquisition.
      expect(outcome).not.toMatchObject({ kind: 'acquired' })
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as NodeJS.ErrnoException).code).toBe('ERR_SQLITE_ERROR')
      expect((thrown as Error).message).toMatch(/unable to open database file/i)

      // Nothing was minted and nobody was signalled — the two consequences a wrong answer here
      // would have produced, read as OS facts rather than as the module's account of itself.
      expect(readFileSync(epochFile)).toEqual(epochBefore)
      expect(readFileSync(leaseFile)).toEqual(leaseBytesBefore)
      expect(processIsAliveInTest(holder.pid)).toBe(true)
      expect(processState(holder.pid)).not.toBe('Z')
      expect(holder.signalCode).toBeNull()

      // The accepting control, on the same fixture discriminated only by the chmod that was just
      // reverted: this state IS recovery input, so a guard that refused everything would fail here.
      const readable = acquireWriterLease(knowledgeRoot, {
        mutationLockTakeoverMs: 0,
        acquireDeadlineMs: 4_000,
      })
      expect(readable).toMatchObject({ kind: 'acquired', epoch: seeded.epoch + 1 })

      writeFileSync(exitPermit, 'go\n', 'utf8')
    },
    30_000,
  )
})

/**
 * CR-03's containment ARGUMENT, executed rather than asserted in prose (386-42 UAT item 4).
 *
 * `heartbeatLease` no longer takes the mutation lock, and its docstring concedes that dropping it
 * opens exactly one race: a holder resuming from a >=TTL wedge can land its read-check-write
 * astride a contender's reclaim and clobber the successor's lease. The docstring then claims the
 * race is CONTAINED — not prevented — by the epoch fence, because a reclaim rewrites `.epoch`
 * strictly BEFORE it publishes `.lease`, both inside the lock, so any lease clobbered afterwards
 * names a superseded epoch and every classifier reads it as recovery input.
 *
 * Until these two cases the whole invariant rested on the adjacency of two lines a refactor could
 * reverse with every other case staying green. A real lock was replaced by a written argument, and
 * the argument had never been run.
 *
 * Both interleavings a beat can have with a reclaim's publication window are driven here without
 * any timing dependence and without any production change:
 *
 *   - the beat's ladder BEFORE the reclaim and its write AFTER it (the clobber), driven through
 *     the `Date.now()` stamp that `heartbeatLease` takes between its last check and its only
 *     write — already a spied seam in this file;
 *   - the beat's whole ladder INSIDE the window, driven through the production `afterEpochRewrite`
 *     seam that fires between the reclaim's two rewrites.
 *
 * Both cases redden when `atomicRewrite(.epoch)` and `atomicRewrite(.lease)` are swapped, which is
 * the only reason either of them is evidence for the ordering the argument rests on.
 */
describe('the lock-free beat astride a reclaim: CR-03 containment by the epoch fence (386-42)', () => {
  let root: string
  let knowledgeRoot: string
  let now: ReturnType<typeof vi.spyOn>

  const WEDGE_NOW = 3_000_000

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-clobber-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    now = vi.spyOn(Date, 'now').mockReturnValue(WEDGE_NOW)
  })

  afterEach(() => {
    now.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function leaseOnDisk(): WriterLease {
    return JSON.parse(
      readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8'),
    ) as WriterLease
  }

  /** The >=TTL wedge itself: a holder that stopped beating long enough to become a target. */
  function wedgeHolderPastTtl(): WriterLease {
    const wedged = { ...leaseOnDisk(), heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS }
    writeFileSync(join(knowledgeRoot, LEASE_FILE), `${JSON.stringify(wedged)}\n`, 'utf8')
    return wedged
  }

  it('contains a beat that clobbers the successor: the clobbered lease names a superseded epoch', () => {
    const incumbent = acquireWriterLease(knowledgeRoot)
    if (incumbent.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    const wedged = wedgeHolderPastTtl()

    let successor: ReturnType<typeof acquireWriterLease> | undefined
    let epochWhenReclaimBeganPublishing: number | undefined
    let resumed = false

    /**
     * The interleaving seam, and why this exact instant is the race.
     *
     * `heartbeatLease` completes its whole presence/id/epoch ladder against `.lease` and `.epoch`
     * BEFORE it stamps `heartbeatAtMs`, and that stamp is the only `Date.now()` on its path —
     * `readWriterLease` and `readEpoch` take no clock. So resuming the world here puts the wedged
     * holder in precisely the state the docstring describes: ladder already passed against epoch 1,
     * its single write not yet issued.
     */
    now.mockImplementation(() => {
      if (!resumed) {
        resumed = true
        successor = acquireWithEpochSeam(knowledgeRoot, {
          mutationLockTakeoverMs: 0,
          afterEpochRewrite: () => {
            /**
             * The reclaim is mid-publication: one of its two files is written, the other is not.
             * This is the EARLIEST instant at which the pending clobber could land, so it is the
             * instant at which the fence has to be up already. Reading it here is what makes the
             * case sensitive to the ordering of the two rewrites rather than to their outcome.
             */
            epochWhenReclaimBeganPublishing = readCurrentEpoch(knowledgeRoot)
          },
        })
      }
      return WEDGE_NOW
    })

    const beat = heartbeatLease({ knowledgeRoot, leaseId: incumbent.leaseId })

    /**
     * The interleaving is self-verifying, so this case cannot silently decay into a weaker one:
     * `heartbeated` is only reachable if the ladder ran BEFORE the reclaim (a ladder run after it
     * meets epoch 2 and refuses `stale-epoch`), and the clobber below is only reachable if the
     * write ran AFTER it.
     */
    expect(beat).toMatchObject({ kind: 'heartbeated' })
    if (successor?.kind !== 'acquired') throw new Error('expected the contender to reclaim')
    expect(successor.epoch).toBe(2)
    expect(successor.reclaimed).toEqual(wedged)

    // THE CLOBBER. The successor's freshly published lease is gone, overwritten by a holder that
    // believed it was renewing its own — the loss the lock used to prevent.
    const clobbered = leaseOnDisk()
    expect(clobbered.leaseId).toBe(incumbent.leaseId)
    expect(clobbered.leaseId).not.toBe(successor.leaseId)
    expect(clobbered.heartbeatAtMs).toBe(WEDGE_NOW)
    expect(clobbered.heartbeatAtMs).toBeGreaterThan(wedged.heartbeatAtMs)

    /**
     * THE CONTAINMENT, and the two adjacent lines it rests on. Because `atomicRewrite(.epoch)`
     * strictly precedes `atomicRewrite(.lease)` inside the lock, the fence was already up at the
     * reclaim's FIRST published byte — the earliest moment the pending clobber could have landed —
     * so the clobber could not name a current epoch no matter where in the window it fell.
     */
    expect(epochWhenReclaimBeganPublishing).toBe(2)
    expect(epochWhenReclaimBeganPublishing).toBeGreaterThan(clobbered.epoch)
    expect(readCurrentEpoch(knowledgeRoot)).toBe(2)
    expect(clobbered.epoch).toBe(1)

    /**
     * And the fence is the ONLY thing standing here: the clobber carries a freshly stamped beat, so
     * no TTL sweep will ever age it out. Without the epoch it would be the immortal phantom holder
     * — fresh forever, matching disk, reclaimed by nobody.
     */
    expect(isLeaseStale(clobbered, Date.now())).toBe(false)
    expect(deriveWriterLeaseFreshness(knowledgeRoot, clobbered, Date.now())).toEqual({
      kind: 'reclaimable',
    })

    // Every classifier therefore reads the clobber as recovery input, never as a live holder.
    expect(heartbeatLease({ knowledgeRoot, leaseId: incumbent.leaseId })).toMatchObject({
      kind: 'refused',
      reason: 'stale-epoch',
      observedEpoch: 2,
    })
    const bounced = (() => {
      try {
        withCurrentWriterAuthority(
          knowledgeRoot,
          { leaseId: successor.leaseId, epoch: successor.epoch },
          () => 'must not mutate under a clobbered lease',
        )
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(bounced).toBeInstanceOf(WriterAuthorityLostError)
    expect(bounced).toMatchObject({ reason: 'lease-id-mismatch', observedEpoch: 2 })

    // One successor bounce, then a fresh acquisition reclaims at the next epoch. A liveness
    // hiccup, never minted authority: the worst case the docstring claims, read off disk.
    const recovery = acquireWriterLease(knowledgeRoot, { mutationLockTakeoverMs: 0 })
    expect(recovery).toMatchObject({ kind: 'acquired', epoch: 3, reclaimed: clobbered })
  }, 15_000)

  it('refuses a beat that runs entirely inside the reclaim window, by epoch and not by identity', () => {
    const incumbent = acquireWriterLease(knowledgeRoot)
    if (incumbent.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    wedgeHolderPastTtl()

    let beatInsideWindow: ReturnType<typeof heartbeatLease> | undefined
    let leaseInsideWindow: WriterLease | undefined

    const successor = acquireWithEpochSeam(knowledgeRoot, {
      mutationLockTakeoverMs: 0,
      afterEpochRewrite: () => {
        leaseInsideWindow = leaseOnDisk()
        beatInsideWindow = heartbeatLease({ knowledgeRoot, leaseId: incumbent.leaseId })
      },
    })

    if (successor.kind !== 'acquired') throw new Error('expected the contender to reclaim')

    /**
     * Inside the window the incumbent's own lease is still the published one, so identity cannot
     * be what stops this beat — the id matches. The epoch is already 2 and the lease still says 1,
     * so the fence is what refuses it, by name. Reverse the two rewrites and this same instant
     * carries the successor's lease instead, and the refusal changes to `lease-id-mismatch`:
     * accidental, dependent on a fresh uuid rather than on the fence.
     */
    expect(leaseInsideWindow?.leaseId).toBe(incumbent.leaseId)
    expect(beatInsideWindow).toMatchObject({
      kind: 'refused',
      reason: 'stale-epoch',
      observedEpoch: 2,
    })

    // A refused beat writes nothing, so the reclaim's publication survives it intact.
    expect(leaseOnDisk()).toMatchObject({ leaseId: successor.leaseId, epoch: 2 })
  }, 15_000)
})

function refuseWithoutPosixRunLifecycle(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
}

function ownerEnvironmentB(root: string): NodeJS.ProcessEnv {
  const directory = join(root, 'shadowing-ps')
  mkdirSync(directory, { recursive: true })
  const ps = join(directory, 'ps')
  writeFileSync(ps, "#!/bin/sh\nprintf 'Thu Jan  1 00:00:00 1970\\n'\nexit 0\n", 'utf8')
  chmodSync(ps, 0o755)
  return { PATH: `${directory}:${process.env.PATH ?? ''}` }
}

function awaitChildClose(
  child: ChildProcessWithoutNullStreams,
  watchdogMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      reject(new Error(`child produced no outcome within ${watchdogMs}ms: ${stderr}`))
    }, watchdogMs)
    timer.unref()
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function spawnIncarnationReader(
  pid: number,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const source = `
    const { resolveProcessIncarnation } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
    const token = resolveProcessIncarnation(Number(process.env.AGENT_QA_LEASE_TEST_READ_PID));
    process.stdout.write(JSON.stringify({ token: token ?? null }) + '\\n');
  `
  return spawn(process.execPath, [...LEASE_SOURCE_CHILD_ARGV, '--eval', source], {
    env: { ...process.env, ...env, AGENT_QA_LEASE_TEST_READ_PID: String(pid) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function spawnBoundedLeaseContender(
  knowledgeRoot: string,
  acquireDeadlineMs: number,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const source = `
    const { acquireWriterLease } = await import(${JSON.stringify(WRITER_LEASE_MODULE_URL)});
    const outcome = acquireWriterLease(process.env.AGENT_QA_LEASE_TEST_ROOT, {
      acquireDeadlineMs: Number(process.env.AGENT_QA_LEASE_TEST_DEADLINE_MS),
      mutationLockTakeoverMs: 0,
    });
    process.stdout.write(JSON.stringify({ kind: outcome.kind, reason: outcome.reason }) + '\\n');
  `
  return spawn(process.execPath, [...LEASE_SOURCE_CHILD_ARGV, '--eval', source], {
    env: {
      ...process.env,
      ...env,
      AGENT_QA_LEASE_TEST_ROOT: knowledgeRoot,
      AGENT_QA_LEASE_TEST_DEADLINE_MS: String(acquireDeadlineMs),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function contenderOutcome(
  contender: ChildProcessWithoutNullStreams,
): Promise<{ kind: string; reason?: string }> {
  const closed = await awaitChildClose(contender, 30_000)
  if (closed.code !== 0) throw new Error(`contender exited ${closed.code}: ${closed.stderr}`)
  return lastJsonLine(closed.stdout) as { kind: string; reason?: string }
}

function readMutationLockRowAt(knowledgeRoot: string): Record<string, unknown> | undefined {
  const db = new DatabaseSync(join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE), { readOnly: true })
  try {
    return db.prepare('SELECT * FROM mutation_lock WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined
  } finally {
    db.close()
  }
}

function useSpawnedChildren(prefix: string): {
  root: () => string
  track: (child: ChildProcessWithoutNullStreams) => ChildProcessWithoutNullStreams
} {
  let root = ''
  const spawned: ChildProcessWithoutNullStreams[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), prefix))
  })

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  return {
    root: () => root,
    track: (child) => {
      spawned.push(child)
      return child
    },
  }
}

describe('C442-CROSS-ENV', () => {
  const READING_ENVIRONMENT = { TZ: 'Asia/Kathmandu', LC_ALL: 'C', LANG: 'C' }
  const OWNER_ENVIRONMENT_A = { TZ: 'UTC', LC_ALL: 'fr_FR.UTF-8', LANG: 'fr_FR.UTF-8' }
  const OTHER_READER_ENVIRONMENT = {
    TZ: 'America/Los_Angeles',
    LC_ALL: 'de_DE.UTF-8',
    LANG: 'de_DE.UTF-8',
  }
  const { root, track } = useSpawnedChildren('knowledge-writer-cross-env-')

  it('C442-CROSS-ENV one live process reads as one start-time token from readers with different time zones, locales and a shadowing ps', async () => {
    refuseWithoutPosixRunLifecycle()
    const subject = track(spawnIdleSurrogate(join(root(), 'subject.exit')))
    await waitForOutput(subject, 'surrogate-alive\n')
    if (subject.pid === undefined) throw new Error('subject never started')
    expect(processIsAliveInTest(subject.pid)).toBe(true)

    const readers: [string, NodeJS.ProcessEnv][] = [
      ['reading', READING_ENVIRONMENT],
      ['A', OWNER_ENVIRONMENT_A],
      ['America/Los_Angeles de_DE.UTF-8', OTHER_READER_ENVIRONMENT],
      ['B', ownerEnvironmentB(root())],
    ]
    const tokens: Record<string, unknown> = {}
    for (const [label, env] of readers) {
      const closed = await awaitChildClose(track(spawnIncarnationReader(subject.pid, env)), 30_000)
      if (closed.code !== 0) {
        throw new Error(`reader ${label} exited ${closed.code}: ${closed.stderr}`)
      }
      tokens[label] = (lastJsonLine(closed.stdout) as { token: unknown }).token
    }

    expect(processIsAliveInTest(subject.pid)).toBe(true)
    expect(Object.values(tokens).map((token) => typeof token)).toEqual([
      'string',
      'string',
      'string',
      'string',
    ])
    const first = tokens.reading
    expect(tokens).toEqual(Object.fromEntries(readers.map(([label]) => [label, first])))
  }, 60_000)

  it('C442-CROSS-ENV a mutation-lock holder stamped under another time zone, locale or ps is read as itself, never as a reused pid', async () => {
    refuseWithoutPosixRunLifecycle()
    const owners: [string, NodeJS.ProcessEnv][] = [
      ['A', OWNER_ENVIRONMENT_A],
      ['B', ownerEnvironmentB(root())],
    ]
    const ends: Record<string, { holder: string; contender: string; stamp: unknown }> = {}
    for (const [label, env] of owners) {
      const knowledgeRoot = join(root(), `holder-${label}`, 'agent-qa-knowledge')
      mkdirSync(knowledgeRoot, { recursive: true })
      const holder = track(
        spawnAuthorityHolder(knowledgeRoot, join(root(), `holder-${label}.permit`), env),
      )
      const holderExit = observeExit(holder)
      await waitForOutput(holder, 'inside\n')
      if (holder.pid === undefined) throw new Error(`holder ${label} never started`)
      expect(processIsAliveInTest(holder.pid)).toBe(true)
      const claimed = readMutationLockRowAt(knowledgeRoot)
      expect(claimed).toMatchObject({ pid: holder.pid })
      expect(claimed?.incarnation).toBeTypeOf('string')

      const leaseFile = join(knowledgeRoot, LEASE_FILE)
      const lease = JSON.parse(readFileSync(leaseFile, 'utf8')) as WriterLease
      writeFileSync(
        leaseFile,
        `${JSON.stringify({ ...lease, heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS })}\n`,
        'utf8',
      )

      const outcome = await contenderOutcome(
        track(spawnBoundedLeaseContender(knowledgeRoot, 8_000, READING_ENVIRONMENT)),
      )
      const holderEnd = await Promise.race([
        holderExit.then((exit) => exit.signal ?? `exit ${exit.code}`),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve(holder.signalCode ?? 'alive and unsignalled'), 3_000).unref()
        }),
      ])
      ends[label] = { holder: holderEnd, contender: outcome.kind, stamp: claimed?.incarnation }
    }

    const observed = Object.fromEntries(
      Object.entries(ends).map(([label, end]) => [
        label,
        { holder: end.holder, contender: end.contender },
      ]),
    )
    expect(observed, JSON.stringify(ends)).toEqual({
      A: { holder: 'SIGKILL', contender: 'acquired' },
      B: { holder: 'SIGKILL', contender: 'acquired' },
    })
  }, 90_000)
})

describe('C442-INCARNATION-FORMAT', () => {
  const { root, track } = useSpawnedChildren('knowledge-writer-incarnation-format-')

  it('C442-INCARNATION-FORMAT a ps host stamps ps-lstart-utc read by /bin/ps in UTC and the C locale, and Linux stamps proc-starttime', () => {
    const token = resolveProcessIncarnation(process.pid)
    if (process.platform === 'win32') {
      expect(token).toBeUndefined()
      return
    }
    if (process.platform === 'linux') {
      expect(token).toBe(`proc-starttime:${observedProcessStartToken(process.pid)}`)
      return
    }
    const lstart = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
    }).trim()
    expect(lstart).not.toBe('')
    expect(token).toBe(`ps-lstart-utc:${lstart}`)
  })

  it('C442-INCARNATION-FORMAT a mutation-lock row stamped in another start-time format is never reclaimed and its live owner never signalled', async () => {
    refuseWithoutPosixRunLifecycle()
    const knowledgeRoot = join(root(), 'agent-qa-knowledge')
    const surrogate = track(spawnIdleSurrogate(join(root(), 'surrogate.exit')))
    await waitForOutput(surrogate, 'surrogate-alive\n')
    if (surrogate.pid === undefined) throw new Error('surrogate never started')
    expect(processIsAliveInTest(surrogate.pid)).toBe(true)

    mkdirSync(knowledgeRoot, { recursive: true })
    const dbPath = join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE)
    const seed = new DatabaseSync(dbPath)
    try {
      seed.exec('PRAGMA journal_mode = WAL')
      seed.exec(LEGACY_MUTATION_LOCK_TABLE)
      seed.exec('ALTER TABLE mutation_lock ADD COLUMN incarnation TEXT')
      seed.prepare(`
        INSERT INTO mutation_lock (id, generation_token, pid, acquired_at_ms, incarnation)
        VALUES (1, ?, ?, ?, ?)
      `).run(
        'foreign-format-generation',
        surrogate.pid,
        Date.now() - 60_000,
        'foreign-format:incarnation',
      )
    } finally {
      seed.close()
    }
    expect(readMutationLockRowAt(knowledgeRoot)).toMatchObject({
      pid: surrogate.pid,
      incarnation: 'foreign-format:incarnation',
    })

    const blocking = new DatabaseSync(dbPath)
    blocking.exec('PRAGMA busy_timeout = 250')
    blocking.exec('BEGIN IMMEDIATE')
    let outcome: { kind: string; reason?: string }
    try {
      outcome = await contenderOutcome(track(spawnBoundedLeaseContender(knowledgeRoot, 4_000, {})))
    } finally {
      blocking.exec('ROLLBACK')
      blocking.close()
    }

    expect({
      outcome,
      surrogate: {
        alive: processIsAliveInTest(surrogate.pid),
        exitCode: surrogate.exitCode,
        signal: surrogate.signalCode,
      },
      row: readMutationLockRowAt(knowledgeRoot),
    }).toMatchObject({
      outcome: { kind: 'refused', reason: 'mutation-lock-unreclaimable' },
      surrogate: { alive: true, exitCode: null, signal: null },
      row: { pid: surrogate.pid, incarnation: 'foreign-format:incarnation' },
    })
  }, 60_000)
})
