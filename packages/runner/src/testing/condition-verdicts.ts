// Scripted per-condition verifier output for test doubles. Framework-free: it
// ships in the runner barrel so every package's verifier doubles speak the same shape. A met
// condition cites a line the runner will find in what the verifier was given.

import type { ScreenState } from '@vostride/agent-qa-schema'
import type { Action } from '../platform.js'
import type { VerificationResult } from '../loop/types.js'
import { verifierActionDescription } from '../loop/prompts.js'

/** A legacy `{ success }` verdict a double may still be written with, or the full result. */
export type ScriptedVerdict =
  | { success: boolean; reasoning: string; isAppError?: boolean }
  | VerificationResult

const NO_FILE = { name: '', match: 'none', text: '' } as const

function citedLine(after: ScreenState | undefined): string | undefined {
  for (const line of (after?.tree ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.replace(/\s/g, '').length >= 3) return trimmed.slice(0, 200)
  }
  return undefined
}

/** One met condition quoting the whole step, citing the first line of the final screen. */
export function metVerification(options: {
  step: string
  after?: ScreenState
  action?: Action
  reasoning?: string
}): VerificationResult {
  const line = citedLine(options.after)
  const citation = line !== undefined
    ? { source: 'final-screen' as const, quote: line }
    : {
        source: 'action' as const,
        quote: options.action ? verifierActionDescription(options.action).slice(0, 200) : 'Action taken',
      }
  const reasoning = options.reasoning ?? 'Step completed'
  return {
    conditions: [
      {
        quote: options.step,
        verdict: 'met',
        needs: 'none',
        controlRef: '',
        file: { ...NO_FILE },
        citations: [citation],
        reasoning,
      },
    ],
    dialogs: [],
    isAppError: false,
    reasoning,
  }
}

/** One not-met condition quoting the whole step, with no citations. */
export function notMetVerification(options: {
  step: string
  reasoning: string
}): VerificationResult {
  return {
    conditions: [
      {
        quote: options.step,
        verdict: 'not-met',
        needs: 'none',
        controlRef: '',
        file: { ...NO_FILE },
        citations: [],
        reasoning: options.reasoning,
      },
    ],
    dialogs: [],
    isAppError: false,
    reasoning: options.reasoning,
  }
}

/** A passing or failing scripted verdict in the per-condition shape, with `isAppError` carried. */
export function scriptedVerification(options: {
  step: string
  after?: ScreenState
  action?: Action
  pass: boolean
  reasoning: string
  isAppError?: boolean
}): VerificationResult {
  const result = options.pass
    ? metVerification(options)
    : notMetVerification({ step: options.step, reasoning: options.reasoning })
  return { ...result, isAppError: options.isAppError ?? false }
}

/** Convert a scripted verdict to the per-condition shape against what `verify` received. */
export function toVerificationResult(
  verdict: ScriptedVerdict,
  received: { step: string; after?: ScreenState; action?: Action },
): VerificationResult {
  if ('conditions' in verdict) return verdict
  return scriptedVerification({
    ...received,
    pass: verdict.success,
    reasoning: verdict.reasoning,
    ...(verdict.isAppError !== undefined ? { isAppError: verdict.isAppError } : {}),
  })
}
