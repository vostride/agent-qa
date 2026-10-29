// SC4's crash half: a real daemon SIGKILLed between the two chain stages (Phase 388 plan 06).
//
// Everything load-bearing here is a real operating-system fact rather than a simulation of one.
// A real daemon process holds the real writer lease and serves the real agent-job dispatcher; a
// real CLI-side `runPostRunTail` in THIS process durably enqueues `analyze-run` and is told
// `handed-off` by the real `acquireWriterLease`; the daemon really claims that job, really commits
// `completeAndChain`, and is really SIGKILLed while parked inside `curate-memory`'s handler. Only
// then are the durable rows read, and read from a cold composition over the same database.
//
// The kill's POSITION is the part a sleep could not have given us: the daemon-side curation fold
// publishes a marker the instant it is entered and then parks, so by the time the signal goes out
// `analyze-run`'s completion and its successor's insertion have committed in one transaction and
// `curate-memory` is claimed by a process about to stop existing. That is precisely the window
// SC4 names.
//
// What is NOT real, and why: the daemon-side fold's BODY. The shipped closure needs an author
// factory and a guardrail policy — real provider credentials — and plan 04's in-process proof
// substitutes the same one callable for the same reason. Its production wiring is pinned
// structurally at the bottom of this file instead, where it can be stated exactly.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chainJobIdsForRun } from '@vostride/agent-qa-agent'
import { DIGEST_JOB_ID_SOURCE, LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import {
  isLeaseStale,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
} from '@vostride/agent-qa-knowledge-local'
import type { RunNotification } from '@vostride/agent-qa-schema'
import { afterAll, afterEach, describe, expect, test } from 'vitest'

import { FIXTURE_CURATION_COUNTS } from './post-run-daemon/daemon.fixture.js'
import {
  readCheckpointFiles,
  readJobRows,
  readNotifications,
  runRealTail,
  writeProjectFixture,
} from './post-run-daemon/project.js'
import {
  cleanupPostRunDaemonRoots,
  killIfRunning,
  LEG_TIMEOUT_MS,
  makePostRunDaemonRoot,
  pidIsAlive,
  sendRealSigkill,
  startPostRunDaemon,
  stopAllPostRunDaemons,
  waitForMarker,
  waitUntil,
} from './post-run-daemon/spawn-helpers.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const RUN_ID = 'run-388-06-crash'

const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined)
  await stopAllPostRunDaemons()
})

afterAll(cleanupPostRunDaemonRoots)

interface PlantedLease {
  readonly leaseId: string
  readonly pid: number
  readonly epoch: number
  readonly heartbeatAtMs: number
}

