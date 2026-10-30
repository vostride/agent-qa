// A non-empty fingerprint union decides alone; the text lane decides only when the union is empty.

import type { AddsValueFinding } from '@vostride/agent-qa-schema'

import type { SuiteFingerprintIndexLike, SuiteTextCorpusEntryLike } from './ports.js'

// Compared with `>=`, so a tie reads as covered: over-flagging is the safe failure on this lane.
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
  // Suite tests outside `index.coveredTests()`, which have no fingerprint evidence.
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

// Shares one traversal with `textSimilarity`, so dedup's shared-token count uses the same tokens.
export interface TextOverlap {
  /** Token-set Jaccard, symmetric and bounded. */
  readonly score: number
  /** How many normalized tokens the two texts share — the numerator, reported. */
  readonly sharedTokens: number
}

// Two empty texts score 0, not 1, or one empty corpus entry would cover every draft.
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

// Separator written as the escape `\u0000`: a raw control byte makes tools read the file as binary.
function identityKey(filePath: string, testName: string): string {
  return `${filePath}\u0000${testName}`
}

// Answered even after gate 1 fails: no evidence returns `false` with a reason naming the absence.
export function addsValueGate(input: AddsValueGateInput): AddsValueGateResult {
  const union = input.index.elementUnion()
  const covered = input.index.coveredTests()

  // An empty suite passes, or the first test a project writes would be denied.
  if (union.size === 0 && input.textCorpus.length === 0) {
    return {
      pass: true,
      finding: { novelElements: [...new Set(input.draftElements)], comparedTests: [] },
      reason: 'the suite is empty — no fingerprint coverage and no comparable text, so every '
        + 'element is uncovered',
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

  // A non-empty union means the fingerprint lane spoke, and its answer is the verdict.
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
      + `${input.unionSize} — the fingerprint lane decided`
    if (input.textCovered.length === 0) {
      return `${decided}, and no evidence-less suite test resembles the draft`
    }
    return `${decided}; ${input.textCovered.length} evidence-less suite test(s) resemble the draft `
      + 'on the degraded text lane and are recorded per compared test without deciding'
  }
  if (input.pass) {
    return 'the suite fingerprint index is empty, so the degraded text lane decided: no '
      + 'evidence-less suite test resembles the draft'
  }
  if (input.unionSize === 0 && input.textCovered.length > 0) {
    return 'the text fallback lane matched '
      + input.textCovered.map((entry) => `${entry.filePath}::${entry.testName}`).join(', ')
      + ` at or above ${TEXT_FALLBACK_SIMILARITY_THRESHOLD} similarity — an evidence-less suite `
      + 'test this draft resembles, flagged toward already-covered'
  }
  if (input.draftElementCount === 0) {
    return 'the draft produced no fingerprint elements, so nothing could be shown to be novel — '
      + 'not a finding that it duplicates the suite (check gate 1 first)'
  }
  return `every element the draft exercised (${input.draftElementCount}) is already in the suite `
    + `union of ${input.unionSize}`
}
