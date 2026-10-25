// THE FAILURE VIEW'S PROJECTION — what a member's block shows, derived from the op's bytes alone.
//
// Phase 406-01 · DETL-04, D-03 / D-05 / D-10. Grown in 406-06 · D-08 / D-09 / D-10 / D-11 / D-19.
//
// THIS FILE COMPOSES NO SENTENCE, AND THAT IS THE POINT. `analysis.get` is THE single producer of
// a run's verdict sentences (389 D-11), written by `packages/agent/src/analysis/render-sentence.ts`.
// Every surface, the CLI print, CLI chat and this page, reads its output rather than re-deriving it.
// A template here would be a second producer of one fact, which is the 405 D-01 anti-pattern
// restated. What this module does is JOIN: the
// op's `verdicts[]` to the op's `sentences[]` and to its `clusters[]`, keyed by the member handle,
// into the map the page hands each `MemberGroup`.
//
// IT IS PURE AND TOTAL. No I/O, no clock, no React. The only inputs are the op's own bytes and the
// analysis CHIP STATUS WORD — a pushed `watchPostProcessing` frame is a TRIGGER and never a paint
// input (D-03, 404 D-17 applied a second time). An absent analysis and an empty `verdicts[]` (a
// green run: `resolveRunVerdicts` filters `passed | skipped | cancelled`, so a run with nothing to
// explain answers an empty list) both project to the same honest answer: no entry, therefore no
// block.
//
// THE JOIN KEY IS `perTest`, WHICH IS `RunDetailMember.testIndex`. Never `testId` — that is a
// per-run explicit id the projection does not key members by — and never array position, which
// would pair the first verdict with the first sentence whatever member each is about.
//
// THE VERDICT IS WHAT KEYS AN ENTRY, NOT THE SENTENCE (406-06). A verdict the renderer has not
// answered for yet is kept, with an empty sentence: it still carries the `producer`, the
// `confidence` and — through the chip — the marker, which is exactly what a reader needs while the
// sentence is still coming. A SENTENCE with no verdict is still dropped; there is no producer to
// attribute it to and no outcome to grade it against. (406-01 dropped both; this widening is the
// one behaviour 406-06 supersedes, and its cell says so.)
//
// THE LIFECYCLE'S ONLY INPUT IS THE CHIP WORD (D-09 / D-11). `provisional` while the chain is
// `pending` or `running`, `failed` when it permanently fell back, nothing when it is `done` or when
// no read has landed. It is NEVER inferred from the sentence's text. The deterministic floor closes
// its sentences with an undetermined-cause clause, and a projection that sniffed for that wording
// would mark an LLM verdict that happened to contain it and would go quiet the day the floor's copy
// changed — so the wording is not written in this file at all, and a grep for it is an acceptance
// gate. The cells pin the rule with a PAIR: the same chip, two sentences, one marker.
//
// EVERY PUBLISHED SENTENCE IS AN EXPORTED CONSTANT (`post-processing-view.ts`'s law). The cells
// assert against the constants, so copy moves in one place and the tests move with it.

import type {
  AnalysisGetOutput,
  AnalysisMemoryOnPathEntry,
  AnalysisResolvedVerdict,
  PostProcessingChipStatus,
  Mark,
  RunDetailMemberMark,
  RunDetailProjection,
} from '@vostride/agent-qa-schema'

export type OnMark = (testIndex: number, stepIndex: number | undefined, kind: Mark, note?: string) => Promise<'refreshed' | 'retained' | 'stale'>
/** 432-09 (D-15): a refused mark, as a plain reason. */
export interface MarkDenial { reason: string }

/** The provenance chip when the model authored this verdict (D-10). */
export const LLM_VERDICT_LABEL = 'LLM verdict'

/** The provenance chip when nothing but the deterministic classifier spoke (D-10). */
export const DETERMINISTIC_FALLBACK_LABEL = 'deterministic fallback'

/** The marker beside a sentence the chain may still upgrade (D-09). */
export const ANALYSIS_PROVISIONAL_TEXT = 'analysis running — this may upgrade'

/** The marker beside a sentence the chain will never upgrade, because it failed (D-11). */
export const ANALYSIS_FAILED_FALLBACK_TEXT = 'analysis failed — showing deterministic fallback'

/**
 * The analysis chip's word, or nothing when the post-processing read has not answered yet.
 *
 * This is the input the provisional and failed MARKERS are keyed off. They are keyed off the CHIP,
 * never off the sentence's text.
 */
export type AnalysisChipWord = PostProcessingChipStatus | undefined

/** What the block warns about, when there is anything to warn about (D-09 / D-11). */
export type MemberVerdictMarker = 'provisional' | 'failed'

/** One sibling of a member's cluster: the join keys a link needs, nothing more (389 D-16). */
export interface MemberVerdictSibling {
  readonly testIndex: number
  readonly testId: string
}

/** One artifact the verdict cited, with the two absence facts folded into one rendered state. */
export interface MemberVerdictArtifact {
  readonly id: string
  readonly sha: string
  /** `present === false` OR `evidenceIncomplete === true` — presence-UNKNOWN is neither (D-17). */
  readonly incomplete: boolean
}