function readLease(knowledgeRoot: string): PlantedLease {
  return JSON.parse(readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8')) as PlantedLease
}

describePosix('a daemon killed mid-chain loses nothing (concurrency edge)', () => {
  test(
    'leaves curate-memory claimed-not-lost, refuses a PID-blind takeover, and completes on '
    + 'restart with exactly one notification',
    async () => {
      const paths = makePostRunDaemonRoot('chain')
      const project = writeProjectFixture(paths.agentQaRoot, RUN_ID)

      // ---- the first generation: lease held, chain served, killed mid-flight ------------------
      const first = startPostRunDaemon('first', paths)
      const ready = await waitForMarker(first, paths.readyMarker.first, 'the first daemon')
      const daemonPid = first.child.pid!
      expect(ready).toMatchObject({ ready: true, pid: daemonPid })

      // The REAL tail, from a process that is not the daemon. The lease is really held, so this
      // is really the hand-off posture — no operation on that path is doubled.
      const tail = await runRealTail({
        agentQaRoot: paths.agentQaRoot,
        knowledgeRoot: paths.knowledgeRoot,
        runId: RUN_ID,
        hosts,
      })
      expect(tail.report).toMatchObject({ enqueue: 'enqueued', drain: 'handed-off' })

      const entered = await waitForMarker(
        first,
        paths.enteredMarker.first,
        'the daemon-side curation fold to be entered',
      )
      expect(entered).toMatchObject({ runId: RUN_ID, pid: daemonPid })

      // Every checkpoint the chain has fsync'd so far, read off disk BEFORE the crash.
      const checkpointsBeforeKill = readCheckpointFiles(paths.agentQaRoot)
      expect(Object.keys(checkpointsBeforeKill).length).toBeGreaterThan(0)

      await sendRealSigkill(first.child)
      expect(pidIsAlive(daemonPid)).toBe(false)

      // ---- what a dead host left behind -------------------------------------------------------
      const afterKill = await readJobRows(paths.agentQaRoot, paths.knowledgeRoot)
      const analyzeAfterKill = afterKill.find((row) => row.kind === 'analyze-run')
      const curateAfterKill = afterKill.find((row) => row.kind === 'curate-memory')

      // The successor EXISTS because it was inserted in the predecessor's own completion
      // transaction. Nothing was lost: one stage is durably terminal, the other is durably
      // claimed by a process that no longer exists.
      expect(analyzeAfterKill).toMatchObject({ status: 'done', claimed: false, attempts: 1 })
      expect(curateAfterKill).toMatchObject({ status: 'queued', claimed: true, attempts: 1 })
      expect(afterKill.map((row) => row.kind).sort()).toEqual(['analyze-run', 'curate-memory'])
      // The chain never reached a terminal, so nothing may claim it did.
      expect(await readNotifications(paths.agentQaRoot, paths.knowledgeRoot)).toEqual([])

      // ---- presence is decided by the lease, never by PID --------------------------------------
      const lease = readLease(paths.knowledgeRoot)
      expect(lease.pid).toBe(daemonPid)
      expect(isLeaseStale(lease, Date.now())).toBe(false)
      // The SHIPPED acquisition, called exactly as `runDaemonHost` calls it (host.ts:636). The
      // holder's process is provably gone — and the answer is still `held`, naming that dead pid.
      // A rule that consulted process liveness would hand the authority over on the spot.
      const contended = LOCAL_DAEMON_CAPABILITIES.acquireWriterLease(paths.knowledgeRoot)
      expect(contended.kind).toBe('held')
      expect(contended.kind === 'held' ? contended.holder.pid : undefined).toBe(daemonPid)
      expect(pidIsAlive(daemonPid)).toBe(false)

      // ---- the restart --------------------------------------------------------------------------
      // Wait out the lease's own TTL. Nothing is doctored: the successor becomes eligible for the
      // reason production says it does, which is that the beat stopped.
      const waitMs = Math.max(0, lease.heartbeatAtMs + LEASE_HEARTBEAT_TTL_MS + 1_500 - Date.now())
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      expect(isLeaseStale(readLease(paths.knowledgeRoot), Date.now())).toBe(true)

      // Open the gate before the restart, so the resumed fold returns instead of parking again.
      writeFileSync(paths.gate, 'open\n', 'utf8')
      const restarted = startPostRunDaemon('restarted', paths)
      await waitForMarker(restarted, paths.readyMarker.restarted, 'the restarted daemon')

      // Two waits, not one, and the split is the point: a chain that never RESUMED and a chain
      // that resumed and wrote no notification are different failures, and a single wait on the
      // notification row would report them with the same message.
      await waitForMarker(
        restarted,
        paths.enteredMarker.restarted,
        'the restarted daemon to re-claim the abandoned curate-memory row',
      )
      let notifications = await readNotifications(paths.agentQaRoot, paths.knowledgeRoot)
      await waitUntil(
        async () => {
          notifications = await readNotifications(paths.agentQaRoot, paths.knowledgeRoot)
          return notifications.length > 0
        },
        `the resumed chain reached its terminal without notifying:\n${restarted.output()}`,
      )

      // Exactly ONE notification for the run, carrying the resumed stage's own counts.
      expect(notifications).toHaveLength(1)
      expect(notifications[0]!.runId).toBe(RUN_ID)
      const notification = notifications[0]!.payload as RunNotification
      expect(notification).toMatchObject({
        runId: RUN_ID,
        outcome: 'done',
        stages: {
          analysis: { status: 'done' },
          curation: {
            status: 'done',
            curated: FIXTURE_CURATION_COUNTS.curated,
            deprecated: FIXTURE_CURATION_COUNTS.deprecated,
          },
        },
      })

      // Checkpoint replay stability, split the way the 385 matrix splits it — outcome asserted
      // byte-for-byte, history asserted with an exact value rather than dropped.
      //
      // The stage that COMPLETED before the crash owns the outcome half: `analyze-run`'s
      // verdicts-authored artifact is the analysis this phase exists to produce, and a chain
      // resumed from a crash must not re-author it. The stage that was INTERRUPTED owns the
      // history half: its checkpoint is legitimately re-authored, and the attempt stamped into it
      // is the record of that — a comparison that demanded byte-identity there would be demanding
      // the resumed attempt lie about which attempt it was.
      const checkpointsAfterRestart = readCheckpointFiles(paths.agentQaRoot)
      const analyzeJobId = String(chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE).analyzeRun)
      const curateJobId = String(chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE).curateMemory)
      const analyzeCheckpoints = Object.entries(checkpointsBeforeKill)
        .filter(([path]) => path.startsWith(`${analyzeJobId}/`))
      expect(analyzeCheckpoints.length).toBeGreaterThan(0)
      for (const [path, bytes] of analyzeCheckpoints) {
        expect(checkpointsAfterRestart[path], `checkpoint ${path} changed across the crash`)
          .toBe(bytes)
      }
      const curateCheckpoints = Object.entries(checkpointsAfterRestart)
        .filter(([path]) => path.startsWith(`${curateJobId}/`))
      expect(curateCheckpoints.length).toBeGreaterThan(0)
      for (const [path, bytes] of curateCheckpoints) {
        expect(
          (JSON.parse(bytes) as { payload: { attempt: number } }).payload.attempt,
          `the resumed stage's checkpoint ${path} must record the attempt that authored it`,
        ).toBe(2)
      }

      // The abandoned claim was released by the successor's authority rather than by a timer, and
      // the row it released was re-run: attempt 2, terminal, unclaimed.
      const afterRestart = await readJobRows(paths.agentQaRoot, paths.knowledgeRoot)
      expect(afterRestart.find((row) => row.kind === 'curate-memory'))
        .toMatchObject({ status: 'done', claimed: false, attempts: 2 })
      // The stage that finished before the crash was NOT re-run.
      expect(afterRestart.find((row) => row.kind === 'analyze-run'))
        .toMatchObject({ status: 'done', claimed: false, attempts: 1 })
      expect(afterRestart.every((row) => !row.claimed)).toBe(true)

      // ---- the dedupe holds through the whole story --------------------------------------------
      const second = await runRealTail({
        agentQaRoot: paths.agentQaRoot,
        knowledgeRoot: paths.knowledgeRoot,
        runId: RUN_ID,
        hosts,
      })
      expect(second.report).toMatchObject({ enqueue: 'deduped', drain: 'handed-off' })
      const afterSecondTail = await readJobRows(paths.agentQaRoot, paths.knowledgeRoot)
      expect(afterSecondTail.filter((row) => row.kind === 'analyze-run')).toHaveLength(1)
      expect(await readNotifications(paths.agentQaRoot, paths.knowledgeRoot)).toHaveLength(1)

      await killIfRunning(restarted.child)
    },
    LEG_TIMEOUT_MS,
  )
})

