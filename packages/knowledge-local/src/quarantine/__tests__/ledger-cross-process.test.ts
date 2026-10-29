// Two real OS processes share one ledger; O_APPEND atomicity holds only on a local filesystem.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import {
  QUARANTINE_LEDGER_FILENAME,
  appendQuarantineEvents,
  foldQuarantineLedgerState,
  readQuarantineLedger,
} from '../ledger.js'
import { createQuarantineOperations } from '../operations.js'
import type { QuarantineOperationsOptions } from '../operations.js'
import {
  CLI_OWNER,
  CONTESTED,
  DAEMON_OWNER,
  QUARANTINE_CHILD_ENV,
  READ_NOW,
  burstEvent,
  foldWithoutReleaseGuard,
  steppingClock,
  writerIdentity,
} from './fixtures/cross-process-contract.js'

/** Distinct identities each writer opens in leg 1, beside the one contested identity. */
const OWN_IDENTITIES = 6
/** How long the daemon-shaped writer stays inside its own `decide` while the child hammers. */
const INSIDE_HOLD_MS = 600
/** The floor the child's blocked first `add` must clear for the exclusion to be real, not noise. */
const MIN_OBSERVED_BLOCK_MS = 250
/** Leg 4: alternation rounds, then free-burst lines, per writer. */
const ALTERNATION_ROUNDS = 6
const BURST_LINES = 60

const childFixturePath = fileURLToPath(
  new URL('./fixtures/quarantine-ledger-child.test.ts', import.meta.url),
)
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const vitestPath = join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs')

interface ChildHandle {
  child: ChildProcess
  output: () => string
}

/** Published in one step, so the child cannot observe a marker that is not yet a marker. */
function publishMarker(path: string): void {
  const staging = `${path}.${String(process.pid)}.tmp`
  writeFileSync(staging, 'go\n', 'utf8')
  renameSync(staging, path)
}

/**
 * A SYNCHRONOUS block, which is the only kind that can hold a `decide` open.
 *
 * `underWriterLease` refuses an async `decide` at compile time (`SynchronousDecision`), so the
 * announcement window has to be built out of something that does not yield the event loop. This is
 * `writer-lease.ts`'s own idiom for the same reason.
 */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms)
}

