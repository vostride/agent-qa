// The artifact is durable before the verdicts value is recorded, and a resume never re-authors.

import {
  asRecordId,
  canonicalJson,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  guardRunAnalysisArtifact,
  resolveRunVerdicts,
  sha256hex,
  slugBranch,
  VerdictSentencePartsSchema,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  Job,
  RunAnalysisArtifact,
  Verdict,
} from '@vostride/agent-qa-schema'
import { deterministicVerdict, UNKNOWN_SIGNAL_RATIONALE } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import { createRealJobKindRegistry } from '../kinds.js'
import type { PostRunJobCapabilities, TestOutcomeHistoryLike } from '../kinds.js'
import type { JobHandlerContext } from '../kind-registry.js'
import { buildSyntheticHandoff } from './fixtures/synthetic-handoff.js'

const EVIDENCE_TEXT = 'Error: element "Submit" not found'
const ANALYZE_JOB_ID = 'job_analyze_389_tracer'

interface HarnessOptions {
  readonly recorded?: Map<string, unknown>
  /** Scripted model answers, one per generate call; unscripted calls answer ''. */
  readonly modelOutputs?: readonly string[]
  /** Every generate call throws this message — the transport-failure leg. */
  readonly generateError?: string
  /** Binds the OPTIONAL readTestHistory capability member when provided. */
  readonly readTestHistory?: (query: {
    product: string
    filePath: string
    testName: string
  }) => TestOutcomeHistoryLike | undefined
}

/**
 * The jobs harness for one analyze-run invocation: stub capabilities recording call ORDER,
 * a generate-counting scripted model, and a faithful in-memory `recordLlmAuthorship` — read
 * the recorded value, on a miss invoke the author exactly once and record what it returned
 * before handing it back. The same control flow the engine's primitive ships, over a Map
 * instead of a store.
 */
function harness(handoff: CompletedRunHandoff, options: HarnessOptions = {}) {
  const recorded = options.recorded ?? new Map<string, unknown>()
  const calls: string[] = []
  const published: { checkpointId: string; value: unknown }[] = []
  const artifacts: RunAnalysisArtifact[] = []
  let authorInvocations = 0
  let generateCalls = 0

  const model = {
    modelId: 'stub',
    generate: async (): Promise<{ text: string }> => {
      generateCalls += 1
      if (options.generateError !== undefined) throw new Error(options.generateError)
      return { text: options.modelOutputs?.[generateCalls - 1] ?? '' }
    },
  }

  const capabilities: PostRunJobCapabilities = {
    loadCompletedRunHandoff: () => handoff,
    curateRun: async () => ({ curated: 0, deprecated: 0, complete: true }),
    persistAnalysis: (artifact) => {
      calls.push('persistAnalysis')
      artifacts.push(artifact)
    },
    ...(options.readTestHistory === undefined
      ? {}
      : { readTestHistory: options.readTestHistory }),
  }

  const record = async (checkpointId: string, value: unknown): Promise<void> => {
    calls.push(`record:${checkpointId}`)
    published.push({ checkpointId, value })
    recorded.set(checkpointId, value)
  }

  const job = {
    id: ANALYZE_JOB_ID,
    kind: 'analyze-run',
    status: 'queued',
    summary: 'fixture',
    attempts: 1,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  } as unknown as Job

  const context: JobHandlerContext = {
    job,
    payload: {
      runId: String(handoff.runId),
      handoffDigest: sha256hex(canonicalJson(handoff)),
      handoffSchemaVersion: handoff.schemaVersion,
      executionContext: handoff.executionContext,
    },
    publishCheckpoint: record,
    recordLlmAuthorship: (async <T>(
      checkpointId: string,
      author: (model: { modelId: string; generate: () => Promise<{ text: string }> }) => Promise<T>,
    ): Promise<T> => {
      if (recorded.has(checkpointId)) return recorded.get(checkpointId) as T
      authorInvocations += 1
      const value = await author(model)
      await record(checkpointId, value)
      return value
    }) as unknown as JobHandlerContext['recordLlmAuthorship'],
  }

  return {
    calls,
    published,
    artifacts,
    authorInvocationCount: () => authorInvocations,
    generateCallCount: () => generateCalls,
    run: () => createRealJobKindRegistry(capabilities).require('analyze-run').handler(context),
  }
}

