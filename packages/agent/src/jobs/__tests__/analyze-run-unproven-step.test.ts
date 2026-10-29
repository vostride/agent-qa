// analyze-run never asks a model to label a test whose failing
// step the verifier left unproven; its floor verdict (the runner classifier's 'unknown' with the
// step's reason) passes through byte-identical. A not-met-only block stays eligible as today.
// The evidence diet quotes the step's conditionVerdicts block, without a saved file's difference
// text.

import { canonicalJson, sha256hex } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  ConditionVerdict,
  ConditionVerdictsEvidence,
  Job,
  RunAnalysisArtifact,
  StepEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import { classifyRootCause } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import { buildEvidencePacks } from '../evidence-diet.js'
import { createRealJobKindRegistry } from '../kinds.js'
import type { PostRunJobCapabilities } from '../kinds.js'
import type { JobHandlerContext } from '../kind-registry.js'
import type { JobModelRequest } from '../record-llm-authorship.js'
import { buildSyntheticHandoff } from './fixtures/synthetic-handoff.js'

const EVIDENCE_TEXT = 'Error: element "Submit" not found'
const UNPROVEN_ERROR =
  'Step failed: The draft was not saved — Unverified: "the setting is saved" (no re-read after reload)'

function block(verdict: ConditionVerdict): ConditionVerdictsEvidence {
  return {
    ending: 'give-up',
    conditions: [
      {
        quote: 'the setting is saved',
        verdict,
        reason: 'no re-read after reload',
        citations: [{ source: 'final-screen', quote: 'Settings', found: true }],
      },
    ],
  }
}

function floorVerdict(step: StepEvidence, testIndex: number): Verdict {
  const verdict = classifyRootCause({
    result: {
      name: 'judged member',
      filePath: 'tests/failed-0.yaml',
      status: 'failed',
      duration: 1,
      steps: [{ name: step.stepText, status: 'failed', duration: 1, error: UNPROVEN_ERROR, evidence: step }],
    },
    outcome: 'failed',
    testIndex,
  })
  if (verdict === undefined) throw new Error('a failed member always classifies')
  return verdict
}

/** Two stepped failures; member 0's failing step carries the block, member 1 is plain. */
function judgedHandoff(verdict: ConditionVerdict, failureCount = 2): CompletedRunHandoff {
  const base = buildSyntheticHandoff({ runId: 'run-439-unproven', failureCount })
  const tests = base.tests.map((test) => {
    if (test.testIndex !== 0) return test
    const steps = test.steps.map((step) =>
      step.verifierVerdict.pass
        ? step
        : {
            ...step,
            verifierVerdict: { pass: false, reasoning: UNPROVEN_ERROR },
            conditionVerdicts: block(verdict),
          },
    )
    return { ...test, steps, rootCause: floorVerdict(steps[0] as StepEvidence, test.testIndex) }
  })
  return { ...base, tests }
}

const SAVED_FILE_DIFFERENCE = 'line 2: expected «a,1» found «SECRETLINE»'

function savedFileBlock(): ConditionVerdictsEvidence {
  return {
    ending: 'give-up',
    conditions: [
      {
        quote: 'the export holds the order',
        verdict: 'not-met',
        needs: 'file',
        reason: 'the saved file differs at line 2',
        citations: [{ source: 'action', quote: 'Download "orders.csv"', found: true }],
        file: { name: 'match', content: 'differs', firstDifference: SAVED_FILE_DIFFERENCE },
      },
    ],
  }
}

