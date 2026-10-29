// Beside `Verdict`, never inside: widening the union would ripple through every guard and handoff.

import { z } from 'zod'

import { EntityUriSchema } from '../entity/uri'

/**
 * Where the sentence's grounding quote came from, as a discriminated pair.
 *
 * The step arm names the captured step the quote was lifted from. The `test-outcome` arm is
 * the typed alternative for tests that captured ZERO steps (a suite-bootstrap failure, a
 * session that never opened): those failures still get a sentence, and a fabricated
 * `stepIndex` pointing at a step that does not exist is exactly the overstatement this
 * discriminant makes unrepresentable.
 */
export type VerdictGroundingQuote =
  | { stepIndex: number; quote: string }
  | { source: 'test-outcome'; quote: string }

// Matched to `Verdict.perTest` by number, never by array position.
export interface VerdictSentenceParts {
  perTest: number
  /** A verbatim quote of captured evidence — never paraphrase, never fabrication. */
  groundingQuote: VerdictGroundingQuote
  /** What distinguishes THIS failure from its neighbours — the sentence's middle. */
  discriminator: string
  /** The one concrete thing to do next — the sentence's end. */
  nextAction: string
  /** `agentqa://` entity references the sentence surfaces as navigable links. */
  links: string[]
}

/** The runtime half of the contract — the artifact guard parses every part through this. */
export const VerdictSentencePartsSchema = z.object({
  perTest: z.number(),
  groundingQuote: z.union([
    z.object({ stepIndex: z.number(), quote: z.string() }),
    z.object({ source: z.literal('test-outcome'), quote: z.string() }),
  ]),
  discriminator: z.string(),
  nextAction: z.string(),
  links: z.array(EntityUriSchema),
})