/** A valid authored wire entry for one stepped failure of the synthetic handoff. */
function authoredWireEntry(testIndex: number): Record<string, unknown> {
  return {
    testIndex,
    class: 'app_bug',
    confidence: 0.85,
    memoryMisdirectionRuledOut: true,
    citedSteps: [0],
    citedArtifacts: [],
    rationale: 'the submit control is gone from the checkout DOM',
    groundingQuote: { stepIndex: 0, quote: EVIDENCE_TEXT },
    discriminator: 'the same step passed on the previous build',
    nextAction: 'file the failure against the application with the quoted evidence',
    links: [],
  }
}

/** The floor the handler projects: rootCause where persisted, the minted unknown elsewhere. */
function expectedFloor(handoff: CompletedRunHandoff): Verdict[] {
  return handoff.tests
    .filter((test) => test.outcome === 'failed')
    .map(
      (test) =>
        test.rootCause ??
        deterministicVerdict('unknown', UNKNOWN_SIGNAL_RATIONALE, [], test.testIndex),
    )
}

describe('the analyze-run tracer: artifact before checkpoint', () => {
  const persistedFlake = deterministicVerdict('flake', 'retryCount 2 > 0', [0], 0)
  const handoff = buildSyntheticHandoff({
    failureCount: 2,
    steplessFailureCount: 1,
    passedCount: 1,
    rootCauseFor: (index) => (index === 0 ? persistedFlake : undefined),
  })

  it('persists the artifact strictly before the verdicts-authored value is recorded', async () => {
    const { calls, run } = harness(handoff)
    const outcome = await run()

    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)
    // Strict order AND exactly once each: the artifact write is inside the author, the record
    // happens after the author returns, and neither runs twice.
    expect(calls).toEqual(['persistAnalysis', 'record:verdicts-authored'])
  })

  it('records exactly {runId, verdicts} — the frozen byte-shape', async () => {
    const { published, run } = harness(handoff)
    await run()

    expect(published).toHaveLength(1)
    const entry = published[0] as (typeof published)[number]
    expect(entry.checkpointId).toBe('verdicts-authored')
    const value = entry.value as Record<string, unknown>
    // Exact key-set, not a subset match: sentence parts must never ride the checkpoint.
    expect(Object.keys(value).sort()).toEqual(['runId', 'verdicts'])
    expect(value).toEqual({ runId: String(handoff.runId), verdicts: expectedFloor(handoff) })
  })

  it('writes an artifact the guard admits, with parts joined by perTest quoting real evidence', async () => {
    const { artifacts, run } = harness(handoff)
    await run()

    expect(artifacts).toHaveLength(1)
    const artifact = artifacts[0] as RunAnalysisArtifact
    expect(artifact.schemaVersion).toBe(CURRENT_ANALYSIS_SCHEMA_VERSION)
    expect(artifact.runId).toBe(String(handoff.runId))
    expect(artifact.verdicts).toEqual(expectedFloor(handoff))
    // The guard round-trip: what the author persists is what every reader admits.
    expect(guardRunAnalysisArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact)

    // One parts record per verdict, joined by perTest — never by array position.
    expect(artifact.parts.map((part) => part.perTest)).toEqual(
      artifact.verdicts.map((verdict) => verdict.perTest),
    )

    // The stepped failures quote the sub-action's captured error VERBATIM.
    const flakePart = artifact.parts.find((part) => part.perTest === 0)
    expect(flakePart?.groundingQuote).toEqual({ stepIndex: 0, quote: EVIDENCE_TEXT })
    expect(flakePart?.discriminator).toBe('flake: retryCount 2 > 0')

    // The floor's unknown gets the honest undetermined discriminator.
    const unknownPart = artifact.parts.find((part) => part.perTest === 1)
    expect(unknownPart?.discriminator).toBe('root cause undetermined')
    expect(unknownPart?.nextAction).toContain('inspect the run manually')

    // The step-less failure quotes its test-level outcome through the typed no-step arm —
    // never a fabricated stepIndex.
    const steplessPart = artifact.parts.find((part) => part.perTest === 2)
    expect(steplessPart?.groundingQuote).toEqual({ source: 'test-outcome', quote: 'failed' })
  })

  it('never re-enters the author and never rewrites the artifact on resume', async () => {
    const floor = expectedFloor(handoff)
    const recorded = new Map<string, unknown>([
      ['verdicts-authored', { runId: String(handoff.runId), verdicts: floor }],
    ])
    const { artifacts, authorInvocationCount, calls, run } = harness(handoff, { recorded })
    const outcome = await run()

    // The author callback body is never entered, and the artifact is never touched.
    expect(authorInvocationCount()).toBe(0)
    expect(artifacts).toHaveLength(0)
    expect(calls).toEqual([])

    // The resumed job still completes its chain work from the recorded value alone.
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)
    expect(outcome.next.map((request) => request.kind)).toEqual(['curate-memory'])
    expect(outcome.next[0]).toMatchObject({
      payload: { verdictSummary: { total: 3, byClass: { flake: 1, unknown: 2 } } },
    })
  })

  it('resolveRunVerdicts answers the artifact when present and the floor when absent', async () => {
    const { artifacts, run } = harness(handoff)
    await run()
    const artifact = artifacts[0] as RunAnalysisArtifact

    expect(resolveRunVerdicts(artifact, handoff)).toEqual(artifact.verdicts)
    expect(resolveRunVerdicts(undefined, handoff)).toEqual(expectedFloor(handoff))

    // A failed member without rootCause resolves to the minted unknown, byte-identical to
    // the runner's own fill — class, producer, confidence 0 and the fixed rationale.
    const minted = resolveRunVerdicts(undefined, handoff).find((verdict) => verdict.perTest === 1)
    expect(minted).toEqual(deterministicVerdict('unknown', UNKNOWN_SIGNAL_RATIONALE, [], 1))
    expect(minted?.class).toBe('unknown')
    expect(minted?.producer).toBe('deterministic-classifier')
  })

  it('validates agentqa:// links through EntityUriSchema and refuses a malformed ref', () => {
    const part = {
      perTest: 0,
      groundingQuote: { stepIndex: 0, quote: EVIDENCE_TEXT },
      discriminator: 'flake: retryCount 2 > 0',
      nextAction: 'watch for recurrence',
      links: ['agentqa://memory/MEM-001'],
    }
    expect(VerdictSentencePartsSchema.safeParse(part).success).toBe(true)
    // Case-mangled and free-form refs both fail the parse — never a bare string check.
    expect(
      VerdictSentencePartsSchema.safeParse({ ...part, links: ['agentqa://MEMORY/mem-001'] })
        .success,
    ).toBe(false)
    expect(
      VerdictSentencePartsSchema.safeParse({ ...part, links: ['not-a-uri'] }).success,
    ).toBe(false)
  })
})