/** Member 0's failing step and its neighbour both carry a saved-file difference. */
function savedFileHandoff(): CompletedRunHandoff {
  const base = buildSyntheticHandoff({
    runId: 'run-439-saved-file',
    failureCount: 2,
    passingStepsAfter: 1,
  })
  const tests = base.tests.map((test) => {
    if (test.testIndex !== 0) return test
    const steps = test.steps.map((step) =>
      step.verifierVerdict.pass
        ? { ...step, conditionVerdicts: savedFileBlock() }
        : {
            ...step,
            verifierVerdict: { pass: false, reasoning: UNPROVEN_ERROR },
            conditionVerdicts: savedFileBlock(),
          },
    )
    const failing = steps.find((step) => !step.verifierVerdict.pass) as StepEvidence
    return { ...test, steps, rootCause: floorVerdict(failing, test.testIndex) }
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
    id: 'job_analyze_439_unproven',
    kind: 'analyze-run',
    status: 'queued',
    summary: 'fixture',
    attempts: 1,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
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

describe('analysis of a run with an unproven step', () => {
  it('an unproven test is never model-labelled', async () => {
    const handoff = judgedHandoff('unverified')
    const floor = handoff.tests[0]?.rootCause as Verdict
    expect(floor.class).toBe('unknown')
    expect(floor.evidence.rationale).toBe(UNPROVEN_ERROR)

    const { requests, artifacts, run } = harness(handoff, [
      JSON.stringify({ tests: [authoredEntry(0), authoredEntry(1)] }),
    ])
    const outcome = await run()
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)

    expect(requests).toHaveLength(1)
    const prompt = (requests[0] as JobModelRequest).prompt
    expect(prompt.includes('stepped failure 0')).toBe(false)
    expect(prompt).toContain('stepped failure 1')

    const verdicts = (artifacts[0] as RunAnalysisArtifact).verdicts
    const unproven = verdicts.find((verdict) => verdict.perTest === 0)
    expect(canonicalJson(unproven)).toBe(canonicalJson(floor))
    expect(unproven).toStrictEqual(floor)
    expect(verdicts.find((verdict) => verdict.perTest === 1)?.class).toBe('app_bug')
  })

  it('a run whose only unknown member is unproven reaches no model', async () => {
    const handoff = judgedHandoff('inconclusive', 1)
    const { requests, artifacts, run } = harness(handoff, [])
    await run()

    expect(requests).toHaveLength(0)
    expect((artifacts[0] as RunAnalysisArtifact).verdicts).toStrictEqual([
      handoff.tests[0]?.rootCause,
    ])
  })

  it('a test with a not-met-only block is still eligible as today', async () => {
    const handoff = judgedHandoff('not-met')
    const { requests, artifacts, run } = harness(handoff, [
      JSON.stringify({ tests: [authoredEntry(0), authoredEntry(1)] }),
    ])
    await run()

    expect(requests).toHaveLength(1)
    expect((requests[0] as JobModelRequest).prompt).toContain('stepped failure 0')
    const authored = (artifacts[0] as RunAnalysisArtifact).verdicts.find(
      (verdict) => verdict.perTest === 0,
    )
    expect(authored?.producer).toBe('analyze-run')
  })

  it("the diet quotes the step's conditions", () => {
    const handoff = judgedHandoff('not-met')
    const [judged, plain] = buildEvidencePacks(handoff, [0, 1], () => undefined)
    const failing = judged?.steps.find((quote) => quote.role === 'failing')
    expect(failing?.conditionVerdicts).toEqual(block('not-met'))
    expect(failing?.conditionVerdicts).toEqual(handoff.tests[0]?.steps[0]?.conditionVerdicts)

    const plainFailing = plain?.steps.find((quote) => quote.role === 'failing')
    expect(plainFailing).toBeDefined()
    expect(plainFailing !== undefined && 'conditionVerdicts' in plainFailing).toBe(false)
  })

  it('a saved-file difference never reaches the analyze-run pack or prompt', async () => {
    const handoff = savedFileHandoff()
    const packs = buildEvidencePacks(handoff, [0, 1], () => undefined)
    const quotes = packs[0]?.steps ?? []
    expect(quotes.map((quote) => quote.role).sort()).toEqual(['failing', 'neighbor'])
    for (const quote of quotes) {
      const condition = quote.conditionVerdicts?.conditions[0]
      expect(condition?.verdict).toBe('not-met')
      expect(condition?.reason).toBe('the saved file differs at line 2')
      expect(condition?.file).toEqual({ name: 'match', content: 'differs' })
    }

    const { requests, run } = harness(handoff, [
      JSON.stringify({ tests: [authoredEntry(0), authoredEntry(1)] }),
    ])
    await run()
    expect(requests).toHaveLength(1)
    const prompt = (requests[0] as JobModelRequest).prompt
    expect(prompt).toContain('stepped failure 0')
    expect(prompt).toContain('the saved file differs at line 2')

    for (const text of [canonicalJson(packs), prompt]) {
      expect(text).not.toContain('SECRETLINE')
      expect(text).not.toContain('expected «')
      expect(text).not.toContain('firstDifference')
    }
  })
})
