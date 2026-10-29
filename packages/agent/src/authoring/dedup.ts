// Deterministic: an intent has no execution fingerprint, and a model judge cannot be proven.

import { AUTHORING_DEDUP_CONTINUATIONS, suiteTestRef } from '@vostride/agent-qa-schema'
import type { AuthoringDedupContinuation } from '@vostride/agent-qa-schema'

import { textOverlap } from './adds-value.js'
import type { SuiteTestIdentity, SuiteTextCorpusEntryLike } from './ports.js'

// Below gate 3's threshold: a false refusal costs one re-issue, a missed duplicate costs every run.
export const DEDUP_REFUSE_SIMILARITY_THRESHOLD = 0.45

// `matchedRef` is the durable `<filePath>::<testName>`, not a `TST-###` short-id.
export interface DedupEvidence {
  readonly score: number
  readonly matched: SuiteTestIdentity
  readonly matchedRef: string
  readonly sharedTokens: number
  readonly threshold: number
}

/** The closest suite member, reported on BOTH arms so an admit can say what it was nearly. */
export interface DedupClosest {
  readonly filePath: string
  readonly testName: string
  readonly similarity: number
}

/**
 * How stage 2 read the suite, and the arm it took.
 *
 * `comparedTests` is on both arms and is the universe claim in one number: the comparison
 * population is EVERY test in the suite, not the fingerprint-covered subset gate 3's primary lane
 * speaks for. A draft duplicating a test the derived index has no rows for is still refused, and a
 * lane that filtered its input would report a smaller count before it reported a wrong match.
 *
 * `closest` is present whenever the corpus was non-empty. On the `duplicate` arm it is the same
 * member `evidence` names — two readings of one comparison, kept so a consumer that only wants
 * "what was it nearest" reads one field on both arms.
 */
export type DedupScreening =
  | {
    readonly kind: 'no-duplicate'
    readonly comparedTests: number
    readonly closest?: DedupClosest
  }
  | {
    readonly kind: 'duplicate'
    readonly comparedTests: number
    readonly closest: DedupClosest
    readonly evidence: DedupEvidence
    readonly continuations: readonly AuthoringDedupContinuation[]
  }

// Delegates to `suiteTestRef` so the producer and the binder share one spelling.
export function dedupMatchRef(identity: SuiteTestIdentity): string {
  return suiteTestRef(identity.filePath, identity.testName)
}

// Scores the larger of the whole-document and name-only axes, because an intent has no steps.
function scoreIntentAgainst(
  intent: string,
  entry: SuiteTextCorpusEntryLike,
): { readonly score: number; readonly sharedTokens: number } {
  const wholeDocument = textOverlap({ testName: intent, steps: [] }, entry)
  const nameOnly = textOverlap(
    { testName: intent, steps: [] },
    { filePath: entry.filePath, testName: entry.testName, stepsText: [] },
  )
  // Strictly greater, so the whole-document axis keeps the reading on a tie. It is the axis this
  // lane shipped with and the one gate 3 screens on, so the evidence a refusal names stays the
  // evidence the post-run gate would name for the same pair whenever the two axes agree.
  return nameOnly.score > wholeDocument.score ? nameOnly : wholeDocument
}

// Ties go to the smallest workspace-relative path, so two runs over one suite name one test.
export function dedupBeforeAuthor(
  intent: string,
  corpus: readonly SuiteTextCorpusEntryLike[],
): DedupScreening {
  let best: { readonly entry: SuiteTextCorpusEntryLike; readonly overlap: { score: number; sharedTokens: number } } | undefined

  for (const entry of corpus) {
    const overlap = scoreIntentAgainst(intent, entry)
    if (
      best === undefined
      || overlap.score > best.overlap.score
      // Strictly smaller, so the running best is only displaced by a genuinely earlier path. A
      // `<=` here would make the LAST of a tied group win and re-introduce iteration order.
      || (overlap.score === best.overlap.score && entry.filePath < best.entry.filePath)
    ) {
      best = { entry, overlap }
    }
  }

  if (best === undefined) return { kind: 'no-duplicate', comparedTests: corpus.length }

  const closest: DedupClosest = {
    filePath: best.entry.filePath,
    testName: best.entry.testName,
    similarity: best.overlap.score,
  }

  // `>=`, so a score sitting exactly on the pin reads as duplicate and the intent is refused.
  // Over-flagging toward refuse is the safe failure here for the reason the threshold's own
  // comment measures, and it is what makes a pin the corpus can land on exactly usable at all.
  if (best.overlap.score < DEDUP_REFUSE_SIMILARITY_THRESHOLD) {
    return { kind: 'no-duplicate', comparedTests: corpus.length, closest }
  }

  const matched: SuiteTestIdentity = {
    filePath: best.entry.filePath,
    testName: best.entry.testName,
  }
  return {
    kind: 'duplicate',
    comparedTests: corpus.length,
    closest,
    evidence: {
      score: best.overlap.score,
      matched,
      matchedRef: dedupMatchRef(matched),
      sharedTokens: best.overlap.sharedTokens,
      threshold: DEDUP_REFUSE_SIMILARITY_THRESHOLD,
    },
    continuations: AUTHORING_DEDUP_CONTINUATIONS,
  }
}