describe('the daemon-claimed chain runs the production curation fold', () => {
  test('binds curate-memory to `curateCompletedRun` at exactly one site in the daemon host', () => {
    const source = readFileSync(new URL('../daemon/host.ts', import.meta.url), 'utf8')
    // The daemon composes ONE post-run binding, and what it binds is the same per-run fold the
    // CLI tail binds. Two sites, or a body of the daemon's own, is the divergence D-01 forbids:
    // the curation chip would then depend on which process happened to hold the lease.
    expect(source.match(/^\s*postRun: \{$/gmu) ?? []).toHaveLength(1)
    expect(source.match(/curateRun: async \(\{/gu) ?? []).toHaveLength(1)
    expect(source.match(/await curateCompletedRun\(\{/gu) ?? []).toHaveLength(1)
    // The authority handed in is the lease this process already owns — never a fresh acquire.
    expect(source).toContain('authority: { leaseId: acquired.leaseId, epoch: acquired.epoch }')
  })

  test('the crash fixture wraps that binding rather than replacing the daemon composition', () => {
    const raw = readFileSync(
      new URL('./post-run-daemon/daemon.fixture.ts', import.meta.url),
      'utf8',
    )
    // Comments stripped BEFORE the scan. The 388-02/388-03 hazard, met here in miniature: the
    // header of that file explains what it deliberately does not double, and a scan over prose
    // reads every one of those names as the thing it is promising not to do.
    const code = raw.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
    // `runDaemonHost` is the real entry; the fixture supplies an operations table and nothing else.
    expect(code).toContain('runDaemonHost({')
    expect(code.match(/composeLocalAgent\(\{\n\s+\.\.\.input,/u)).not.toBeNull()
    // None of the four mechanisms every assertion above depends on is doubled: the daemon's own
    // lease acquisition, its recovery composition, its dispatcher and its socket are the shipped
    // ones. The only key the fixture may put on the operations table beside `drainQueue` is
    // `composeLocalAgent`, and it delegates.
    const table = code.slice(
      code.indexOf('const operations: Partial<DaemonHostOperations> = {'),
      code.indexOf('\n  }\n\n  const host = runDaemonHost({'),
    )
    expect(table.length).toBeGreaterThan(0)
    const operationKeys = [...table.matchAll(/^ {4}(\w+)[:,]/gmu)].map((match) => match[1]!)
    expect(operationKeys.sort()).toEqual(['composeLocalAgent', 'drainQueue'])
    expect(existsSync(new URL('./post-run-daemon/spawn-helpers.ts', import.meta.url))).toBe(true)
  })

  test('the daemon host declares the unmasked candidate-prose posture, exactly once', () => {
    const raw = readFileSync(new URL('../daemon/host.ts', import.meta.url), 'utf8')
    // Comments stripped BEFORE the scan (the idiom above): a rationale comment naming the
    // posture value must never be countable as a second declaration.
    const code = raw.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
    // The pin that makes the fixture divergence honest and stated (388-10, UF-388-01): the
    // SC4 crash legs above compose a daemon whose SUBSTITUTED fold never reaches the
    // candidate projection and which therefore declares the MASKED posture — those legs
    // still exercise the real dispatcher, the real store, the real lease and a real SIGKILL
    // against a real claimed curate-memory row, the evidence 388-SECURITY.md's T-388-18 and
    // T-388-19 rest on. PRODUCTION declares the other posture, so its host never claims the
    // kind whose fold it cannot mask, and this assertion is what stops that difference from
    // becoming a silent drift toward the posture the fixtures declare.
    expect(code.match(/'no-masker'/gu) ?? []).toHaveLength(1)
  })

  test('the candidate projection has exactly one production call site — inside the safety scope', () => {
    // What makes the daemon leg's absence claim load-bearing rather than an argument: a leg
    // that never claims the kind never invokes the fold, and the fold is the only thing that
    // reaches the projection — so no candidate prose can cross on that leg. Scoped to
    // non-test sources with comment lines stripped, and pinned on the INVOCATION form (open
    // paren) deliberately: the projection is reached through an OPERATIONS TABLE, not a
    // direct import call. `curation-tail.ts` imports it, types it as a table member and
    // binds it as that table's default — three appearances that are one seam declared once,
    // not three call sites, and a bare-token pin would count them and then be "fixed" into
    // something vacuous. Because the call goes through `operations.`, a TEST may substitute
    // the projection — which is exactly why the pin excludes `__tests__`. Expected 2: the
    // `export function` declaration in emit-candidates.ts and the one call inside
    // curation-tail.ts's safety scope.
    const srcRoot = fileURLToPath(new URL('..', import.meta.url))
    const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      .filter((rel) => rel.endsWith('.ts') && !rel.includes('__tests__'))
    let invocations = 0
    for (const rel of files) {
      const raw = readFileSync(join(srcRoot, rel), 'utf8')
      const code = raw.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
      invocations += (code.match(/emitCurationCandidates\(/gu) ?? []).length
    }
    expect(invocations).toBe(2)
  })
})
