// Terms arrive as inputs because the repair cap lives in `agent`, which schema must not import.

// Types are derived from the zod schemas, so the wire validator and the type cannot drift.

import { z } from 'zod'

/** The three terms, as the caller that knows all three supplies them. */
const fanOutBoundTerms = {
  /** The first stability gate's run count — `DRAFT_STABILITY_RUNS_N`, or 1 in draft mode. */
  initialN: z.number().int().min(0),
  /** One probe per repair iteration — `REPAIR_ITERATION_CAP`. */
  probeK: z.number().int().min(0),
  /** The final stability gate on the repaired candidate — `DRAFT_STABILITY_RUNS_N`. */
  finalN: z.number().int().min(0),
}

export const FanOutBoundInputSchema = z.object(fanOutBoundTerms).strict().readonly()

export type FanOutBoundInput = z.infer<typeof FanOutBoundInputSchema>

/**
 * The three terms and their total, all four separately readable.
 *
 * `total` IS NOT RE-DERIVED BY A REFINEMENT HERE, and the omission is deliberate. A
 * `.refine(b => b.total === b.initialN + b.probeK + b.finalN)` would be a SECOND assembly of the
 * three terms living one file away from `computeFanOutBound`, which is precisely the second
 * arithmetic this file's header forbids and mutation I of the phase's mutation driver (since
 * removed) existed to catch. The schema's job is the shape; the sum has exactly one site.
 */
export const FanOutBoundSchema = z.object({
  ...fanOutBoundTerms,
  total: z.number().int().min(0),
}).strict().readonly()

export type FanOutBound = z.infer<typeof FanOutBoundSchema>

/**
 * A term that would SUBTRACT from the disclosure.
 *
 * The one arithmetic error this number may never make, so it is refused at the input rather than
 * clamped: a negative term is a caller bug, and the safe-looking repair — treating it as zero —
 * would answer a smaller bound than the loop's worst case, which is the defect itself.
 */
export class FanOutBoundError extends Error {
  constructor(readonly term: keyof FanOutBoundInput, readonly value: number) {
    super(
      `fan-out bound: ${term} must be a non-negative integer, and it was ${value} — `
        + 'a term that subtracts would make the preview lower than the loop\'s own worst case',
    )
    this.name = 'FanOutBoundError'
  }
}

/**
 * THE ONE fan-out arithmetic. `initialN + probeK + finalN`, with all three terms preserved.
 *
 * Pure and total: one argument, no clock, no store, no config. `schema`'s only runtime dependency
 * is `zod`, so there is nothing here for a later edit to reach for even if it wanted to.
 */
export function computeFanOutBound(input: FanOutBoundInput): FanOutBound {
  for (const term of ['initialN', 'probeK', 'finalN'] as const) {
    const value = input[term]
    if (!Number.isInteger(value) || value < 0) throw new FanOutBoundError(term, value)
  }
  return {
    initialN: input.initialN,
    probeK: input.probeK,
    finalN: input.finalN,
    total: input.initialN + input.probeK + input.finalN,
  }
}

// Produced by the function, not a literal, so it cannot pin a shape the function never answers.
export const NO_RUNS_FAN_OUT_BOUND: FanOutBound = computeFanOutBound({
  initialN: 0,
  probeK: 0,
  finalN: 0,
})

/** What a consumed run was STARTED for. Closed, and the two are not interchangeable. */
export const FAN_OUT_RUN_PURPOSES = ['gate', 'probe'] as const

export type FanOutRunPurpose = (typeof FAN_OUT_RUN_PURPOSES)[number]

/**
 * One run the invocation actually spent — a ref and a role, never the run document.
 *
 * `completedAt` is OPTIONAL because a run whose record could not be read is a real posture: the run
 * happened and must be counted, and pretending to know when it finished would fabricate a position
 * in the sequence. See the ordering rule below for where such an entry lands.
 */
export const ConsumedRunSchema = z.object({
  runId: z.string().min(1),
  purpose: z.enum(FAN_OUT_RUN_PURPOSES),
  /** Epoch milliseconds, when the run's record says so. */
  completedAt: z.number().optional(),
}).strict().readonly()

export type ConsumedRun = z.infer<typeof ConsumedRunSchema>

// Both numbers ride one object so a reader is never handed either alone.
export const FanOutReportSchema = z.object({
  previewed: FanOutBoundSchema,
  /** Distinct runs, in the order they finished, ties broken by run id. */
  consumed: z.array(ConsumedRunSchema).readonly(),
  consumedTotal: z.number().int().min(0),
  /**
   * The actual figure exceeded the previewed bound.
   *
   * REPORTED, NEVER CLAMPED AND NEVER THROWN. A clamp would turn a consent defect into a silent
   * correctness bug — the artifact would carry the number the preview promised rather than the
   * number that was spent — and a throw would destroy the receipt that holds the evidence for it.
   * The flag is a disclosure of the same kind the report itself is, and every path this phase
   * exercises asserts it is false.
   *
   * IT IS NOT RE-DERIVED HERE EITHER. `consumedTotal > previewed.total` spelled as a refinement
   * would be a second answer to the question `buildFanOutReport` already answered, and the two
   * could disagree only in the direction that hides an excess.
   */
  exceedsPreview: z.boolean(),
}).strict().readonly()

