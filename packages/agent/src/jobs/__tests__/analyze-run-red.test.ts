// A real recorded red handoff beside the synthetic, so cells cover the shape a session produced.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  canonicalJson,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardCompletedRunHandoff,
  sha256hex,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  AnalysisGetOutput,
  CompletedRunHandoff,
  FunctionCaller,
  Job,
  RunAnalysisArtifact,
  Verdict,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../../functions/invoke.js'
import { ANALYSIS_GET_FUNCTION_ID } from '../../functions/ops/analysis-get.js'
import { createFunctionRegistry } from '../../functions/registry.js'
import type { FunctionDeps } from '../../functions/spec.js'
import { createRealJobKindRegistry } from '../kinds.js'
import type { PostRunJobCapabilities } from '../kinds.js'
import type { JobHandlerContext } from '../kind-registry.js'
import type { JobModelRequest } from '../record-llm-authorship.js'
import { buildSyntheticHandoff } from './fixtures/synthetic-handoff.js'

const EVIDENCE_TEXT = 'Error: element "Submit" not found'

// No `grantedScopes` or `safeMode` on the caller; the registry reads neither.
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

// The harness from `analyze-run-e2e.test.ts`, plus a `vision` flag and a `readEvidenceBlob` seam.

interface HarnessOptions {
  /** Scripted model answers, one per generate call; unscripted calls answer ''. */
  readonly modelOutputs?: readonly string[]
  readonly vision?: boolean
  readonly readTestHistory?: PostRunJobCapabilities['readTestHistory']
  readonly readEvidenceBlob?: PostRunJobCapabilities['readEvidenceBlob']
}

function harness(handoff: CompletedRunHandoff, options: HarnessOptions = {}) {
  const recorded = new Map<string, unknown>()
  const artifacts: RunAnalysisArtifact[] = []
  const requests: JobModelRequest[] = []
  let generateCalls = 0

  const model = {
    modelId: 'scripted-406-red',
    ...(options.vision === undefined ? {} : { vision: options.vision }),
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
      artifacts.push(artifact)
    },
    ...(options.readTestHistory === undefined
      ? {}
      : { readTestHistory: options.readTestHistory }),
    ...(options.readEvidenceBlob === undefined
      ? {}
      : { readEvidenceBlob: options.readEvidenceBlob }),
  }

  const context: JobHandlerContext = {
    job: {
      id: 'job_analyze_406_red',
      kind: 'analyze-run',
      status: 'queued',
      summary: 'fixture',
      attempts: 1,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    } as unknown as Job,
    payload: {
      runId: String(handoff.runId),
      handoffDigest: sha256hex(canonicalJson(handoff)),
      handoffSchemaVersion: handoff.schemaVersion,
      executionContext: handoff.executionContext,
    },
    publishCheckpoint: async (checkpointId: string, value: unknown) => {
      recorded.set(checkpointId, value)
    },
    recordLlmAuthorship: (async <T>(
      checkpointId: string,
      author: (capability: typeof model) => Promise<T>,
    ): Promise<T> => {
      if (recorded.has(checkpointId)) return recorded.get(checkpointId) as T
      const value = await author(model)
      recorded.set(checkpointId, value)
      return value
    }) as unknown as JobHandlerContext['recordLlmAuthorship'],
  }

  return {
    artifacts,
    requests,
    generateCallCount: () => generateCalls,
    run: () => createRealJobKindRegistry(capabilities).require('analyze-run').handler(context),
  }
}

/** One valid `OUTPUT_CONTRACT` answer for a single analyzed member. */
function validAnswer(options: {
  readonly testIndex: number
  readonly citedStep: number
  readonly quote: string
}): string {
  return JSON.stringify({
    tests: [
      {
        testIndex: options.testIndex,
        class: 'app_bug',
        confidence: 0.86,
        memoryMisdirectionRuledOut: true,
        citedSteps: [options.citedStep],
        citedArtifacts: [],
        rationale: 'scripted',
        groundingQuote: { stepIndex: options.citedStep, quote: options.quote },
        discriminator: 'scripted discriminator',
        nextAction: 'scripted next action',
        links: [],
      },
    ],
  })
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
        get: (runId) =>
          Promise.resolve(String(runId) === String(handoff.runId) ? handoff : undefined),
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
        getMasked: () =>
          Promise.resolve({
            schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
            configPath: 'agent-qa.config.yaml',
            entries: [],
          }),
      },
      analysis: { getArtifact: () => artifact },
    } as FunctionDeps,
    // No `resolveExecutionContext` registry option; the registry reads no context.
  })
  return (await invokeFunction(
    registry,
    ANALYSIS_GET_FUNCTION_ID,
    { runId: String(handoff.runId) },
    CALLER,
  )) as AnalysisGetOutput
}

// ------------------------------------------------------------------------------------------
// The trimmed recorded fixture, loaded through the shipped guard, never a bare JSON.parse.
// ------------------------------------------------------------------------------------------

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/red-run-handoff.json', import.meta.url),
)

