// RED scaffold (Wave 1, Phase 360 · EXEC-07 · D-10/D-11 · spec §7.2/§12.2).
// Pins the structured assertValue split BEFORE Plan 10 wires it:
//   Block A — the pure runner comparator `compareAssertValue` (D-10 "runner judges"): one
//     deterministic case per closed op in the registered assertValue schema
//     (isNull/isDefined/equals/notEquals/gt/lt/contains); a mismatch carries both values; the
//     outcome shape matches AssertValueEvidence with sorted keys.
//   Block B — orchestration: the adapter reads the source and the runner comparator mints (D-10
//     division). Since 439 D-12 a passing assertValue on a completing step no longer short-circuits
//     the verifier: the verifier judges it with the read as evidence. Every AI-judged conclusion (assertAI or extractAI) goes through the step
//     verifier with the author's context (quick 261004-lsa), and verdictSource 'verifier-model'
//     is recorded only with the final verdict, so a rejection leaves it undefined. A false
//     assertAI never calls verify; a failing assertValue and a platform-unavailable source are
//     honest §7.1 failures the planner mediates; registered secrets arrive masked in evidence.
//
// RED BY DESIGN: Block A imports the not-yet-existing compound/assert-value.js
// (compareAssertValue) — the whole file fails at collection until Plan 10 lands the module, then
// the Block B un-wired-behavior pins take over (verdictSource / short-circuit / comparator mint).
// readAssertValueOutcomeMeta is added to compound/metadata.ts by Plan 10. Typecheck stays green
// via @ts-expect-error; action shapes not yet in the runner union ride the loose ActionPlan.action.
import { describe, it, expect } from 'vitest'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlan, AiJudgment, PlanResult, Planner, StepContext, Verifier } from '../types.js'
import type { VerifierStepRecord } from '../step-record.js'
import { scriptedVerification, toVerificationResult } from '../../testing/condition-verdicts.js'
import type { ScriptedVerdict } from '../../testing/condition-verdicts.js'
import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeStepContext, makePlanner, makeActionPlan } from './loop-harness.js'
import { SecretStore, SecretRedactor } from '../secrets.js'
// compareAssertValue landed in Plan 08 (compound/assert-value.js) — Block A goes green here.
import { compareAssertValue } from '../../compound/assert-value.js'
// readAssertValueOutcomeMeta landed in Plan 08 (compound/metadata.ts); the seam it reads is Plan 10.
import { readAssertValueOutcomeMeta } from '../../compound/metadata.js'

// ---------------------------------------------------------------------------
// Local harness helpers
// ---------------------------------------------------------------------------
function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

function readingAdapter(observation: ScreenState, read: ActionResult): PlatformAdapter {
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return observation
    },
    async execute(): Promise<ActionResult> {
      return read
    },
  }
}

interface LooseSub {
  result?: { success?: boolean; error?: string; metadata?: Record<string, unknown> }
}

function subs(result: Awaited<ReturnType<typeof executeStep>>): LooseSub[] {
  return (result.evidence as { subActions?: LooseSub[] } | undefined)?.subActions ?? []
}

interface ShortCircuitVerifier extends Verifier {
  verifyCalls: number
  judgeClaim(claim: string, screen: ScreenState, opts?: Record<string, unknown>): Promise<AiJudgment>
}

function makeShortCircuitVerifier(judgment: { verdict: boolean; rationale: string } = { verdict: true, rationale: 'ok' }): ShortCircuitVerifier {
  const v: ShortCircuitVerifier = {
    verifyCalls: 0,
    async verify(step, _before, after, action) {
      v.verifyCalls++
      return { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'ok' }) }
    },
    async judgeClaim() {
      return { outcome: 'judged', ...judgment }
    },
  }
  return v
}

interface ScriptedVerifier extends Verifier {
  verifyArgs: unknown[][]
  judgeClaimCalls: number
  extractCalls: number
  judgeClaim(claim: string, screen: ScreenState, opts?: Record<string, unknown>): Promise<AiJudgment>
  extractData(query: string, screen: ScreenState, opts?: Record<string, unknown>): Promise<Record<string, unknown>>
}

type Verification = ScriptedVerdict

