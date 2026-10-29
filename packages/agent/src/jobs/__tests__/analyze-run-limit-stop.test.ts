// analyze-run never asks a model to label a limit stop.
//
// A limit-stopped member's floor verdict is `unknown` (the run ran out of limit, not into an
// answer), and analyze-run authors every unknown floor member — so without the exclusion a model
// could turn a dead control into an `app_bug`. The handler is driven end to end with the scripted
// model and the in-memory recordLlmAuthorship from the analyze-run suites; the floor verdict for
// the limit-stopped member comes from the runner's own classifier.

import { canonicalJson, formatLimitStopReason, sha256hex } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  Job,
  LimitStopEvidence,
  RunAnalysisArtifact,
  StepEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import { classifyRootCause } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import { createRealJobKindRegistry } from '../kinds.js'
import type { PostRunJobCapabilities } from '../kinds.js'
import type { JobHandlerContext } from '../kind-registry.js'
import type { JobModelRequest } from '../record-llm-authorship.js'
import { buildSyntheticHandoff } from './fixtures/synthetic-handoff.js'

const EVIDENCE_TEXT = 'Error: element "Submit" not found'

const LIMIT_STOP: LimitStopEvidence = {
  limit: 'actions',
  configured: 30,
  used: 30,
  reason: formatLimitStopReason('actions', 30, 30),
  requestedOutcome: 'unverified',
  lastVerifierRejection: 'the Save button did nothing',
}

/** The floor verdict the runner's classifier mints for a member whose only step hit the limit. */
function limitFloorVerdict(step: StepEvidence, testIndex: number): Verdict {
  const verdict = classifyRootCause({
    result: {
      name: 'limit-stopped member',
      filePath: 'tests/failed-0.yaml',
      status: 'failed',
      duration: 1,
      steps: [
        {
          name: step.stepText,
          status: 'failed',
          duration: 1,
          error: LIMIT_STOP.reason,
          evidence: step,
        },
      ],
    },
    outcome: 'failed',
    testIndex,
  })
  if (verdict === undefined) throw new Error('a failed member always classifies')
  return verdict
}

/**
 * Two stepped failures: member 0 stopped at its action limit, member 1 a plain unknown failure.
 * `persistFloor` decides whether member 0 carries the runner's rootCause or is left to the
 * handler's minted unknown — the exclusion must hold either way.
 */
function limitHandoff(persistFloor: boolean, failureCount = 2): CompletedRunHandoff {
  const base = buildSyntheticHandoff({ runId: 'run-436-limit', failureCount })
  const tests = base.tests.map((test) => {
    if (test.testIndex !== 0) return test
    const steps = test.steps.map((step) =>
      step.verifierVerdict.pass
        ? step
        : {
            ...step,
            verifierVerdict: { pass: false, reasoning: LIMIT_STOP.reason },
            limitStop: LIMIT_STOP,
          },
    )
    const failing = steps[0] as StepEvidence
    return {
      ...test,
      steps,
      ...(persistFloor ? { rootCause: limitFloorVerdict(failing, test.testIndex) } : {}),
    }
  })
  return { ...base, tests }
}

function authoredEntry(testIndex: number): Record<string, unknown> {
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

/** The analyze-run handler over one handoff, with a scripted model that records its requests. */
function harness(handoff: CompletedRunHandoff, outputs: readonly string[]) {
  const requests: JobModelRequest[] = []
  const artifacts: RunAnalysisArtifact[] = []
  const recorded = new Map<string, unknown>()

  const model = {
    modelId: 'scripted-author',
    async generate(request: JobModelRequest): Promise<{ text: string }> {
      requests.push(request)
      const text = outputs[requests.length - 1]
      if (text === undefined) throw new Error(`no scripted output for call ${requests.length}`)
      return { text }
    },
  }

  const capabilities: PostRunJobCapabilities = {
    loadCompletedRunHandoff: () => handoff,
    curateRun: async () => ({ curated: 0, deprecated: 0, complete: true }),
    persistAnalysis: (artifact) => {
      artifacts.push(artifact)
    },
  }

  const job = {
    id: 'job_analyze_436_limit',
    kind: 'analyze-run',
    status: 'queued',
    summary: 'fixture',
    attempts: 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
  } as unknown as Job

  const context: JobHandlerContext = {
    job,
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
    requests,
    artifacts,
    run: () => createRealJobKindRegistry(capabilities).require('analyze-run').handler(context),
  }
}

describe('analysis leaves limit-stopped members to the floor', () => {
  it('analyze-run does not author a limit-stopped member', async () => {
    const handoff = limitHandoff(true)
    const floorForLimit = handoff.tests[0]?.rootCause as Verdict
    expect(floorForLimit.class).toBe('unknown')

    // The model is handed an app_bug answer for BOTH members; only the plain one may land.
    const { requests, artifacts, run } = harness(handoff, [
      JSON.stringify({ tests: [authoredEntry(0), authoredEntry(1)] }),
    ])
    const outcome = await run()
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)

    expect(requests).toHaveLength(1)
    const prompt = (requests[0] as JobModelRequest).prompt
    expect(prompt.includes('stepped failure 0')).toBe(false)
    expect(prompt).toContain('stepped failure 1')
    expect(prompt).not.toContain(LIMIT_STOP.reason)
    expect(floorForLimit.evidence.rationale).toBe(LIMIT_STOP.reason)

    expect(artifacts).toHaveLength(1)
    const verdicts = (artifacts[0] as RunAnalysisArtifact).verdicts
    const limitVerdict = verdicts.find((verdict) => verdict.perTest === 0)
    expect(canonicalJson(limitVerdict)).toBe(canonicalJson(floorForLimit))
    expect(limitVerdict).toStrictEqual(floorForLimit)

    const plain = verdicts.find((verdict) => verdict.perTest === 1)
    expect(plain?.class).toBe('app_bug')
    expect(plain?.producer).toBe('analyze-run')
  })

  it('a limit-stopped member with no persisted rootCause is not authored either', async () => {
    const handoff = limitHandoff(false)
    const { requests, artifacts, run } = harness(handoff, [
      JSON.stringify({ tests: [authoredEntry(0), authoredEntry(1)] }),
    ])
    await run()

    expect(requests).toHaveLength(1)
    expect((requests[0] as JobModelRequest).prompt).not.toContain('stepped failure 0')
    const limitVerdict = (artifacts[0] as RunAnalysisArtifact).verdicts.find(
      (verdict) => verdict.perTest === 0,
    )
    expect(limitVerdict?.class).toBe('unknown')
    expect(limitVerdict?.producer).toBe('deterministic-classifier')
  })

  it('a run whose only unknown member is limit-stopped reaches no model', async () => {
    const handoff = limitHandoff(true, 1)
    const { requests, artifacts, run } = harness(handoff, [])
    await run()

    expect(requests).toHaveLength(0)
    expect((artifacts[0] as RunAnalysisArtifact).verdicts).toStrictEqual([
      handoff.tests[0]?.rootCause,
    ])
  })
})