function load399RedHandoff(): CompletedRunHandoff {
  return guardCompletedRunHandoff(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')))
}

describe('the trimmed red handoff fixture still loads through the shipped guard', () => {
  it('is a captured red handoff that loads, with one failed member whose floor is unknown', () => {
    const handoff = load399RedHandoff()

    expect(handoff.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
    expect(handoff.aggregateVerdict).toBe('failed')
    expect(handoff.tests).toHaveLength(1)
    expect(handoff.tests[0]?.outcome).toBe('failed')
    expect(handoff.tests[0]?.rootCause?.class).toBe('unknown')
    expect(handoff.tests[0]?.rootCause?.producer).toBe('deterministic-classifier')
  })

  it('kept the evidence the author quotes from and the refs the vision gate reads', () => {
    const step = load399RedHandoff().tests[0]?.steps[1]

    expect(step?.stepText).toBeTruthy()
    expect(step?.retrievalTrace).toBeDefined()
    expect(step?.servedBrief).toBeDefined()
    const errors = (step?.subActions ?? []).filter((sub) => sub.result.error !== undefined)
    expect(errors.length).toBeGreaterThan(0)
    const refs = (step?.subActions ?? []).filter(
      (sub) => sub.decisionScreenshotRef !== undefined,
    )
    expect(refs.length).toBeGreaterThan(0)
  })
})

describe('(a) a red synthetic run whose model answers validly is authored in ONE call', () => {
  it('upgrades the unknown floor member to a producer: analyze-run verdict', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const run = harness(handoff, {
      modelOutputs: [validAnswer({ testIndex: 0, citedStep: 0, quote: EVIDENCE_TEXT })],
    })

    const outcome = await run.run()

    expect(outcome.status).toBe('complete')
    expect(run.generateCallCount()).toBe(1)
    const verdict = run.artifacts[0]?.verdicts[0] as Verdict
    expect(verdict.producer).toBe('analyze-run')
    expect(verdict.class).toBe('app_bug')
    expect(verdict.confidence).toBe(0.86)
  })

  it('serves a sentence carrying the scripted quote back through analysis.get', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const run = harness(handoff, {
      modelOutputs: [validAnswer({ testIndex: 0, citedStep: 0, quote: EVIDENCE_TEXT })],
    })

    await run.run()
    const served = await readThroughTheOp(handoff, run.artifacts[0] as RunAnalysisArtifact)

    expect(served.sentences[0]?.sentence).toContain(EVIDENCE_TEXT)
    expect(served.verdicts[0]?.producer).toBe('analyze-run')
  })
})

describe('(b) the REAL recorded red handoff is authored the same way', () => {
  it('upgrades its unknown member when the quote is verbatim from the failing step', async () => {
    const handoff = load399RedHandoff()
    const failingStep = handoff.tests[0]?.steps[1]
    const lastError = [...(failingStep?.subActions ?? [])]
      .reverse()
      .find((sub) => sub.result.error !== undefined)?.result.error as string
    // A verbatim contiguous substring of `subActions[].result.error` — the validator's rule.
    const quote = lastError.slice(0, 48)
    const run = harness(handoff, {
      modelOutputs: [
        validAnswer({
          testIndex: 0,
          citedStep: failingStep?.stepIndex ?? 1,
          quote,
        }),
      ],
    })

    const outcome = await run.run()

    expect(outcome.status).toBe('complete')
    expect(run.generateCallCount()).toBe(1)
    expect(run.artifacts[0]?.verdicts[0]?.producer).toBe('analyze-run')
    expect(run.artifacts[0]?.verdicts[0]?.class).toBe('app_bug')
  })
})

describe('(c) an unparseable model answer degrades to the floor and the job still COMPLETES', () => {
  it('spends the one repair round-trip, keeps deterministic-classifier, and hands on curation', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const run = harness(handoff, {
      modelOutputs: ['not an author payload', 'still not'],
    })

    const outcome = await run.run()

    expect(run.generateCallCount()).toBe(2)
    expect(run.artifacts[0]?.verdicts[0]?.producer).toBe('deterministic-classifier')
    expect(run.artifacts[0]?.verdicts[0]?.class).toBe('unknown')
    expect(outcome.status).toBe('complete')
    expect(
      (outcome as { next?: readonly { kind: string }[] }).next?.map((job) => job.kind),
    ).toContain('curate-memory')
  })
})

describe('(d) a capability that throws propagates out of the handler (no catch)', () => {
  it('rejects with the readTestHistory error rather than degrading to the floor', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const run = harness(handoff, {
      modelOutputs: [validAnswer({ testIndex: 0, citedStep: 0, quote: EVIDENCE_TEXT })],
      readTestHistory: () => {
        throw new Error('history read exploded')
      },
    })

    await expect(run.run()).rejects.toThrow('history read exploded')
  })

  it('rejects with the readEvidenceBlob error when a vision model reads a cited screenshot', async () => {
    const handoff = buildSyntheticHandoff({
      failureCount: 1,
      decisionScreenshotRefs: [
        { id: 'decision-screenshot:406', sha: 'a'.repeat(64) },
      ],
    })
    const run = harness(handoff, {
      vision: true,
      modelOutputs: [validAnswer({ testIndex: 0, citedStep: 0, quote: EVIDENCE_TEXT })],
      readEvidenceBlob: () => {
        throw new Error('blob read exploded')
      },
    })

    await expect(run.run()).rejects.toThrow('blob read exploded')
  })
})
