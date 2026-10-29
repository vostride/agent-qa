// The whole-run author (Phase 389, plan 04 — D-01/D-02/D-03, ANLZ-02).
//
// `authorRunAnalysis` is a pure composition over injected capabilities: ONE `model.generate`
// call over every unknown-verdict failure together (D-01 — no per-test fan-out, no second
// LLM stage), parse-with-repair capped at exactly one round-trip (D-03), per-test degrade
// to the deterministic floor for whatever still fails validation, and a merge law that
// upgrades `unknown` floor members ONLY — deterministic verdicts pass through
// byte-identical. The D-02 vision leg rides the same single request as optional image
// parts, gated on the capability's declared `vision` and a bound blob reader; every other
// posture is the L9 text-only degradation, structurally identical to the pre-widening
// request.
//
// Every leg here drives a scripted JobModelCapability stub — a plain object, no network —
// with a recorded-request capture, and the generate-call-count assertions are the D-01/D-03
// contract: exactly 1 on valid output, exactly 2 when the single repair engages, never 3.

import type { CompletedRunHandoff, Verdict } from '@vostride/agent-qa-schema'
import { asRecordId, canonicalJson } from '@vostride/agent-qa-schema'
import { deterministicVerdict, UNKNOWN_SIGNAL_RATIONALE } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import { buildEvidencePacks } from '../evidence-diet.js'
import type { EvidenceHistoryLookup } from '../evidence-diet.js'
import type { JobModelRequest } from '../record-llm-authorship.js'
import {
  AUTHOR_REPAIR_CAP,
  authorRunAnalysis,
  MAX_AUTHOR_IMAGES,
  stampVerdictMemoryOnPath,
} from '../analyze-run-author.js'
import { buildSyntheticHandoff } from './fixtures/synthetic-handoff.js'

const EVIDENCE_TEXT = 'Error: element "Submit" not found'
const VERIFIER_REASONING = 'the submit button never appeared on the checkout screen'

const NO_HISTORY: EvidenceHistoryLookup = () => undefined

// ---------------------------------------------------------------------------------------
// The scripted model: answers the queued texts in order, records every request it saw.
// Throwing when the script runs dry is deliberate — a third generate call is a bug this
// harness turns into a loud failure rather than an extra scripted answer.
// ---------------------------------------------------------------------------------------

interface ScriptedModel {
  readonly capability: {
    readonly modelId: string
    readonly vision?: boolean
    generate(request: JobModelRequest): Promise<{ text: string }>
  }
  requests(): readonly JobModelRequest[]
  calls(): number
}

function scriptedModel(
  outputs: readonly string[],
  options: { readonly vision?: boolean } = {},
): ScriptedModel {
  const requests: JobModelRequest[] = []
  let calls = 0
  return {
    capability: {
      modelId: 'scripted-author',
      ...(options.vision === undefined ? {} : { vision: options.vision }),
      async generate(request: JobModelRequest) {
        requests.push(request)
        const text = outputs[calls]
        calls += 1
        if (text === undefined) {
          throw new Error(`the script has no output for generate call ${calls}`)
        }
        return { text }
      },
    },
    requests: () => [...requests],
    calls: () => calls,
  }
}

/** The floor exactly as the handler projects it: rootCause where persisted, minted unknown else. */
function floorOf(handoff: CompletedRunHandoff): Verdict[] {
  return handoff.tests
    .filter((test) => test.outcome !== 'passed' && test.outcome !== 'skipped' && test.outcome !== 'cancelled')
    .map(
      (test) =>
        test.rootCause ??
        deterministicVerdict('unknown', UNKNOWN_SIGNAL_RATIONALE, [], test.testIndex),
    )
}

function unknownIndexes(floor: readonly Verdict[]): number[] {
  return floor.filter((verdict) => verdict.class === 'unknown').map((verdict) => verdict.perTest)
}

/** A valid authored entry for one stepped failure of the synthetic handoff. */
function authoredEntry(
  testIndex: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    ...overrides,
  }
}

