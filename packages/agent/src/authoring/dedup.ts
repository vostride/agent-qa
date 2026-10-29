// Stage 2 — dedup-before-author, the deterministic suite-wide text lane.
//
// WHAT THIS LANE DOES, in order:
//
//   1. Score the caller's INTENT against every test in the authored suite, through the shipped
//      `textOverlap` and no other recipe, on the two axes an intent and a test can actually be
//      COMPARED on — the test's whole document, and the test's name alone — keeping the larger.
//   2. Keep the highest-scoring member, breaking a tie on the lexicographically smallest
//      workspace-relative identity path.
//   3. Refuse when that score is at or above the pinned threshold, naming the member, the score,
//      the shared-token count that produced it, and the two continuations an author can take.
//   4. Otherwise admit, still reporting the closest member so a caller can see what it was
//      nearly.
//
// WHY IT IS DETERMINISTIC, and why that is the point rather than a limitation. An intent has no
// execution fingerprint — nothing has been run, and nothing has even been authored — so 393's
// anchor-sequence recipe cannot fire here at all, and it is the reason this screen is worth doing
// before a model call rather than after one. No model judges duplication either: a
// non-deterministic filter cannot be proven against a frozen corpus, and a filter nobody can prove
// is a filter whose false-refusal rate is a matter of opinion. What this lane trades away is
// recall on a crafted paraphrase, and that is bounded rather than unowned — gate 3 remains the
// anchor-level backstop for near-duplicates that slip the text screen.
//
// WHY THE FAILURE DIRECTION IS TOWARD REFUSE. Not re-argued here: `adds-value.ts`'s own comment on
// `TEXT_FALLBACK_SIMILARITY_THRESHOLD` states the asymmetry for the same comparison on the same
// normalizer, and one statement of a rule is the whole point of reusing the mechanics.
//
// WHAT IT COSTS TO BE WRONG, per direction, is what the threshold comment below measures.

import { AUTHORING_DEDUP_CONTINUATIONS, suiteTestRef } from '@vostride/agent-qa-schema'
import type { AuthoringDedupContinuation } from '@vostride/agent-qa-schema'

import { textOverlap } from './adds-value.js'
import type { SuiteTestIdentity, SuiteTextCorpusEntryLike } from './ports.js'

/**
 * Similarity at or above which an intent is refused as a near-duplicate of an existing test.
 *
 * A PINNED CONSTANT, never config.
 *
 * IT SITS BELOW GATE 3's, DELIBERATELY. `TEXT_FALLBACK_SIMILARITY_THRESHOLD` is 0.5; this is 0.45.
 * The two answer different questions on the same scale — gate 3 asks whether a draft that has
 * already been authored and run adds value, and this asks whether an intent already exists — and
 * the costs of being wrong are not symmetric between them. An over-flagging pre-run screen costs
 * ONE refused invocation the user can re-issue deliberately after reading which test it matched.
 * An under-flagging one costs a duplicate test in the suite, which is paid on every run forever
 * and which nothing downstream will remove.
 *
 * RETUNE, AND IT IS A MEASUREMENT RATHER THAN A PREFERENCE. Before moving this number, re-run the
 * frozen corpus at `__tests__/fixtures/dedup-corpus/expectations.json` and report three things.
 * ALL THREE WERE RE-MEASURED 2026-08-13 on the producible input distribution; the numbers this
 * comment carried until then were taken over whole test DOCUMENTS, which no caller can send, and
 * so described a lane nobody was ever running.
 *   (a) WHICH ROWS MOVE. The corpus carries a boundary triple — 0.4444444444, 0.4500000000 and
 *       0.4545454545 — so the immediate neighbourhood is already instrumented. The value is
 *       0.45 rather than a rounder number because 0.45 is the value the corpus can sit EXACTLY
 *       on: the at-threshold utterance's nine tokens are all `uat-381-ladder` tokens, so its
 *       Jaccard is 9/20, which is the same IEEE-754 double as the literal here. A pin no row can
 *       land on to the digit makes the `>=` direction a coin flip with a constant next to it.
 *       Re-measured against the fixed recipe, EVERY row moved up or stayed where it was — max is
 *       monotone, so it cannot do anything else — and the pin was not touched. That is what "no
 *       retune was required" means here: not that nothing moved, but that nothing crossed.
 *   (b) THE FALSE-REFUSAL RATE ON THE ACCEPT CONTROLS. The corpus's accept control tops out at
 *       0.4166666667 against the suite, so there is 0.0333 of headroom below and it is the
 *       narrowest margin among the rows standing for genuinely new intents. The boundary rows sit
 *       closer — below-threshold is 0.0056 under — but they are instrumentation aimed at the pin,
 *       not controls, and reading them as controls would report a false-refusal risk the corpus
 *       deliberately manufactured. Note that this number MOVES with the comparison universe:
 *       393 measured the same text at 0.4074 by scoring it against one file, and reading the whole
 *       suite raised it. A threshold inherited from a narrower universe is measured on a different
 *       instrument. It also moves with the AXIS: the same control scores 0.1724 on the whole
 *       document and 0.4167 on the name, and the name axis is the one that decides it — so the
 *       margin this clause reports is a margin on the axis that actually binds.
 *   (c) THE WALL-CLOCK COST PER REFUSED INVOCATION. A refusal here is strictly cheaper than the
 *       alternative — TWO token-set intersections per suite member against one model call plus N
 *       gate-runs at roughly 22s each — which is why over-flagging is affordable at all. The
 *       second axis was expected to double the per-comparison work and MEASURED 1.30×, because
 *       the name axis re-tokenizes only a name where the document axis tokenizes every step:
 *       0.0179ms → 0.0232ms per invocation over 6 members, and 0.0369ms over the 10-member demo
 *       suite, each the mean of 100000 invocations, measured 2026-08-13. That is roughly six
 *       hundred thousand times cheaper than one gate-run it can avoid. Report it rather than
 *       assuming it — including the factor, which was assumed 2× and is not — because it is the
 *       number that stops being true first if the lane ever grows a per-comparison cost.
 *
 * A retune that only argues from intuition is the failure this comment exists to prevent.
 */
