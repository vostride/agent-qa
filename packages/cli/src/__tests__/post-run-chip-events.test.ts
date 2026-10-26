// The chip trail an in-process drain leaves behind (Phase 388 plan 04, D-13 / D-16).
//
// Driven through the REAL tail against a real sqlite store, a real handoff and the real handler
// bodies, because the claim is about what a finished run's `events.jsonl` CONTAINS after the
// chain ran — and a fake pump would let the emitter agree with a story nothing durable told.
// The events file is written by hand as a three-line fixture rather than by a real run: what
// matters to the seq claim is only that a log with a `runFinished` at `finalSeq` exists, and
// standing a whole runner up to produce one would put the runner between this proof and its
// subject.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { invokeFunction, RUNS_POST_PROCESSING_FUNCTION_ID } from '@vostride/agent-qa-agent'
import {
  composeLocalAgent,
  DIGEST_JOB_ID_SOURCE,
  DRAIN_BUDGET_MS,
  type LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  type CompletedRunHandoff,
  type PostProcessingStatus,
  type RunEventEnvelope,
  type Verdict,
  CURRENT_BUS_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLI_FUNCTION_CALLER } from '../composition/local-agent-host.js'
import { createPostRunChipEmitter } from '../curation/post-run-chip-emitter.js'
import {
  digestFetchCommand,
  renderPostProcessingSummaryLine,
  runPostRunTail,
  type PostRunTailOperations,
  type RunPostRunTailOptions,
} from '../curation/post-run-tail.js'
import { enqueueThroughTheStep } from './post-run-step-harness.js'

/**
 * The composition's REQUIRED quarantine identity mint (390-12 / D-01). Passthrough here: this
 * fixture already speaks canonical workspace-relative bytes, and the recipe itself stays pinned
 * in core's `workspace-paths.test.ts` — what these hosts exercise is everything BUT quarantine.
 */
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-388-04-chips'
const EVENTS_FILE = 'events.jsonl'

// 389-04's author swap put unknown-floor members on the model path, so a throwing stub
// now aborts the chain under test. Unparseable text makes the author degrade per-test to
// the byte-identical deterministic floor (plan 04's proven posture) — chain mechanics
// keep their 388-era shape.
const TEST_MODEL: JobModelCapability = {
  modelId: 'test:post-run-chip-events',
  generate: async () => ({ text: 'not an author payload' }),
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/post-run-chip-events.config.yaml',
    entries: [],
  }),
}

const PERSISTED_ROOT_CAUSE: Verdict = {
  class: 'timeout',
  producer: 'deterministic-classifier',
  confidence: 1,
  evidence: {
    citedSteps: [0],
    citedAnchors: [],
    citedArtifacts: [],
    rationale: 'member outcome timeout',
  },
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}

function fixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'chips-storefront' },
    buildOrdinal: 4,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_classified',
        testName: 'member the classifier reached',
        filePath: 'tests/classified.yaml',
        testIndex: 0,
        outcome: 'timeout',
        steps: [],
        rootCause: PERSISTED_ROOT_CAUSE,
      },
      {
        testId: 't_unclassified',
        testName: 'member the classifier declined',
        filePath: 'tests/unclassified.yaml',
        testIndex: 1,
        outcome: 'failed',
        steps: [],
      },
    ],
  }
}

/**
 * The run's own log as the runner left it: `runFinished` last, `finalSeq` its own seq.
 *
 * Three lines, and the third one is the whole point — every chip envelope the emitter appends
 * has to continue from THIS number, not from one the emitter chose.
 */
const FIXTURE_EVENT_LINES = [
  { seq: 1, ts: 10, runId: RUN_ID, type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION } },
  { seq: 2, ts: 20, runId: RUN_ID, type: 'verdict', payload: { verdict: 'failed' } },
  {
    seq: 3,
    ts: 30,
    runId: RUN_ID,
    type: 'runFinished',
    payload: { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 3 },
  },
] as unknown as RunEventEnvelope[]

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  agentQaRoot: string
  eventsPath: string
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  clock: { value: number }
  options(overrides?: Partial<PostRunTailOperations>): RunPostRunTailOptions
}