function outputOf(entries: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ tests: entries })
}

function authorInput(
  handoff: CompletedRunHandoff,
  overrides: Record<string, unknown> = {},
) {
  const floor = floorOf(handoff)
  return {
    handoff,
    floor,
    packs: buildEvidencePacks(handoff, unknownIndexes(floor), NO_HISTORY),
    history: NO_HISTORY,
    ...overrides,
  }
}

describe('authorRunAnalysis: one whole-run call', () => {
  it('makes exactly ONE generate call on valid output, covering every unknown in one prompt', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2 })
    const model = scriptedModel([outputOf([authoredEntry(0), authoredEntry(1)])])

    const result = await authorRunAnalysis(model.capability, authorInput(handoff))

    expect(model.calls()).toBe(1)
    const request = model.requests()[0] as JobModelRequest
    // Both analyzed tests ride the one prompt — no per-test fan-out.
    expect(request.prompt).toContain('stepped failure 0')
    expect(request.prompt).toContain('stepped failure 1')
    expect(result.verdicts.map((verdict) => verdict.class)).toEqual(['app_bug', 'app_bug'])
  })

  it('invites cross-test pattern notes in the stable tier — the "40 reds, one cause" enrichment', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2 })
    const model = scriptedModel([outputOf([authoredEntry(0), authoredEntry(1)])])

    await authorRunAnalysis(model.capability, authorInput(handoff))

    const request = model.requests()[0] as JobModelRequest
    expect(request.system ?? '').toMatch(/pattern/i)
  })

  it('propagates a model throw to the caller — transport failure is job-retry territory', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const model: ScriptedModel['capability'] = {
      modelId: 'throwing',
      async generate() {
        throw new Error('socket hang up')
      },
    }

    await expect(authorRunAnalysis(model, authorInput(handoff))).rejects.toThrow(
      'socket hang up',
    )
  })
})

describe('the merge law: upgrade unknown floor members ONLY', () => {
  it('upgrades unknowns with producer forced code-side; deterministic members byte-identical', async () => {
    const environment = deterministicVerdict('environment', 'DNS resolution failed', [0], 0)
    const flake = deterministicVerdict('flake', 'retryCount 2 > 0', [0], 2)
    const handoff = buildSyntheticHandoff({
      failureCount: 3,
      rootCauseFor: (index) => (index === 0 ? environment : index === 2 ? flake : undefined),
    })
    // The script re-classes ALL THREE — including the two deterministic members — and even
    // claims a producer. Only the unknown may move, and the producer claim is discarded.
    const model = scriptedModel([
      outputOf([
        authoredEntry(0, { class: 'app_bug' }),
        authoredEntry(1, { class: 'app_bug', producer: 'deterministic-classifier' }),
        authoredEntry(2, { class: 'app_bug' }),
      ]),
    ])

    const input = authorInput(handoff)
    const result = await authorRunAnalysis(model.capability, input)

    expect(model.calls()).toBe(1)
    expect(canonicalJson(result.verdicts[0])).toBe(canonicalJson(environment))
    expect(canonicalJson(result.verdicts[2])).toBe(canonicalJson(flake))
    const upgraded = result.verdicts[1] as Verdict
    expect(upgraded.class).toBe('app_bug')
    expect(upgraded.producer).toBe('analyze-run')
    expect(upgraded.confidence).toBe(0.85)
    expect(result.degradedTests).toEqual([])
  })

  it('returns authored parts for upgraded members only, joined by perTest', async () => {
    const flake = deterministicVerdict('flake', 'retryCount 2 > 0', [0], 0)
    const handoff = buildSyntheticHandoff({
      failureCount: 2,
      rootCauseFor: (index) => (index === 0 ? flake : undefined),
    })
    const model = scriptedModel([outputOf([authoredEntry(1)])])

    const result = await authorRunAnalysis(model.capability, authorInput(handoff))

    expect(result.authoredParts.map((parts) => parts.perTest)).toEqual([1])
    expect(result.authoredParts[0]?.groundingQuote).toEqual({ stepIndex: 0, quote: EVIDENCE_TEXT })
  })
})