/** How many of a member's cited artifacts are gone, out of how many it cited (D-19). */
export interface MemberVerdictMissingEvidence {
  readonly missing: number
  readonly total: number
}

/** One member's verdict, ready to paint. Every field is the op's, except the product's own copy. */
export interface MemberVerdictView {
  readonly marks?: readonly RunDetailMemberMark[]
  /** The member handle this block belongs under — the op's `perTest`. */
  readonly testIndex: number
  /** The op's sentence, VERBATIM. Never sliced, never re-cased, never re-composed. */
  readonly sentence: string
  readonly producer: AnalysisResolvedVerdict['producer']
  readonly confidence: number
  /** This product's own words about the two fields above (D-10). */
  readonly provenance: string
  /** The chip word's marker, absent on a terminal chain and on an unread one (D-09 / D-11). */
  readonly marker?: MemberVerdictMarker
  /** The marker's exported sentence — present exactly when `marker` is. */
  readonly markerText?: string
  /** The step ordinals this verdict read, in the producer's order (D-01 / D-02). */
  readonly citedSteps: readonly number[]
  /** The artifacts this verdict read, each with its rendered absence state (D-01 / D-19). */
  readonly citedArtifacts: readonly MemberVerdictArtifact[]
  /** The other members of this member's cluster, self excluded, producer order kept (D-08). */
  readonly siblings: readonly MemberVerdictSibling[]
  /** The sibling line — present exactly when `siblings` is non-empty. */
  readonly siblingText?: string
  /** The member-level absence count — present only when something is actually gone (D-19). */
  readonly missingEvidence?: MemberVerdictMissingEvidence
  /** The count line — present exactly when `missingEvidence` is. */
  readonly missingEvidenceText?: string
  /** The records this verdict declared on its failing path. Absent when it declared nothing. */
  readonly memoryOnPath?: MemberMemoryOnPathView
}

/**
 * The provenance chip's reading (D-10).
 *
 * A CONFIDENCE ONLY WHERE THERE IS ONE TO READ. `analyze-run` authors a number a reader can weigh;
 * the deterministic floor mints `confidence: 0` for every `unknown` it fills in, and printing
 * "deterministic fallback · 0.00" would offer that constant as though it were a measurement.
 */
export function provenanceLabel(
  producer: AnalysisResolvedVerdict['producer'],
  confidence: number,
): string {
  return producer === 'analyze-run'
    ? `${LLM_VERDICT_LABEL} · ${confidence.toFixed(2)}`
    : DETERMINISTIC_FALLBACK_LABEL
}

/**
 * The chip word's marker — the WHOLE lifecycle rule, in one total switch (D-09 / D-11).
 *
 * `complete` and "no read yet" both answer nothing, and they answer it for different reasons: a
 * terminal chain has nothing left to warn about, and a page that has not heard from the read route
 * has nothing to warn WITH. Neither is a marker, and inventing one for either would put a
 * permanent "still running" beside a finished verdict.
 */
export function markerFor(chip: AnalysisChipWord): MemberVerdictMarker | undefined {
  switch (chip) {
    case 'pending':
    case 'running':
      return 'provisional'
    case 'failed':
      return 'failed'
    case 'complete':
    case undefined:
      return undefined
  }
}

/** The marker's own sentence, so the word and the copy cannot drift apart. */
function markerTextFor(marker: MemberVerdictMarker | undefined): string | undefined {
  if (marker === undefined) return undefined
  return marker === 'provisional' ? ANALYSIS_PROVISIONAL_TEXT : ANALYSIS_FAILED_FALLBACK_TEXT
}

/**
 * The affordance on a step the verdict cited (D-02).
 *
 * THE ORDINAL IS THE PRODUCER'S, NOT THE TREE'S. The sentence directly above this row quotes the
 * same step as `observed (step N)`, and the step is addressed by `<testIndex>:<stepIndex>` in the
 * `?step=` deep link, so both the prose a reader just read and the URL they can copy count from
 * zero. The tree's own "step N of M" counter is a display ordinal and is deliberately not borrowed
 * here — a link labelled one number that jumps to another is the off-by-one nobody debugs.
 */
export function citedStepLabel(stepIndex: number): string {
  return `step ${String(stepIndex)}`
}

/**
 * The affordance on an artifact the verdict cited (D-02, second half).
 *
 * IT NAMES THE THING, NOT THE ACTION. The sha is on the element as `data-cited-artifact` and is
 * what the click carries; a label that spelled it would put 64 hex characters in a sentence and
 * still not tell a reader what opens. The word is the noun the drawer's own tab wears.
 */
export const CITED_ARTIFACT_LABEL = 'screenshot'

/** The cluster sibling line (D-08). Counts the SIBLINGS, so "other" is literally true. */
export function siblingLine(count: number): string {
  return `same failure as ${String(count)} other ${count === 1 ? 'test' : 'tests'}`
}