function makeScriptedVerifier(script: {
  judgment?: { verdict: boolean; rationale: string }
  verdict?: Verification
  verifications?: Verification[]
  extracted?: Record<string, unknown>
}): ScriptedVerifier {
  const v: ScriptedVerifier = {
    verifyArgs: [],
    judgeClaimCalls: 0,
    extractCalls: 0,
    async verify(...args: Parameters<Verifier['verify']>) {
      v.verifyArgs.push(args)
      const [step, , after, action] = args
      const scripted = script.verifications?.[Math.min(v.verifyArgs.length - 1, script.verifications.length - 1)]
      const verdict = scripted ?? script.verdict ?? { success: true, reasoning: 'ok', isAppError: false }
      return { verification: toVerificationResult(verdict, { step, after, action }) }
    },
    async judgeClaim() {
      v.judgeClaimCalls++
      return { outcome: 'judged', ...(script.judgment ?? { verdict: true, rationale: 'ok' }) }
    },
    async extractData() {
      v.extractCalls++
      return script.extracted ?? {}
    },
  }
  return v
}

function verifyCall(args: unknown[]): { step: string; action: { type?: string }; authorContext: unknown } {
  return { step: args[0] as string, action: args[3] as { type?: string }, authorContext: args[8] }
}

function capturingPlanner(plans: ActionPlan[]): Planner & { failureContexts: (string | undefined)[] } {
  let call = 0
  const p = {
    failureContexts: [] as (string | undefined)[],
    async plan(_step: string, _state: ScreenState, context: StepContext): Promise<PlanResult> {
      p.failureContexts.push(context.failureContext)
      const plan = plans[Math.min(call, plans.length - 1)]
      call++
      return { plan }
    },
  }
  return p
}

interface EvidenceView {
  verdictSource?: string
  aiJudgment?: { verdict?: boolean }
  verifierVerdict?: { reasoning?: string }
}

const cfg = { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 }

// ---------------------------------------------------------------------------
// Block A — the pure comparator (D-10 "runner judges")
// ---------------------------------------------------------------------------
describe('Block A — compareAssertValue: one deterministic case per closed op (D-10)', () => {
  it('equals / notEquals', () => {
    expect(compareAssertValue({ source: 'url', op: 'equals', expected: 'https://x.test/home', actual: 'https://x.test/home' }).passed).toBe(true)
    expect(compareAssertValue({ source: 'url', op: 'notEquals', expected: 'https://x.test/home', actual: 'https://x.test/login' }).passed).toBe(true)
  })

  it('contains', () => {
    expect(compareAssertValue({ source: 'url', op: 'contains', expected: 'home', actual: 'https://x.test/home' }).passed).toBe(true)
  })

  it('gt / lt (numeric)', () => {
    expect(compareAssertValue({ source: 'expr-result', op: 'gt', expected: '10', actual: '11' }).passed).toBe(true)
    expect(compareAssertValue({ source: 'expr-result', op: 'lt', expected: '10', actual: '9' }).passed).toBe(true)
  })

  it('isNull / isDefined (no expected)', () => {
    expect(compareAssertValue({ source: 'storage', op: 'isNull', actual: null }).passed).toBe(true)
    expect(compareAssertValue({ source: 'storage', op: 'isDefined', actual: 'present' }).passed).toBe(true)
  })

  it('a mismatch is not-ok and carries both values; the outcome shape matches AssertValueEvidence sorted keys', () => {
    const r = compareAssertValue({ source: 'url', op: 'equals', expected: 'a', actual: 'b' })
    expect(r.passed).toBe(false)
    expect(r.expected).toBe('a')
    expect(r.actual).toBe('b')
    expect(Object.keys(r).sort()).toEqual(['actual', 'expected', 'op', 'passed', 'source'])
  })
})

