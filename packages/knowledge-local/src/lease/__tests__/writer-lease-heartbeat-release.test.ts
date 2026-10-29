import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { threadId, Worker } from 'node:worker_threads'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LEASE_FILE,
  LEASE_GUARD_DIR,
  LEASE_GUARD_STALE_MS,
  LEASE_GUARD_WAIT_MS,
  acquireWriterLease,
  heartbeatLease,
  readWriterLease,
  releaseLease,
} from '../writer-lease.js'
import { RESOLVE_TS_SOURCE_HOOK } from './source-import-hook.js'

/**
 * a heartbeat must never resurrect a released lease.
 *
 * Phase 432 deferred items 432-19 #7 (with 432-13 #6, 432-14 #7, 432-17 #4): the beat read the
 * lease and then rewrote it without any exclusion against `releaseLease`, so a beat that read
 * before a release wrote after it. The released lease came back under the SAME id with a fresh
 * stamp and the current epoch, and the next acquire answered `held`.
 *
 * The interleaving is driven through the seam the 386-42 clobber cells already use: the beat's
 * only `Date.now()` is the stamp it takes between its last check and its only write. The release
 * runs on a REAL second thread loaded from this same source file, so the two sides contend the way
 * the daemon's heartbeat worker and its main thread do.
 */
const SOURCE_URL = new URL('../writer-lease.ts', import.meta.url).href

const GO = 0
const CONTENDED = 1
const RETURNED = 2
const SIGNAL_SLOTS = 3
const WINDOW_WAIT_MS = 15_000

const RELEASE_WORKER_SOURCE = String.raw`
'use strict'
${RESOLVE_TS_SOURCE_HOOK}
const { parentPort, workerData } = require('node:worker_threads')
const { url, knowledgeRoot, leaseId, signals } = workerData
const flags = new Int32Array(signals)
import(url).then((lease) => {
  parentPort.postMessage({ kind: 'ready' })
  Atomics.wait(flags, ${GO}, 0)
  let outcome
  try {
    outcome = lease.releaseLease({ knowledgeRoot, leaseId }, {
      onLeaseGuardContended: () => {
        Atomics.store(flags, ${CONTENDED}, 1)
        Atomics.notify(flags, ${CONTENDED})
      },
    })
  } catch (error) {
    outcome = { kind: 'threw', name: error && error.name, message: error && error.message }
  }
  Atomics.store(flags, ${RETURNED}, 1)
  Atomics.notify(flags, ${RETURNED})
  parentPort.postMessage({ kind: 'released', outcome })
}, (error) => {
  parentPort.postMessage({ kind: 'load-failed', message: String(error && error.message) })
})
`

interface ReleaseWorker {
  readonly flags: Int32Array
  readonly released: Promise<unknown>
  terminate(): Promise<number>
}

async function startReleaseWorker(knowledgeRoot: string, leaseId: string): Promise<ReleaseWorker> {
  const signals = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * SIGNAL_SLOTS)
  const worker = new Worker(RELEASE_WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { url: SOURCE_URL, knowledgeRoot, leaseId, signals },
  })
  let resolveReleased: (value: unknown) => void = () => undefined
  const released = new Promise<unknown>((resolve) => {
    resolveReleased = resolve
  })
  await new Promise<void>((resolve, reject) => {
    worker.on('message', (message: { kind: string; outcome?: unknown; message?: string }) => {
      if (message.kind === 'ready') resolve()
      else if (message.kind === 'released') resolveReleased(message.outcome)
      else reject(new Error(`release worker failed to load the lease module: ${message.message}`))
    })
    worker.on('error', reject)
  })
  return { flags: new Int32Array(signals), released, terminate: () => worker.terminate() }
}

/** Block this thread until the release has either landed or been seen waiting on the beat. */
function waitForReleaseToLandOrContend(flags: Int32Array): void {
  const deadline = process.hrtime.bigint() + BigInt(WINDOW_WAIT_MS) * 1_000_000n
  while (Atomics.load(flags, CONTENDED) === 0 && Atomics.load(flags, RETURNED) === 0) {
    if (process.hrtime.bigint() >= deadline) return
    Atomics.wait(flags, RETURNED, 0, 5)
  }
}