describe('parse-with-repair, capped at exactly one round-trip', () => {
  it('repairs malformed-then-valid in exactly 2 calls, carrying the per-test reject reasons', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const invented = 'the submit button vanished from the checkout page entirely'
    const model = scriptedModel([
      outputOf([authoredEntry(0, { groundingQuote: { stepIndex: 0, quote: invented } })]),
      outputOf([authoredEntry(0)]),
    ])

    const result = await authorRunAnalysis(model.capability, authorInput(handoff))

    expect(model.calls()).toBe(2)
    const repairRequest = model.requests()[1] as JobModelRequest
    // The feedback names the failing test and the validator's own reason, verbatim enough
    // to correct against — the withRetryFeedback idiom.
    expect(repairRequest.prompt).toContain('quote not found')
    expect(repairRequest.prompt).toMatch(/test 0/i)
    expect(result.verdicts[0]?.class).toBe('app_bug')
    expect(result.verdicts[0]?.producer).toBe('analyze-run')
    expect(result.degradedTests).toEqual([])
  })

  it('degrades still-failing tests to the deterministic unknown and keeps valid siblings (per-test)', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2 })
    const floor = floorOf(handoff)
    const badQuote = { stepIndex: 0, quote: 'an observation the run never captured' }
    const model = scriptedModel([
      outputOf([
        authoredEntry(0),
        authoredEntry(1, { groundingQuote: badQuote }),
      ]),
      outputOf([
        authoredEntry(0),
        authoredEntry(1, { groundingQuote: badQuote }),
      ]),
    ])

    const result = await authorRunAnalysis(model.capability, authorInput(handoff))

    expect(model.calls()).toBe(2)
    // Test 0 validated on the first attempt and persists through the sibling's failure.
    expect(result.verdicts[0]?.class).toBe('app_bug')
    // Test 1 failed twice: byte-identical to the deterministic unknown floor member.
    expect(canonicalJson(result.verdicts[1])).toBe(canonicalJson(floor[1]))
    expect(result.degradedTests).toEqual([1])
    expect(result.authoredParts.map((parts) => parts.perTest)).toEqual([0])
  })

  it('never makes a third call: the cap is a structural bound, not a retry budget', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const floor = floorOf(handoff)
    // THREE malformed outputs scripted; a third call would consume one and pass — instead
    // the author must stop at 2 and degrade.
    const model = scriptedModel(['not json at all', 'still not json', 'never reached'])

    const result = await authorRunAnalysis(model.capability, authorInput(handoff))

    expect(AUTHOR_REPAIR_CAP).toBe(1)
    expect(model.calls()).toBe(1 + AUTHOR_REPAIR_CAP)
    expect(canonicalJson(result.verdicts[0])).toBe(canonicalJson(floor[0]))
    expect(result.degradedTests).toEqual([0])
  })

  it('answers with unfilled floor members when an analyzed test is missing from both outputs', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2 })
    const floor = floorOf(handoff)
    const model = scriptedModel([
      outputOf([authoredEntry(0)]),
      outputOf([authoredEntry(0)]),
    ])

    const result = await authorRunAnalysis(model.capability, authorInput(handoff))

    expect(model.calls()).toBe(2)
    const repairRequest = model.requests()[1] as JobModelRequest
    expect(repairRequest.prompt).toMatch(/test 1/i)
    expect(canonicalJson(result.verdicts[1])).toBe(canonicalJson(floor[1]))
    expect(result.degradedTests).toEqual([1])
  })
})