export const DEDUP_REFUSE_SIMILARITY_THRESHOLD = 0.45

/**
 * What a refusal NAMES. Every field is evidence a reader can act on, not a summary of a verdict.
 *
 * `matchedRef` is the reference a caller hands to `entities.resolve`, spelled
 * `<filePath>::<testName>` — the same spelling `adds-value.ts`'s gate reason already prints, so
 * the two surfaces that name a suite test name it the same way.
 *
 * IT IS NOT A `TST-###` SHORT-ID, and that is measured rather than an omission. `ENTITY_KINDS`
 * reserves `TST`, but a short-ID exists only once something SIGHTS the entity, and sighting is
 * what mints the permanent address — `resolver/resolve.ts` states that no creation path anywhere
 * calls the ledger, so a refusal could not mint one without becoming a write on a read path.
 * Measured further: `composeLocalAgent()` wires exactly one sighting source, the memory one, so
 * NO suite test has a `TST-###` on any host in this build. Printing one would publish an address
 * that resolves to nothing, which is precisely ENTY-01's never-guess failure. The durable identity
 * is what this build can name truthfully, so it is what the refusal names; when a `TST` sighting
 * source lands, this field is the one place that has to change.
 *
 * `threshold` rides along because a refusal that reports 0.52 without reporting what it was
 * compared to tells an author nothing about whether their draft was borderline.
 */
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

/**
 * The `entities.resolve` reference for a suite test — the house spelling, in one place.
 *
 * DELEGATES to `suiteTestRef` rather than re-forming the string. Two spellings of one
 * reference were live in the tree — this one and the schema's, minted there with the words "so no
 * surface invents a second" — and while they agreed the drift was invisible. The one that survives
 * is the one in `schema`, because the binder that CONSUMES this ref lives on the other side of the
 * package boundary from the lane that produces it.
 */
export function dedupMatchRef(identity: SuiteTestIdentity): string {
  return suiteTestRef(identity.filePath, identity.testName)
}

/**
 * How alike are an INTENT and a committed test — on the two axes the two can be compared on.
 *
 * WHY TWO. `textOverlap` is a token-set Jaccard, so the denominator is the UNION. An intent is one
 * sentence and has no steps; a suite entry is a name plus every step it runs. Scoring the intent
 * against the entry's whole document therefore puts tokens in the denominator the intent
 * structurally cannot supply, and the resulting score is bounded far below 1 no matter how exactly
 * the two agree. That is not a tuning problem, it is a comparison between things of different
 * kinds, and it made this lane's refusal arm arithmetically unreachable: an intent that was a
 * committed test's name VERBATIM — the strongest duplicate signal that can exist — scored 0.2917
 * against a 0.45 pin, and across the whole shipping demo suite the best such score was 0.40. Ten
 * of ten committed tests were un-refusable, measured live and then generalised (394-30 leg D,
 * 394-VERIFICATION round 4, WINDOWS 118).
 *
 * So the entry is also read on the axis an intent CAN saturate: its name alone. A name and a
 * sentence are both one line of description, and their union carries nothing neither side could
 * have said.
 *
 * THE LARGER WINS, and the direction is the safe one twice over. Max is monotone upward, so no
 * pair the whole-document axis already refused can flip to admit — the change can only add
 * refusals, which is the direction this threshold's own comment spends forty lines arguing for.
 * And a duplicate is a duplicate on EITHER reading: an utterance reciting a procedure a test
 * already performs is caught on the document axis, an utterance naming a test that already exists
 * is caught on the name axis, and neither catches the other's case.
 *
 * BOTH AXES GO THROUGH THE ONE SHIPPED `textOverlap`. Two axes are not two recipes — what differs
 * is which text is compared, never how. A second tokenizer or a second notion of similarity is
 * what D-16 forbids, and nothing here defines either.
 */
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

/**
 * Stage 2 — screen the intent against the authored suite, BEFORE anything is authored.
 *
 * The intent stands in for the draft's text because at this point there IS no draft, which is what
 * makes the screen worth doing at all. It is scored through `textOverlap`, the shipped comparison
 * gate 3's degraded lane already screens with, rather than through a second recipe: two
 * notions of "how alike are these two tests" would let the pre-authoring screen and the post-run
 * gate disagree about the same pair. Which TEXTS that recipe is pointed at is
 * {@link scoreIntentAgainst}'s subject.
 *
 * THE TIE-BREAK IS PART OF THE CONTRACT, not an implementation detail. Two suite tests can score
 * identically — most easily when a suite carries the same test at two paths — and a lane that took
 * whichever the host happened to yield first would report a different duplicate on a re-run over
 * the same suite, which makes the refusal's link unreliable at exactly the moment a user is
 * deciding whether to trust it. The smallest workspace-relative identity path wins, so two
 * invocations against one suite name one test.
 */
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
