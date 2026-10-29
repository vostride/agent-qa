// LIFE-01 (a): exactly one `verdict`, in the right place, on real runs (Phase 404 plan 01, D-15).
//
// THE CLAIM, IN ONE SENTENCE: `verdict` is the exactly-once terminal event determined by test
// execution ALONE — after the last `testFinished`, before any post-processing envelope — and it is
// read off `events.jsonl`, the run's own durable record, never off an in-memory bus.
//
// WHY THE FILE AND NOT THE BUS. The bus is a live object a cell can inspect for free; the file is
// what a person, the dashboard, the SSE replay and 408's embed all actually read. A cell over the
// bus would be green for a shell that published correctly and a log writer that reordered, and the
// log writer is on the path every consumer takes. So every leg here constructs a REAL `FsEventLog`
// in a temp root (legs 2 and 4) or spawns the shipped binary (leg 1), and asserts by `seq` — never
// by array position, which would make the claim about how the file happened to be flushed.
//
// THREE RUN SHAPES, BECAUSE "DETERMINED BY TEST EXECUTION ALONE" IS ONLY INTERESTING AT THE EDGES.
// A green N-member suite proves almost nothing: the interesting inputs are the ones where the run
// ENDED for a reason other than its members finishing — a run-level cancel, or a fail-fast group
// that skipped the rest. Each still publishes exactly one verdict, and each still publishes it
// after every member's own finish, including the finishes the shell SYNTHESIZED for members it
// never executed.
//
// MUTATION CONTROL (recorded 2026-08-26, not a cell): a second `bus.publish('verdict', { verdict })`
// inserted immediately after the shipped one in `runner/src/run/shell.ts` reds every leg below on
// "exactly one verdict". The red line and the restored-diff proof are in 404-01-SUMMARY.md.

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startRun } from '@vostride/agent-qa-runner'
import type {
  MemberTestExecutor,
  MemberTestRunContext,
  RunConfig,
  RunMemberDescriptor,
} from '@vostride/agent-qa-runner'
import { FsEventLog, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import type { CompletedRunHandoff, RunEventEnvelope, RunSession } from '@vostride/agent-qa-schema'
import type { TestResult } from '@vostride/agent-qa-runner'

import {
  ANCHORED_BUILDS,
  buildFreshness,
  cleanupTempRoots,
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  spawnCollecting,
  trackTempRoot,
} from './conformance/spawned-chat.js'
import { openProjectHost, runRealTail } from './post-run-daemon/project.js'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { runFixtureProject } from './post-run-disposition.test.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

/** Every post-processing envelope name a drained chain can append after `runFinished`. */
const POST_PROCESSING_TYPES = new Set([
  'analysisStarted',
  'analysisCompleted',
  'analysisFailed',
  'curationStarted',
  'curationCompleted',
  'curationFailed',
])

interface LoggedEvent {
  seq: number
  type: string
  payload: Record<string, unknown>
}

function parseEventsFile(path: string): LoggedEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as LoggedEvent)
}

/**
 * The one ordering assertion every leg makes, so three legs cannot drift into three claims.
 *
 * By `seq` throughout: the file's line order and the run's event order are two different facts, and
 * only the second one is what LIFE-01 is about.
 */
function assertVerdictSequence(events: LoggedEvent[], leg: string): LoggedEvent {
  const verdicts = events.filter(event => event.type === 'verdict')
  expect(verdicts, `${leg}: exactly one verdict envelope per run`).toHaveLength(1)
  const verdict = verdicts[0]
  const finishes = events.filter(event => event.type === 'testFinished')
  expect(finishes.length, `${leg}: the run finished at least one member`).toBeGreaterThan(0)
  for (const finished of finishes) {
    expect(
      finished.seq,
      `${leg}: member ${String(finished.payload.testId)} finished before the verdict was derived`,
    ).toBeLessThan(verdict.seq)
  }
  return verdict
}

// ---- Legs 2 and 4: the shipped shell over a REAL FsEventLog ---------------------------------

function passResult(name: string): TestResult {
  return {
    name,
    filePath: `${name}.test.ts`,
    status: 'passed',
    steps: [{ name: 'a step', status: 'passed', duration: 1 }],
    duration: 1,
  }
}

