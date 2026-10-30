// The flag compares exact integers, never the rounded percentage the render shows.

import { z } from 'zod'

import { draftDispositionWritesTarget } from './disposition'
import type { DraftReceipt } from './draft-receipt'

// Ordered as the reference distribution is quoted; a fifth member is a new denominator.
export const AUTHORING_FUNNEL_STAGES = [
  'built',
  'passedStably',
  'addedValue',
  'writeEligible',
] as const

export type AuthoringFunnelStage = (typeof AUTHORING_FUNNEL_STAGES)[number]

// A rational pair, not a decimal, so no consumer re-derives the comparison as a rounded percentage.
export const KEEP_RATE_CEILING = { num: 9, den: 10 } as const

export const FUNNEL_MIN_DRAFTS_FLOOR = 10

// Absent `dedupRefusals` means nothing recorded refusals, which differs from zero refusals.
export interface FunnelSideCounters {
  readonly dedupRefusals?: number
}

export interface AuthoringFunnelInput {
  /** The receipts in the window. This IS the denominator. */
  readonly receipts: readonly DraftReceipt[]
  readonly sideCounters: FunnelSideCounters
  /**
   * Loop invocations the window covers, where the caller can count them.
   *
   * Receipts are addressed by content digest, so two byte-identical drafts collapse to ONE
   * receipt and one `built`. That is accepted rather than re-keyed — `receiptPath`'s recipe is
   * what `demo/init/scripts/drain-393-gates.sh` reads by — and it is DISCLOSED: when this number
   * exceeds the receipt count, the render carries the caveat rather than quietly under-reporting.
   */
  readonly invocationCount?: number
}

export const AuthoringFunnelSchema = z.object({
  stages: z.object({
    built: z.number().int().nonnegative(),
    passedStably: z.number().int().nonnegative(),
    addedValue: z.number().int().nonnegative(),
    writeEligible: z.number().int().nonnegative(),
  }).strict(),
  sideCounters: z.object({
    dedupRefusals: z.number().int().nonnegative().optional(),
  }).strict(),
  /** The EXACT ratio, absent when nothing was built. Never the flag's input. */
  keepRate: z.number().min(0).max(1).optional(),
  acceptanceFailure: z.boolean(),
  smallSample: z.boolean(),
  undercounted: z.boolean(),
  /** The ONE rendered line every surface prints. See {@link renderFunnelLine}. */
  line: z.string().min(1),
}).strict()

export type AuthoringFunnel = z.infer<typeof AuthoringFunnelSchema>

// Matched on word boundaries, so `window` does not trip `win` and `started` does not trip `star`.
export const FUNNEL_SUCCESS_FRAMING_LEXICON: readonly string[] = [
  'success',
  'successful',
  'succeeded',
  'achievement',
  'achieved',
  'score',
  'scored',
  'grade',
  'excellent',
  'great',
  'healthy',
  'on track',
  'milestone',
  'well done',
  'congratulations',
  'complete',
  'completed',
  'progress',
  'goal',
  '✅',
  '🎉',
  '👍',
  '⭐',
]

/** Raised when a composed funnel line carries a framing the prohibition forbids. */
export class FunnelSuccessFramingError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(
      'A funnel render may never present the keep rate as an achievement, a score or a '
      + `percentage-complete. Refusing a line carrying: ${violations.join(', ')}`,
    )
    this.name = 'FunnelSuccessFramingError'
  }
}

/** Which forbidden framings a string carries, in lexicon order. Empty is the clean answer. */
export function successFramingViolations(text: string): string[] {
  const lowered = text.toLowerCase()
  return FUNNEL_SUCCESS_FRAMING_LEXICON.filter((term) => (
    /^[a-z ]+$/.test(term)
      ? new RegExp(`(^|[^a-z])${term.replace(/ /g, '\\s+')}([^a-z]|$)`).test(lowered)
      : lowered.includes(term)
  ))
}

/**
 * The wording table every render composes from — the ONE place the funnel's words live.
 *
 * Pinned as a frozen record rather than inlined, so the prohibition above has something to screen
 * and a later editor changing a phrase edits it in the file that refuses a framed one.
 */
