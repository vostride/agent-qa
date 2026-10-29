// JOBQ-06's byte-proof: the post-run chain is invisible to the verdict (Phase 388 plan 05).
//
// The requirement's own sentence is three claims — the verdict is reported and the exit code
// determined BEFORE the enqueue, an enqueue failure is surfaced but never thrown, and
// post-processing never gates the verdict or the navigation. The first two already have
// executed regressions (388-02). The third is the one this file exists for, and it is the one
// spot-checks cannot carry: `expect(exitCode).toBe(1)` passes just as happily against a tail
// that interleaved a warning through the reporter's summary block (RESEARCH Pitfall 10).
//
// ═══ 2026-08-26 — Phase 404 D-05/D-10 SUPERSEDE THE FIRST CLAUSE, DELIBERATELY ═══
//
// "the exit code is determined BEFORE the enqueue" was true of a build where the enqueue lived in
// `commands/run.ts`'s tail. It is no longer: D-10 has the runner SHELL await a post-verdict step
// between `verdict` and `runFinished`, and D-05 put the durable hand-off inside it — so the
// enqueue happens before `mapVerdictToExitCode` is ever reached, on EVERY door rather than on
// this one. That is the ratified design and not a regression: the step is bounded at
// `POST_VERDICT_STEP_BUDGET_MS`, its failure degrades to `detached` + a named `runWarning`, and
// `runFinished` still publishes last. The enqueue's own failure legs therefore moved to
// `curation/__tests__/post-verdict-step.test.ts` with the enqueue.
//
// WHAT SURVIVES HERE IS THE PART THAT WAS ALWAYS THE POINT: nothing the post-run TAIL does can
// change the frozen exit code, and no post-run byte may precede a verdict byte. The scenario
// below therefore compares a clean run against one whose STEP already failed — the posture the
// tail is told about through `enqueueOutcome: 'failed'` — plus the tail's own induced failures.
//
// So the same scenario runs TWICE — post-processing induced to fail, and not — and what is compared is
// the WHOLE captured byte sequence of each channel, the 385 D-03 logical-dump discipline
// applied to output. Three things make the comparison non-vacuous rather than a comparison of
// two empty strings:
//
//   1. The verdict-scoped output is the SHIPPED console reporter's rendering of the shipped
//      envelope fixture, through the reporter's own injected writer. Real bytes, ~2 KB of them,
//      produced by the code a user actually reads.
//   2. The tail's log is the REAL `curationTailLog` from `run.ts`, so which CHANNEL each
//      post-run line lands on is under test rather than chosen by this file. Route the D-08
//      line to `console.log` in run.ts and the stdout comparison goes red.
//   3. The two scenarios genuinely diverge after the boundary: A prints a close-out line, B
//      prints the D-07 warning. A comparison that held over identical suffixes would be
//      proving nothing; this one holds over a prefix whose suffixes differ.
//
// The tail is bound through `runVerdictFirstCurationTail` — the SAME wrapper entry both
// production sites use — so the freeze-then-enqueue ordering is the subject rather than a
// reconstruction of it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import {
  composeLocalAgent,
  DIGEST_JOB_ID_SOURCE,
  type LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import { mapVerdictToExitCode } from '@vostride/agent-qa-runner'
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

import { curationTailLog } from '../commands/run.js'
import { runVerdictFirstCurationTail } from '../curation/curation-tail.js'
import {
  digestFetchCommand,
  runPostRunTail,
  type PostRunTailHostInput,
  type PostRunTailOperations,
  type RunPostRunTailOptions,
} from '../curation/post-run-tail.js'
import { enqueueThroughTheStep } from './post-run-step-harness.js'
import { createConsoleReporter } from '../reporters/console-reporter.js'
import { buildReporterFixture } from './reporters/fixtures.js'

/**
 * The composition's REQUIRED quarantine identity mint (390-12 / D-01). Passthrough here: this
 * fixture already speaks canonical workspace-relative bytes, and the recipe itself stays pinned
 * in core's `workspace-paths.test.ts` — what these hosts exercise is everything BUT quarantine.
 */
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-388-05-isolation'
const EVENTS_FILE = 'events.jsonl'