describe('the full author behind the frozen checkpoint', () => {
  it('upgrades unknown floor members and persists LLM parts beside template parts', async () => {
    const persistedFlake = deterministicVerdict('flake', 'retryCount 2 > 0', [0], 0)
    const handoff = buildSyntheticHandoff({
      failureCount: 2,
      rootCauseFor: (index) => (index === 0 ? persistedFlake : undefined),
    })
    const output = JSON.stringify({ tests: [authoredWireEntry(1)] })
    const { artifacts, generateCallCount, published, run } = harness(handoff, {
      modelOutputs: [output],
    })

    const outcome = await run()
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)

    // One whole-run call authored the one unknown member.
    expect(generateCallCount()).toBe(1)

    const artifact = artifacts[0] as RunAnalysisArtifact
    // The deterministic flake is byte-identical to the floor; the unknown upgraded.
    expect(canonicalJson(artifact.verdicts[0])).toBe(canonicalJson(persistedFlake))
    const upgraded = artifact.verdicts[1] as Verdict
    expect(upgraded.class).toBe('app_bug')
    expect(upgraded.producer).toBe('analyze-run')

    // One producer-keyed rule: template parts for the deterministic member, LLM parts otherwise.
    expect(artifact.parts.map((part) => part.perTest)).toEqual([0, 1])
    expect(artifact.parts[0]?.discriminator).toBe('flake: retryCount 2 > 0')
    expect(artifact.parts[1]?.discriminator).toBe('the same step passed on the previous build')
    expect(artifact.parts[1]?.groundingQuote).toEqual({ stepIndex: 0, quote: EVIDENCE_TEXT })

    // The guard admits what was persisted, and the checkpoint stays the frozen shape with
    // the MERGED verdicts.
    expect(guardRunAnalysisArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact)
    const value = (published[0] as { value: unknown }).value as Record<string, unknown>
    expect(Object.keys(value).sort()).toEqual(['runId', 'verdicts'])
    expect(value.verdicts).toEqual(artifact.verdicts)
  })

  it('zero failed tests: no model call, empty artifact still written, checkpoint still publishes', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 0, passedCount: 2 })
    const { artifacts, generateCallCount, published, run } = harness(handoff)

    const outcome = await run()
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)

    expect(generateCallCount()).toBe(0)
    const artifact = artifacts[0] as RunAnalysisArtifact
    expect(artifact.verdicts).toEqual([])
    expect(artifact.parts).toEqual([])
    const value = (published[0] as { value: unknown }).value as Record<string, unknown>
    expect(Object.keys(value).sort()).toEqual(['runId', 'verdicts'])
    expect(value).toEqual({ runId: String(handoff.runId), verdicts: [] })
  })

  it('all-deterministic floor: no model call, floor verdicts with template parts', async () => {
    const persistedFlake = deterministicVerdict('flake', 'retryCount 2 > 0', [0], 0)
    const handoff = buildSyntheticHandoff({
      failureCount: 1,
      rootCauseFor: () => persistedFlake,
    })
    const { artifacts, generateCallCount, run } = harness(handoff)

    await run()

    expect(generateCallCount()).toBe(0)
    const artifact = artifacts[0] as RunAnalysisArtifact
    expect(artifact.verdicts).toEqual([persistedFlake])
    expect(artifact.parts[0]?.discriminator).toBe('flake: retryCount 2 > 0')
  })

  it('author transport failure propagates — no artifact, no checkpoint, retry territory', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const { artifacts, published, run } = harness(handoff, { generateError: 'socket hang up' })

    await expect(run()).rejects.toThrow('socket hang up')
    expect(artifacts).toHaveLength(0)
    expect(published).toHaveLength(0)
  })

  it('degrades honestly when the model answers garbage: floor unknown with honest-unknown parts', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const { artifacts, generateCallCount, run } = harness(handoff, {
      modelOutputs: ['not json', 'still not json'],
    })

    await run()

    // One repair round-trip, then degrade — never a third call.
    expect(generateCallCount()).toBe(2)
    const artifact = artifacts[0] as RunAnalysisArtifact
    expect(artifact.verdicts).toEqual([
      deterministicVerdict('unknown', UNKNOWN_SIGNAL_RATIONALE, [], 0),
    ])
    expect(artifact.parts[0]?.discriminator).toBe('root cause undetermined')
    expect(artifact.parts[0]?.nextAction).toContain('inspect the run manually')
  })

  it('keys history lookups by product + filePath + testName — never testId', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const queries: { product: string; filePath: string; testName: string }[] = []
    const history: TestOutcomeHistoryLike = {
      passes: 3,
      failures: 1,
      heals: 0,
      flakeCount: 0,
      lastOutcomes: [{ buildOrdinal: 0, passed: true }],
      lastBuildOrdinal: 0,
    }
    const { generateCallCount, run } = harness(handoff, {
      modelOutputs: [JSON.stringify({ tests: [authoredWireEntry(0)] })],
      readTestHistory: (query) => {
        queries.push(query)
        return history
      },
    })

    await run()

    expect(generateCallCount()).toBe(1)
    // Two consumers of ONE injected lookup — the diet's prior-build channel and the
    // author's context-tier history line — both keyed identically.
    expect(queries.length).toBeGreaterThanOrEqual(1)
    for (const query of queries) {
      // The projection's key, spelled the projection's way: product = slugBranch(scope.key),
      // the handoff's own filePath and display testName — the fixture's testId
      // ('t_failed_0') appears in NO field.
      expect(Object.keys(query).sort()).toEqual(['filePath', 'product', 'testName'])
      expect(query).toEqual({
        product: slugBranch(handoff.scope.key),
        filePath: 'tests/failed-0.yaml',
        testName: 'stepped failure 0',
      })
      expect(Object.values(query)).not.toContain('t_failed_0')
    }
  })

  it('compiles with every optional capability member unbound — the between-waves posture', async () => {
    // The default harness binds NONE of readTestHistory / analysisTokenBudget /
    // readEvidenceBlob; a run with an unknown member still authors (degraded diet, no
    // ladder, text-only) and never crashes.
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const { artifacts, run } = harness(handoff, {
      modelOutputs: [JSON.stringify({ tests: [authoredWireEntry(0)] })],
    })

    const outcome = await run()
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)
    expect((artifacts[0] as RunAnalysisArtifact).verdicts[0]?.producer).toBe('analyze-run')
  })
})

