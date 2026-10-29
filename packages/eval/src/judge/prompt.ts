// D-07 minimality law: this module assembles the judge's ENTIRE evidentiary world — minimal
// textual evidence only (step text, the gold-vs-candidate identities or the two values, and
// optional recorded element names/roles). No screenshots, no full accessibility tree: what
// buildJudgePrompt renders is everything the judge is ever shown.
//
// the A/B order swap is PHYSICAL — each order is its own independently assembled payload
// with the item contents actually transposed, never both orders in one prompt. Swap agreement
// is adjudicate's job; this module only guarantees the transposition is real.
//
// Every template/framing string comes from JUDGE_CONFIG.promptTemplate so the judgeVersion
// bump-guard hash covers the injection defense; this module contributes assembly logic only.
// All app-derived content (names, values, step text, element lists) renders strictly inside
// frameBegin/frameEnd untrusted-data frames — labels, questions, and framing lines are the
// only content outside frames (spec §B4(b) content-as-data posture).

import { JUDGE_CONFIG } from './config'
import type { JudgeOrder } from './port'

/** Element identity evidence — mirrors the recorded GoldAnchorDescriptor minus ref. */
export interface JudgeElementEvidence {
  role: string
  nameNormalized: string
  ordinal: number
}

/** The narrow equivalence question the judge answers — closed union, one axis per call. */
export type JudgeQuestion =
  | { kind: 'element-equivalence'; gold: JudgeElementEvidence; candidate: JudgeElementEvidence }
  | { kind: 'value-equivalence'; goldValue: string; candidateValue: string }

/** The complete judge-visible evidence for one tie (D-07 — nothing else is ever shown). */
export interface JudgeTieEvidence {
  stepText: string
  question: JudgeQuestion
  recordedElements?: readonly JudgeElementEvidence[]
}

/** One order-tagged payload, shaped for JudgeCallRequest — adjudicate hands it to the port verbatim. */
export interface JudgePromptPayload {
  system: string
  prompt: string
  order: JudgeOrder
}

function renderElement(element: JudgeElementEvidence): string {
  return `role=${element.role} name=${element.nameNormalized} ordinal=${element.ordinal}`
}

/** Wrap app-derived content as non-executable data between the constitution's frame lines. */
function frame(content: string): string {
  const { frameBegin, frameEnd } = JUDGE_CONFIG.promptTemplate
  return `${frameBegin}\n${content}\n${frameEnd}`
}

/**
 * Assemble one contrastive order-swapped judge payload. Pure and deterministic: same
 * evidence + order yields a byte-identical payload; the system tier is always the
 * constitution's systemTier verbatim (never mutated per call).
 */
export function buildJudgePrompt(
  evidence: JudgeTieEvidence,
  order: JudgeOrder,
): JudgePromptPayload {
  const template = JUDGE_CONFIG.promptTemplate
  const { question } = evidence

  let questionText: string
  let goldContent: string
  let candidateContent: string
  if (question.kind === 'element-equivalence') {
    questionText = template.questionElementEquivalence
    goldContent = renderElement(question.gold)
    candidateContent = renderElement(question.candidate)
  } else {
    questionText = template.questionValueEquivalence
    goldContent = question.goldValue
    candidateContent = question.candidateValue
  }

  // D-08 physical assignment: 'ab' puts the gold side under ITEM A; 'ba' transposes.
  // The labels stay neutral — the prompt never reveals which side is which.
  const itemAContent = order === 'ab' ? goldContent : candidateContent
  const itemBContent = order === 'ab' ? candidateContent : goldContent

  const parts = [
    questionText,
    frame(evidence.stepText),
    template.itemALabel,
    frame(itemAContent),
    template.itemBLabel,
    frame(itemBContent),
  ]
  if (evidence.recordedElements !== undefined && evidence.recordedElements.length > 0) {
    parts.push(frame(evidence.recordedElements.map(renderElement).join('\n')))
  }

  return { system: template.systemTier, prompt: parts.join('\n'), order }
}
