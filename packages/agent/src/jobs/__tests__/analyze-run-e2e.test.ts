// The ANLZ-04 acceptance E2E — 40 red tests, N distinct problems.
//
// The phase's headline story driven through the REAL path, never a shortcut: the real
// analyze-run handler (floor → author → artifact → checkpoint) with a scripted model, then
// the `analysis.get` op over the persisted artifact — the same op the CLI tail prints from
// and the run page will serve. Three legs:
//
//   1. 40 failures, ONE shared anchor and cause → exactly 1 cluster, count 40, every member
//      ref present — AND all 40 per-test sentences still served (ANLZ-03: presentation
//      dedupes, sentences never disappear).
//   2. The same run shape with TWO causes → exactly 2 clusters with correct membership
//      (N problems — not 1, not 40).
//   3. The SAME 40-failure fixture as the D-01 compaction stressor: a pinned tiny
//      test-injected inputBudget forces every ladder rung (verified against the exported
//      ladder itself), and the prompt the scripted model actually received still carries
//      BOTH forced channels for every analyzed test — prior-build history and the served
//      brief + retrieval trace — because compaction squeezes the window, never the channels.

import {
  canonicalJson,
  slugBranch,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  AnalysisGetOutput,
  CompletedRunHandoff,
  FunctionCaller,
  Job,
  RunAnalysisArtifact,
} from '@vostride/agent-qa-schema'
import { sha256hex } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../../functions/invoke.js'
import { ANALYSIS_GET_FUNCTION_ID } from '../../functions/ops/analysis-get.js'
import { createFunctionRegistry } from '../../functions/registry.js'
import type { FunctionDeps } from '../../functions/spec.js'
import { buildEvidencePacks, compactEvidencePacks } from '../evidence-diet.js'
import type { EvidenceHistoryLookup } from '../evidence-diet.js'
import { createRealJobKindRegistry } from '../kinds.js'
import type { PostRunJobCapabilities, TestOutcomeHistoryLike } from '../kinds.js'
import type { JobHandlerContext } from '../kind-registry.js'
import type { JobModelRequest } from '../record-llm-authorship.js'
import { buildSyntheticHandoff } from './fixtures/synthetic-handoff.js'

const EVIDENCE_TEXT = 'Error: element "Submit" not found'

// no `grantedScopes` or `safeMode` on the caller; the registry reads
// neither.
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

// ------------------------------------------------------------------------------------------
// The end-to-end harness: real handler, scripted model (requests CAPTURED), then the op.
// ------------------------------------------------------------------------------------------

interface HarnessOptions {
  /** Scripted model answers, one per generate call; unscripted calls answer ''. */
  readonly modelOutputs?: readonly string[]
  readonly readTestHistory?: PostRunJobCapabilities['readTestHistory']
  readonly analysisTokenBudget?: PostRunJobCapabilities['analysisTokenBudget']
}

