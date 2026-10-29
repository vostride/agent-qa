// Gate 3 — adds-value.
//
// SET SEMANTICS, NO THRESHOLD, ON THE PRIMARY LANE (D-14, spec §6.3 verbatim). The draft adds
// value when at least one of its fingerprint elements is absent from the union of the suite's.
// There is no similarity score here and therefore no magic constant to defend: conservatism lives
// in the normalizer, where "near-same elements are the same element" already has exactly one
// definition. The receipt NAMES the uncovered elements rather than counting them, because a gate
// that says "0.31" tells an author nothing they can act on.
//
// BOTH SIDES OF THE COMPARISON ARE MINTED BY ONE FUNCTION. The suite union is folded from
// `testFingerprintElements`; so is the draft's own element list, from the draft's member outcome
// inside its gate-run document. The elements arrive here already computed — see `verify-draft.ts`
// — and this module never derives them, which is what stops a second recipe from appearing on the
// draft side and turning a comparison of two tests into a comparison of two derivations.
//
// THE TEXT LANE IS DEGRADED, AND SAYS SO PER TEST. A suite test the derived index has no
// evidence for cannot join the set comparison at all, and dropping it would let a draft look novel
// purely because the thing it duplicates has never been run. So those tests join on text
// similarity instead, over-flagging toward "already covered" — the safe direction, symmetric with
// the ratified dedup posture — and every compared test carries the lane that answered for it, so a
// fingerprint-lane fact and a text-lane guess can never be read as the same claim.
//
// DECIDER PRECEDENCE, AND IT IS NOT SYMMETRIC (D-14 over D-16 · CR-01). Wherever the fingerprint
// lane CAN speak — a non-empty suite union — it is the whole verdict, and the text lane's
// resemblances are recorded per compared test without deciding. Only when the union is empty, so
// the primary lane has nothing to say, does the text lane decide. The shipped decider was
// `novel > 0 && textCovered.length === 0`, which is the other arrangement: a 0.5 Jaccard guess
// vetoing a fingerprint fact, and — because the derived index is gitignored and therefore empty on
// every fresh checkout and every CI job — the SOLE decider in the common case, on a threshold D-14
// says this gate does not have. Two concurrent deciders is the defect, not the ordering of them.
// If a future change gives the text lane a say where a union exists, it is re-minting that defect.

import type { AddsValueFinding } from '@vostride/agent-qa-schema'

import type { SuiteFingerprintIndexLike, SuiteTextCorpusEntryLike } from './ports.js'

/**
 * Similarity at or above which an evidence-less suite test counts as already covering the draft.
 *
 * A PINNED CONSTANT, never config. It is the only number in this gate, and it exists
 * only on the degraded lane — the fingerprint lane has none by ratified design.
 *
 * RETUNE COMMENT — and this one comes with its measurement. The pair the constant has to separate
 * is the frozen corpus's own: `gate3-near-duplicate.yaml` was authored to mirror
 * `uat-381-local-form.yaml`'s anchors in different words, and `accept-control.yaml` was authored
 * not to. Against uat-381 those two score **0.5000** and **0.4074** respectively under
 * `textSimilarity` below (measured 2026-08-10), so this value sits exactly ON the duplicate and
 * 0.093 above the control — the whole usable band is under a tenth of a point, and the duplicate
 * has zero margin above the line. That is the honest reason D-16 calls this lane a fallback rather
 * than a comparison: two tests of the same small app share most of their tokens whatever they do,
 * so the signal lives in the tail. Two consequences follow, both deliberate. The comparison is
 * `>=`, so a tie reads as covered and the draft loses — over-flagging toward covered is the safe
 * failure, and it is what makes a value sitting exactly on the duplicate usable at all. And RAISING
 * this number immediately stops catching the duplicate, while LOWERING it has room down to 0.4074
 * before it starts refusing the accept control; the asymmetry is worth knowing before reaching for
 * the knob.
 *
 * Before moving it, re-measure BOTH corpus scores (the test
 * `separates the corpus near-duplicate from the corpus accept control` prints the pair by
 * failing), and re-run the frozen expectations table — a widening that catches one more duplicate
 * while failing the accept control has moved the gate's numerator in the direction that costs a
 * user a good test.
 */
export const TEXT_FALLBACK_SIMILARITY_THRESHOLD = 0.5

export interface DraftTextLike {
  readonly testName: string
  readonly steps: readonly string[]
}

