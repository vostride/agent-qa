// Branch order: presence, timeout, environment, limit stop, unproven, flake, then unknown.

import { stepOutcomeUnproven } from '@vostride/agent-qa-schema'
import type { MemberTestOutcome, Verdict } from '@vostride/agent-qa-schema'
import type { TestResult } from '../result.js'
import { isTestTimeoutMessage } from './verdict.js'

/** The four classes the deterministic classifier can mint. */
export type DeterministicRootCauseClass = 'timeout' | 'environment' | 'flake' | 'unknown'

/** The fixed unknown-class rationale template. */
export const UNKNOWN_SIGNAL_RATIONALE = 'no deterministic signal matched'

// Exact OS and Chromium error-code tokens, so app text cannot steer a run toward environment.
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

// Mobile's equivalent of the baseline probe: setup error names and WebDriver session failures.
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
  // Run-start baseline probe outcome, for web targets.
  baselineProbe?: { status?: number; elapsedMs: number; error?: string }
  // An unproven reason holds the planner's unmasked words, so the rationale passes through this.
  mask?: (text: string) => string
}

// Fills every VerdictBase field deterministically; confidence is 0 for `unknown`, else 1.
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

// Failing step errors plus failureSummary, the only carrier for a step-less bootstrap failure.
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

// Undefined when the presence rule says no rootCause: skipped, cancelled or a clean pass.
export function classifyRootCause(input: RootCauseInput): Verdict | undefined {
  const { result, outcome, testIndex, baselineProbe } = input
  const citedSteps = failingStepIndices(result)

  // Presence rule: skipped and cancelled never classify.
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