function harness(handoff: CompletedRunHandoff, options: HarnessOptions = {}) {
  const recorded = new Map<string, unknown>()
  const calls: string[] = []
  const published: { checkpointId: string; value: unknown }[] = []
  const artifacts: RunAnalysisArtifact[] = []
  const requests: JobModelRequest[] = []
  let generateCalls = 0

  const model = {
    modelId: 'scripted-e2e',
    generate: async (request: JobModelRequest): Promise<{ text: string }> => {
      requests.push(request)
      generateCalls += 1
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
    ...(options.analysisTokenBudget === undefined
      ? {}
      : { analysisTokenBudget: options.analysisTokenBudget }),
  }

  const record = async (checkpointId: string, value: unknown): Promise<void> => {
    calls.push(`record:${checkpointId}`)
    published.push({ checkpointId, value })
    recorded.set(checkpointId, value)
  }

  const context: JobHandlerContext = {
    job: {
      id: 'job_analyze_389_e2e',
      kind: 'analyze-run',
      status: 'queued',
      summary: 'fixture',
      attempts: 1,
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as unknown as Job,
    payload: {
      runId: String(handoff.runId),
      handoffDigest: sha256hex(canonicalJson(handoff)),
      handoffSchemaVersion: handoff.schemaVersion,
      executionContext: handoff.executionContext,
    },
    publishCheckpoint: record,
    recordLlmAuthorship: (async <T>(
      checkpointId: string,
      author: (capability: typeof model) => Promise<T>,
    ): Promise<T> => {
      if (recorded.has(checkpointId)) return recorded.get(checkpointId) as T
      const value = await author(model)
      await record(checkpointId, value)
      return value
    }) as unknown as JobHandlerContext['recordLlmAuthorship'],
  }

  return {
    calls,
    published,
    artifacts,
    requests,
    generateCallCount: () => generateCalls,
    run: () => createRealJobKindRegistry(capabilities).require('analyze-run').handler(context),
  }
}

/** Read the persisted artifact back through the ONE producer, exactly as the CLI tail does. */
async function readThroughTheOp(
  handoff: CompletedRunHandoff,
  artifact: RunAnalysisArtifact,
): Promise<AnalysisGetOutput> {
  const registry = createFunctionRegistry({
    deps: {
      runs: {
        list: () => Promise.resolve([handoff]),
        get: (runId) => Promise.resolve(
          String(runId) === String(handoff.runId) ? handoff : undefined,
        ),
        readEvents: () => Promise.resolve([]),
        readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
      },
      knowledge: {
        listBundles: () => Promise.resolve([]),
        inspectRecords: () => Promise.resolve([]),
        diffSince: () => Promise.resolve([]),
        showRecord: ({ recordId }) =>
          Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
      },
      entities: {
        resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
        get: () => Promise.resolve(undefined),
      },
      config: {
        getMasked: () => Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [],
        }),
      },
      analysis: { getArtifact: () => artifact },
    } as FunctionDeps,
    // no `resolveExecutionContext` registry option; the registry reads
    // no context.
  })
  return await invokeFunction(
    registry,
    ANALYSIS_GET_FUNCTION_ID,
    { runId: String(handoff.runId) },
    CALLER,
  ) as AnalysisGetOutput
}

/** One valid authored wire entry for a stepped failure of the synthetic fixture. */
function wireEntry(
  testIndex: number,
  overrides: { class?: string; rationale?: string; discriminator?: string } = {},
): Record<string, unknown> {
  return {
    testIndex,
    class: overrides.class ?? 'app_bug',
    confidence: 0.85,
    memoryMisdirectionRuledOut: true,
    citedSteps: [0],
    citedArtifacts: [],
    rationale: overrides.rationale ?? 'the submit control is gone from the checkout DOM',
    groundingQuote: { stepIndex: 0, quote: EVIDENCE_TEXT },
    discriminator: overrides.discriminator ?? 'the same step passed on the previous build',
    nextAction: 'file the failure against the application with the quoted evidence',
    links: [],
  }
}