function failResult(name: string): TestResult {
  return {
    name,
    filePath: `${name}.test.ts`,
    status: 'failed',
    steps: [{ name: 'a step', status: 'failed', duration: 1, error: 'boom' }],
    duration: 1,
  }
}

/** An executor whose active member hangs until its abortSignal fires — `run-cancel`'s own shape. */
function abortableExecutor(calls: string[]): MemberTestExecutor {
  return (member: RunMemberDescriptor, ctx: MemberTestRunContext) =>
    new Promise(resolve => {
      calls.push(member.testId)
      const cancelled = {
        name: member.testId,
        filePath: `${member.testId}.test.ts`,
        status: 'cancelled' as const,
        steps: [],
        duration: 1,
      }
      if (ctx.abortSignal.aborted) {
        resolve(cancelled)
        return
      }
      ctx.abortSignal.addEventListener('abort', () => { resolve(cancelled) }, { once: true })
    })
}

function scriptedExecutor(
  script: Record<string, TestResult>,
  calls: string[],
): MemberTestExecutor {
  return async (member: RunMemberDescriptor) => {
    calls.push(member.testId)
    return script[member.testId] ?? passResult(member.testId)
  }
}

/**
 * Start a run whose events land in a real `events.jsonl`, and answer the path they landed in.
 *
 * No handoff store and no post-verdict port: neither is on the claim's path, and a run with no
 * `postVerdict` composed publishes `runFinished` with the honest `detached` — which is exactly
 * what a shell-only harness is.
 */