export type FanOutReport = z.infer<typeof FanOutReportSchema>

/**
 * Order the consumed runs into a sequence two renders of one report cannot disagree about.
 *
 * COMPLETION ORDER, TIES BROKEN BY RUN ID. Gate runs a fast local executor finishes inside the same
 * millisecond genuinely tie, so the id is what makes the order total rather than a fallback nobody
 * reaches. A run with NO known completion time sorts after every timed one, ordered by id among its
 * own kind: sorting it as `0` would place a run nothing timed ahead of runs that really did finish
 * first, which is a fabricated sequence rather than an unknown one.
 */
function orderConsumedRuns(runs: readonly ConsumedRun[]): readonly ConsumedRun[] {
  return [...runs].sort((left, right) => {
    const leftTime = left.completedAt
    const rightTime = right.completedAt
    if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
      return leftTime - rightTime
    }
    if (leftTime === undefined && rightTime !== undefined) return 1
    if (leftTime !== undefined && rightTime === undefined) return -1
    return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0
  })
}

/**
 * Pair a previewed bound with the runs an invocation actually spent.
 *
 * DISTINCT BY RUN ID, and the first role wins. A run that served as the last repair probe and then
 * counted toward the final stability gate is ONE child process, and it was started as a probe —
 * counting it twice would inflate the actual figure in the safe-looking direction, which is exactly
 * how a real preview under-count would be masked by the report that exists to expose it.
 */
export function buildFanOutReport(input: {
  readonly previewed: FanOutBound
  readonly runs: readonly ConsumedRun[]
}): FanOutReport {
  const distinct = new Map<string, ConsumedRun>()
  for (const run of input.runs) {
    if (!distinct.has(run.runId)) distinct.set(run.runId, run)
  }
  const consumed = orderConsumedRuns([...distinct.values()])
  return {
    previewed: input.previewed,
    consumed,
    consumedTotal: consumed.length,
    exceedsPreview: consumed.length > input.previewed.total,
  }
}

/** The wording table both renders compose from — the ONE place this plan's words live. */
export const FAN_OUT_PHRASES = {
  runCost: 'each run is a full `agent-qa run` process against your application',
  previewLead: 'This authoring invocation will execute up to',
  stability: 'stability runs',
  probes: 'repair probes',
  finalStability: 'final stability runs',
  reportLead: 'Runs consumed:',
  previewedWord: 'previewed',
  exceeded: 'THIS EXCEEDS THE PREVIEWED BOUND — report this, it is a defect in the bound',
} as const

/**
 * The disclosure the dispatch confirm renders — the sentence a person actually consents on.
 *
 * COMPOSED FROM THE BOUND'S OWN INTEGERS AND NOTHING ELSE. No caller text reaches this string: the
 * `intent` an arbitrary caller supplies is free text that already reaches a model, and a confirm
 * message it could write is a channel through which a caller could dress up what they are asking a
 * person to approve. Every token below is either a pinned phrase or a number this file computed.
 *
 * It names all three terms rather than only the total, because "up to 9 runs" is a number and
 * "3 stability runs + up to 3 repair probes + 3 final stability runs" is an explanation of it.
 */
export function renderFanOutPreview(bound: FanOutBound): string {
  return `${FAN_OUT_PHRASES.previewLead} ${bound.total} runs `
    + `(${bound.initialN} ${FAN_OUT_PHRASES.stability}, up to ${bound.probeK} `
    + `${FAN_OUT_PHRASES.probes}, ${bound.finalN} ${FAN_OUT_PHRASES.finalStability}). `
    + `${FAN_OUT_PHRASES.runCost}.`
}

/**
 * The honest half: what was actually spent, beside what was disclosed.
 *
 * The two figures are rendered in ONE line for the reason they ride one object — a reader handed
 * the actual alone cannot check the disclosure, and a reader handed the disclosure alone is being
 * told what was promised rather than what happened.
 */
export function renderFanOutReport(report: FanOutReport): string {
  const line = `${FAN_OUT_PHRASES.reportLead} ${report.consumedTotal} `
    + `(${FAN_OUT_PHRASES.previewedWord} up to ${report.previewed.total})`
  return report.exceedsPreview ? `${line} — ${FAN_OUT_PHRASES.exceeded}` : line
}