describe('a release cannot land inside a heartbeat', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-beat-release-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('waits a concurrent release out of the beat window: nothing resurrects, the next acquire is not held', async () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    const releaser = await startReleaseWorker(knowledgeRoot, acquired.leaseId)

    try {
      const realNow = Date.now.bind(Date)
      let windowEntered = false
      vi.spyOn(Date, 'now').mockImplementation(() => {
        if (!windowEntered) {
          windowEntered = true
          Atomics.store(releaser.flags, GO, 1)
          Atomics.notify(releaser.flags, GO)
          waitForReleaseToLandOrContend(releaser.flags)
        }
        return realNow()
      })

      const beat = heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })
      vi.restoreAllMocks()
      const released = await releaser.released

      expect(windowEntered).toBe(true)
      expect(beat).toMatchObject({ kind: 'heartbeated' })
      expect(released).toEqual({ kind: 'released' })

      // THE TRUTHS: once the release has returned, the lease is gone and stays gone.
      const afterRelease = readWriterLease(knowledgeRoot)
      const nextAcquire = acquireWriterLease(knowledgeRoot)
      expect({ afterRelease, nextAcquire }).toMatchObject({
        afterRelease: { kind: 'absent' },
        nextAcquire: { kind: 'acquired' },
      })

      // And the order is the guarded one: the release met the in-flight beat and waited for it.
      expect(Atomics.load(releaser.flags, CONTENDED)).toBe(1)
    } finally {
      await releaser.terminate()
    }
  }, 30_000)

  it('refuses a release attempted from inside the beat window on the same thread, without waiting', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')

    const realNow = Date.now.bind(Date)
    let inWindow: unknown
    let inWindowElapsedMs = Number.POSITIVE_INFINITY
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (inWindow === undefined) {
        const startedAtNs = process.hrtime.bigint()
        try {
          inWindow = releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })
        } catch (error) {
          inWindow = { kind: 'threw', name: (error as Error).name }
        }
        inWindowElapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6
      }
      return realNow()
    })

    const beat = heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })
    vi.restoreAllMocks()

    // A release nested inside the beat's own guarded window can never be let in by waiting, so it
    // fails fast by name instead of landing between the beat's read and its write.
    expect(inWindow).toEqual({ kind: 'threw', name: 'LeaseGuardBusyError' })
    expect(inWindowElapsedMs).toBeLessThan(1_000)
    expect(beat).toMatchObject({ kind: 'heartbeated' })

    expect(releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })).toEqual({
      kind: 'released',
    })
    expect(readWriterLease(knowledgeRoot)).toEqual({ kind: 'absent' })
    expect(acquireWriterLease(knowledgeRoot)).toMatchObject({ kind: 'acquired' })
  })
})