function startLoggedRun(
  members: readonly RunMemberDescriptor[],
  executor: MemberTestExecutor,
  extra: Partial<RunConfig> = {},
): { session: RunSession; eventsPath: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-404-seq-')))
  const runId = 'r_verdict-sequence-fixture-run'
  const config = {
    runId,
    scope: { tier: 'suite', key: 'sequence' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members,
    executor,
    ...extra,
    ports: { eventLog: new FsEventLog({ root, runId }), ...(extra.ports ?? {}) },
  } as unknown as RunConfig
  return {
    session: startRun(config),
    eventsPath: join(root, RUNS_SUBDIR, slugBranch(runId), 'events.jsonl'),
  }
}

function settled(session: RunSession): Promise<{ verdict: string; handoff: CompletedRunHandoff }> {
  return (session as unknown as {
    done: Promise<{ verdict: string; handoff: CompletedRunHandoff }>
  }).done
}

afterEach(() => {
  cleanupTempRoots()
})

describe('(a): one verdict, after the last testFinished, on every run shape', () => {
  it('leg 2 — a run-level cancel mid-member still publishes exactly one verdict, and it is cancelled', async () => {
    const calls: string[] = []
    const { session, eventsPath } = startLoggedRun(
      [
        { testId: 'a', name: 'test a', filePath: 'a.test.ts' },
        { testId: 'b', name: 'test b', filePath: 'b.test.ts' },
      ],
      abortableExecutor(calls),
    )
    ;(session as unknown as { subscribe(from: number, h: (e: RunEventEnvelope) => void): void })
      .subscribe(1, () => undefined)
    ;(session as unknown as { cancel(): void }).cancel()
    const completion = await settled(session)
    expect(completion.verdict).toBe('cancelled')

    const events = parseEventsFile(eventsPath)
    const verdict = assertVerdictSequence(events, 'cancel')
    expect(
      verdict.payload.verdict,
      'cancel: the one verdict carries the aggregate the cancel produced',
    ).toBe('cancelled')
  })

  it('leg 4 — a fail-fast skip publishes one verdict, and EVERY skipped member finished before it', async () => {
    const calls: string[] = []
    const members: RunMemberDescriptor[] = [
      { testId: 'g1-a', name: 'group 1 a', filePath: 'g1-a.test.ts', failFastGroup: 'g1' },
      { testId: 'g1-b', name: 'group 1 b', filePath: 'g1-b.test.ts', failFastGroup: 'g1' },
      { testId: 'g1-c', name: 'group 1 c', filePath: 'g1-c.test.ts', failFastGroup: 'g1' },
    ]
    const { session, eventsPath } = startLoggedRun(
      members,
      scriptedExecutor({ 'g1-a': failResult('g1-a') }, calls),
    )
    ;(session as unknown as { subscribe(from: number, h: (e: RunEventEnvelope) => void): void })
      .subscribe(1, () => undefined)
    await settled(session)

    expect(calls, 'fail-fast: the rest of the group is never executed').toEqual(['g1-a'])
    const events = parseEventsFile(eventsPath)
    const verdict = assertVerdictSequence(events, 'fail-fast')
    const skipped = events.filter(
      event => event.type === 'testFinished' && event.payload.outcome === 'skipped',
    )
    expect(
      skipped.map(event => event.payload.testId).sort(),
      'fail-fast: the shell SYNTHESIZES a finish for each member it never ran',
    ).toEqual(['g1-b', 'g1-c'])
    for (const event of skipped) {
      expect(
        event.seq,
        'fail-fast: a synthesized skip is still a member finish, and still precedes the verdict',
      ).toBeLessThan(verdict.seq)
    }
  })
})

describePosix('(a) leg 1: the shipped binary, with post-processing envelopes present', () => {
  it('a real `agent-qa run` writes one verdict, after every testFinished and BEFORE the first post-processing envelope', async () => {
    const freshness = buildFreshness(ANCHORED_BUILDS)
    expect(
      { missing: freshness.missing, stale: freshness.stale },
      `this cell drives the built CLI: ${REBUILD_INSTRUCTION}`,
    ).toEqual({ missing: [], stale: [] })

    const { root } = runFixtureProject('sequence', 2)
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run', 'tests/probe-0.yaml'])
    expect(
      outcome.signal,
      `the run must exit on its own, not on a signal (stderr: ${outcome.stderr})`,
    ).toBeNull()

    const agentQaRoot = join(root, '.agent-qa')
    const runsDir = join(agentQaRoot, RUNS_SUBDIR)
    const dirs = readdirSync(runsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    expect(dirs, 'the fixture ran exactly one run').toHaveLength(1)
    const eventsPath = join(runsDir, dirs[0], 'events.jsonl')
    const beforeTail = parseEventsFile(eventsPath)
    const runId = String(beforeTail[0].payload.runId ?? '')
      || String((beforeTail[0] as unknown as { runId?: string }).runId ?? '')

    // THE SECOND HALF OF THE CLAIM NEEDS CHIP LINES TO EXIST. The spawned run left the chain
    // enqueued and left the writer lease free; driving the SHIPPED tail in-process over the same
    // run directory is what appends the post-processing envelopes, so "before any post-processing
    // envelope" is measured against envelopes that are really there rather than vacuously true.
    const hosts: LocalAgentHost[] = []
    try {
      const tail = await runRealTail({
        agentQaRoot,
        knowledgeRoot: join(root, 'agent-qa-knowledge'),
        runId,
        hosts,
      })
      expect(
        tail.report.drain,
        // 2026-08-26: the spawned run acquires the lease only if a pump of its own asks for it, and
        // this fixture dies above its tail — so it exits leaving the lease exactly as it found it.
        // Either way the claim this cell needs is the same one: no lease of that run's is still
        // held, so the in-process tail can pump and emit chips.
        'the spawned run holds no lease of its own afterwards, so the in-process tail can pump and emit chips',
      ).not.toBe('handed-off')
    } finally {
      for (const host of hosts) await host.close()
    }

    const events = parseEventsFile(eventsPath)
    const verdict = assertVerdictSequence(events, 'shipped')
    const chips = events.filter(event => POST_PROCESSING_TYPES.has(event.type))
    expect(
      chips.length,
      'the tail appended at least one post-processing envelope — otherwise this leg is vacuous',
    ).toBeGreaterThan(0)
    for (const chip of chips) {
      expect(
        verdict.seq,
        `shipped: the verdict precedes the ${chip.type} envelope — test execution decides it alone`,
      ).toBeLessThan(chip.seq)
    }
    const finish = events.find(event => event.type === 'runFinished')
    expect(finish, 'shipped: runFinished is present').toBeDefined()
    expect(
      verdict.seq,
      'shipped: and it precedes runFinished, which the post-verdict step sits between',
    ).toBeLessThan(finish!.seq)
  }, 300_000)
})

// `openProjectHost` is referenced so the harness import stays honest about what this file drives.
void openProjectHost
