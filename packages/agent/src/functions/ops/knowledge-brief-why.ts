// `knowledge.brief.why` — why did the brief say this.
//
// The verb answers about THEN. It reads the retrieval trace the serving path wrote down at the
// moment it assembled the brief, and it does not re-run retrieval — not because re-running is
// discouraged, but because this op is handed nothing it could re-run retrieval WITH.
//
// The structure is the argument, so it is worth stating exactly what is structural and what is
// not. `mapStepEvidenceToWhy` below is a pure function of (lookup, input): it takes no `deps`
// at all, so the code that decides what the answer IS cannot read a live index by any route —
// there is no handle in scope. `invoke` has the whole `FunctionDeps` record, as every op does,
// and makes exactly one call with it: `deps.runs.readStepEvidence`. That the call is the only
// one is a SOURCE claim, scanned and mutation-probed rather than enforced by a type. Both
// halves are stated because they are different strengths of guarantee and it would be easy to
// present the weaker one as the stronger.
//
// The substrate is on the RUNS port, not the knowledge port. A step's evidence is a record of
// what happened during a run; the knowledge index is a record of what is true now. Answering
// out of the second would answer a different question than the one asked — the exact
// dishonesty KREV-02 exists to prevent — and no serving capability is reachable from here.

import { BriefWhyInputSchema, BriefWhyResultSchema, asRunId } from '@vostride/agent-qa-schema'
import type {
  BriefWhyInput,
  BriefWhyResult,
  ServedRetrievalTraceV1,
} from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionSpec, StepEvidenceLookup } from '../spec.js'

export const KNOWLEDGE_BRIEF_WHY_FUNCTION_ID = 'knowledge.brief.why'

/**
 * The address named more than one step, and this verb will not choose one.
 *
 * A caller-facing refusal rather than a `no-trace` arm, and the distinction is the point. Every
 * `no-trace` reason is a statement about a step that WAS addressed and had no trace; this is a
 * statement about the question. Reporting an ambiguous address as an absence would be a wrong
 * answer wearing an honest one's clothes — the reader would conclude the run captured nothing,
 * when in fact two steps answered and neither was asked about.
 *
 * It carries the candidates because that is what the caller needs to ask again. A closed reason
 * enum could have said "ambiguous" and could not have said which tests to choose between, which
 * would leave the reader to go and find them by hand.
 */
export class AmbiguousStepAddressError extends Error {
  constructor(
    readonly runId: string,
    readonly stepIndex: number,
    readonly testIds: readonly string[],
  ) {
    super(
      `Step ${String(stepIndex)} of run ${runId} is ambiguous: ${testIds.join(', ')}. `
      + 'stepIndex is numbered per member test, so name a testId.',
    )
    this.name = 'AmbiguousStepAddressError'
  }
}

/**
 * Narrow a trace to one record's attribution, keeping BOTH ledgers.
 *
 * The truncation ledger is filtered too, and that is the whole value of the filter: "why didn't
 * it mention record X" is answered by X appearing among the CUT candidates with its rank and
 * score, and a filter that kept only served lines would answer that question with silence.
 *
 * A record that appears in neither ledger yields an answered result with two empty ledgers,
 * which is the honest reading: the trace exists, and that record took no part in the brief.
 * Reporting it as `no-trace` would claim nothing was written down.
 */
function narrowToRecord(
  trace: ServedRetrievalTraceV1,
  recordId: string,
): ServedRetrievalTraceV1 {
  return {
    schemaVersion: trace.schemaVersion,
    servedLines: trace.servedLines.filter((line) => line.recordId === recordId),
    truncated: trace.truncated.filter((line) => line.recordId === recordId),
  }
}

/**
 * THE answering logic, as a function of what was read back and nothing else.
 *
 * Exported for its own tests. Deliberately takes no `deps`: an implementation that could
 * consult a live index would need a handle, and there is none in scope to give it one.
 *
 * Throws only for the ambiguous address (see {@link AmbiguousStepAddressError}); every other
 * outcome is an arm of the closed union, because absence is a fact about the evidence and the
 * caller has to be able to read it rather than catch it.
 */
export function mapStepEvidenceToWhy(
  lookup: StepEvidenceLookup,
  input: BriefWhyInput,
): BriefWhyResult {
  switch (lookup.kind) {
    case 'run-not-recorded':
      // `artifact-missing` and not a `RunNotFoundError`: a why-question about a run whose
      // handoff has been pruned is exactly the "go looking" case D-15 separated from the
      // permanent one, and the surface's message differs.
      return { kind: 'no-trace', reason: 'artifact-missing' }
    case 'step-not-found':
      return { kind: 'no-trace', reason: 'step-not-found' }
    case 'ambiguous-step-address':
      throw new AmbiguousStepAddressError(input.runId, input.stepIndex, lookup.testIds)
    case 'found': {
      const trace = lookup.evidence.retrievalTrace
      if (trace === undefined) {
        // The run predates trace capture, or captured none. Permanent: retrying changes
        // nothing. The brief itself survived, so it is OFFERED — a reader who cannot learn why
        // a line was chosen can at least read the line.
        return {
          kind: 'no-trace',
          reason: 'pre-trace-run',
          servedBrief: lookup.evidence.servedBrief,
        }
      }
      return {
        kind: 'answered',
        trace: input.recordId === undefined ? trace : narrowToRecord(trace, input.recordId),
      }
    }
  }
}

export const knowledgeBriefWhySpec: FunctionSpec<BriefWhyInput, BriefWhyResult> = {
  id: KNOWLEDGE_BRIEF_WHY_FUNCTION_ID,
  summary: 'Explain why a served brief said what it said, from the trace written at serve time.',
  resultKind: 'unary',
  input: BriefWhyInputSchema,
  output: BriefWhyResultSchema,
  risk: { name: `fn:${KNOWLEDGE_BRIEF_WHY_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * `no-trace` IS THE HONEST ABSENCE THIS VERB EXISTS FOR.
   *
   * KREV-02's whole posture is that a brief whose trace is gone must be SAID to be gone rather than
   * re-derived; the op that answers it is given no serving capability at all. That is an answer the
   * verb is proud of, not a control declining, so the arm is `executed` with the store's own reason.
   */
  classify(output): ClauseVerdict {
    switch (output.kind) {
      case 'answered':
        return { status: 'executed', outcome: 'answered from the persisted retrieval trace' }
      case 'no-trace':
        return { status: 'executed', outcome: `no-trace: ${output.reason}` }
      default:
        return output satisfies never
    }
  },
  async invoke(input, deps) {
    // The DTO speaks a plain string because it crosses a process boundary as JSON; the port
    // speaks the branded id every other run read uses. Narrowing HERE, once, is what keeps both
    // true, and `asRunId` is the same brand `runs.get`'s own input schema applies.
    const lookup = await deps.runs.readStepEvidence(asRunId(input.runId), {
      stepIndex: input.stepIndex,
      ...(input.testId === undefined ? {} : { testId: input.testId }),
    })
    return mapStepEvidenceToWhy(lookup, input)
  },
}