describe('40 red tests, one root cause → ONE cluster ×40 through the real path', () => {
  it('authors, persists, checkpoints and serves: 1 cluster, count 40, 40 per-test sentences',
    async () => {
      const handoff = buildSyntheticHandoff({ failureCount: 40 })
      // One shared class for one shared cause — the model sees the whole run at once and
      // answers all 40 members in the ONE call the harness scripts.
      const output = JSON.stringify({
        tests: Array.from({ length: 40 }, (_, index) => wireEntry(index)),
        patternNote: 'all 40 members fail on the same missing Submit control',
      })
      const h = harness(handoff, { modelOutputs: [output] })

      const outcome = await h.run()
      if (outcome.status !== 'complete') {
        throw new Error(`expected complete, got ${outcome.status}`)
      }
      // One whole-run model call; artifact durable strictly BEFORE the checkpoint value —
      // the D-09 ordering, held at scale.
      expect(h.generateCallCount()).toBe(1)
      expect(h.calls).toEqual(['persistAnalysis', 'record:verdicts-authored'])
      const value = (h.published[0] as { value: unknown }).value as Record<string, unknown>
      expect(Object.keys(value).sort()).toEqual(['runId', 'verdicts'])

      const analysis = await readThroughTheOp(handoff, h.artifacts[0] as RunAnalysisArtifact)

      // ANLZ-04's presentation law: 40 red tests present as ONE distinct problem.
      expect(analysis.clusters).toHaveLength(1)
      const cluster = analysis.clusters[0]!
      expect(cluster.count).toBe(40)
      expect(cluster.members).toHaveLength(40)
      expect(cluster.members.map((member) => member.testId)).toEqual(
        Array.from({ length: 40 }, (_, index) => `t_failed_${index}`),
      )

      // ANLZ-03's floor: every member test still CARRIES its own sentence — presentation
      // dedupes, sentences never disappear.
      expect(analysis.sentences).toHaveLength(40)
      expect(analysis.sentences.map((entry) => entry.perTest)).toEqual(
        Array.from({ length: 40 }, (_, index) => index),
      )
      for (const entry of analysis.sentences) {
        expect(entry.sentence).toContain(`app_bug: observed (step 0): "${EVIDENCE_TEXT}"`)
        expect(entry.sentence).toContain('next: ')
      }
      // The representative's sentence is LOOKED UP from the per-test list — the
      // cluster view and the expanded view cannot drift.
      expect(cluster.representative.sentence).toBe(
        analysis.sentences.find((entry) => entry.perTest === cluster.representative.testIndex)!
          .sentence,
      )
      // Every verdict is the author's upgrade, served through the one accessor.
      expect(analysis.verdicts).toHaveLength(40)
      for (const verdict of analysis.verdicts) {
        expect(verdict.class).toBe('app_bug')
        expect(verdict.producer).toBe('analyze-run')
      }
    })

  it('two distinct causes → exactly 2 clusters with correct membership (N problems)', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 4 })
    const output = JSON.stringify({
      tests: [
        wireEntry(0),
        wireEntry(1),
        wireEntry(2, {
          class: 'environment',
          rationale: 'the checkout backend answered 503 for both members',
          discriminator: 'every request to the payment service timed out this build',
        }),
        wireEntry(3, {
          class: 'environment',
          rationale: 'the checkout backend answered 503 for both members',
          discriminator: 'every request to the payment service timed out this build',
        }),
      ],
    })
    const h = harness(handoff, { modelOutputs: [output] })
    await h.run()

    const analysis = await readThroughTheOp(handoff, h.artifacts[0] as RunAnalysisArtifact)

    // Not 1 (the causes differ) and not 4 (the presentation dedupes): exactly 2.
    expect(analysis.clusters).toHaveLength(2)
    const memberships = analysis.clusters
      .map((cluster) => cluster.members.map((member) => member.testIndex).sort())
      .sort((left, right) => (left[0]! - right[0]!))
    expect(memberships).toEqual([[0, 1], [2, 3]])
    expect(analysis.clusters.map((cluster) => cluster.count).sort()).toEqual([2, 2])
    // All four members still carry their own sentence.
    expect(analysis.sentences).toHaveLength(4)
  })
})

