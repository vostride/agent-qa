// Byte sequences of both channels are compared, so no post-run byte precedes a verdict byte.

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

// Passthrough: the fixture speaks canonical workspace-relative bytes, and core pins the recipe.
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-isolation'
const EVENTS_FILE = 'events.jsonl'

// Unparseable text, not a throw: a throwing model aborts the chain; this degrades to the floor.
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
  /** The SHELL's hand-off, run where the shell runs it: before any verdict output. */
  stepEnqueue(): Promise<void>
  options(overrides?: Partial<PostRunTailOperations>): RunPostRunTailOptions
}

function fixture(): Fixture {
  const agentQaRoot = mkdtempSync(join(tmpdir(), 'agent-qa-'))
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

// Stdout is what a `| tee` or CI log parser consumes, so no post-run concern may appear in it.
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
  /** Anything the wrapper's defensive boundary had to catch — this must stay empty. */
  unexpectedErrors: unknown[]
  /** Ordered landmarks, for the freeze-before-post-processing pin. */
  order: string[]
  /** Everything on stdout at the instant the drain leg ran. */
  stdoutAtDrain: string | undefined
}

// The tail is built after the snapshot, so anything it does falls past the comparison boundary.
async function runScenario(
  f: Fixture,
  input: {
    operations?: Partial<PostRunTailOperations>
    detach?: boolean
    /** What the shell's post-verdict step reported. Default: an ordinary hand-off. */
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

// The real composition wrapped, so the runs differ by one rejected pump call and nothing else.
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
    // The shell's step already failed the hand-off and said so; the tail adds nothing more.
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

    // The failed run adds nothing after the boundary; the enqueue warning is the shell's.
    const failedSuffix = tailSuffix(failed.stderr, failed.verdictScopedStderr)
    const cleanSuffix = tailSuffix(clean.stderr, clean.verdictScopedStderr)
    expect(lines(failedSuffix)).toEqual([])
    // The clean run's suffix differs, with close-out and digest, so the prefix identity is a claim.
    const cleanLines = lines(cleanSuffix)
    expect(cleanLines[0]).toContain(`post-processing complete for ${RUN_ID}`)
    expect(cleanLines[1]).toBe(`digest — ${RUN_ID}`)
    expect(cleanLines[2]).toBe('analysis — 2 distinct problems:')
    // Every digest section is present; this host reads no mark ledger, and the digest says so.
    expect(cleanSuffix).toContain('marks — ledger not read here')
    expect(cleanSuffix).not.toMatch(/pending overall|minted this run/)
    expect(cleanSuffix).toContain('candidates — ')
    expect(cleanSuffix).toContain('quarantine — 0 quarantined · 0 expired')
    expect(cleanSuffix).not.toBe(failedSuffix)

    // Nothing escaped the tail: a tail that rethrew would land here even with the exit code intact.
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

      // Moving a post-run leg ahead of the freeze or past the detach gate reorders this list.
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

      // Under `--detach` the close-out runs and the drain does not; the shell already handed off.
      expect(scenario.order).toEqual(['verdict-output', 'exit-code-frozen', 'finish'])
      expect(scenario.stdout).toBe(scenario.verdictScopedStdout)
      expect(scenario.exitCode).toBe(mapVerdictToExitCode('failed'))
      expect(scenario.unexpectedErrors).toEqual([])
      const suffix = tailSuffix(scenario.stderr, scenario.verdictScopedStderr)
      expect(lines(suffix)).toEqual([
        'post-processing — analysis: pending · curation: pending'
        // Nothing drained under `--detach`, so the line carries the fetch command.
        + ` · digest: ${digestFetchCommand(RUN_ID)}`,
      ])
    })

  it('routes both run.ts tail sites through the one helper and no legacy per-site tail', () => {
    const source = readFileSync(
      new URL('../commands/run.ts', import.meta.url),
      'utf8',
    )
    // Each verdict site composes its tail through `composeCliPostRunTail`.
    expect(source.match(/composeCliPostRunTail\(/gu) ?? []).toHaveLength(2)
    expect(source.match(/runPostRunTail\(/gu) ?? []).toHaveLength(0)
    expect(source.match(/runVerdictFirstCurationTail\(/gu) ?? []).toHaveLength(2)
    // Neither site enqueues; a second enqueue would be a durable hand-off hidden by idempotency.
    expect(source.match(/postRunTail\.enqueue\(\)/gu) ?? []).toHaveLength(0)
    // …and both sites tell the shell's step what to do about post-processing.
    expect(source.match(/postProcessing:/gu) ?? []).toHaveLength(2)
    // A thunk: evaluating the take as an argument acquires the lease outside the releasing `try`.
    expect(
      source.match(
        /postRunTail\.drain\(\{\s*takeLease: \(\) => postVerdict\.takeAcquiredLease\(\),\s*\}\)/gu,
      ) ?? [],
    ).toHaveLength(2)
    expect(source.match(/postRunTail\.drain\(\)/gu) ?? []).toHaveLength(0)
    expect(
      source.match(/drain\(\{\s*lease:/gu) ?? [],
      'a pre-evaluated authority is acquired outside the pump\'s own release',
    ).toHaveLength(0)
    expect(source.match(/postRunTail\.finish\(/gu) ?? []).toHaveLength(2)
    // Neither site names the per-site curation tail.
    expect(source.match(/runCurationTail\(/gu) ?? []).toHaveLength(0)
    // …and the navigation line this file mirrors is on stdout, where the tail never writes.
    expect(source).toContain('console.log(`Run ID: ${runId}`)')
  })
})
