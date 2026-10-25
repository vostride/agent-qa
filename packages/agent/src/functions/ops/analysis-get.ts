// `analysis.get` — one run's full analysis, served once (Phase 389, D-10/D-11/D-14/D-15).
//
// THE single producer of resolved verdicts + rendered sentences + clusters. Plan 07's CLI
// print, M5's run page and 392's chat all call this op; none of them re-derives a verdict,
// composes a second sentence or folds its own clusters — the sentence renderer and the
// cluster function are the same pure symbols this file calls, so every surface is
// byte-identical by construction (SC3, the L10 thin-client law).
//
// Absence discipline (D-10/D-11): a composition with no analysis port refuses BY NAME; a
// bound port with no artifact on disk answers the handoff FLOOR — verdicts through the D-10
// accessor, sentences from the honest template parts — because "the analysis never ran" is
// a true state of a run, not an error. A run with no failures answers empty lists.

import {
  AnalysisGetInputSchema,
  AnalysisGetOutputSchema,
  errorTextOf,
  exercisedAnchors,
  failingStepOf,
  failureFingerprint,
  resolveRunVerdicts,
  slugBranch,
} from '@vostride/agent-qa-schema'
import type {
  AnalysisGetInput,
  AnalysisGetOutput,
  AnalysisSentence,
  CompletedRunHandoff,
  PerTestOutcome,
  RunAnalysisArtifact,
  Verdict,
  VerdictSentenceParts,
} from '@vostride/agent-qa-schema'

import { clusterVerdicts } from '../../analysis/cluster.js'
import { annotatePresence } from './evidence-presence.js'
import { renderVerdictSentence } from '../../analysis/render-sentence.js'
import { templateSentenceParts } from '../../jobs/kinds.js'
import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'
import { RunNotFoundError } from './runs-get.js'

/**
 * Lowercase dot taxonomy (D-15): the locked `analysis` domain, one noun. The exported
 * constant is what plan 07's CLI and every later surface name; the literal appears here
 * once, and the parity-coverage suite picks the id up from the registry automatically.
 */
export const ANALYSIS_GET_FUNCTION_ID = 'analysis.get'

/**
 * Join one verdict to its authored parts, or mint the honest floor (D-06/D-07).
 *
 * Artifact present → the authored parts record joined by `perTest` (never array position).
 * Artifact absent — or an artifact member with no parts record, a shape the guard admits —
 * → the SAME producer-keyed template rule the author uses (`templateSentenceParts`,
 * imported, not respelled), so sentence existence never depends on what got persisted.
 */
function partsFor(
  verdict: Verdict,
  artifact: RunAnalysisArtifact | undefined,
  handoff: CompletedRunHandoff,
): VerdictSentenceParts {
  return (
    artifact?.parts.find((candidate) => candidate.perTest === verdict.perTest)
    ?? templateSentenceParts(verdict, handoff)
  )
}

/**
 * The window key one failure is counted under (390 D-07), or nothing.
 *
 * Every input rule is IMPORTED from schema and none is respelled here: which step the failure
 * is about (`failingStepOf`), which recorded bytes describe it (`errorTextOf`), which anchors
 * it touched (`exercisedAnchors`), and how those compose into the frozen recipe
 * (`failureFingerprint`). That matters because the projection's WRITER composes the window key
 * from the very same four symbols — a second spelling here would mean the clause counts a
 * window nothing ever wrote to.
 *
 * The class folded in is the RESOLVED one (389 D-13's `::class` suffix), so an artifact
 * upgrading a member `unknown → flake` queries a different window on purpose.
 *
 * `undefined` for a member with no failing step to key from — a zero-step failure, or a
 * verdict whose `perTest` names no member. The recipe would happily key those through its
 * error arm, but the value it would produce is a stand-in for evidence that was never
 * recorded, and the query travels perfectly well on identity alone.
 */
function fingerprintFor(
  verdict: Verdict,
  test: PerTestOutcome | undefined,
): string | undefined {
  if (test === undefined) return undefined
  const step = failingStepOf(test)
  if (step === undefined) return undefined
  return failureFingerprint(
    { anchors: exercisedAnchors(step), errorText: errorTextOf(step, test) },
    verdict.class,
  )
}

