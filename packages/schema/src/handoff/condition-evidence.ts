export const CONDITION_VERDICTS = ['met', 'not-met', 'unverified', 'inconclusive'] as const
export type ConditionVerdict = (typeof CONDITION_VERDICTS)[number]

/** The runner check that changed a condition's verdict, when one did. */
export const CONDITION_GUARDS = [
  'quote-not-in-step',
  'not-covered',
  'citation-missing',
  'admits-not-done',
  'open-dialog',
  'limit',
  'narrowed',
  'file',
  'no-reload',
  'visual-text-only',
  'verifier-error',
] as const
export type ConditionGuard = (typeof CONDITION_GUARDS)[number]

/** What a condition needs beyond a cited line, as the verifier tagged it. */
export const CONDITION_NEEDS = ['visual', 'persistence', 'limit-max', 'limit-min', 'file'] as const
export type ConditionNeed = (typeof CONDITION_NEEDS)[number]

/** The part of what the verifier was given that a citation points at. */
export const CITATION_SOURCES = [
  'start-screen',
  'final-screen',
  'action',
  'read',
  'carried',
  'screenshot',
] as const
export type CitationSource = (typeof CITATION_SOURCES)[number]

/** How the step ended when the block was recorded. */
export const CONDITION_ENDINGS = [
  'completion',
  'give-up',
  'infeasible',
  'limit-stop',
  'unresolved',
  'timeout',
  'cancelled',
] as const
export type ConditionEnding = (typeof CONDITION_ENDINGS)[number]

/**
 * One citation as checked by the runner. `found` is where the runner looked; a 'screenshot'
 * citation cannot be checked and is recorded 'unchecked'. `source` is where the quote was found.
 */
export interface ConditionCitation {
  source: CitationSource
  quote: string
  found: boolean | 'unchecked'
}

/** The runner's comparison of a saved file with the expected name and text. */
export interface ConditionFileCheck {
  name: 'match' | 'differs'
  content: 'match' | 'differs' | 'unverified'
  firstDifference?: string
}

/** One requested condition. Every text field is masked and bounded before record. */
export interface ConditionRecord {
  /** The step words this condition covers. */
  quote: string
  /** The runner's final verdict. */
  verdict: ConditionVerdict
  /** The model's verdict, present only when a guard changed it. */
  judged?: ConditionVerdict
  guard?: ConditionGuard
  needs?: ConditionNeed
  reason: string
  citations: ConditionCitation[]
  file?: ConditionFileCheck
}

/** An open dialog on the final screen and how the verifier accounted for it. */
export interface OpenDialogAccount {
  name: string
  account: 'bears-on-condition' | 'requested' | 'unrelated' | 'unaccounted'
}

export interface ConditionVerdictsEvidence {
  ending: ConditionEnding
  conditions: ConditionRecord[]
  openDialogs?: OpenDialogAccount[]
}

export const CONDITION_RECORD_KEYS = [
  'quote',
  'verdict',
  'judged',
  'guard',
  'needs',
  'reason',
  'citations',
  'file',
] as const satisfies readonly (keyof ConditionRecord)[]

export const CONDITION_VERDICTS_EVIDENCE_KEYS = [
  'ending',
  'conditions',
  'openDialogs',
] as const satisfies readonly (keyof ConditionVerdictsEvidence)[]

const UNPROVEN_ENDINGS: readonly ConditionEnding[] = [
  'completion',
  'give-up',
  'infeasible',
  'limit-stop',
  'unresolved',
]

/**
 * True when the step is unproven rather than failed: the verifier's judgment left something
 * unverified, inconclusive or unaccounted with nothing not met and no open dialog bearing on a
 * condition, or an assertAI or extractAI step ended because the model could not judge or extract.
 * Timeout and cancelled blocks are recorded facts, not judgments, so they never count.
 */
export function stepOutcomeUnproven(step: {
  conditionVerdicts?: ConditionVerdictsEvidence
}): boolean {
  const block = step.conditionVerdicts
  if (block === undefined || !UNPROVEN_ENDINGS.includes(block.ending)) return false
  const dialogs = block.openDialogs ?? []
  if (block.conditions.some((condition) => condition.verdict === 'not-met')) return false
  if (dialogs.some((dialog) => dialog.account === 'bears-on-condition')) return false
  return (
    block.conditions.some(
      (condition) => condition.verdict === 'unverified' || condition.verdict === 'inconclusive',
    ) || dialogs.some((dialog) => dialog.account === 'unaccounted')
  )
}
