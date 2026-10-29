// Joins the op's verdicts to its sentences by `perTest`; it composes and inspects no sentence.

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
export interface MarkDenial { reason: string }

/** The provenance chip when the model authored this verdict. */
export const LLM_VERDICT_LABEL = 'LLM verdict'

/** The provenance chip when nothing but the deterministic classifier spoke. */
export const DETERMINISTIC_FALLBACK_LABEL = 'deterministic fallback'

/** The marker beside a sentence the chain may still upgrade. */
export const ANALYSIS_PROVISIONAL_TEXT = 'analysis running — this may upgrade'

/** The marker beside a sentence the chain will never upgrade, because it failed. */
export const ANALYSIS_FAILED_FALLBACK_TEXT = 'analysis failed — showing deterministic fallback'

/**
 * The analysis chip's word, or nothing when the post-processing read has not answered yet.
 *
 * This is the input the provisional and failed MARKERS are keyed off. They are keyed off the CHIP,
 * never off the sentence's text.
 */
export type AnalysisChipWord = PostProcessingChipStatus | undefined

/** What the block warns about, when there is anything to warn about. */
export type MemberVerdictMarker = 'provisional' | 'failed'

/** One sibling of a member's cluster: the join keys a link needs, nothing more. */
export interface MemberVerdictSibling {
  readonly testIndex: number
  readonly testId: string
}

/** One artifact the verdict cited, with the two absence facts folded into one rendered state. */
export interface MemberVerdictArtifact {
  readonly id: string
  readonly sha: string
  // `present === false` or `evidenceIncomplete === true`; unknown presence is neither.
  readonly incomplete: boolean
}

/** How many of a member's cited artifacts are gone, out of how many it cited. */
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
  /** This product's own words about the two fields above. */
  readonly provenance: string
  /** The chip word's marker, absent on a terminal chain and on an unread one. */
  readonly marker?: MemberVerdictMarker
  /** The marker's exported sentence — present exactly when `marker` is. */
  readonly markerText?: string
  /** The step ordinals this verdict read, in the producer's order. */
  readonly citedSteps: readonly number[]
  /** The artifacts this verdict read, each with its rendered absence state. */
  readonly citedArtifacts: readonly MemberVerdictArtifact[]
  /** The other members of this member's cluster, self excluded, producer order kept. */
  readonly siblings: readonly MemberVerdictSibling[]
  /** The sibling line — present exactly when `siblings` is non-empty. */
  readonly siblingText?: string
  /** The member-level absence count — present only when something is actually gone. */
  readonly missingEvidence?: MemberVerdictMissingEvidence
  /** The count line — present exactly when `missingEvidence` is. */
  readonly missingEvidenceText?: string
  /** The records this verdict declared on its failing path. Absent when it declared nothing. */
  readonly memoryOnPath?: MemberMemoryOnPathView
}

// The deterministic floor mints `confidence: 0`, so its chip prints no confidence.
export function provenanceLabel(
  producer: AnalysisResolvedVerdict['producer'],
  confidence: number,
): string {
  return producer === 'analyze-run'
    ? `${LLM_VERDICT_LABEL} · ${confidence.toFixed(2)}`
    : DETERMINISTIC_FALLBACK_LABEL
}

// A complete chain and an unread one get no marker, or a finished verdict would read running.
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

// Counts from zero like the sentence and the `?step=` link, not like the tree's display ordinal.
export function citedStepLabel(stepIndex: number): string {
  return `step ${String(stepIndex)}`
}

// The sha rides on `data-cited-artifact`; the label names the drawer tab the click opens.
export const CITED_ARTIFACT_LABEL = 'screenshot'

// Counts siblings only, so `other` is literally true.
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

// The plural keys on the total, because the noun is the cited set, not the missing subset.
export function missingEvidenceLine(count: MemberVerdictMissingEvidence): string {
  const noun = count.total === 1 ? 'cited artifact' : 'cited artifacts'
  return `${String(count.missing)} of ${String(count.total)} ${noun} unavailable`
}

// Total over every input the page holds; a member with no entry renders no block.
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
      // A host that cannot stat its blobs omits `present`, so only `=== false` claims a deletion.
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