describe('the lease-file guard itself', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-lease-guard-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function guardDir(): string {
    return join(knowledgeRoot, LEASE_GUARD_DIR)
  }

  function plantGuard(owner: { pid: number; threadId: number; claimedAtNs: bigint }): void {
    const token = randomUUID()
    mkdirSync(guardDir(), { recursive: true })
    writeFileSync(join(guardDir(), `owner-${token}`), `${JSON.stringify({
      pid: owner.pid,
      threadId: owner.threadId,
      token,
      claimedAtNs: String(owner.claimedAtNs),
    })}\n`, 'utf8')
  }

  /** The guard and its staging siblings, wherever the parent directory stands. */
  function guardEntries(): string[] {
    const parent = dirname(guardDir())
    if (!existsSync(parent)) return []
    return readdirSync(parent).filter((entry) => entry.startsWith(basename(guardDir())))
  }

  function deadPid(): number {
    const exited = spawnSync(process.execPath, ['-e', ''])
    if (exited.pid === undefined) throw new Error('expected a spawned pid')
    return exited.pid
  }

  it('leaves nothing behind after a beat and a release', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')

    expect(heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })).toMatchObject({
      kind: 'heartbeated',
    })
    expect(guardEntries()).toEqual([])
    expect(releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })).toEqual({
      kind: 'released',
    })
    expect(guardEntries()).toEqual([])
    // The guard's parent directories were created for it and removed with it.
    expect(existsSync(join(knowledgeRoot, 'memory'))).toBe(false)
  })

  it('answers an absent lease before staging any guard', () => {
    expect(heartbeatLease({
      knowledgeRoot,
      leaseId: '00000000-0000-4000-8000-000000000000',
    })).toEqual({ kind: 'refused', reason: 'lease-missing' })
  })

  it.each([
    [
      'a dead process',
      () => ({ pid: deadPid(), threadId: 0, claimedAtNs: process.hrtime.bigint() }),
    ],
    [
      'a live process past the age bound',
      () => ({
        pid: process.pid,
        threadId: threadId + 1_000,
        claimedAtNs: process.hrtime.bigint() - BigInt(LEASE_GUARD_STALE_MS + 1_000) * 1_000_000n,
      }),
    ],
    [
      'a claim stamped ahead of this clock (a previous boot)',
      () => ({
        pid: process.pid,
        threadId: threadId + 1_000,
        claimedAtNs: process.hrtime.bigint() + 3_600_000_000_000n,
      }),
    ],
  ])('reclaims a guard left by %s and beats', (_label, owner) => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    plantGuard(owner())

    expect(heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })).toMatchObject({
      kind: 'heartbeated',
    })
    expect(guardEntries()).toEqual([])
  })

  it.each([
    ['owner bytes nobody can attribute', () => {
      mkdirSync(guardDir(), { recursive: true })
      writeFileSync(join(guardDir(), `owner-${randomUUID()}`), 'not a guard\n', 'utf8')
    }],
    ['a plain file where the guard directory belongs', () => {
      mkdirSync(dirname(guardDir()), { recursive: true })
      writeFileSync(guardDir(), 'not a guard\n', 'utf8')
    }],
  ])('reclaims %s and releases', (_label, plant) => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    plant()

    expect(releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })).toEqual({
      kind: 'released',
    })
    expect(guardEntries()).toEqual([])
  })

  /**
   * 2026-10-03 (quick 261003-lgd, Phase 432 review CR-01 and WR-11): two cells here re-spelled.
   *
   * 'reclaims a guard directory with no owner in it and releases' asserted that the stray was
   * unlinked; that bulk unlink is CR-01's deletion through a planted link. An ownerless directory
   * is now moved aside whole (writer-lease-guard-containment.test.ts, cell d), and the release
   * still lands. 'waits a live foreign section out for the busy window only' pinned WR-11: a
   * guard with this process's pid and another thread's id, claimed just now, made the waiter
   * throw before the residue bound could ever be reached. The waiter now outlasts the bound and
   * reclaims (cell e there). What still refuses by name is a guard held by LIVE sections for the
   * whole wait, which this cell now drives: each residue is reclaimed, a fresh live section takes
   * the guard at that moment, and the waiter gives up after LEASE_GUARD_WAIT_MS, touching none.
   */
  it('moves an ownerless guard directory aside whole, keeping its entries, and releases', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    mkdirSync(guardDir(), { recursive: true })
    writeFileSync(join(guardDir(), 'stray'), 'not a guard\n', 'utf8')

    expect(releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })).toEqual({
      kind: 'released',
    })
    const entries = guardEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^lease-guard\.residue-/)
    expect(readFileSync(join(dirname(guardDir()), entries[0]!, 'stray'), 'utf8'))
      .toBe('not a guard\n')
  })

  it('waits out a guard held by live sections for the whole wait, then refuses by name and writes nothing', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    // A residue one second from the bound, so the cell does not spend the whole bound on it.
    plantGuard({
      pid: process.pid,
      threadId: threadId + 1_000,
      claimedAtNs: process.hrtime.bigint() - BigInt(LEASE_GUARD_STALE_MS - 1_000) * 1_000_000n,
    })
    const leaseBefore = readFileSync(join(knowledgeRoot, LEASE_FILE))
    let contentions = 0
    let reclaims = 0

    const startedAtNs = process.hrtime.bigint()
    const beat = (() => {
      try {
        return heartbeatLease(
          { knowledgeRoot, leaseId: acquired.leaseId },
          {
            onLeaseGuardContended: () => { contentions += 1 },
            // As each residue is reclaimed, a fresh live section takes the guard.
            beforeLeaseGuardReclaim: () => {
              reclaims += 1
              plantGuard({
                pid: process.pid,
                threadId: threadId + 1_000 + reclaims,
                claimedAtNs: process.hrtime.bigint(),
              })
            },
          },
        )
      } catch (error) {
        return { kind: 'threw', name: (error as Error).name }
      }
    })()
    const waitedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6

    expect(beat).toEqual({ kind: 'threw', name: 'LeaseGuardBusyError' })
    expect(contentions).toBe(1)
    expect(reclaims).toBeGreaterThanOrEqual(1)
    expect(waitedMs).toBeGreaterThanOrEqual(LEASE_GUARD_WAIT_MS)
    expect(waitedMs).toBeLessThan(LEASE_GUARD_WAIT_MS + LEASE_GUARD_STALE_MS)
    expect(readFileSync(join(knowledgeRoot, LEASE_FILE))).toEqual(leaseBefore)
    // The live section's guard is not the beat's to remove.
    expect(guardEntries()).toEqual([basename(guardDir())])
    expect(readdirSync(guardDir())).toHaveLength(1)
  }, 40_000)
})