describe('the vision leg and the text-only degradations', () => {
  const SHA_A = 'sha-aaaa'
  const SHA_B = 'sha-bbbb'
  const BYTES_A = new Uint8Array([1, 2, 3])
  const BYTES_B = new Uint8Array([4, 5, 6])

  function blobReader(map: Record<string, Uint8Array>) {
    return (sha: string): Uint8Array | undefined => map[sha]
  }

  function visionHandoff() {
    return buildSyntheticHandoff({
      failureCount: 1,
      decisionScreenshotRefs: [
        { id: 'shot-1', sha: SHA_A },
        { id: 'shot-2', sha: SHA_A },
        { id: 'shot-3', sha: SHA_B },
      ],
    })
  }

  it('attaches the failing steps\' screenshot bytes to the ONE request when vision + reader allow', async () => {
    const handoff = visionHandoff()
    const model = scriptedModel([outputOf([authoredEntry(0)])], { vision: true })

    await authorRunAnalysis(
      model.capability,
      authorInput(handoff, { readEvidenceBlob: blobReader({ [SHA_A]: BYTES_A, [SHA_B]: BYTES_B }) }),
    )

    expect(model.calls()).toBe(1)
    const request = model.requests()[0] as JobModelRequest
    // Deduped by sha (three refs, two distinct shas), in pack order.
    expect(request.images).toEqual([BYTES_A, BYTES_B])
  })

  it('skips unresolvable shas rather than failing the request', async () => {
    const handoff = visionHandoff()
    const model = scriptedModel([outputOf([authoredEntry(0)])], { vision: true })

    await authorRunAnalysis(
      model.capability,
      authorInput(handoff, { readEvidenceBlob: blobReader({ [SHA_B]: BYTES_B }) }),
    )

    const request = model.requests()[0] as JobModelRequest
    expect(request.images).toEqual([BYTES_B])
  })

  it('caps the attached images at MAX_AUTHOR_IMAGES', async () => {
    const refs = Array.from({ length: MAX_AUTHOR_IMAGES + 3 }, (_, index) => ({
      id: `shot-${index}`,
      sha: `sha-${index}`,
    }))
    const blobs = Object.fromEntries(
      refs.map((ref, index) => [ref.sha, new Uint8Array([index])]),
    )
    const handoff = buildSyntheticHandoff({ failureCount: 1, decisionScreenshotRefs: refs })
    const model = scriptedModel([outputOf([authoredEntry(0)])], { vision: true })

    await authorRunAnalysis(
      model.capability,
      authorInput(handoff, { readEvidenceBlob: blobReader(blobs) }),
    )

    const request = model.requests()[0] as JobModelRequest
    expect(request.images).toHaveLength(MAX_AUTHOR_IMAGES)
  })

  it('sends a text-only request when the capability does not advertise vision', async () => {
    const handoff = visionHandoff()
    const model = scriptedModel([outputOf([authoredEntry(0)])])

    await authorRunAnalysis(
      model.capability,
      authorInput(handoff, { readEvidenceBlob: blobReader({ [SHA_A]: BYTES_A, [SHA_B]: BYTES_B }) }),
    )

    expect(model.calls()).toBe(1)
    const request = model.requests()[0] as JobModelRequest
    expect('images' in request).toBe(false)
  })

  it('sends a text-only request when no blob reader is bound, even with vision advertised', async () => {
    const handoff = visionHandoff()
    const model = scriptedModel([outputOf([authoredEntry(0)])], { vision: true })

    await authorRunAnalysis(model.capability, authorInput(handoff))

    const request = model.requests()[0] as JobModelRequest
    expect('images' in request).toBe(false)
  })

  it('sends a text-only request when the compaction ladder stripped the refs (rung >= 1)', async () => {
    const handoff = visionHandoff()
    const model = scriptedModel([outputOf([authoredEntry(0)])], { vision: true })

    // A budget the raw packs exceed but rung 1 satisfies: estimate = 0 once refs are gone.
    const estimate = (text: string): number => (text.includes('shot-1') ? 1_000_000 : 1)
    const result = await authorRunAnalysis(
      model.capability,
      authorInput(handoff, {
        readEvidenceBlob: blobReader({ [SHA_A]: BYTES_A, [SHA_B]: BYTES_B }),
        tokenBudget: { estimate, inputBudget: 10 },
      }),
    )

    expect(model.calls()).toBe(1)
    const request = model.requests()[0] as JobModelRequest
    expect('images' in request).toBe(false)
    expect(result.compaction.rung).toBeGreaterThanOrEqual(1)
    expect(result.compaction.overBudget).toBe(false)
  })

  it('surfaces overBudget from the ladder instead of swallowing it', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const model = scriptedModel([outputOf([authoredEntry(0)])])

    const result = await authorRunAnalysis(
      model.capability,
      authorInput(handoff, {
        tokenBudget: { estimate: (text: string) => text.length, inputBudget: 1 },
      }),
    )

    expect(result.compaction.rung).toBe(4)
    expect(result.compaction.overBudget).toBe(true)
  })

  it('the repair round-trip reuses the SAME image set — never a re-fetch, never a drop', async () => {
    const handoff = visionHandoff()
    let reads = 0
    const reader = (sha: string): Uint8Array | undefined => {
      reads += 1
      return sha === SHA_A ? BYTES_A : sha === SHA_B ? BYTES_B : undefined
    }
    const model = scriptedModel(
      ['not json at all', outputOf([authoredEntry(0)])],
      { vision: true },
    )

    await authorRunAnalysis(
      model.capability,
      authorInput(handoff, { readEvidenceBlob: reader }),
    )

    expect(model.calls()).toBe(2)
    const [first, second] = model.requests() as [JobModelRequest, JobModelRequest]
    expect(second.images).toEqual(first.images)
    // One resolve per distinct sha, not per attempt.
    expect(reads).toBe(2)
  })
})