// ---------------------------------------------------------------------------
// Block B — orchestration + the D-11 verifier short-circuit
// ---------------------------------------------------------------------------
describe('Block B — assertValue orchestration and the deterministic verifier short-circuit (D-10/D-11)', () => {
  it('a passing assertValue on a completing step mints a deterministic verdict with ZERO verifier.verify calls and verdictSource assert-value (D-10 adapter reads / runner judges, D-11)', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true, data: 'https://x.test/home' })
    const verifier = makeShortCircuitVerifier()
    const plan = makeActionPlan({ action: { type: 'assertValue', source: 'url', op: 'contains', expected: 'home' }, stepComplete: true })

    const result = await executeStep(
      'Assert the url contains home',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    // 439 D-12: the short-circuit is gone; the passing read is evidence the verifier judges.
    expect(verifier.verifyCalls).toBe(1)
    expect(result.status).toBe('passed')
    expect((result.evidence as { verdictSource?: string }).verdictSource).toBe('verifier-model')
    expect((result.evidence as { assertOutcome?: { passed?: boolean } }).assertOutcome?.passed).toBe(true)
  })

  it('a passing assertAI does not close the step by itself — the step verifier runs once and decides, verdictSource verifier-model (quick 261004-0hc)', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeShortCircuitVerifier({ verdict: true, rationale: 'the header is present' })
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: 'the header is present', mode: 'multimodal', effort: 'medium', consensus: 1 },
      stepComplete: true,
    })

    const result = await executeStep(
      'Assert the header via AI',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(verifier.verifyCalls).toBe(1)
    expect(result.status).toBe('passed')
    expect((result.evidence as { verdictSource?: string }).verdictSource).toBe('verifier-model')
  })

  it('bsky-16 tracer: the verifier, given the author context, rejects a passing-assertAI conclusion and the step does not pass', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({
      judgment: { verdict: true, rationale: 'the page shows the #caturday hashtag' },
      verdict: { success: false, reasoning: 'The final screen is Safari, not Bluesky', isAppError: false },
    })
    const assertTurn = makeActionPlan({
      action: {
        type: 'assertAI',
        claim: 'The current screen is the dedicated #caturday hashtag page, although this browser session is logged out',
        mode: 'multimodal',
        effort: 'medium',
        consensus: 1,
      },
      stepComplete: true,
    })
    const bail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })

    const planner = capturingPlanner([assertTurn, bail])

    const result = await executeStep(
      'Open the #caturday hashtag page',
      ports({ adapter, planner, verifier, plannerConfig: cfg }),
      makeStepContext({ testContext: 'Only the final screen is graded.' }),
    )

    expect(result.status).toBe('failed')
    // The rejected completion, then the give-up's own judgment (439 D-08).
    expect(verifier.verifyArgs).toHaveLength(2)
    expect(verifyCall(verifier.verifyArgs[0]).action.type).toBe('assertAI')
    expect(verifyCall(verifier.verifyArgs[0]).authorContext).toEqual({ testContext: 'Only the final screen is graded.' })
    expect(result.evidence?.conditionVerdicts?.ending).toBe('give-up')
    expect(verifier.judgeClaimCalls).toBe(1)
    expect(planner.failureContexts).toHaveLength(2)
    expect(planner.failureContexts[1]).toContain('The final screen is Safari, not Bluesky')
    const evidence = result.evidence as EvidenceView
    expect(evidence.verdictSource).toBeUndefined()
    expect(evidence.aiJudgment?.verdict).toBe(true)
    expect(evidence.verifierVerdict?.reasoning).not.toBe('Step verified deterministically from the assertion outcome')
  })

  it('the verifier accepts a passing-assertAI conclusion: the step passes on the verifier reasoning', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({
      judgment: { verdict: true, rationale: 'the page shows the #caturday hashtag' },
      verdict: { success: true, reasoning: 'Bluesky shows the #caturday results', isAppError: false },
    })
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: 'Bluesky shows the #caturday results', mode: 'multimodal', effort: 'medium', consensus: 1 },
      stepComplete: true,
    })

    const result = await executeStep(
      'Open the #caturday hashtag page',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    expect(verifier.verifyArgs).toHaveLength(1)
    expect(verifier.judgeClaimCalls).toBe(1)
    const evidence = result.evidence as EvidenceView
    expect(evidence.verdictSource).toBe('verifier-model')
    expect(evidence.verifierVerdict?.reasoning).toBe('Bluesky shows the #caturday results')
  })

  it('unchanged: a false assertAI never calls verify and never passes the step (self-correcting judged-false error)', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({ judgment: { verdict: false, rationale: 'no hashtag page is visible' } })
    const assertTurn = makeActionPlan({
      action: { type: 'assertAI', claim: 'the #caturday hashtag page is visible', mode: 'multimodal', effort: 'medium', consensus: 1 },
      stepComplete: true,
    })
    const bail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })

    const result = await executeStep(
      'Open the #caturday hashtag page',
      ports({ adapter, planner: makePlanner([assertTurn, bail]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    // The false assertAI's completion claim is never verified; the one call is the give-up's
    // own judgment (439 D-08).
    expect(verifier.verifyArgs).toHaveLength(1)
    expect(result.evidence?.conditionVerdicts?.ending).toBe('give-up')
    expect(result.status).toBe('failed')
    expect(subs(result)[0]?.result?.success).toBe(false)
    expect(subs(result)[0]?.result?.error).toContain('judged false')
  })

  it('an extractAI-concluded step goes through the step verifier with the author context (quick 261004-lsa)', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({
      extracted: { title: 'Home' },
      verdict: { success: true, reasoning: 'The page title is visible', isAppError: false },
    })
    const plan = makeActionPlan({
      action: { type: 'extractAI', query: 'the page title' },
      stepComplete: true,
    })

    const result = await executeStep(
      'Read the page title',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext({ testContext: 'The home page is open.' }),
    )

    expect(verifier.extractCalls).toBe(1)
    expect(verifier.verifyArgs).toHaveLength(1)
    expect(verifyCall(verifier.verifyArgs[0]).action.type).toBe('extractAI')
    expect(verifyCall(verifier.verifyArgs[0]).authorContext).toEqual({ testContext: 'The home page is open.' })
    expect(result.status).toBe('passed')
    expect((result.evidence as EvidenceView).verdictSource).toBe('verifier-model')
  })

  it('an extractAI-concluded step that the verifier rejects does not pass', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({
      extracted: {},
      verdict: { success: false, reasoning: 'No title is visible', isAppError: false },
    })
    const extractTurn = makeActionPlan({ action: { type: 'extractAI', query: 'the page title' }, stepComplete: true })
    const bail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })

    const result = await executeStep(
      'Read the page title',
      ports({ adapter, planner: makePlanner([extractTurn, bail]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    // The rejected completion, then the give-up's own judgment (439 D-08).
    expect(verifier.verifyArgs).toHaveLength(2)
    expect(verifyCall(verifier.verifyArgs[0]).action.type).toBe('extractAI')
    expect(result.evidence?.conditionVerdicts?.ending).toBe('give-up')
    expect(result.status).not.toBe('passed')
    expect((result.evidence as EvidenceView).verdictSource).toBeUndefined()
  })

  it('an always-rejecting verifier is bounded by the action limit and records no verdict source', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({
      judgment: { verdict: true, rationale: 'the header is present' },
      verdict: { success: false, reasoning: 'The header is not visible', isAppError: false },
    })
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: 'the header is present', mode: 'multimodal', effort: 'medium', consensus: 1 },
      stepComplete: true,
    })

    const result = await executeStep(
      'Verify the header is shown',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(result.status).toBe('failed')
    expect(result.error).toBe(
      'Stopped: action limit reached — 4 of 4 actions used — Not met: "Verify the header is shown" (The header is not visible)',
    )
    // One call per completion claim, plus the limit stop's own judgment (439 D-08).
    expect(verifier.verifyArgs.length).toBeLessThanOrEqual(cfg.maxActions + 1)
    expect(verifier.judgeClaimCalls).toBeLessThanOrEqual(cfg.maxActions)
    expect((result.evidence as EvidenceView).verdictSource).toBeUndefined()
  })

  it('reject, then re-assert, then accept: two verify calls, and the second turn carries the rejection', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({
      judgment: { verdict: true, rationale: 'the header is present' },
      verifications: [
        { success: false, reasoning: 'The header is hidden behind a dialog', isAppError: false },
        { success: true, reasoning: 'The header is shown', isAppError: false },
      ],
    })
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: 'the header is present', mode: 'multimodal', effort: 'medium', consensus: 1 },
      stepComplete: true,
    })
    const planner = capturingPlanner([plan])

    const result = await executeStep(
      'Verify the header is shown',
      ports({ adapter, planner, verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(verifier.verifyArgs).toHaveLength(2)
    expect(verifier.judgeClaimCalls).toBe(2)
    expect(result.status).toBe('passed')
    expect((result.evidence as EvidenceView).verdictSource).toBe('verifier-model')
    expect(planner.failureContexts[1]).toContain('The header is hidden behind a dialog')
  })

  it('an expected error passes: the verifier reads the refusal as success with isAppError false', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({
      judgment: { verdict: true, rationale: 'the error is shown' },
      verdict: { success: true, reasoning: 'The login was refused as the test expects', isAppError: false },
    })
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: "An 'Incorrect password' error is shown", mode: 'multimodal', effort: 'medium', consensus: 1 },
      stepComplete: true,
    })

    const result = await executeStep(
      'Log in with a wrong password and confirm the login is refused',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext({ testContext: 'The login must be refused.' }),
    )

    expect(result.status).toBe('passed')
    expect(verifier.verifyArgs).toHaveLength(1)
  })

  it('companion: an unexpected application error fails the step with no replan and records the verdict source', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeScriptedVerifier({
      judgment: { verdict: true, rationale: 'the error is shown' },
      verdict: { success: false, reasoning: 'The server returned HTTP 500', isAppError: true },
    })
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: "An 'Incorrect password' error is shown", mode: 'multimodal', effort: 'medium', consensus: 1 },
      stepComplete: true,
    })
    const planner = capturingPlanner([plan])

    const result = await executeStep(
      'Log in with a wrong password and confirm the login is refused',
      ports({ adapter, planner, verifier, plannerConfig: cfg }),
      makeStepContext({ testContext: 'The login must be refused.' }),
    )

    expect(result.status).toBe('failed')
    expect(result.error?.startsWith('Application error:')).toBe(true)
    expect(planner.failureContexts).toHaveLength(1)
    expect((result.evidence as EvidenceView).verdictSource).toBe('verifier-model')
  })

  it('control: a completing step without any assertion outcome verifies exactly once with verdictSource verifier-model', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true })
    const verifier = makeShortCircuitVerifier()
    const plan = makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true })

    const result = await executeStep(
      'Click submit',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(verifier.verifyCalls).toBe(1)
    expect((result.evidence as { verdictSource?: string }).verdictSource).toBe('verifier-model')
  })

  it('a failing assertValue is an honest §7.1 failure the planner mediates (D-10)', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true, data: 'https://x.test/login' })
    const verifier = makeShortCircuitVerifier()
    const assertTurn = makeActionPlan({ action: { type: 'assertValue', source: 'url', op: 'contains', expected: 'home' }, stepComplete: true })
    const bail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })

    const result = await executeStep(
      'Assert the url is home',
      ports({ adapter, planner: makePlanner([assertTurn, bail]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(subs(result)[0]?.result?.success).toBe(false)
  })

  it('a source unavailable on the platform surfaces a §7.1 error, never a crash (D-10)', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: false, error: 'storage source unavailable on this platform' })
    const verifier = makeShortCircuitVerifier()
    const assertTurn = makeActionPlan({ action: { type: 'assertValue', source: 'storage', op: 'isDefined' }, stepComplete: true })
    const bail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })

    const result = await executeStep(
      'Assert a storage value',
      ports({ adapter, planner: makePlanner([assertTurn, bail]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(result.status).toBe('failed')
  })

  it('registered-secret assertValue expected/actual values arrive masked in evidence (masked-before-record, T-360-01)', async () => {
    const store = new SecretStore({ TOKEN: 'sk-live-supersecret' })
    const redactor = new SecretRedactor(store)
    const adapter = readingAdapter(makeScreenState(), { success: true, data: 'sk-live-supersecret' })
    const verifier = makeShortCircuitVerifier()
    const plan = makeActionPlan({ action: { type: 'assertValue', source: 'storage', op: 'equals', expected: '{{secret:TOKEN}}' }, stepComplete: true })

    const result = await executeStep(
      'Assert the stored token',
      ports({ adapter, planner: makePlanner([plan]), verifier, secretStore: store, secretRedactor: redactor, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(JSON.stringify(result.evidence)).not.toContain('supersecret')
    const outcome = readAssertValueOutcomeMeta(subs(result)[0]?.result) as { passed?: boolean } | undefined
    expect(outcome).toBeDefined()
    expect(JSON.stringify(outcome)).not.toContain('supersecret')
  })
})

describe('C441-RUN-RECORDS', () => {
  const PW = 'Hunter-42-zz'
  const EMAIL = 'qa@example.com'

  function declared(values: Record<string, string>) {
    const secretStore = new SecretStore(values)
    return { secretStore, secretRedactor: new SecretRedactor(secretStore) }
  }

  async function runAssert(
    secrets: Record<string, string>,
    read: ActionResult,
    action: Record<string, unknown>,
  ) {
    const verifier = makeScriptedVerifier({})
    const bail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })
    const plan = makeActionPlan({ action: { type: 'assertValue', ...action } as never, stepComplete: true })
    const result = await executeStep(
      'Assert the stored value',
      ports({
        adapter: readingAdapter(makeScreenState(), read),
        planner: makePlanner([plan, bail]),
        verifier,
        ...declared(secrets),
        plannerConfig: cfg,
      }),
      makeStepContext(),
    )
    const outcome = (result.evidence as { assertOutcome?: { expected?: string; actual?: string | null } } | undefined)
      ?.assertOutcome
    const record = verifier.verifyArgs[0]?.[10] as VerifierStepRecord | undefined
    return { result, outcome, meta: readAssertValueOutcomeMeta(subs(result)[0]?.result), record }
  }

  function recorded(result: Awaited<ReturnType<typeof executeStep>>): string[] {
    return [JSON.stringify(result.evidence), ...subs(result).map((sub) => JSON.stringify(sub.result))]
  }

  it('an assertValue on a declared value records its marker in the outcome and the step result', async () => {
    const { result, outcome, meta } = await runAssert(
      { PW_441: PW },
      { success: true, data: `${PW} for ${EMAIL}` },
      { source: 'storage', op: 'contains', expected: '{{secret:PW_441}}' },
    )
    expect(result.status).toBe('passed')
    expect(outcome?.expected).toBe('[secret:PW_441]')
    expect(outcome?.actual).toBe(`[secret:PW_441] for ${EMAIL}`)
    expect(meta?.expected).toBe('[secret:PW_441]')
    expect(meta?.actual).toBe(`[secret:PW_441] for ${EMAIL}`)
    for (const text of recorded(result)) expect(text).not.toContain(PW)
    expect(JSON.stringify(result.evidence)).toContain(EMAIL)
  })

  it('an assertValue is judged on the raw read', async () => {
    const { result, outcome, meta } = await runAssert(
      { PW_441: PW },
      { success: true, data: PW },
      { source: 'storage', op: 'contains', expected: 'Hunter' },
    )
    expect(result.status).toBe('passed')
    expect(outcome?.expected).toBe('Hunter')
    expect(outcome?.actual).toBe('[secret:PW_441]')
    expect(meta?.actual).toBe('[secret:PW_441]')
    for (const text of recorded(result)) expect(text).not.toContain(PW)
  })

  it('a network read is judged per raw entry and recorded masked', async () => {
    const log = [
      { url: 'https://example.test/api/session', method: 'GET', headers: { authorization: `Bearer ${PW}` } },
      { url: 'https://example.test/api/login', method: 'POST', body: `password=${PW}&user=${EMAIL}` },
    ]
    const { result, outcome, meta } = await runAssert(
      { PW_441: PW },
      { success: true, data: log },
      { source: 'network', op: 'contains', expected: '{{secret:PW_441}}' },
    )
    expect(result.status).toBe('passed')
    expect(outcome?.actual).toContain('[secret:PW_441]')
    expect(outcome?.actual).toContain(EMAIL)
    expect(meta?.actual).toBe(outcome?.actual)
    for (const text of recorded(result)) expect(text).not.toContain(PW)
  })

  it('a declared value with a quote or backslash in a storage map is recorded by name, never in its JSON-escaped form', async () => {
    const value = 'Hun"ter\\42'
    const escaped = JSON.stringify(value).slice(1, -1)
    const escapedTwice = JSON.stringify(escaped).slice(1, -1)
    const { result, outcome, meta, record } = await runAssert(
      { PW_QUOTE_441: value },
      { success: true, data: { token: value, user: EMAIL } },
      { source: 'storage', op: 'contains', expected: EMAIL },
    )
    const expectedActual = '{"token":"[secret:PW_QUOTE_441]","user":"qa@example.com"}'
    expect(result.status).toBe('passed')
    expect(outcome?.actual).toBe(expectedActual)
    expect(meta?.actual).toBe(expectedActual)
    expect(record?.reads[0]?.text).toContain(`(read "${expectedActual}")`)
    for (const text of recorded(result)) {
      expect(text).not.toContain(value)
      expect(text).not.toContain(escaped)
      expect(text).not.toContain(escapedTwice)
    }
  })
})