describe('the same fixture as the compaction stressor (forced channels intact)', () => {
  /** The ladder's injected estimator for this leg: characters as tokens, deterministic. */
  const byLength = (text: string): number => text.length
  /**
   * Pinned tiny budget: nothing fits at ANY rung for the 40-pack fixture, so the ladder
   * provably walks every rung and returns rung 4 over budget — verified below against the
   * exported ladder itself, not assumed.
   */
  const INPUT_BUDGET = 10

  const LONG_EVIDENCE = `${EVIDENCE_TEXT} ${'x'.repeat(700)}`
  const SCREENSHOT_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const HISTORY: TestOutcomeHistoryLike = {
    passes: 3,
    failures: 2,
    heals: 0,
    flakeCount: 1,
    lastOutcomes: [{ buildOrdinal: 4, passed: true }],
    lastBuildOrdinal: 4,
  }

  function stressorHandoff(): CompletedRunHandoff {
    return buildSyntheticHandoff({
      failureCount: 40,
      buildOrdinal: 5,
      passingStepsBefore: 2,
      passingStepsAfter: 2,
      evidenceText: LONG_EVIDENCE,
      decisionScreenshotRefs: [{ id: 'shot-1', sha: SCREENSHOT_SHA }],
      retrievalTrace: {
        schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: [{ recordId: 'rec-e2e-trace', leg: 'lexical', rank: 1, score: 0.5 }],
        truncated: [],
      },
    })
  }

  it('forces every rung under the pinned budget and the prompt still carries both forced channels for all 40 tests',
    async () => {
      const handoff = stressorHandoff()
      // Garbage answers on purpose: this leg is about the PROMPT the author composed, and
      // the degrade path (one repair, then the floor) is the already-proven posture.
      const h = harness(handoff, {
        modelOutputs: ['not json', 'still not json'],
        readTestHistory: () => HISTORY,
        analysisTokenBudget: { estimate: byLength, inputBudget: INPUT_BUDGET },
      })
      await h.run()

      // The rung claim, established through the EXPORTED ladder over the same inputs — the
      // fixture with this budget engages rung 1, 2, 3 and 4 and still ends over budget.
      const history: EvidenceHistoryLookup = () => HISTORY
      const packs = buildEvidencePacks(
        handoff,
        Array.from({ length: 40 }, (_, index) => index),
        history,
      )
      const expected = compactEvidencePacks(packs, byLength, INPUT_BUDGET)
      expect(expected.rung).toBe(4)
      expect(expected.overBudget).toBe(true)

      // One author call + one repair, both captured.
      expect(h.generateCallCount()).toBe(2)
      const prompt = (h.requests[0] as JobModelRequest).prompt

      // The handler walked the SAME ladder to the same bytes: the first compacted pack's
      // canonical JSON appears verbatim in the volatile tier.
      expect(prompt).toContain(canonicalJson(expected.packs[0]))

      // Forced channel 1 — prior-build history — present for every analyzed test.
      expect(prompt.match(/"prior-build"/gu) ?? []).toHaveLength(40)
      // Forced channel 2 — the served brief and its serve-time retrieval trace — likewise.
      expect(prompt.match(/synthetic-brief-digest/gu) ?? []).toHaveLength(40)
      expect(prompt.match(/rec-e2e-trace/gu) ?? []).toHaveLength(40)

      // The rung effects, visible in the same prompt: refs stripped (rung 1), neighbors
      // gone (rungs 2–3), quotes capped at 500 chars (rung 4) — while the failing step and
      // the channels above survived whole.
      expect(prompt).not.toContain(SCREENSHOT_SHA)
      expect(prompt).not.toContain('neighbor step')
      // The quote rides the volatile tier as canonical JSON, so the truncation is asserted
      // on the JSON-escaped bytes: the capped 500-char prefix is present, the full text not.
      const escaped = (text: string): string => JSON.stringify(text).slice(1, -1)
      expect(prompt).not.toContain(escaped(LONG_EVIDENCE))
      expect(prompt).toContain(escaped(LONG_EVIDENCE.slice(0, 500)))

      // And the run still answers honestly through the op: 40 floor unknowns (the garbage
      // degraded per-test), every one still carrying its sentence.
      const analysis = await readThroughTheOp(handoff, h.artifacts[0] as RunAnalysisArtifact)
      expect(analysis.sentences).toHaveLength(40)
      for (const verdict of analysis.verdicts) expect(verdict.class).toBe('unknown')
    })
})