/**
 * 2026-10-02 (quick 261002-lse follow-up): reclaiming a stale guard is a compare-and-swap.
 *
 * Two reclaimers can judge the SAME stale guard residue. The first reclaims it and holds a fresh,
 * live guard; the second must then reclaim nothing. It used to move whatever sat at the guard path
 * aside and put it back, so for that window the live holder's guard was gone: a third claimant got
 * in beside the live holder, and the holder's own release, missing its guard, left it orphaned.
 *
 * The stale guard is left by a real process SIGKILLed inside its section, so the cell does not
 * depend on how a guard is laid out on disk.
 */
const HOLDER_GO = 0
const HOLDER_IN_SECTION = 1
const HOLDER_PROCEED = 2

const HOLDER_WORKER_SOURCE = String.raw`
'use strict'
${RESOLVE_TS_SOURCE_HOOK}
const { parentPort, workerData } = require('node:worker_threads')
const { url, knowledgeRoot, leaseId, signals } = workerData
const flags = new Int32Array(signals)
import(url).then((lease) => {
  parentPort.postMessage({ kind: 'ready' })
  Atomics.wait(flags, ${HOLDER_GO}, 0)
  const realNow = Date.now
  let first = true
  Date.now = () => {
    if (first) {
      first = false
      Atomics.store(flags, ${HOLDER_IN_SECTION}, 1)
      Atomics.notify(flags, ${HOLDER_IN_SECTION})
      Atomics.wait(flags, ${HOLDER_PROCEED}, 0, 15000)
    }
    return realNow()
  }
  let outcome
  try {
    outcome = lease.heartbeatLease({ knowledgeRoot, leaseId })
  } catch (error) {
    outcome = { kind: 'threw', name: error && error.name }
  }
  Date.now = realNow
  parentPort.postMessage({ kind: 'done', outcome })
}, (error) => {
  parentPort.postMessage({ kind: 'load-failed', message: String(error && error.message) })
})
`