const ALPHA = asRecordId('rec-alpha')

/** Serve one candidate record on step 0 of member 0, leaving every other byte alone. */
function withCandidateOnStepZero(handoff: CompletedRunHandoff): CompletedRunHandoff {
  const tests = handoff.tests.map((test) =>
    test.testIndex !== 0
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
                        id: ALPHA,
                        kind: 'fact',
                        summary: 'served record rec-alpha',
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

describe('stampVerdictMemoryOnPath', () => {
  it('stamps the records the path served and removes a declaration when it served none', () => {
    const clean = buildSyntheticHandoff({ failureCount: 1 })
    const served = withCandidateOnStepZero(clean)
    const declared = {
      ...deterministicVerdict('unknown', UNKNOWN_SIGNAL_RATIONALE, [0], 0),
      memoryOnPath: [{ recordId: asRecordId('rec-invented'), trust: 'candidate' }],
    } as unknown as Verdict

    const onPath = stampVerdictMemoryOnPath({
      verdict: declared,
      parts: undefined,
      test: served.tests[0],
    })
    expect(onPath.memoryOnPath).toEqual([{ recordId: ALPHA, trust: 'candidate' }])

    const offPath = stampVerdictMemoryOnPath({
      verdict: declared,
      parts: undefined,
      test: clean.tests[0],
    })
    expect(offPath).not.toHaveProperty('memoryOnPath')
  })
})

describe('authorship usage', () => {
  it('reports the model calls it made ONCE, capped at one repair', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const clean = scriptedModel([outputOf([authoredEntry(0)])])
    const repaired = scriptedModel(['not json at all', outputOf([authoredEntry(0)])])

    const first = await authorRunAnalysis(clean.capability, authorInput(handoff))
    const second = await authorRunAnalysis(repaired.capability, authorInput(handoff))

    expect(first.usage.modelCalls).toBe(1)
    expect(first.usage.repairCalls).toBe(0)
    expect(second.usage.modelCalls).toBe(1 + AUTHOR_REPAIR_CAP)
    expect(second.usage.repairCalls).toBe(AUTHOR_REPAIR_CAP)
    expect(second.usage.estimatedTokens).toBe(second.compaction.estimatedTokens)
  })
})