// 389-04's author swap put unknown-floor members on the model path, so a throwing stub
// now aborts the chain under test. Unparseable text makes the author degrade per-test to
// the byte-identical deterministic floor (plan 04's proven posture) — chain mechanics
// keep their 388-era shape.
const TEST_MODEL: JobModelCapability = {
  modelId: 'test:post-run-exit-isolation',
  generate: async () => ({ text: 'not an author payload' }),
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/post-run-exit-isolation.config.yaml',
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
    scope: { tier: 'product', key: 'isolation-storefront' },
    buildOrdinal: 5,
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

/** The run's own log as the runner left it — the emitter continues from `runFinished.finalSeq`. */
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
  vi.restoreAllMocks()
})

interface Fixture {
  agentQaRoot: string
  /** The composition every scenario uses — wrapped, never replaced, by the failure legs. */
  composeTestHost(input: PostRunTailHostInput): LocalAgentHost
  /** The SHELL's hand-off, run where the shell runs it: before any verdict output (404 D-05). */
  stepEnqueue(): Promise<void>
  options(overrides?: Partial<PostRunTailOperations>): RunPostRunTailOptions
}

function fixture(): Fixture {
  const agentQaRoot = mkdtempSync(join(tmpdir(), 'agent-qa-388-05-'))
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
  writeFileSync(
    join(runDir, EVENTS_FILE),
    `${FIXTURE_EVENT_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  )

  const composeTestHost = (): LocalAgentHost => {
    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: TEST_CONFIG,
      knowledgeRoot: () => knowledgeRoot,
      model: () => TEST_MODEL,
      idSource: DIGEST_JOB_ID_SOURCE,
      postRun: {
        curateRun: async () => ({ curated: 2, deprecated: 1, complete: true }),
        // True of this substitute: it returns counts without ever reaching candidate emission.
        candidateProse: 'masker-active',
      },
    })
    hosts.push(host)
    return host
  }

  return {
    agentQaRoot,
    composeTestHost,
    async stepEnqueue(): Promise<void> {
      await enqueueThroughTheStep({
        runId: RUN_ID,
        agentQaRoot,
        configPath: join(agentQaRoot, 'agent-qa.config.yaml'),
        composeHost: composeTestHost,
      })
    },
    options(overrides: Partial<PostRunTailOperations> = {}): RunPostRunTailOptions {
      return {
        runId: RUN_ID,
        agentQaRoot,
        configPath: join(agentQaRoot, 'agent-qa.config.yaml'),
        knowledgeConfig: { dir: 'knowledge' },
        configDir: agentQaRoot,
        // The PRODUCTION log object, not a double. Every post-run line's channel is therefore
        // run.ts's choice and not this file's, which is what makes the stdout comparison a
        // statement about the product.
        log: curationTailLog,
        operations: {
          resolveKnowledgeRoot: () => knowledgeRoot,
          runCurationTail: async () => undefined,
          composeHost: composeTestHost,
          ...overrides,
        },
      }
    },
  }
}

/**
 * The two process channels, captured as ordered byte sequences.
 *
 * `console.log` is stdout and `console.error`/`console.warn` are stderr — Node's contract, and
 * the reason the split is meaningful here: the reporter and the CLI's navigation lines are the
 * stdout stream a `| tee` or a CI log parser consumes, and JOBQ-06 is the promise that a
 * post-run concern never appears in it.
 */
interface Channels {
  stdout: string
  stderr: string
}

function captureChannels(channels: Channels): () => void {
  const toStdout = (...args: unknown[]): void => {
    channels.stdout += `${args.map((arg) => String(arg)).join(' ')}\n`
  }
  const toStderr = (...args: unknown[]): void => {
    channels.stderr += `${args.map((arg) => String(arg)).join(' ')}\n`
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(toStdout),
    vi.spyOn(console, 'error').mockImplementation(toStderr),
    vi.spyOn(console, 'warn').mockImplementation(toStderr),
  ]
  return () => {
    for (const spy of spies) spy.mockRestore()
  }
}

interface Scenario {
  /** What the process would exit with. */
  exitCode: number
  /** Everything on each channel, first byte to last. */
  stdout: string
  stderr: string
  /** The same two, snapshotted the instant before the tail is entered. */
  verdictScopedStdout: string
  verdictScopedStderr: string
  /** Anything the wrapper's defensive boundary had to catch — this must stay empty (D-07). */
  unexpectedErrors: unknown[]
  /** Ordered landmarks, for the freeze-before-post-processing pin. */
  order: string[]
  /** Everything on stdout at the instant the drain leg ran. */
  stdoutAtDrain: string | undefined
}

/**
 * One complete run of the production shape: reporter → navigation → freeze → wrapper → tail.
 *
 * The reporter, the navigation line and the exit-code freeze happen before the snapshot; the
 * tail is CONSTRUCTED after it, so the snapshot boundary is exactly where run.ts's boundary is
 * and anything the tail does — including anything its construction does (388-02 D-3) — falls on
 * the far side of the comparison.
 */
async function runScenario(
  f: Fixture,
  input: {
    operations?: Partial<PostRunTailOperations>
    detach?: boolean
    /** What the shell's post-verdict step reported (404 D-05). Default: an ordinary hand-off. */
    enqueueOutcome?: RunPostRunTailOptions['enqueueOutcome']
  } = {},
): Promise<Scenario> {
  const channels: Channels = { stdout: '', stderr: '' }
  const order: string[] = []
  let stdoutAtDrain: string | undefined
  // The shell's post-verdict step, at the point the shell runs it: between `verdict` and
  // `runFinished`, i.e. BEFORE any of the verdict-scoped output below. Skipped when the caller
  // is modelling a step whose own hand-off failed.
  if (input.enqueueOutcome !== 'failed') await f.stepEnqueue()

  const restore = captureChannels(channels)
  try {
    // 1. The SHIPPED console reporter over the SHIPPED envelope fixture, through the reporter's
    //    own injected writer. `plain`/`isTTY:false` remove the TTY control codes so what is
    //    compared is the text a CI log holds.
    const reporterFixture = buildReporterFixture()
    const reporter = createConsoleReporter({
      plain: true,
      colorize: false,
      verbose: true,
      isTTY: false,
      write: (chunk: string) => {
        channels.stdout += chunk
      },
    })
    for (const envelope of reporterFixture.envelopes) reporter.handler(envelope)
    await reporter.flush()

    // 2. The CLI's navigation line, on the channel `printRunId` uses (pinned by source below).
    console.log(`Run ID: ${RUN_ID}`)
    order.push('verdict-output')

    // 3. The freeze — the REAL mapping, from the fixture's own aggregate verdict.
    const exitCode = mapVerdictToExitCode('failed')
    order.push('exit-code-frozen')

    const verdictScopedStdout = channels.stdout
    const verdictScopedStderr = channels.stderr

    // 4. The tail, bound exactly as both run.ts sites bind it. Each leg records the moment the
    //    WRAPPER called it — the ordering claim is about the wrapper's gates, so a landmark
    //    that vanished when a leg short-circuited would let a reorder hide behind an absence.
    const tail = runPostRunTail({
      ...f.options(input.operations),
      enqueueOutcome: input.enqueueOutcome ?? 'enqueued',
    })
    const unexpectedErrors: unknown[] = []
    const returned = await runVerdictFirstCurationTail({
      exitCode,
      detach: input.detach === true,
      runTail: async () => {
        order.push('drain')
        stdoutAtDrain = channels.stdout
        await tail.drain()
      },
      finish: async (i) => {
        order.push('finish')
        await tail.finish(i)
      },
      onUnexpectedError: (error) => {
        unexpectedErrors.push(error)
      },
    })

    return {
      exitCode: returned,
      stdout: channels.stdout,
      stderr: channels.stderr,
      verdictScopedStdout,
      verdictScopedStderr,
      unexpectedErrors,
      order,
      stdoutAtDrain,
    }
  } finally {
    restore()
  }
}

/** Split a captured channel into the verdict-scoped prefix and whatever the tail added. */
function tailSuffix(whole: string, prefix: string): string {
  expect(whole.startsWith(prefix)).toBe(true)
  return whole.slice(prefix.length)
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0)
}

/**
 * The PUMP, rejected inside the store — the truest form of "the drain failed".
 *
 * The real composition is WRAPPED rather than replaced: everything else about the host, the
 * queue and the handlers stays the shipped thing, so what the clean run and this run differ by
 * is one rejected call and nothing else.
 *
 * 2026-08-26: this used to reject `queue.enqueue`. The tail does not enqueue any more (404 D-05),
 * so the equivalent injection one layer along is the claim the pump makes — same host, same
 * wrapper idiom, same single rejected call.
 */
function rejectThePump(f: Fixture, message: string): Partial<PostRunTailOperations> {
  return {
    composeHost: (composeInput) => {
      const host = f.composeTestHost(composeInput)
      return {
        ...host,
        jobs: async () => {
          const jobs = await host.jobs()
          return {
            ...jobs,
            queue: {
              ...jobs.queue,
              runNextJob: async () => {
                throw new Error(message)
              },
            },
          }
        },
      } as unknown as LocalAgentHost
    },
  }
}

/** The host itself refusing to open its store — the pump never reaches a queue at all. */
function rejectTheStoreOpen(f: Fixture, message: string): Partial<PostRunTailOperations> {
  return {
    composeHost: (composeInput) => ({
      ...f.composeTestHost(composeInput),
      jobs: async () => {
        throw new Error(message)
      },
    }) as unknown as LocalAgentHost,
  }
}

describe('an induced post-processing failure is invisible to the verdict', () => {
  it('is byte-identical to the clean run in exit code and verdict-scoped output', async () => {
    const clean = await runScenario(fixture())
    const failing = fixture()
    // The 404 D-05 posture: the SHELL's step already failed the hand-off and already published
    // `post-run-enqueue-failed` on the bus. What this scenario measures is what the tail does
    // with that news — which is nothing at all, on either channel.
    const failed = await runScenario(failing, { enqueueOutcome: 'failed' })

    // The verdict-scoped output is REAL and substantial — a byte comparison of two empty
    // strings would prove nothing, so this is asserted before anything is compared to it.
    expect(clean.verdictScopedStdout.length).toBeGreaterThan(500)
    expect(clean.verdictScopedStdout).toContain('Checkout test')
    expect(clean.verdictScopedStdout).toContain(`Run ID: ${RUN_ID}`)

    // 1. The exit code. Strictly equal, and equal to the verdict's own mapping.
    expect(failed.exitCode).toBe(clean.exitCode)
    expect(clean.exitCode).toBe(mapVerdictToExitCode('failed'))

    // 2. The reporter and the navigation, WHOLE SEQUENCE. Not a line pick, not a substring:
    //    every byte either process wrote to stdout, compared as one string.
    expect(failed.stdout).toBe(clean.stdout)
    // …and the tail contributed none of them, in either scenario. This is the assertion that
    // makes the equality above load-bearing rather than a coincidence of two equal prefixes:
    // a post-run line routed to stdout appears in exactly one of the two runs.
    expect(clean.stdout).toBe(clean.verdictScopedStdout)
    expect(failed.stdout).toBe(failed.verdictScopedStdout)

    // 3. The stderr prefix — everything written before the tail — is byte-identical too.
    expect(failed.verdictScopedStderr).toBe(clean.verdictScopedStderr)

    // 4. The failed run adds NOTHING after the boundary. The D-07 warning is the shell's now, so
    //    a tail that printed one here would be the second, quieter copy of a sentence a user
    //    already read — and any byte at all here would have to be one nobody asked for.
    const failedSuffix = tailSuffix(failed.stderr, failed.verdictScopedStderr)
    const cleanSuffix = tailSuffix(clean.stderr, clean.verdictScopedStderr)
    expect(lines(failedSuffix)).toEqual([])
    // The clean run's own close-out is the other half of the divergence: the suffixes DIFFER,
    // which is why the prefix identity above is a claim and not an artefact. Since 389 D-12
    // the clean drain also prints a block after the close-out, and since 391 D-17 that block
    // is the DIGEST — headed by the run, carrying the same clustered analysis section through
    // the same relocated renderer, and then the chain and the decisions waiting on a human.
    const cleanLines = lines(cleanSuffix)
    expect(cleanLines[0]).toContain(`post-processing complete for ${RUN_ID}`)
    expect(cleanLines[1]).toBe(`digest — ${RUN_ID}`)
    expect(cleanLines[2]).toBe('analysis — 2 distinct problems:')
    // The sections D-18 names, all present and all counts. 432-09 (D-25): nothing waits on a
    // human; this host reads no mark ledger, and the digest says so rather than omitting the line.
    expect(cleanSuffix).toContain('marks — ledger not read here')
    expect(cleanSuffix).not.toMatch(/pending overall|minted this run/)
    expect(cleanSuffix).toContain('candidates — ')
    expect(cleanSuffix).toContain('quarantine — 0 quarantined · 0 expired')
    expect(cleanSuffix).not.toBe(failedSuffix)

    // 5. Nothing escaped the tail. The wrapper's defensive boundary was never needed — a tail
    //    that rethrew would land here even though the exit code survived (D-07).
    expect(clean.unexpectedErrors).toEqual([])
    expect(failed.unexpectedErrors).toEqual([])
  })

  it.each([
    {
      leg: 'the knowledge root cannot be resolved',
      inject: (): Partial<PostRunTailOperations> => ({
        resolveKnowledgeRoot: () => {
          throw new Error('the knowledge root is unresolvable')
        },
      }),
      detail: 'the knowledge root is unresolvable',
    },
    {
      leg: 'the job store will not open',
      inject: (f: Fixture): Partial<PostRunTailOperations> =>
        rejectTheStoreOpen(f, 'the job store could not be opened'),
      detail: 'the job store could not be opened',
    },
    {
      leg: 'the queue rejects the pump',
      inject: (f: Fixture): Partial<PostRunTailOperations> =>
        rejectThePump(f, 'the job store rejected the claim'),
      detail: 'the job store rejected the claim',
    },
    {
      leg: 'the durable status read fails',
      inject: (): Partial<PostRunTailOperations> => ({
        readPostProcessingStatus: async (): Promise<PostProcessingStatus> => {
          throw new Error('the status projection could not be read')
        },
      }),
      detail: 'the status projection could not be read',
    },
  ])('warns and resolves with the frozen code when $leg', async ({ inject, detail }) => {
    const reference = await runScenario(fixture())
    const failing = fixture()
    const failed = await runScenario(failing, { operations: inject(failing) })

    expect(failed.exitCode).toBe(reference.exitCode)
    // The whole verdict-scoped sequence, unmoved by the failure.
    expect(failed.stdout).toBe(reference.stdout)
    expect(failed.stdout).toBe(failed.verdictScopedStdout)
    expect(failed.verdictScopedStderr).toBe(reference.verdictScopedStderr)
    // Warned, on stderr, after the boundary — and never thrown.
    const suffix = tailSuffix(failed.stderr, failed.verdictScopedStderr)
    expect(suffix).toContain(detail)
    expect(lines(suffix).length).toBeGreaterThanOrEqual(1)
    expect(failed.unexpectedErrors).toEqual([])
  })
})

describe('the structural halves', () => {
  it('runs the drain only after the verdict output is complete and the code is frozen',
    async () => {
      const f = fixture()
      const scenario = await runScenario(f)

      // A behavioural pin, not a source grep: a wrapper that moved a post-run leg ahead of the
      // freeze, or past the detach gate, reorders this list. Two landmarks rather than three
      // since 404 D-05 — the hand-off is the shell's, and it is bounded and degraded there.
      expect(scenario.order).toEqual([
        'verdict-output',
        'exit-code-frozen',
        'drain',
        'finish',
      ])
      // The drain observed a verdict-scoped output that was already whole — and nothing was
      // appended to it afterwards, so no post-processing byte can precede a verdict byte.
      expect(scenario.stdoutAtDrain).toBe(scenario.verdictScopedStdout)
      expect(scenario.stdout).toBe(scenario.stdoutAtDrain)
      expect(scenario.exitCode).toBe(mapVerdictToExitCode('failed'))
    })

  it('skips only the drain under --detach, with the close-out on the same channel',
    async () => {
      const f = fixture()
      const scenario = await runScenario(f, { detach: true })

      // D-03 under the 404 D-05 tail shape: the close-out runs, the drain does not, and the
      // hand-off already happened in the shell — which is what `--detach` has always meant
      // (RESEARCH Pitfall 8) and no longer needs a leg here to express.
      expect(scenario.order).toEqual(['verdict-output', 'exit-code-frozen', 'finish'])
      expect(scenario.stdout).toBe(scenario.verdictScopedStdout)
      expect(scenario.exitCode).toBe(mapVerdictToExitCode('failed'))
      expect(scenario.unexpectedErrors).toEqual([])
      const suffix = tailSuffix(scenario.stderr, scenario.verdictScopedStderr)
      expect(lines(suffix)).toEqual([
        'post-processing — analysis: pending · curation: pending'
        // 389 D-12: nothing drained under --detach, so the line carries the fetch command.
        + ` · digest: ${digestFetchCommand(RUN_ID)}`,
      ])
    })

  it('routes both run.ts tail sites through the one helper and no legacy per-site tail', () => {
    const source = readFileSync(
      new URL('../commands/run.ts', import.meta.url),
      'utf8',
    )
    // Pitfall 1's regression pin: two sites, one helper, TWO legs each since 404 D-05.
    //
    // 404 D-06: the helper is `composeCliPostRunTail`, and `runPostRunTail` is named at NEITHER
    // site any more. The composition moved so the `runs.start` door could reach the same one —
    // three spellings of "how this project's tail is composed" is how a field added to the tail
    // reaches two of them.
    expect(source.match(/composeCliPostRunTail\(/gu) ?? []).toHaveLength(2)
    expect(source.match(/runPostRunTail\(/gu) ?? []).toHaveLength(0)
    expect(source.match(/runVerdictFirstCurationTail\(/gu) ?? []).toHaveLength(2)
    // 404 D-05: neither site enqueues. A site that reacquired an enqueue leg would be a SECOND
    // durable hand-off path — invisible behind the store's idempotency index, and the reason the
    // dashboard, MCP and daemon doors queued nothing at all before the relocation.
    expect(source.match(/postRunTail\.enqueue\(\)/gu) ?? []).toHaveLength(0)
    // …and both sites tell the shell's step what to do about post-processing.
    expect(source.match(/postProcessing:/gu) ?? []).toHaveLength(2)
    // 404-01 (D-10): both drains now PUMP UNDER THE LEASE the shell's post-verdict step decided
    // on. The pin follows the call shape rather than loosening to `drain(`, because a site that
    // went back to a bare `drain()` would be a site consulting the writer lease a second time —
    // answered `held` by its own process, handing the chain off to nobody (Pitfall 3).
    //
    // 2026-08-27 (CR-01): the shape is a THUNK. Taking the authority is what acquires it, so a
    // site that evaluates the take as the ARGUMENT has minted the lease before `drain()` is
    // entered — outside the try whose `finally` releases, and past the take-once flag the step's
    // no-leak backstop reads. A composition failure inside `drain()` then held the project's
    // writer fence, unheartbeated, for its whole TTL under a wire that already said `drained`.
    expect(
      source.match(
        /postRunTail\.drain\(\{\s*takeLease: \(\) => postVerdict\.takeAcquiredLease\(\),\s*\}\)/gu,
      ) ?? [],
    ).toHaveLength(2)
    expect(source.match(/postRunTail\.drain\(\)/gu) ?? []).toHaveLength(0)
    expect(
      source.match(/drain\(\{\s*lease:/gu) ?? [],
      'CR-01: a pre-evaluated authority is acquired outside the pump\'s own release',
    ).toHaveLength(0)
    expect(source.match(/postRunTail\.finish\(/gu) ?? []).toHaveLength(2)
    // The v51 per-site tail is named at neither site any more (388-02's extraction).
    expect(source.match(/runCurationTail\(/gu) ?? []).toHaveLength(0)
    // …and the navigation line this file mirrors is on stdout, where the tail never writes.
    expect(source).toContain('console.log(`Run ID: ${runId}`)')
  })
})