describe('two reclaimers of one stale guard', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-writer-guard-reclaim-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** Every path under the knowledge root that names a guard, whatever its layout. */
  function guardLeftovers(): string[] {
    const found: string[] = []
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relativePath = `${prefix}${entry.name}`
        if (/guard/.test(entry.name)) found.push(relativePath)
        if (entry.isDirectory()) walk(join(dir, entry.name), `${relativePath}/`)
      }
    }
    walk(knowledgeRoot, '')
    return found.sort()
  }

  /** A real process that dies by SIGKILL inside its beat's guarded section. */
  function leaveDeadGuard(leaseId: string): void {
    const died = spawnSync(process.execPath, ['--input-type=module', '-e', [
      RESOLVE_TS_SOURCE_HOOK,
      'const lease = await import(process.env.LEASE_SOURCE_URL)',
      "Date.now = () => { process.kill(process.pid, 'SIGKILL'); return 0 }",
      'const { LEASE_ROOT: knowledgeRoot, LEASE_ID: leaseId } = process.env',
      'lease.heartbeatLease({ knowledgeRoot, leaseId })',
    ].join('\n')], {
      env: {
        ...process.env,
        LEASE_SOURCE_URL: SOURCE_URL,
        LEASE_ROOT: knowledgeRoot,
        LEASE_ID: leaseId,
      },
      encoding: 'utf8',
    })
    if (died.signal !== 'SIGKILL') {
      throw new Error(`fixture process did not die in its section: ${died.stderr}`)
    }
  }

  async function startHolder(leaseId: string) {
    const signals = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3)
    const worker = new Worker(HOLDER_WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: { url: SOURCE_URL, knowledgeRoot, leaseId, signals },
    })
    let resolveDone: (value: unknown) => void = () => undefined
    const done = new Promise<unknown>((resolve) => {
      resolveDone = resolve
    })
    await new Promise<void>((resolve, reject) => {
      worker.on('message', (message: { kind: string; outcome?: unknown; message?: string }) => {
        if (message.kind === 'ready') resolve()
        else if (message.kind === 'done') resolveDone(message.outcome)
        else reject(new Error(`holder worker failed to load the lease module: ${message.message}`))
      })
      worker.on('error', reject)
    })
    return { flags: new Int32Array(signals), done, terminate: () => worker.terminate() }
  }

  it('admits no second holder and orphans nothing when the same stale guard is reclaimed twice', async () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    leaveDeadGuard(acquired.leaseId)
    expect(guardLeftovers(), 'the killed process left its guard behind').not.toEqual([])
    const holder = await startHolder(acquired.leaseId)
    const proceed = (): void => {
      Atomics.store(holder.flags, HOLDER_PROCEED, 1)
      Atomics.notify(holder.flags, HOLDER_PROCEED)
    }

    try {
      let reclaims = 0
      let third: unknown
      let thirdMetLiveHolder = false
      const attempt = (run: () => unknown): unknown => {
        try {
          return run()
        } catch (error) {
          return { kind: 'threw', name: (error as Error).name }
        }
      }
      const second = attempt(() => heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId }, {
        // This reclaimer has judged the dead guard residue. Before it acts, the holder judges
        // the same guard, reclaims it and stops inside its own live section.
        beforeLeaseGuardReclaim: () => {
          reclaims += 1
          if (reclaims !== 1) return
          Atomics.store(holder.flags, HOLDER_GO, 1)
          Atomics.notify(holder.flags, HOLDER_GO)
          const deadline = process.hrtime.bigint() + 15_000_000_000n
          while (Atomics.load(holder.flags, HOLDER_IN_SECTION) === 0) {
            if (process.hrtime.bigint() >= deadline) break
            Atomics.wait(holder.flags, HOLDER_IN_SECTION, 0, 5)
          }
        },
        // Mid-reclaim, a third claimant arrives while the holder is still inside its section. It
        // must meet the holder's guard; only then is the holder let go, and the third waits it out.
        duringLeaseGuardReclaim: () => {
          if (third !== undefined) return
          third = attempt(() => heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId }, {
            onLeaseGuardContended: () => {
              thirdMetLiveHolder = Atomics.load(holder.flags, HOLDER_PROCEED) === 0
              proceed()
            },
          }))
          proceed()
        },
        onLeaseGuardContended: proceed,
      }))
      const held = await holder.done

      expect(Atomics.load(holder.flags, HOLDER_IN_SECTION)).toBe(1)
      expect({ held, thirdMetLiveHolder, third, second }).toMatchObject({
        held: { kind: 'heartbeated' },
        // The holder's live guard was never moved, so the third claimant met it and waited.
        thirdMetLiveHolder: true,
        third: { kind: 'heartbeated' },
        // And the second reclaimer got the guard after both, normally.
        second: { kind: 'heartbeated' },
      })
      expect(guardLeftovers()).toEqual([])
    } finally {
      proceed()
      await holder.terminate()
    }
  }, 30_000)
})
