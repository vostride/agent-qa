// The single producer of verdicts, sentences and clusters; an unbound port refuses by name.

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

// The literal appears once; surfaces import this constant.
export const ANALYSIS_GET_FUNCTION_ID = 'analysis.get'

// Joined by `perTest`, never array position; absent parts use the author's template rule.
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

// Every key input is imported from schema, matching the writer's window key exactly.
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
  // `recurrence` is not the binding key, because a host without history still serves sentences.
  boundThrough: 'analysis',
  input: AnalysisGetInputSchema,
  output: AnalysisGetOutputSchema,
  risk: { name: `fn:${ANALYSIS_GET_FUNCTION_ID}`, recognized: true, readOnly: true },
  // Counts and the run ref only; verdict sentences ride on `results[]`.
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
    // The one verdict read path: artifact when present, the handoff floor otherwise.
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
        // Recurrence is a live join per call; an absent dep renders the no-history clause.
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
      // Presence is optional enrichment, so a host with no runtime root still serves the analysis.
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
      // The representative's sentence is looked up, never re-rendered, so it cannot drift.
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