/** One record the run's own briefs put on this member's failing path, as declared. */
export type MemberMemoryOnPathEntry = AnalysisMemoryOnPathEntry

/** The records a verdict declared on its failing path, ready to paint. */
export interface MemberMemoryOnPathView {
  readonly onPath: readonly MemberMemoryOnPathEntry[]
  readonly onPathText: string
}

/** The author declared NO records. */
export const MEMORY_ON_PATH_NONE_TEXT = 'memory on path: none declared'

export const MEMORY_ON_PATH_RECORDS_LABEL = 'All records on path'

export function memoryOnPathLine(count: number): string {
  return `memory on path: ${String(count)} ${count === 1 ? 'record' : 'records'}`
}

function readMemoryOnPath(
  memoryOnPath: readonly AnalysisMemoryOnPathEntry[],
): MemberMemoryOnPathView {
  return {
    onPath: memoryOnPath,
    onPathText: memoryOnPath.length === 0
      ? MEMORY_ON_PATH_NONE_TEXT
      : memoryOnPathLine(memoryOnPath.length),
  }
}

/**
 * The member-level count beside a block whose evidence is partly gone (D-19).
 *
 * THE PLURAL KEYS ON THE TOTAL, not on the missing count, because the noun it agrees with is
 * "cited artifacts" — the set the member cited, not the subset that vanished.
 */
export function missingEvidenceLine(count: MemberVerdictMissingEvidence): string {
  const noun = count.total === 1 ? 'cited artifact' : 'cited artifacts'
  return `${String(count.missing)} of ${String(count.total)} ${noun} unavailable`
}

/**
 * The op's answer, keyed by member handle (D-05).
 *
 * TOTAL over every input the page can hold: `undefined` while the first read is in flight or after
 * a rejected one, an empty `verdicts[]` on a green run, a verdict the op listed with no matching
 * sentence, a cluster naming a member no verdict covers, and an evidence block the op did not send
 * at all. A member with no entry renders no block — which is the honest rendering of "there is
 * nothing to explain here".
 */
export function projectAnalysisView(
  analysis: AnalysisGetOutput | undefined,
  chip: AnalysisChipWord,
  detail?: RunDetailProjection | null,
): ReadonlyMap<number, MemberVerdictView> {
  const view = new Map<number, MemberVerdictView>()
  if (analysis === undefined) return view

  const marker = markerFor(chip)
  const markerText = markerTextFor(marker)

  const sentenceByPerTest = new Map(
    analysis.sentences.map((entry) => [entry.perTest, entry.sentence] as const),
  )

  // ONE FOLD OVER THE CLUSTERS, and the first cluster naming a member wins. A member listed twice
  // is a producer fault the page cannot adjudicate; picking one keeps the line total rather than
  // concatenating two contradictory groupings under one sentence.
  const siblingsByPerTest = new Map<number, readonly MemberVerdictSibling[]>()
  for (const entry of analysis.clusters) {
    for (const self of entry.members) {
      if (siblingsByPerTest.has(self.testIndex)) continue
      siblingsByPerTest.set(
        self.testIndex,
        entry.members
          .filter((other) => other.testIndex !== self.testIndex)
          .map((other) => ({ testIndex: other.testIndex, testId: other.testId })),
      )
    }
  }

  for (const verdict of analysis.verdicts) {
    const citedArtifacts = (verdict.evidence?.citedArtifacts ?? []).map((ref) => ({
      id: ref.id,
      sha: ref.sha,
      // PRESENCE-UNKNOWN IS NOT AN ABSENCE (406-03 / D-17). A host that cannot cheaply stat its
      // blobs omits `present` entirely, and `!ref.present` would render that omission as a claimed
      // deletion. The predicate is `=== false`, and it is spelled that way on purpose.
      incomplete: ref.present === false || ref.evidenceIncomplete === true,
    }))
    const missing = citedArtifacts.filter((ref) => ref.incomplete).length
    const missingEvidence =
      missing === 0 ? undefined : { missing, total: citedArtifacts.length }
    const siblings = siblingsByPerTest.get(verdict.perTest) ?? []

    view.set(verdict.perTest, {
      ...(() => {
        const marks = detail?.members.find(member => member.testIndex === verdict.perTest)?.marks
        return marks === undefined ? {} : { marks }
      })(),
      testIndex: verdict.perTest,
      sentence: sentenceByPerTest.get(verdict.perTest) ?? '',
      producer: verdict.producer,
      confidence: verdict.confidence,
      provenance: provenanceLabel(verdict.producer, verdict.confidence),
      marker,
      markerText,
      citedSteps: verdict.evidence?.citedSteps ?? [],
      citedArtifacts,
      siblings,
      siblingText: siblings.length === 0 ? undefined : siblingLine(siblings.length),
      missingEvidence,
      missingEvidenceText:
        missingEvidence === undefined ? undefined : missingEvidenceLine(missingEvidence),
      ...(verdict.memoryOnPath === undefined
        ? {}
        : { memoryOnPath: readMemoryOnPath(verdict.memoryOnPath) }),
    })
  }
  return view
}
