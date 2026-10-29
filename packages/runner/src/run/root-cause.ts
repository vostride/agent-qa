// RCC-02 deterministic minimal root-cause classifier. Pure, total,
// no IO, no LLM — imports limited to schema types, TestResult, and the single-sourced
// isTestTimeoutMessage matcher re-exported by run/verdict.ts (never a second matcher).
// The shell (Plan 07) invokes classifyRootCause at handoff assembly with the member's
// TestResult — which carries retryCount; PerTestOutcome does NOT (RESEARCH Pitfall 3) —
// plus the run-start baseline probe outcome.
//
// BRANCH ORDER (documented + pinned by run/__tests__/root-cause.test.ts):
//   presence rule: skipped/cancelled ⇒ undefined; clean passes ⇒ undefined
//   1. timeout      — member outcome 'timeout' (isTestTimeoutMessage-matched step error)
//   2. environment  — probe connect error → probe status ≥500 → connect/DNS token in a
//                     failing step error / failureSummary → device-session-create token
//      limit stop   — between the probe and the token scans: a failing step whose
//                     evidence carries limitStop is 'unknown', confidence 0, with the limit
//                     reason as rationale. Never environment, timeout or app_bug, and no class
//                     is added; analyze-run excludes these members from model authorship.
//      unproven     — right after the limit stop: a failing step the verifier left
//                     unverified or inconclusive (stepOutcomeUnproven) is 'unknown', confidence
//                     0, with the step's reason, masked by the run's mask, as rationale.
//                     Never an application class.
//   3. flake        — final status 'passed' with retryCount > 0 (member-runner retry loop)
//   4. unknown      — any other failure; confidence 0, the safe Noop default M4's
//                     analyze-run later supersedes via producer keying
//
// deterministicVerdict fills the LLM-shaped VerdictBase faithfully — no loosening:
// confidence 1 for signal-attributed classes (0 for unknown), rationale = a fixed template
// naming the exact signal, citedSteps = failing step indices, citedAnchors/citedArtifacts
// empty, memoryMisdirectionRuledOut true (a deterministic classifier never attributes to
// memory), producer 'deterministic-classifier'.

import { stepOutcomeUnproven } from '@vostride/agent-qa-schema'
import type { MemberTestOutcome, Verdict } from '@vostride/agent-qa-schema'
import type { TestResult } from '../result.js'
import { isTestTimeoutMessage } from './verdict.js'

/** The four classes the deterministic classifier can mint. */
export type DeterministicRootCauseClass = 'timeout' | 'environment' | 'flake' | 'unknown'

/** The fixed unknown-class rationale template. */
export const UNKNOWN_SIGNAL_RATIONALE = 'no deterministic signal matched'

/**
 * Connect/DNS failure tokens matched over failing step errors (RESEARCH A2). Conservative
 * fixed list — misses fall to 'unknown', the safe Noop default; app-controlled error text
 * steering toward environment is bounded by exact OS/Chromium error-code tokens.
 */
export const CONNECT_ERROR_TOKENS: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_INTERNET_DISCONNECTED',
]

/**
 * Device-session-create failure tokens — the D-04 mobile equivalent of the baseline probe
 * (RESEARCH A3 resolution). Located shapes: core's MobileSetupError (launch-resolver.ts —
 * its name renders in String(err) for every setup category) and the adapters' app-launch
 * messages; 'Failed to create session' / 'session not created' cover webdriverio's and the
 * W3C WebDriver (Appium) canonical session-create failure strings.
 */
export const SESSION_CREATE_ERROR_TOKENS: readonly string[] = [
  'MobileSetupError',
  'Failed to create session',
  'session not created',
  'Failed to launch Android app',
  'Failed to launch iOS app',
]

export interface RootCauseInput {
  /** The member's final-attempt TestResult (carries retryCount — the flake signal source). */
  result: TestResult
  /** The derived member outcome (deriveMemberOutcome) — the timeout + presence-rule signal. */
  outcome: MemberTestOutcome
  /** Shell-derived member index; becomes Verdict.perTest. */
  testIndex: number
  /** Run-start baseline probe outcome (D-04, web targets; threaded by Plan 07). */
  baselineProbe?: { status?: number; elapsedMs: number; error?: string }
  /**
   * The run's mask. An unproven step's reason carries the planner's own words, which
   * the step error holds unmasked, so its rationale passes through this before it is recorded.
   */
  mask?: (text: string) => string
}

/**
 * The D-02 faithful VerdictBase constructor. Pure and total: every field of the LLM-shaped
 * base is filled deterministically — confidence keys on the class ('unknown' ⇒ 0, else 1),
 * the unknown rationale is always the fixed template regardless of the signal argument.
 */
export function deterministicVerdict(
  cls: DeterministicRootCauseClass,
  signal: string,
  citedSteps: number[],
  perTest: number,
): Verdict {
  return {
    class: cls,
    producer: 'deterministic-classifier',
    confidence: cls === 'unknown' ? 0 : 1,
    evidence: {
      citedSteps,
      citedAnchors: [],
      citedArtifacts: [],
      rationale: cls === 'unknown' ? UNKNOWN_SIGNAL_RATIONALE : signal,
    },
    memoryMisdirectionRuledOut: true,
    perTest,
  }
}

/** Indices of failing steps — Verdict.evidence.citedSteps. */
function failingStepIndices(result: TestResult): number[] {
  const indices: number[] = []
  result.steps.forEach((s, i) => {
    if (s.status === 'failed') indices.push(i)
  })
  return indices
}