export interface AddsValueGateInput {
  /** The draft's identity name and pre-interpolation step text, for the text lane. */
  readonly draft: DraftTextLike
  /** The draft's own fingerprint elements, in exercised order. */
  readonly draftElements: readonly string[]
  readonly index: SuiteFingerprintIndexLike
  /** D-16's evidence-less population: the authored suite MINUS `index.coveredTests()`. */
  readonly textCorpus: readonly SuiteTextCorpusEntryLike[]
}

export interface AddsValueGateResult {
  readonly pass: boolean
  readonly finding: AddsValueFinding
  readonly reason: string
}

/**
 * Normalized tokens: lowercase, split on anything that is not a letter or digit, empties dropped.
 *
 * No stopword list. A closed set of English function words would be a fifth lexicon to maintain
 * and retune, and its effect here is small in a fixed direction: shared function words inflate
 * every pair's score roughly equally, which the threshold absorbs once rather than per comparison.
 */
function tokens(texts: readonly string[]): Set<string> {
  const set = new Set<string>()
  for (const text of texts) {
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token !== '') set.add(token)
    }
  }
  return set
}

/**
 * What one text comparison produced: the Jaccard score AND the intersection size behind it.
 *
 * TWO READINGS OF ONE COMPARISON, not two comparisons. `textSimilarity` is the score alone and is
 * what this gate decides on; 394's stage-2 dedup refusal has to NAME the evidence that produced
 * its verdict, and a shared-token count recomputed on the other side of that seam would be
 * a second tokenizer — the one thing D-16 says must not exist, since two normalizers let a
 * pre-authoring screen and a post-run gate disagree about the same pair. So the count is reported
 * out of the same traversal over the same {@link tokens} normalizer, and there is still exactly
 * one definition of how alike two tests are.
 */
export interface TextOverlap {
  /** Token-set Jaccard, symmetric and bounded. */
  readonly score: number
  /** How many normalized tokens the two texts share — the numerator, reported. */
  readonly sharedTokens: number
}

/**
 * Token-set Jaccard between a draft and a suite test's text (D-16's fallback comparison).
 *
 * Symmetric and bounded, and TWO EMPTY TEXTS SCORE 0 rather than 1: the degenerate `0/0` is not
 * an identity, and reading it as one would let a single empty text-corpus entry cover every draft
 * ever evaluated — an over-flag so complete it would turn the safe direction into a gate that
 * always says no. A zero score on an empty side reports zero shared tokens, which is the true
 * count rather than a sentinel.
 */
export function textOverlap(draft: DraftTextLike, entry: SuiteTextCorpusEntryLike): TextOverlap {
  const left = tokens([draft.testName, ...draft.steps])
  const right = tokens([entry.testName, ...entry.stepsText])
  if (left.size === 0 || right.size === 0) return { score: 0, sharedTokens: 0 }

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return { score: shared / (left.size + right.size - shared), sharedTokens: shared }
}

/** The score half of {@link textOverlap} — this gate's whole reading of a text comparison. */
export function textSimilarity(draft: DraftTextLike, entry: SuiteTextCorpusEntryLike): number {
  return textOverlap(draft, entry).score
}

/** The draft's elements that no suite test has exercised, deduplicated, in first-seen order. */
function novelElementsOf(
  draftElements: readonly string[],
  union: ReadonlySet<string>,
): string[] {
  const novel: string[] = []
  const seen = new Set<string>()
  for (const element of draftElements) {
    if (union.has(element) || seen.has(element)) continue
    seen.add(element)
    novel.push(element)
  }
  return novel
}

/**
 * The stable identity as one comparable key.
 *
 * The separator is written as the ESCAPE `\u0000`, never as a raw control byte in this source.
 * 393-05 shipped a module carrying a literal NUL and `file(1)` classified the whole file `data`,
 * so `grep` reported it as empty — a false CLEAN verdict from the exact instrument this phase's
 * posture checks rely on. (This very function was written with a raw 0x1F first; `file(1)` said
 * `data` and the lesson landed a second time in one phase.) A separator is still needed, because
 * concatenation alone lets ("ab", "c") and ("a", "bc") collide.
 */
function identityKey(filePath: string, testName: string): string {
  return `${filePath}\u0000${testName}`
}

/**
 * Gate 3 over an already-minted draft element list.
 *
 * The gate is answered even when gate 1 failed and the draft produced little or no evidence —
 * D-04 forbids short-circuiting, and a gate that returned a default in that case would make the
 * corpus's independence claim unprovable. What it returns then is `false` with a reason naming the
 * absence, which is the honest reading: nothing was shown to be novel, which is not the same claim
 * as "this draft duplicates the suite" and the reason string keeps the two apart.
 */