function fixture(behaviour: {
  curateRun?: () => Promise<{ curated: number; deprecated: number; complete: boolean }>
  /** Burn the whole drain budget after the first job, leaving the chain mid-flight. */
  stopAfterFirstJob?: boolean
  /** The tail's mask, threaded to the fold and to the chip's error field. */
  mask?: (text: string) => string
} = {}): Fixture {
  const agentQaRoot = mkdtempSync(join(tmpdir(), 'agent-qa-388-04-'))
  roots.push(agentQaRoot)
  const knowledgeRoot = join(agentQaRoot, 'knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })

  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(RUN_ID))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, HANDOFF_FILE),
    `${JSON.stringify(fixtureHandoff(RUN_ID))}\n`,
    'utf8',
  )
  const eventsPath = join(runDir, EVENTS_FILE)
  writeFileSync(
    eventsPath,
    `${FIXTURE_EVENT_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  )

  const warn = vi.fn<(message: string) => void>()
  const info = vi.fn<(message: string) => void>()
  const clock = { value: 1_000_000 }

  return {
    agentQaRoot,
    eventsPath,
    warn,
    info,
    clock,
    options(overrides: Partial<PostRunTailOperations> = {}): RunPostRunTailOptions {
      return {
        runId: RUN_ID,
        agentQaRoot,
        configPath: join(agentQaRoot, 'agent-qa.config.yaml'),
        knowledgeConfig: { dir: 'knowledge' },
        configDir: agentQaRoot,
        ...(behaviour.mask === undefined ? {} : { mask: behaviour.mask }),
        log: {
          warn: (message: string) => warn(message),
          info: (message: string) => info(message),
        },
        operations: {
          resolveKnowledgeRoot: () => knowledgeRoot,
          runCurationTail: async () => undefined,
          now: () => clock.value,
          composeHost: () => {
            const host = composeLocalAgent({
              mask: (text) => text,
              mintQuarantineIdentityPath: MINT_IDENTITY,
              agentQaRoot,
              config: TEST_CONFIG,
              knowledgeRoot: () => knowledgeRoot,
              model: () => TEST_MODEL,
              idSource: DIGEST_JOB_ID_SOURCE,
              postRun: {
                curateRun: behaviour.curateRun
                  ?? (async () => ({ curated: 2, deprecated: 1, complete: true })),
                // True of every substitute this fixture accepts: none reaches candidate emission.
                candidateProse: 'masker-active',
              },
            })
            hosts.push(host)
            if (behaviour.stopAfterFirstJob !== true) return host
            // Spend the ENTIRE budget the moment the first job lands, which is the only
            // honest way to reach `budget-exhausted` mid-chain against real handlers: the
            // pump's next deadline check is the thing under observation, not a mocked queue.
            return {
              ...host,
              jobs: async () => {
                const jobs = await host.jobs()
                return {
                  ...jobs,
                  queue: {
                    ...jobs.queue,
                    runNextJob: async (input: Parameters<typeof jobs.queue.runNextJob>[0]) => {
                      const outcome = await jobs.queue.runNextJob(input)
                      if (outcome.ran) clock.value += DRAIN_BUDGET_MS
                      return outcome
                    },
                  },
                }
              },
            } as unknown as LocalAgentHost
          },
          ...overrides,
        },
      }
    },
  }
}

function readEvents(eventsPath: string): RunEventEnvelope[] {
  return readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunEventEnvelope)
}

const FIXTURE_BYTES = `${FIXTURE_EVENT_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`

describe('the post-run chip emitter (ANLZ-05, D-13/D-16)', () => {
  it('continues the run log seq and appends one pair per drained stage', async () => {
    const f = fixture()
    const tail = runPostRunTail(f.options())
    await stepEnqueue(f.agentQaRoot)
    await tail.drain()

    expect(tail.report().drain).toBe('drained')
    const events = readEvents(f.eventsPath)
    // The run's own three lines are untouched, byte for byte.
    expect(readFileSync(f.eventsPath, 'utf8').startsWith(FIXTURE_BYTES)).toBe(true)

    const appended = events.slice(FIXTURE_EVENT_LINES.length)
    expect(appended.map((event) => event.type)).toEqual([
      'analysisStarted',
      'analysisCompleted',
      'curationStarted',
      'curationCompleted',
    ])
    // Gapless continuation from `runFinished.finalSeq`, in append order.
    expect(appended.map((event) => event.seq)).toEqual([4, 5, 6, 7])
    for (const event of appended) {
      expect(event.runId).toBe(RUN_ID)
      expect(event.payload).toEqual({ runId: RUN_ID })
      expect(typeof event.ts).toBe('number')
    }
  })

  // 404 D-01/D-02 (2026-08-26): the reserved job kind lost its `STAGE_CHIPS` row and the three
  // `issues*` event names left `RUN_EVENT_TYPES` entirely. The cell survives as the runtime
  // proof that the reserved kind emits NOTHING — the enum removal alone cannot say that,
  // because a row could still be re-added naming any surviving name.
  it('emits no issues chip at all — the reserved job kind emits nothing (D-15, 404 D-02)', async () => {
    const f = fixture()
    const tail = runPostRunTail(f.options())
    await stepEnqueue(f.agentQaRoot)
    await tail.drain()

    const types = readEvents(f.eventsPath).map((event) => event.type)
    expect(types.filter((type) => type.startsWith('issues'))).toEqual([])
    // `notify` is a function-layer emission and not a chip: no envelope claims it either.
    expect(types.filter((type) => type.toLowerCase().includes('notif'))).toEqual([])
  })

  it('appends NOTHING when the chain is handed to the daemon (D-13)', async () => {
    const f = fixture()
    const tail = runPostRunTail(f.options({
      acquireWriterLease: () => ({ kind: 'held', holder: { pid: 4242 } }),
      nudgeDaemon: async () => undefined,
    } as unknown as Partial<PostRunTailOperations>))
    await stepEnqueue(f.agentQaRoot)
    await tail.drain()

    expect(tail.report().drain).toBe('handed-off')
    expect(readFileSync(f.eventsPath, 'utf8')).toBe(FIXTURE_BYTES)
  })

  it('appends nothing when the drain leg never runs (--detach)', async () => {
    const f = fixture()
    const tail = runPostRunTail(f.options())
    await stepEnqueue(f.agentQaRoot)
    // `runVerdictFirstCurationTail` short-circuits before `drain()` under --detach.

    expect(tail.report().drain).toBe('not-attempted')
    expect(readFileSync(f.eventsPath, 'utf8')).toBe(FIXTURE_BYTES)
  })

  it('reports a stage that failed from its OWN observed outcome, never from the next one',
    async () => {
      const f = fixture({
        curateRun: async () => {
          throw new Error('the curation fold could not open the knowledge root')
        },
      })
      const tail = runPostRunTail(f.options())
      await stepEnqueue(f.agentQaRoot)
      await tail.drain()

      const appended = readEvents(f.eventsPath).slice(FIXTURE_EVENT_LINES.length)
      expect(appended.map((event) => event.type)).toEqual([
        'analysisStarted',
        'analysisCompleted',
        'curationStarted',
        'curationFailed',
      ])
      const failure = appended.at(-1)!.payload as { runId: string; error?: string; willRetry?: boolean }
      expect(failure.runId).toBe(RUN_ID)
      expect(failure.error).toContain('knowledge root')
      // The disposition is the ONLY source for this field — a retry-scheduled stage says so,
      // a permanently failed one does not claim a retry nobody scheduled.
      expect(failure.willRetry).toBe(tail.report().drain === 'retry-scheduled')
    })

  it('masks the failure chip\'s error through the run\'s own masker and bounds it (WR-08/P2)',
    async () => {
      const SECRET = 'sk-live-388-07-do-not-log-me'
      const REDACTION = '«redacted:provider-key»'
      const f = fixture({
        // The token sits EARLY in the message and the padding after it, so the mask has to have
        // fired for the redaction to survive the length bound — a slice alone would drop the
        // secret only by accident of where it happened to fall.
        curateRun: async () => {
          throw new Error(
            `the curation fold could not open the knowledge root using ${SECRET} `
            + 'x'.repeat(900),
          )
        },
        mask: (text: string) => text.split(SECRET).join(REDACTION),
      })
      const tail = runPostRunTail(f.options())
      await stepEnqueue(f.agentQaRoot)
      await tail.drain()

      const appended = readEvents(f.eventsPath).slice(FIXTURE_EVENT_LINES.length)
      expect(appended.map((event) => event.type)).toEqual([
        'analysisStarted',
        'analysisCompleted',
        'curationStarted',
        'curationFailed',
      ])
      const failure = appended.at(-1)!.payload as { runId: string; error?: string }
      expect(failure.error).toContain(REDACTION)
      expect(failure.error).not.toContain(SECRET)
      // A diagnostic pointer, not a transcript: the field is bounded whatever was thrown.
      expect(failure.error!.length).toBeLessThanOrEqual(500)
      // …and the claim is about the BYTES on disk, which is what `runs.events` streams.
      expect(readFileSync(f.eventsPath, 'utf8')).not.toContain(SECRET)
    })

  it('bounds the chip error even with no masker on the tail', async () => {
    const f = fixture({
      curateRun: async () => {
        throw new Error(`the curation fold could not open the knowledge root ${'y'.repeat(900)}`)
      },
    })
    const tail = runPostRunTail(f.options())
    await stepEnqueue(f.agentQaRoot)
    await tail.drain()

    const failure = readEvents(f.eventsPath).at(-1)!.payload as { error?: string }
    // The bound is the emitter's, not the masker's: a tail with no masking context still may not
    // stream a thousand characters of somebody's exception into every attached surface.
    expect(failure.error!.length).toBeLessThanOrEqual(500)
    expect(failure.error).toContain('knowledge root')
  })

  it('rides a direct append and never the run bus (D-16)', () => {
    const source = readFileSync(
      new URL('../curation/post-run-chip-emitter.ts', import.meta.url),
      'utf8',
    )
    // Anchored at the start of a line and on `import`/`}` so a rationale comment naming a
    // module is not scanned as one (the 388-02 specifier-extractor hazard, in miniature).
    const specifiers = [...source.matchAll(/^(?:import .*|\})\s*from '([^']+)'/gmu)]
      .map((match) => match[1]!)
      .sort()
    // The bus, its subscribers and the runner's event-log port are all flushed and closed by
    // the time this file runs. Reaching any of them would be reaching a producer that is gone.
    expect(specifiers).toEqual([
      './curation-tail.js',
      '@vostride/agent-qa-schema',
      'node:fs',
    ])
    // …and the append itself is the raw `FsEventLog` discipline, stated once.
    expect(source.match(/appendFileSync\(/gu) ?? []).toHaveLength(1)
  })
})

/**
 * The emitter's SECOND SINK — the dashboard relay (Phase 404 plan 05, D-16).
 *
 * WHAT THE SINK MAY AND MAY NOT COST. The trail is the record: `events.jsonl` is what
 * `runs.postprocessing` is reconciled against and what a later reader replays. The relay is a
 * convenience for a browser that happens to be open right now — so it runs AFTER the line is on
 * disk, it hands over the same object rather than a copy anybody could have edited on the way, and
 * a listener that throws is swallowed here for the run bus's own subscriber-fault reason. The
 * strongest statement of all of that is the byte cell: a run drained with a relay and a run drained
 * without one leave IDENTICAL files.
 */
describe("the relay is the emitter's second sink and never its first (404 D-16)", () => {
  it('hands the relay every appended envelope, in order, AFTER the line is on disk', async () => {
    const f = fixture()
    const relayed: RunEventEnvelope[] = []
    /** What the file held at the moment each relay call was made. */
    const linesAtRelay: number[] = []
    const tail = runPostRunTail({
      ...f.options(),
      relay: (envelope) => {
        relayed.push(envelope)
        linesAtRelay.push(
          readFileSync(f.eventsPath, 'utf8').split('\n').filter((line) => line.length > 0).length,
        )
      },
    })
    await stepEnqueue(f.agentQaRoot)
    await tail.drain()

    const appended = readEvents(f.eventsPath).slice(FIXTURE_EVENT_LINES.length)
    expect(appended.map((event) => event.type)).toEqual([
      'analysisStarted',
      'analysisCompleted',
      'curationStarted',
      'curationCompleted',
    ])
    // ONE RELAY CALL PER APPEND AND NO OTHERS. A sink that fired on an outcome the drop-guard
    // discarded, or twice for one line, breaks this correspondence rather than an inequality
    // somewhere downstream.
    expect(relayed).toEqual(appended)
    // AFTER, not before: by the time each call was made its own line was already the last one on
    // disk. A relay invoked ahead of `appendFileSync` would show one fewer line every time.
    expect(linesAtRelay).toEqual(
      appended.map((_event, index) => FIXTURE_EVENT_LINES.length + index + 1),
    )
    // The SAME object that was serialised, not a structural twin: the envelope the browser is
    // told about and the envelope the file holds cannot be two values that merely agree today.
    for (const [index, envelope] of relayed.entries()) {
      expect(JSON.stringify(envelope)).toBe(JSON.stringify(appended[index]))
    }
  })

  it('leaves the trail BYTE-IDENTICAL to a run drained with no relay at all', async () => {
    const withRelay = fixture()
    const relayed: RunEventEnvelope[] = []
    const relayTail = runPostRunTail({
      ...withRelay.options(),
      relay: (envelope) => { relayed.push(envelope) },
    })
    await stepEnqueue(withRelay.agentQaRoot)
    await relayTail.drain()

    const without = fixture()
    const plainTail = runPostRunTail(without.options())
    await stepEnqueue(without.agentQaRoot)
    await plainTail.drain()

    expect(relayed.length, 'the relay did fire — otherwise the byte claim is vacuous').toBe(4)
    expect(readFileSync(withRelay.eventsPath, 'utf8'))
      .toBe(readFileSync(without.eventsPath, 'utf8'))
  })

  it('swallows a THROWING relay: the append still happened and observe() never threw', async () => {
    const f = fixture()
    let calls = 0
    const tail = runPostRunTail({
      ...f.options(),
      relay: () => {
        calls += 1
        throw new Error('a viewer fault, mid-append')
      },
    })
    await stepEnqueue(f.agentQaRoot)
    // A throw out of the sink would surface HERE, as a rejected drain — the pump calls `observe()`
    // synchronously inside its own loop.
    await expect(tail.drain()).resolves.toBeUndefined()

    expect(calls, 'it threw on every one of them, not just the first').toBe(4)
    expect(tail.report().drain).toBe('drained')
    const appended = readEvents(f.eventsPath).slice(FIXTURE_EVENT_LINES.length)
    expect(appended.map((event) => event.type), 'the trail is complete regardless').toEqual([
      'analysisStarted',
      'analysisCompleted',
      'curationStarted',
      'curationCompleted',
    ])
  })
})

/**
 * Read the SAME op the tail renders from, through a second composition.
 *
 * A second host is what makes the token-equality claim non-circular: if the line were built
 * from anything the tail held in memory, the values compared here — which came out of a cold
 * registry over the same database — would be free to disagree with it.
 */
async function stepEnqueue(agentQaRoot: string): Promise<void> {
  await enqueueThroughTheStep({
    runId: RUN_ID,
    agentQaRoot,
    configPath: join(agentQaRoot, 'agent-qa.config.yaml'),
    composeHost: () => {
      const host = composeLocalAgent({
        mask: (text) => text,
        mintQuarantineIdentityPath: MINT_IDENTITY,
        agentQaRoot,
        config: TEST_CONFIG,
        knowledgeRoot: () => join(agentQaRoot, 'knowledge'),
        model: () => TEST_MODEL,
        idSource: DIGEST_JOB_ID_SOURCE,
      })
      hosts.push(host)
      return host
    },
  })
}

async function readStatusThroughTheOp(
  agentQaRoot: string,
): Promise<PostProcessingStatus> {
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => join(agentQaRoot, 'knowledge'),
    model: () => TEST_MODEL,
    idSource: DIGEST_JOB_ID_SOURCE,
  })
  try {
    return await invokeFunction(
      host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId: RUN_ID },
      CLI_FUNCTION_CALLER,
    ) as PostProcessingStatus
  } finally {
    await host.close()
  }
}

describe('the user-facing post-run lines (D-07 / D-08 / D-09)', () => {
  it('renders the queued-work summary from the op, token for token (D-08/D-14)', async () => {
    const f = fixture()
    const tail = runPostRunTail(f.options({
      acquireWriterLease: () => ({ kind: 'held', holder: { pid: 4242 } }),
      nudgeDaemon: async () => undefined,
    } as unknown as Partial<PostRunTailOperations>))
    await stepEnqueue(f.agentQaRoot)
    await tail.drain()
    await tail.finish()

    expect(tail.report().drain).toBe('handed-off')
    const status = await readStatusThroughTheOp(f.agentQaRoot)
    const line = f.info.mock.calls.map(([message]) => String(message))
      .find((message) => message.startsWith('post-processing —'))
    expect(line).toBeDefined()

    // ONE vocabulary, not three spellings: the rendered statuses ARE the op's chip values.
    expect(line).toBe(
      `post-processing — analysis: ${status.chips.analysis} (daemon will drain)`
      + ` · curation: ${status.chips.curation} (deferred to a later local run)`
      // 389 D-12: this process did not complete analyze-run, so the line carries the one
      // copy-paste that fetches the sentences once the daemon has drained.
      + ` · digest: ${digestFetchCommand(RUN_ID)}`,
    )
    // …and the values it rendered are the durable ones, not a control-flow word.
    expect(status.chips).toEqual({
      analysis: 'pending',
      curation: 'pending',
    })
    // The "(daemon will drain)" half is NOT in the DTO — it is the tail's own posture.
    expect(JSON.stringify(status)).not.toContain('daemon will drain')
  })

  it('renders D-08\'s own example when the stages actually differ (analysis complete, curation queued)',
    async () => {
      const f = fixture({ stopAfterFirstJob: true })
      // First tail: the budget is spent the instant `analyze-run` lands, so the chain stops
      // mid-flight with `curate-memory` durably queued and nothing claiming it.
      const first = runPostRunTail(f.options())
      await stepEnqueue(f.agentQaRoot)
      await first.drain()
      expect(first.report().drain).toBe('budget-exhausted')

      // Second tail, same store, lease now held by a daemon: work stays queued and somebody
      // has been nudged. This is the ONE posture where D-08's example line is literally true.
      const second = runPostRunTail(f.options({
        acquireWriterLease: () => ({ kind: 'held', holder: { pid: 4242 } }),
        nudgeDaemon: async () => undefined,
      } as unknown as Partial<PostRunTailOperations>))
      f.info.mockClear()
      await stepEnqueue(f.agentQaRoot)
      await second.drain()
      await second.finish()

      expect(second.report().drain).toBe('handed-off')
      const status = await readStatusThroughTheOp(f.agentQaRoot)
      // The stages DIFFER, so a line fabricated from the tail's own posture cannot coincide
      // with the durable one — which is what makes the token-equality claim below load-bearing.
      expect(status.chips).toEqual({
        analysis: 'complete',
        curation: 'pending',
      })
      expect(f.info.mock.calls.map(([message]) => String(message))).toEqual([
        'post-processing — analysis: complete · curation: pending (deferred to a later local run)'
        // 389 D-12: the SECOND tail completed nothing in-process (the first one authored the
        // analysis), so its exit line still points at the fetch command rather than printing
        // sentences it never drained.
        + ` · digest: ${digestFetchCommand(RUN_ID)}`,
      ])
    })

  it('drops the daemon parenthetical under --detach, where nobody promised to drain', async () => {
    const f = fixture()
    const tail = runPostRunTail(f.options())
    await stepEnqueue(f.agentQaRoot)
    await tail.finish({ detached: true })

    expect(tail.report().drain).toBe('detached')
    expect(f.info.mock.calls.map(([message]) => String(message))).toEqual([
      'post-processing — analysis: pending · curation: pending'
      + ` · digest: ${digestFetchCommand(RUN_ID)}`,
    ])
  })

  it('never promises a daemon drain for curation, the kind no daemon may claim (WR-09)',
    async () => {
      // The defect this pins: the parenthetical was chosen by POSTURE alone and pasted onto
      // whichever stages were `pending`, so a handed-off leg told the user a daemon would
      // drain curation. Since 388-10 that is false BY CONSTRUCTION, not by timing — the
      // production daemon declares `candidateProse: 'no-masker'`, and
      // `UNCLAIMABLE_BY_PROSE_POSTURE` makes `curate-memory` unclaimable for exactly that
      // posture inside the claim SELECT. Only a masked leg can drain it, and a masked leg is
      // a local run's tail.
      // The plain fixture, so BOTH drainable stages are still `pending` and the two
      // parentheticals are therefore comparable — the whole point of this pin is that the
      // same posture now renders two different promises.
      const f = fixture()
      const handedOff = runPostRunTail(f.options({
        acquireWriterLease: () => ({ kind: 'held', holder: { pid: 4242 } }),
        nudgeDaemon: async () => undefined,
      } as unknown as Partial<PostRunTailOperations>))
      await stepEnqueue(f.agentQaRoot)
      await handedOff.drain()
      await handedOff.finish()
      expect(handedOff.report().drain).toBe('handed-off')

      const line = f.info.mock.calls.map(([message]) => String(message))
        .find((message) => message.startsWith('post-processing —'))
      expect(line).toBeDefined()

      const status = await readStatusThroughTheOp(f.agentQaRoot)
      expect(status.chips).toMatchObject({ analysis: 'pending', curation: 'pending' })

      // Read each stage's OWN parenthetical rather than the line as a whole: the analysis
      // stage keeps its daemon promise, so a substring assertion over the whole line could
      // not tell a fixed curation chip from an unfixed one.
      const stages = line!.replace('post-processing — ', '').split(' · ')
      const curationStage = stages.find((part) => part.startsWith('curation:'))
      expect(curationStage).toBe('curation: pending (deferred to a later local run)')
      expect(curationStage).not.toContain('daemon')

      // The positive half, so this cannot pass by dropping every parenthetical: the stage a
      // daemon DOES drain still says so, under the very same posture.
      const analysisStage = stages.find((part) => part.startsWith('analysis:'))
      expect(analysisStage).toBe('analysis: pending (daemon will drain)')
    })

  // EXIT-LINE-EXCLUDED (425 D-08, 444 D-39). A gate or benchmark run never enqueues a chain, so its
  // chips read `pending` forever and the posture parenthetical promises a drain nobody will perform.
  // The skipped fact the op mints from the run's durable handoff replaces BOTH stage clauses
  // with the words the digest chain line and the dashboard print — and takes the promise with it.
  it('EXIT-LINE-EXCLUDED: renders both stages skipped with the reason and no posture promise',
    () => {
      const gateRun: PostProcessingStatus = {
        runId: RUN_ID,
        chips: { analysis: 'pending', curation: 'pending' },
        skipped: { reason: 'gate-run' },
      }
      // `handed-off` is the ONE posture that pastes a promise onto every pending stage, which is
      // what makes the absence below load-bearing rather than a coincidence of the plain fixture.
      const line = renderPostProcessingSummaryLine(gateRun, 'handed-off')
      expect(line).toBe(
        'post-processing — analysis: skipped (gate run)'
        + ' · curation: skipped (gate run)',
      )
      expect(line).not.toContain('daemon will drain')
      expect(line).not.toContain('deferred to a later local run')

      // The reason is RENDERED, not a constant: the other member of the closed set reads as
      // itself, in both clauses.
      expect(renderPostProcessingSummaryLine(
        { ...gateRun, skipped: { reason: 'outcome-excluded' } },
        'handed-off',
      )).toBe(
        'post-processing — analysis: skipped (outcome-excluded)'
        + ' · curation: skipped (outcome-excluded)',
      )

      // And the same status WITHOUT the field is byte-identical to what the shipped exit-line
      // cells above pin — the arm is additive, keyed on the fact and on nothing else.
      const { skipped: _absent, ...ordinary } = gateRun
      expect(renderPostProcessingSummaryLine(ordinary, 'handed-off')).toBe(
        'post-processing — analysis: pending (daemon will drain)'
        + ' · curation: pending (deferred to a later local run)',
      )
    })

  it('prints the human notification line at chain terminal, from the row (D-09/D-12)',
    async () => {
      const f = fixture()
      const tail = runPostRunTail(f.options())
      await stepEnqueue(f.agentQaRoot)
      await tail.drain()
      await tail.finish()

      const status = await readStatusThroughTheOp(f.agentQaRoot)
      const notification = status.notification!
      expect(notification).toBeDefined()

      const lines = f.info.mock.calls.map(([message]) => String(message))
      const human = lines.find((message) => message.includes(RUN_ID))
      expect(human).toBeDefined()
      // Counts come from the ROW, not from anything the drain remembered.
      expect(human).toContain(`${notification.stages.curation.curated!} curated`)
      expect(human).toContain(`${notification.stages.curation.deprecated!} deprecated`)
      expect(human).toContain(`verdicts ${notification.verdictSummary.total}`)
      expect(human).toContain(`analysis: ${notification.stages.analysis.status}`)
      // A terminal chain says the terminal thing, not the queued-work thing.
      expect(lines.some((message) => message.startsWith('post-processing —'))).toBe(false)
    })

  it('says NOTHING at all when the step reported a failed hand-off (D-07, 404 D-05)',
    async () => {
      // The D-07 warning itself — the run id, "verdict and exit code are unaffected", and the
      // handoff's own path as the manual re-queue route — is now published by the SHELL, off the
      // step's `post-run-enqueue-failed` outcome, and is pinned in `post-verdict-step.test.ts`.
      // What is pinned HERE is the tail's half of that split: told `failed`, it prints no
      // close-out line and adds no second, quieter warning of its own.
      const f = fixture()
      const tail = runPostRunTail({ ...f.options(), enqueueOutcome: 'failed' })
      await tail.finish()

      expect(f.warn, 'the shell already said everything true about this run').not.toHaveBeenCalled()
      // Nothing is queued, so nothing may claim to be.
      expect(f.info).not.toHaveBeenCalled()
    })

  it('reads status through the op and never opens the queue database itself (D-14)', () => {
    const source = readFileSync(
      new URL('../curation/post-run-tail.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain('renderPostProcessingSummaryLine')
    expect(source).toContain('RUNS_POST_PROCESSING_FUNCTION_ID')
    // The CLI never reads `agent-jobs.db` for status — that is the op's job and only the op's.
    expect(source).not.toMatch(/sqlite|DatabaseSync|agent-jobs\.db/u)
  })
})

describe('C444.1-INTERRUPTED', () => {
  it('an interrupted stage emits no failure chip', () => {
    const f = fixture()
    const emitter = createPostRunChipEmitter({
      agentQaRoot: f.agentQaRoot,
      runId: RUN_ID,
      chainJobIds: ['job-analyze', 'job-curate', 'job-propose'],
      now: () => f.clock.value,
    })

    emitter.observe({
      ran: true,
      disposition: 'interrupted',
      handlerInvoked: true,
      job: { id: 'job-analyze', kind: 'analyze-run' },
      reason: 'handler-threw: the model request was aborted',
    })

    const appended = readEvents(f.eventsPath).slice(FIXTURE_EVENT_LINES.length)
    expect(appended.map((event) => event.type)).toEqual(['analysisStarted'])
    expect(emitter.emitted()).toBe(1)
  })
})