/**
 * The untrusted error texts a failure surfaces on TestResult: failing step errors plus
 * failureSummary — the only carrier when a suite-bootstrap/session-create failure produces
 * a step-less failed result (the CLI bootstrapFailure path; RESEARCH A3).
 */
function failureErrorTexts(result: TestResult): string[] {
  const texts = result.steps
    .filter((s) => s.status === 'failed' && s.error !== undefined)
    .map((s) => s.error as string)
  if (result.failureSummary !== undefined) texts.push(result.failureSummary)
  return texts
}

/** Failing steps a per-step limit stopped, with their recorded reasons. */
function limitStoppedSteps(result: TestResult): { index: number; reason: string }[] {
  const stopped: { index: number; reason: string }[] = []
  result.steps.forEach((s, i) => {
    const limitStop = s.evidence?.limitStop
    if (s.status === 'failed' && limitStop !== undefined) {
      stopped.push({ index: i, reason: limitStop.reason })
    }
  })
  return stopped
}

/** Failing steps the verifier left unproven, with the step's reason, masked. */
function unprovenSteps(
  result: TestResult,
  mask: (text: string) => string,
): { index: number; reason: string }[] {
  const unproven: { index: number; reason: string }[] = []
  result.steps.forEach((s, i) => {
    if (s.status === 'failed' && s.evidence !== undefined && stepOutcomeUnproven(s.evidence)) {
      unproven.push({ index: i, reason: mask(s.error ?? s.evidence.verifierVerdict.reasoning) })
    }
  })
  return unproven
}

function unknownFromSteps(
  steps: readonly { index: number; reason: string }[],
  testIndex: number,
): Verdict {
  return {
    class: 'unknown',
    producer: 'deterministic-classifier',
    confidence: 0,
    evidence: {
      citedSteps: steps.map(({ index }) => index),
      citedAnchors: [],
      citedArtifacts: [],
      rationale: steps[0]?.reason ?? UNKNOWN_SIGNAL_RATIONALE,
    },
    memoryMisdirectionRuledOut: true,
    perTest: testIndex,
  }
}

function matchToken(texts: readonly string[], tokens: readonly string[]): { token: string; text: string } | undefined {
  for (const text of texts) {
    for (const token of tokens) {
      if (text.includes(token)) return { token, text }
    }
  }
  return undefined
}

/**
 * Classify one member's root cause from deterministic signals only. Returns
 * undefined when the presence rule says no rootCause (skipped/cancelled/clean pass).
 * See the module header for the documented, pinned branch order.
 */
export function classifyRootCause(input: RootCauseInput): Verdict | undefined {
  const { result, outcome, testIndex, baselineProbe } = input
  const citedSteps = failingStepIndices(result)

  // Presence rule (D-01, refined in Plan 01): skipped/cancelled never classify.
  if (outcome === 'skipped' || outcome === 'cancelled') return undefined

  // 3. flake — the only class a pass can mint. Keyed on the final-attempt TestResult's
  // retryCount from the member-runner meta.retries loop (healed IS a pass: status 'passed').
  if (outcome === 'passed' || outcome === 'healed') {
    const retries = result.retryCount ?? 0
    if (retries > 0) return deterministicVerdict('flake', `passed on retry ${retries}`, citedSteps, testIndex)
    return undefined
  }

  // 1. timeout — the hard test budget, single-sourced via isTestTimeoutMessage.
  if (outcome === 'timeout') {
    const matched = result.steps.find(
      (s) => s.status === 'failed' && s.error !== undefined && isTestTimeoutMessage(s.error),
    )
    return deterministicVerdict(
      'timeout',
      `test budget exhausted: ${matched?.error ?? 'test deadline reached'}`,
      citedSteps,
      testIndex,
    )
  }

  // 2. environment — probe first (run-scoped signal), then failing-error token scans.
  if (baselineProbe !== undefined) {
    if (baselineProbe.error !== undefined) {
      return deterministicVerdict(
        'environment',
        `health probe connect failure: ${baselineProbe.error}`,
        citedSteps,
        testIndex,
      )
    }
    if (baselineProbe.status !== undefined && baselineProbe.status >= 500) {
      return deterministicVerdict(
        'environment',
        `health probe: ${baselineProbe.status} in ${baselineProbe.elapsedMs}ms`,
        citedSteps,
        testIndex,
      )
    }
  }

  const limitStopped = limitStoppedSteps(result)
  if (limitStopped.length > 0) return unknownFromSteps(limitStopped, testIndex)

  const unproven = unprovenSteps(result, input.mask ?? ((text) => text))
  if (unproven.length > 0) return unknownFromSteps(unproven, testIndex)

  const texts = failureErrorTexts(result)
  const connect = matchToken(texts, CONNECT_ERROR_TOKENS)
  if (connect !== undefined) {
    const detail = connect.text.slice(connect.text.indexOf(connect.token) + connect.token.length).trim()
    return deterministicVerdict(
      'environment',
      `connect failure: ${connect.token}${detail === '' ? '' : ` ${detail}`}`,
      citedSteps,
      testIndex,
    )
  }

  const session = matchToken(texts, SESSION_CREATE_ERROR_TOKENS)
  if (session !== undefined) {
    return deterministicVerdict('environment', `device session create failure: ${session.text}`, citedSteps, testIndex)
  }

  // 4. unknown — no deterministic signal matched; the safe Noop default.
  return deterministicVerdict('unknown', UNKNOWN_SIGNAL_RATIONALE, citedSteps, testIndex)
}