const SERVED_CANDIDATE = asRecordId('rec-served-candidate')

/** Serve one candidate record on step 0 of each listed member, leaving every other byte alone. */
function withCandidateServedOn(
  handoff: CompletedRunHandoff,
  testIndexes: readonly number[],
): CompletedRunHandoff {
  const tests = handoff.tests.map((test) =>
    !testIndexes.includes(test.testIndex)
      ? test
      : {
          ...test,
          steps: test.steps.map((step) =>
            step.stepIndex !== 0
              ? step
              : {
                  ...step,
                  servedBrief: {
                    ...step.servedBrief,
                    channel1: [
                      {
                        id: SERVED_CANDIDATE,
                        kind: 'fact',
                        summary: 'served candidate record',
                        trust: 0.2,
                        status: 'candidate',
                        servedAsCanary: false,
                        tier: 'L1',
                      },
                    ],
                  },
                },
          ),
        },
  ) as CompletedRunHandoff['tests']
  return { ...handoff, tests }
}

describe('the analyze-run handler stamps memoryOnPath on every persisted verdict', () => {
  it.each([
    { member: 'authored', modelOutputs: [JSON.stringify({ tests: [authoredWireEntry(1)] })], producer: 'analyze-run' },
    { member: 'degraded', modelOutputs: ['not json', 'still not json'], producer: 'deterministic-classifier' },
  ])('stamps a deterministic and an $member member whose path served a candidate, and no other', async ({ modelOutputs, producer }) => {
    const handoff = withCandidateServedOn(
      buildSyntheticHandoff({
        failureCount: 3,
        rootCauseFor: (index) =>
          index === 1 ? undefined : deterministicVerdict('flake', 'retryCount 2 > 0', [0], index),
      }),
      [0, 1],
    )
    const { artifacts, published, run } = harness(handoff, { modelOutputs })

    const outcome = await run()
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)

    const artifact = artifacts[0] as RunAnalysisArtifact
    const onPath = [{ recordId: SERVED_CANDIDATE, trust: 'candidate' }]
    expect(artifact.verdicts.map((verdict) => verdict.perTest)).toEqual([0, 1, 2])
    expect(artifact.verdicts[0]).toMatchObject({ producer: 'deterministic-classifier', memoryOnPath: onPath })
    expect(artifact.verdicts[1]).toMatchObject({ producer, memoryOnPath: onPath })
    expect(artifact.verdicts[2]).not.toHaveProperty('memoryOnPath')
    // The checkpoint carries the same stamped verdicts the artifact persisted.
    expect(published[0]?.value).toEqual({ runId: String(handoff.runId), verdicts: artifact.verdicts })
  })
})