describe('quarantine ledger under real cross-process contention', () => {
  let base: string
  let root: string
  let markers: {
    ready: string
    go: string
    report: string
    inside: string
    insideDone: string
    folded: string
    resume: string
  }
  let handles: ChildHandle[]

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'agent-qa-quarantine-contention-'))
    root = join(base, 'knowledge')
    markers = {
      ready: join(base, 'child-ready'),
      go: join(base, 'parent-go'),
      report: join(base, 'child-report.json'),
      inside: join(base, 'parent-inside'),
      insideDone: join(base, 'parent-inside-done'),
      folded: join(base, 'child-folded.json'),
      resume: join(base, 'parent-resume'),
    }
    handles = []
  })

  afterEach(() => {
    for (const handle of handles) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        handle.child.kill('SIGKILL')
      }
    }
    rmSync(base, { recursive: true, force: true })
  })

  function spawnChild(role: string, extra: Record<string, string> = {}): ChildHandle {
    const child = spawn(
      process.execPath,
      [vitestPath, 'run', childFixturePath, '--pool=threads', '--maxWorkers=1'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          [QUARANTINE_CHILD_ENV.gate]: '1',
          [QUARANTINE_CHILD_ENV.role]: role,
          [QUARANTINE_CHILD_ENV.root]: root,
          [QUARANTINE_CHILD_ENV.report]: markers.report,
          [QUARANTINE_CHILD_ENV.ready]: markers.ready,
          [QUARANTINE_CHILD_ENV.go]: markers.go,
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let text = ''
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) throw new Error('child pipes were not created')
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        text += chunk
      })
    }
    const handle: ChildHandle = { child, output: () => text }
    handles.push(handle)
    return handle
  }

  async function waitFor(
    description: string,
    ready: () => boolean,
    handle: ChildHandle,
    timeoutMs = 45_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (ready()) return
      if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
        // One more look: the child may have satisfied the condition and exited in the same tick.
        if (ready()) return
        throw new Error(`child exited before ${description}:\n${handle.output()}`)
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${description}:\n${handle.output()}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async function awaitChildReport(handle: ChildHandle): Promise<Record<string, unknown>> {
    const exitCode = await new Promise<number | null>((resolve) => {
      if (handle.child.exitCode !== null) {
        resolve(handle.child.exitCode)
        return
      }
      handle.child.on('exit', (code) => resolve(code))
    })
    expect(exitCode, handle.output()).toBe(0)
    const report = JSON.parse(readFileSync(markers.report, 'utf8')) as Record<string, unknown>
    expect(report.failed, String(report.message)).toBe(false)
    // A genuine SECOND OS process, not a worker thread: a thread would have reported this pid.
    expect(report.pid).not.toBe(process.pid)
    expect(typeof report.pid).toBe('number')
    expect(report.pid as number).toBeGreaterThan(0)
    return report
  }

  /** The composition every leg below shares, minus the one field that distinguishes the legs. */
  function operationsOptions(
    now: () => string,
  ): Omit<QuarantineOperationsOptions, 'resolveWriterAuthority'> {
    return {
      resolveKnowledgeRoot: () => root,
      now,
      // Corpus paths are already workspace-relative, so the mint is the identity.
      mintIdentityPath: (filePath) => filePath,
    }
  }

  function ledger(): ReturnType<typeof readQuarantineLedger> {
    return readQuarantineLedger(root)
  }

  it(
    'excludes a CLI-shaped writer from a daemon-shaped writer\'s cycle and loses no event',
    async () => {
      // The daemon at startup: it acquires the MRSW lease and holds it for its whole lifetime.
      const acquired = acquireWriterLease(root)
      if (acquired.kind !== 'acquired') {
        throw new Error(`expected an acquired writer lease, got ${acquired.kind}`)
      }

      const handle = spawnChild('serialized-add', {
        [QUARANTINE_CHILD_ENV.inside]: markers.inside,
        [QUARANTINE_CHILD_ENV.insideDone]: markers.insideDone,
        [QUARANTINE_CHILD_ENV.rounds]: String(OWN_IDENTITIES),
      })
      await waitFor('the child to load', () => existsSync(markers.ready), handle)

      const clock = steppingClock(0)
      let announced = false
      const operations = createQuarantineOperations({
        ...operationsOptions(() => {
          // `now()` is the FIRST statement of `readState`, which is the first statement of the
          // verb's `decide` — so this runs INSIDE the serialized section and nothing has been
          // read or written yet. That is what makes the announcement below a statement about
          // the critical region rather than about the call that precedes it.
          if (!announced) {
            announced = true
            publishMarker(markers.inside)
            blockFor(INSIDE_HOLD_MS)
          }
          return clock()
        }),
        // The daemon arm: this process already holds the lease, so the verb rides it instead of
        // being told `held` by itself. `daemon/host.ts:1875` composes exactly this.
        resolveWriterAuthority: () => ({ leaseId: acquired.leaseId, epoch: acquired.epoch }),
      })

      publishMarker(markers.go)
      const contested = await operations.add({ ...CONTESTED, owner: DAEMON_OWNER })
      for (let index = 0; index < OWN_IDENTITIES; index += 1) {
        await operations.add({ ...writerIdentity('parent', index), owner: DAEMON_OWNER })
      }
      publishMarker(markers.insideDone)
      expect(releaseLease({ knowledgeRoot: root, leaseId: acquired.leaseId }).kind).toBe('released')

      const report = await awaitChildReport(handle)

      // THE SIMULTANEITY EVIDENCE. Not "a refusal happened" — a refusal happened while the other
      // process was demonstrably inside its own read-fold-decide-append cycle.
      expect(report.heldRefusalsWhileParentInside as number).toBeGreaterThanOrEqual(1)
      expect(report.blockedMs as number).toBeGreaterThanOrEqual(MIN_OBSERVED_BLOCK_MS)

      // THE OUTCOME. One opening for the contested identity, whoever won the race for it.
      expect(contested.kind).toBe('entered')
      expect(report.contestedOutcome).toBe('renewed')

      const read = ledger()
      expect(read.refusedLines).toEqual([])
      expect(read.events).toHaveLength(OWN_IDENTITIES * 2 + 2)
      expect(
        read.events.filter(
          (event) => event.kind === 'entered' && event.testName === CONTESTED.testName,
        ),
      ).toHaveLength(1)

      // Every event either writer appended is present, by SET and not only by count.
      const expected = new Set<string>([CONTESTED.testName])
      for (let index = 0; index < OWN_IDENTITIES; index += 1) {
        expected.add(writerIdentity('parent', index).testName)
        expected.add(writerIdentity('child', index).testName)
      }
      expect(new Set(read.events.map((event) => event.testName))).toEqual(expected)

      const entries = foldQuarantineLedgerState(read.events, READ_NOW)
      expect(entries).toHaveLength(expected.size)
      const contestedEntry = entries.find((entry) => entry.testName === CONTESTED.testName)
      // The second writer renewed without naming an owner, so the first writer's claim stands.
      // A lost read-fold-decide cycle would have overwritten it with a second opening.
      expect(contestedEntry?.owner).toBe(DAEMON_OWNER)
      expect(contestedEntry?.state).toBe('quarantined')
    },
    120_000,
  )

  it(
    'CONTROL: the same cycle without the lease loses an update the harness can see',
    async () => {
      const handle = spawnChild('unserialized-cycle', {
        [QUARANTINE_CHILD_ENV.folded]: markers.folded,
        [QUARANTINE_CHILD_ENV.resume]: markers.resume,
      })
      await waitFor('the child to load', () => existsSync(markers.ready), handle)

      // The daemon composition with a REAL standing lease, which is what production actually is:
      // acquire once, hold, hand the acquired pair in. What makes this the CONTROL for leg 1 is
      // not the parent's authority — it is that the child runs a lease-less replica of the cycle
      // with a barrier forced open between its fold and its append, so the two writers overlap
      // inside the critical region no matter what the parent holds.
      const acquired = acquireWriterLease(root)
      if (acquired.kind !== 'acquired') {
        throw new Error(`expected an acquired writer lease, got ${acquired.kind}`)
      }
      const operations = createQuarantineOperations({
        ...operationsOptions(steppingClock(0)),
        resolveWriterAuthority: () => ({ leaseId: acquired.leaseId, epoch: acquired.epoch }),
      })

      publishMarker(markers.go)
      await waitFor('the child to fold and decide', () => existsSync(markers.folded), handle)
      expect(JSON.parse(readFileSync(markers.folded, 'utf8'))).toEqual({
        decision: 'entered',
        observedState: 'absent',
      })

      const daemonAnswer = await operations.add({ ...CONTESTED, owner: DAEMON_OWNER })
      const parentAppendedAtMs = Date.now()
      publishMarker(markers.resume)

      const report = await awaitChildReport(handle)
      expect(releaseLease({ knowledgeRoot: root, leaseId: acquired.leaseId }).kind).toBe('released')

      // THE INTERLEAVING, MEASURED: the child folded, this process appended, the child appended.
      expect(report.foldedAtMs as number).toBeLessThanOrEqual(parentAppendedAtMs)
      expect(parentAppendedAtMs).toBeLessThanOrEqual(report.appendedAtMs as number)

      // THE LOSS. Two openings for one identity — the double-open `operations.ts` names as the
      // race serializing only the append would leave intact.
      const read = ledger()
      expect(read.refusedLines).toEqual([])
      expect(read.events.map((event) => event.kind)).toEqual(['entered', 'entered'])

      const entries = foldQuarantineLedgerState(read.events, READ_NOW)
      expect(entries).toHaveLength(1)
      // This process was ANSWERED `entered` naming its own owner, and committed truth records the
      // other writer's. The verb's answer is a lie about the file it just wrote.
      expect(daemonAnswer.kind).toBe('entered')
      expect(daemonAnswer.kind === 'entered' ? daemonAnswer.entry.owner : undefined)
        .toBe(DAEMON_OWNER)
      expect(entries[0].owner).toBe(CLI_OWNER)
    },
    120_000,
  )

  it(
    'CONTROL: a pre-release fold appending after a human release cannot undo it',
    async () => {
      // Same daemon composition as leg 2, and for the same reason: a real acquisition, held
      // across both verbs. The byte sequence this leg forces onto disk comes from the CHILD's
      // lease-less fold, not from the parent's authority being unverifiable.
      const acquired = acquireWriterLease(root)
      if (acquired.kind !== 'acquired') {
        throw new Error(`expected an acquired writer lease, got ${acquired.kind}`)
      }
      const operations = createQuarantineOperations({
        ...operationsOptions(steppingClock(0)),
        resolveWriterAuthority: () => ({ leaseId: acquired.leaseId, epoch: acquired.epoch }),
      })
      expect((await operations.add({ ...CONTESTED, owner: DAEMON_OWNER })).kind).toBe('entered')

      const handle = spawnChild('unserialized-cycle', {
        [QUARANTINE_CHILD_ENV.folded]: markers.folded,
        [QUARANTINE_CHILD_ENV.resume]: markers.resume,
      })
      await waitFor('the child to load', () => existsSync(markers.ready), handle)
      publishMarker(markers.go)
      await waitFor('the child to fold pre-release state', () => existsSync(markers.folded), handle)

      // FINDING 1, and it is structural rather than lucky: a fold that sees pre-release state sees
      // an OPEN window, and `operations.add` routes an open window to `renewed`. The `entered`
      // branch the truth worries about is only reachable from an absent or already-released fold —
      // which is to say, never from pre-release state.
      expect(JSON.parse(readFileSync(markers.folded, 'utf8'))).toEqual({
        decision: 'renewed',
        observedState: 'quarantined',
      })

      expect((await operations.release({ ...CONTESTED })).kind).toBe('released')
      publishMarker(markers.resume)
      await awaitChildReport(handle)
      expect(releaseLease({ knowledgeRoot: root, leaseId: acquired.leaseId }).kind).toBe('released')

      // The harness really did force the dangerous byte order onto disk.
      const read = ledger()
      expect(read.refusedLines).toEqual([])
      expect(read.events.map((event) => event.kind))
        .toEqual(['entered', 'released-manual', 'renewed'])

      // FINDING 2: the release STANDS, on the read side, independently of any lock.
      const entries = foldQuarantineLedgerState(read.events, READ_NOW)
      expect(entries).toHaveLength(1)
      expect(entries[0].state).toBe('released')

      // Without the release guard these bytes undo the release: a real lost-update input.
      expect(foldWithoutReleaseGuard(read.events)).toBe('quarantined')
    },
    120_000,
  )

  it(
    'never tears a line when both processes append with no serialization at all',
    async () => {
      const handle = spawnChild('append-burst', {
        [QUARANTINE_CHILD_ENV.rounds]: String(ALTERNATION_ROUNDS),
        [QUARANTINE_CHILD_ENV.burst]: String(BURST_LINES),
        [QUARANTINE_CHILD_ENV.resume]: markers.resume,
      })
      await waitFor('the child to load', () => existsSync(markers.ready), handle)
      publishMarker(markers.go)

      function committedNames(): string[] {
        return readQuarantineLedger(root).events.map((event) => event.testName)
      }

      // PHASE 1 — strict alternation. Neither side writes round i+1 until it has SEEN the other's
      // round i, so the committed order is interleaved by construction, not by scheduling luck.
      for (let index = 0; index < ALTERNATION_ROUNDS; index += 1) {
        appendQuarantineEvents(root, [burstEvent('parent', index)])
        await waitFor(
          `the child's alternation line ${String(index)}`,
          () => committedNames().includes(`child-burst-${String(index)}`),
          handle,
        )
      }

      // PHASE 2 — free burst, which is where simultaneity actually lives. The parent stops
      // half way and waits to SEE a free-phase line from the child before writing the rest, so
      // "these two bursts overlapped" is a fact about the file rather than about the clock.
      publishMarker(markers.resume)
      const half = ALTERNATION_ROUNDS + BURST_LINES / 2
      for (let index = ALTERNATION_ROUNDS; index < half; index += 1) {
        appendQuarantineEvents(root, [burstEvent('parent', index)])
      }
      await waitFor(
        'a free-burst line from the child',
        () => committedNames().includes(`child-burst-${String(ALTERNATION_ROUNDS)}`),
        handle,
      )
      for (let index = half; index < ALTERNATION_ROUNDS + BURST_LINES; index += 1) {
        appendQuarantineEvents(root, [burstEvent('parent', index)])
      }

      await awaitChildReport(handle)

      // NO TEAR: every non-blank line parsed AND passed the read's own shape guard. `refusedLines`
      // is the ledger's line-level damage report, so an empty one over 132 lines written by two
      // unsynchronized processes is the measurement, not an absence of measurement.
      const read = ledger()
      expect(read.refusedLines).toEqual([])
      expect(read.events).toHaveLength((ALTERNATION_ROUNDS + BURST_LINES) * 2)

      // NO LOSS: the exact set both writers authored, and nothing else.
      const expected = new Set<string>()
      for (let index = 0; index < ALTERNATION_ROUNDS + BURST_LINES; index += 1) {
        expected.add(`parent-burst-${String(index)}`)
        expected.add(`child-burst-${String(index)}`)
      }
      expect(new Set(read.events.map((event) => event.testName))).toEqual(expected)

      // The raw bytes agree with the parse: one trailing newline, no blank line a torn write
      // would have left behind, and exactly one line per event.
      const raw = readFileSync(join(root, QUARANTINE_LEDGER_FILENAME), 'utf8')
      expect(raw.endsWith('\n')).toBe(true)
      expect(raw.slice(0, -1).split('\n').filter((line) => line.trim().length === 0)).toEqual([])
      expect(raw.slice(0, -1).split('\n')).toHaveLength(read.events.length)

      // The alternation phase's order is a fact about two processes taking turns.
      const names = read.events.map((event) => event.testName)
      const alternating: string[] = []
      for (let index = 0; index < ALTERNATION_ROUNDS; index += 1) {
        alternating.push(`parent-burst-${String(index)}`, `child-burst-${String(index)}`)
      }
      expect(names.slice(0, ALTERNATION_ROUNDS * 2)).toEqual(alternating)

      // And the free phase's overlap is a fact about the file: a child line sits before the last
      // parent line, which the mid-burst handshake above guarantees.
      const firstFreeChild = names.indexOf(`child-burst-${String(ALTERNATION_ROUNDS)}`)
      const lastParent = names.lastIndexOf(
        `parent-burst-${String(ALTERNATION_ROUNDS + BURST_LINES - 1)}`,
      )
      expect(firstFreeChild).toBeGreaterThan(-1)
      expect(firstFreeChild).toBeLessThan(lastParent)
    },
    120_000,
  )
})