export const analysisGetSpec: FunctionSpec<AnalysisGetInput, AnalysisGetOutput> = {
  id: ANALYSIS_GET_FUNCTION_ID,
  summary: "Read one run's resolved verdicts, rendered sentences and failure clusters.",
  resultKind: 'unary',
  // Bound exactly where a composition supplies the artifact reader (D-16 idiom). The
  // OPTIONAL `recurrence` dep is deliberately NOT the binding key: a host without history
  // still serves sentences — the renderer answers the explicit no-history clause — so tying
  // the binding to it would refuse a capability this host can honestly run.
  boundThrough: 'analysis',
  input: AnalysisGetInputSchema,
  output: AnalysisGetOutputSchema,
  risk: { name: `fn:${ANALYSIS_GET_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * An analysis is an ANSWER, and its verdicts are what it answered (399.1 D-01).
   *
   * COUNTS AND THE RUN REF, never a sentence out of the artifact: the receipt is a map (392's
   * charter) and every verdict sentence is on `results[]`, which D-04 renders in full beside it.
   */
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `analysis for ${output.runId} — ${output.verdicts.length} verdict(s), `
        + `${output.clusters.length} cluster(s)`,
    }
  },
  async invoke(input, deps: FunctionDeps) {
    const analysis = deps.analysis
    if (analysis === undefined) {
      throw new FunctionNotBoundError(ANALYSIS_GET_FUNCTION_ID)
    }

    const runId = String(input.runId)
    const document = await deps.runs.get(input.runId)
    if (document === undefined) {
      throw new RunNotFoundError(runId)
    }

    const artifact = analysis.getArtifact(runId)
    // The ONE verdict read path (D-10): artifact verdicts when present, the handoff's
    // deterministic floor when absent — never a per-consumer merge.
    const resolved = resolveRunVerdicts(artifact, document)
    // The projection's key law: stable test identity is (product, filePath, testName),
    // with product derived exactly as the outcome projection partitions it.
    const product = slugBranch(document.scope.key)

    const sentences: AnalysisSentence[] = resolved.map((verdict) => {
      const test = document.tests.find((candidate) => candidate.testIndex === verdict.perTest)
      const fingerprint = fingerprintFor(verdict, test)
      const sentence = renderVerdictSentence(
        verdict,
        partsFor(verdict, artifact, document),
        // Recurrence is a LIVE join through the D-08 seam, per call — an absent dep renders
        // the explicit no-history clause, never a dropped section.
        deps.recurrence,
        {
          product,
          filePath: test?.filePath ?? '',
          testName: test?.testName ?? '',
          // OMITTED, not `undefined`: the leg's absence is a fact about this member, and a
          // present-but-empty key would look like a window with no occurrences in it.
          ...(fingerprint === undefined ? {} : { fingerprint }),
        },
      )
      return { perTest: verdict.perTest, testId: test?.testId ?? '', sentence }
    })

    const sentenceByPerTest = new Map(sentences.map((entry) => [entry.perTest, entry.sentence]))

    return {
      runId,
      // The verdict's OWN evidence, projected (406 D-01) — cited steps and cited artifacts as the
      // resolved verdict already held them, so the failure view's links are this op's refs and not
      // a second join over `analysis.json`. Presence is consulted OPPORTUNISTICALLY through the
      // optional blob port: `boundThrough` stays `analysis`, because a host with no runtime root
      // still serves a complete analysis — it simply cannot say whether the screenshots survive.
      verdicts: await Promise.all(resolved.map(async (verdict) => {
        const test = document.tests.find((candidate) => candidate.testIndex === verdict.perTest)
        const cited = verdict.evidence.citedArtifacts
        return {
          perTest: verdict.perTest,
          testId: test?.testId ?? '',
          class: verdict.class,
          producer: verdict.producer,
          confidence: verdict.confidence,
          evidence: {
            citedSteps: [...verdict.evidence.citedSteps],
            citedArtifacts: await annotatePresence(deps.evidenceBlobs, input.runId, cited),
          },
          ...(verdict.memoryOnPath === undefined
            ? {}
            : {
                memoryOnPath: verdict.memoryOnPath.map((entry) => ({
                  recordId: String(entry.recordId),
                  trust: entry.trust,
                })),
              }),
        }
      })),
      sentences,
      // Render-time clustering through the ONE pure fold (D-14); the representative carries
      // its already-composed sentence (D-15) — looked up, never re-rendered, so cluster and
      // per-test presentation cannot drift.
      clusters: clusterVerdicts(resolved, document).map((cluster) => ({
        fingerprint: cluster.fingerprint,
        count: cluster.count,
        members: cluster.members,
        representative: {
          testIndex: cluster.representative.testIndex,
          sentence: sentenceByPerTest.get(cluster.representative.testIndex) ?? '',
        },
      })),
    }
  },
}