export const FUNNEL_PHRASES = {
  heading: 'Authoring funnel',
  built: 'built',
  passedStably: 'passed stably',
  addedValue: 'added value',
  writeEligible: 'write-eligible',
  noDrafts: 'No drafts reached authoring in this window, so there is no keep rate to report.',
  acceptanceFailure: 'ACCEPTANCE FAILURE',
  notFiltering: 'the loop is not filtering',
  smallSample: 'too few drafts to judge the filter',
  undercounted:
    'fewer receipts than invocations — byte-identical drafts share one receipt, so `built` is a '
    + 'lower bound here',
  refusalsUnrecorded: 'dedup refusals not recorded on this host',
} as const satisfies Readonly<Record<string, string>>

/** What {@link renderFunnelLine} needs: the computed funnel minus the line it is about to make. */
export type FunnelRenderParts = Omit<AuthoringFunnel, 'line'>

/**
 * Compose the ONE line every surface prints, and refuse it if it frames the rate as a success.
 *
 * The percentage is rounded HERE and nowhere else, and nothing downstream of this function reads
 * it back: `acceptanceFailure` was decided on integers before this ran.
 */
export function renderFunnelLine(parts: FunnelRenderParts): string {
  const { stages, sideCounters, keepRate } = parts
  const segments: string[] = [
    `${FUNNEL_PHRASES.heading} — ${stages.built} ${FUNNEL_PHRASES.built}`
    + ` · ${stages.passedStably} ${FUNNEL_PHRASES.passedStably}`
    + ` · ${stages.addedValue} ${FUNNEL_PHRASES.addedValue}`
    + ` · ${stages.writeEligible} ${FUNNEL_PHRASES.writeEligible}.`,
  ]

  if (keepRate === undefined) {
    segments.push(FUNNEL_PHRASES.noDrafts)
  } else {
    const percent = Math.round(keepRate * 100)
    const rate = `keep rate ${percent}% over ${stages.built} drafts`
    if (parts.acceptanceFailure) {
      segments.push(`${FUNNEL_PHRASES.acceptanceFailure}: ${rate} — ${FUNNEL_PHRASES.notFiltering}.`)
    } else if (parts.smallSample) {
      segments.push(
        `${rate} — ${FUNNEL_PHRASES.smallSample} (the floor is ${FUNNEL_MIN_DRAFTS_FLOOR} drafts).`,
      )
    } else {
      segments.push(`${rate}.`)
    }
  }

  if (parts.undercounted) segments.push(`Note: ${FUNNEL_PHRASES.undercounted}.`)

  const refusals = sideCounters.dedupRefusals === undefined
    ? FUNNEL_PHRASES.refusalsUnrecorded
    : `${sideCounters.dedupRefusals} dedup refusals`
  segments.push(`Beside the funnel: ${refusals}.`)

  const line = segments.join(' ')
  const violations = successFramingViolations(line)
  if (violations.length > 0) throw new FunnelSuccessFramingError(violations)
  return line
}

export function computeAuthoringFunnel(input: AuthoringFunnelInput): AuthoringFunnel {
  let passedStably = 0
  let addedValue = 0
  // Read off the receipt's STORED disposition, never recomputed from its gates: the stored value is
  // the answer that was given, and the one the loop's write decision read.
  let writeEligible = 0
  for (const receipt of input.receipts) {
    if (receipt.gates.executesDefinitive.pass && receipt.gates.stableVerdict.pass) passedStably += 1
    if (receipt.gates.addsValue.pass) addedValue += 1
    if (draftDispositionWritesTarget(receipt.disposition)) writeEligible += 1
  }

  const built = input.receipts.length
  const stages = { built, passedStably, addedValue, writeEligible }

  const smallSample = built < FUNNEL_MIN_DRAFTS_FLOOR
  // INTEGERS. Never `writeEligible / built > 0.9`, and never the rounded percentage the line shows.
  const aboveCeiling = writeEligible * KEEP_RATE_CEILING.den > KEEP_RATE_CEILING.num * built
  const acceptanceFailure = aboveCeiling && built >= FUNNEL_MIN_DRAFTS_FLOOR

  const parts: FunnelRenderParts = {
    stages,
    sideCounters: {
      ...(input.sideCounters.dedupRefusals === undefined
        ? {}
        : { dedupRefusals: input.sideCounters.dedupRefusals }),
    },
    // Absent rather than 0 when nothing was built, so the line says no drafts instead of 0%.
    ...(built === 0 ? {} : { keepRate: writeEligible / built }),
    acceptanceFailure,
    smallSample,
    undercounted: input.invocationCount !== undefined && input.invocationCount > built,
  }

  return { ...parts, line: renderFunnelLine(parts) }
}