export function addsValueGate(input: AddsValueGateInput): AddsValueGateResult {
  const union = input.index.elementUnion()
  const covered = input.index.coveredTests()

  // a truly empty suite trivially passes — everything is uncovered. Stated as its own rule
  // rather than left to fall out of the novel-element count, which answers `false` for a draft
  // with no elements and would deny the first test a project ever writes.
  if (union.size === 0 && input.textCorpus.length === 0) {
    return {
      pass: true,
      finding: { novelElements: [...new Set(input.draftElements)], comparedTests: [] },
      reason: 'the suite is empty — no fingerprint coverage and no comparable text, so every '
        + 'element is uncovered (D-16)',
    }
  }

  const novelElements = novelElementsOf(input.draftElements, union)
  const draftElementSet = new Set(input.draftElements)

  const comparedTests: AddsValueFinding['comparedTests'] = covered.map((identity) => {
    const suiteElements = new Set(
      input.index.elementsForTest(identity.filePath, identity.testName),
    )
    return {
      filePath: identity.filePath,
      testName: identity.testName,
      lane: 'fingerprint' as const,
      // Does THIS test on its own subsume everything the draft exercised — the per-test statement
      // behind a union-level verdict, so an author told "already covered" can be told by what.
      covered: draftElementSet.size > 0
        && [...draftElementSet].every((element) => suiteElements.has(element)),
    }
  })

  // The text lane, over identities the fingerprint lane could not speak for. A host that hands
  // over an identity WITH evidence anyway is answered by the lane that has it: one test may appear
  // once, or the receipt would carry two lanes for one comparison and contradict itself.
  const fingerprintIdentities = new Set(
    covered.map((identity) => identityKey(identity.filePath, identity.testName)),
  )
  const textCovered: SuiteTextCorpusEntryLike[] = []
  for (const entry of input.textCorpus) {
    if (fingerprintIdentities.has(identityKey(entry.filePath, entry.testName))) continue
    const similar = textSimilarity(input.draft, entry) >= TEXT_FALLBACK_SIMILARITY_THRESHOLD
    if (similar) textCovered.push(entry)
    comparedTests.push({
      filePath: entry.filePath,
      testName: entry.testName,
      lane: 'text',
      covered: similar,
    })
  }

  // D-14 outranks D-16 wherever the primary lane has evidence: a non-empty union means the
  // fingerprint lane spoke, and its answer is the verdict. The text lane decides only in the state
  // it was ratified for — an index that can say nothing at all.
  const pass = union.size > 0
    ? novelElements.length > 0
    : novelElements.length > 0 && textCovered.length === 0

  return { pass, finding: { novelElements, comparedTests }, reason: gateReason({
    pass,
    novelElements,
    unionSize: union.size,
    draftElementCount: draftElementSet.size,
    textCovered,
  }) }
}

function gateReason(input: {
  pass: boolean
  novelElements: readonly string[]
  unionSize: number
  draftElementCount: number
  textCovered: readonly SuiteTextCorpusEntryLike[]
}): string {
  // Every branch NAMES THE LANE THAT ANSWERED. The verdict is one boolean over two possible
  // sources, so a receipt that does not say which one decided cannot be audited for whether a
  // fingerprint fact or a degraded-lane guess produced it.
  if (input.pass && input.unionSize > 0) {
    const decided = `${input.novelElements.length} element(s) absent from the suite union of `
      + `${input.unionSize} — the fingerprint lane decided (D-14)`
    if (input.textCovered.length === 0) {
      return `${decided}, and no evidence-less suite test resembles the draft (D-16)`
    }
    return `${decided}; ${input.textCovered.length} evidence-less suite test(s) resemble the draft `
      + 'on the degraded text lane and are recorded per compared test without deciding (D-16)'
  }
  if (input.pass) {
    return 'the suite fingerprint index is empty, so the degraded text lane decided: no '
      + 'evidence-less suite test resembles the draft (D-16)'
  }
  if (input.unionSize === 0 && input.textCovered.length > 0) {
    return 'the text fallback lane matched '
      + input.textCovered.map((entry) => `${entry.filePath}::${entry.testName}`).join(', ')
      + ` at or above ${TEXT_FALLBACK_SIMILARITY_THRESHOLD} similarity — an evidence-less suite `
      + 'test this draft resembles, flagged toward already-covered (D-16)'
  }
  if (input.draftElementCount === 0) {
    return 'the draft produced no fingerprint elements, so nothing could be shown to be novel — '
      + 'not a finding that it duplicates the suite (check gate 1 first)'
  }
  return `every element the draft exercised (${input.draftElementCount}) is already in the suite `
    + `union of ${input.unionSize} (D-14)`
}
