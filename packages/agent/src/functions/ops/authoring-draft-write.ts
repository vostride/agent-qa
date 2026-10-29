// One entry for every stage, so a caller cannot verify a draft it never deduplicated.

import {
  AuthoringDraftWriteInputSchema,
  AuthoringDraftWriteOutputSchema,
  FanOutReportSchema,
  renderFanOutReport,
} from '@vostride/agent-qa-schema'
import type {
  AuthoringDraftWriteInput,
  AuthoringDraftWriteOutput,
  AuthoringStop,
} from '@vostride/agent-qa-schema'

import { authoringFanOutBound, runAuthoringLoop } from '../../authoring/loop.js'
import type { AuthoringLoopOutcome } from '../../authoring/loop.js'
import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const AUTHORING_DRAFT_WRITE_FUNCTION_ID = 'authoring.draft.write'

// Copied from the route and the last gate run, never re-derived or read from model prose.
export function projectStop(
  outcome: Extract<AuthoringLoopOutcome, { kind: 'stopped' }>,
): AuthoringStop {
  const last = outcome.receipt.gateRuns.at(-1)
  if (last === undefined) {
    throw new Error(
      'authoring.draft.write: a stopped outcome names no gate run — stage 5 routes on the last '
        + 'gate run, so this cannot be a stopped outcome',
    )
  }
  const point = outcome.route.failurePoint
  return {
    runId: last.runId,
    memberOutcome: last.memberOutcome,
    signalClass: outcome.route.signalClass,
    failurePoint: point === null
      ? null
      : {
          stepIndex: point.stepIndex,
          stepText: point.stepText,
          reasoning: point.reasoning,
          ...(point.verdictSource === undefined
            ? {}
            : { verdictSource: String(point.verdictSource) }),
        },
    evidenceRefs: outcome.route.evidenceRefs,
    // One spread, so the kind and the spend appear on exactly the same payloads.
    ...(outcome.abandonment === undefined
      ? {}
      : {
          repairAbandonment: outcome.abandonment.kind,
          repairIterations: outcome.abandonment.iterations,
        }),
  }
}

export const authoringDraftWriteSpec: FunctionSpec<
  AuthoringDraftWriteInput,
  AuthoringDraftWriteOutput
> = {
  id: AUTHORING_DRAFT_WRITE_FUNCTION_ID,
  summary: 'Author a test for an intent, verify it against the keep-gates, and return its receipt.',
  resultKind: 'unary',
  // The WRITE half, which is the half that makes this op mutating: a host with no model and no
  // shelf cannot author at all. The read half is bound with it or not at all — see the invoke's
  // second check, which refuses on either half by the same name.
  boundThrough: 'draftShelf',
  input: AuthoringDraftWriteInputSchema,
  output: AuthoringDraftWriteOutputSchema,
  // Every door runs this op without a prompt. One call starts a loop that runs to its end, spending
  // up to nine child `agent-qa run` processes against the person's application, and writes the
  // draft straight into their suite; there is no mid-loop approval state.
  risk: {
    name: `fn:${AUTHORING_DRAFT_WRITE_FUNCTION_ID}`,
    recognized: true,
  },
  // A refused dedup is `refused` with its matched ref; every other arm is `executed`.
  classify(output): ClauseVerdict {
    const report = FanOutReportSchema.safeParse(output.fanOut)
    const spent = report.success ? ` — ${renderFanOutReport(report.data)}` : ''
    if (output.outcome === 'refused') {
      const stated = output.statedValueRefusal
      if (stated !== undefined) {
        const values = stated.missingValues.map((value) => JSON.stringify(value)).join(', ')
        return {
          status: 'refused',
          outcome: `stated-values-missing:${stated.stage} ${values}${spent}`,
        }
      }
      const matched = output.refusal?.matchedRef
      const named = matched === undefined ? 'duplicate' : `duplicate-of:${matched}`
      return { status: 'refused', outcome: `${named}${spent}` }
    }
    const authored = output.draftRef?.testName
    const named = authored === undefined ? output.outcome : `${output.outcome} ${authored}`
    // A draft the writer refused or failed to write is not reported as executed.
    const file = output.written?.file
    if (file?.kind === 'not-written' && file.reason !== 'rejected') {
      return {
        status: file.reason === 'write-failed' ? 'failed' : 'refused',
        outcome: `${named} — not written: ${file.reason}${spent}`,
      }
    }
    const wrote = file === undefined
      ? ''
      : file.kind === 'written' ? ` — wrote ${file.filePath}` : ' — not written: rejected'
    return { status: 'executed', outcome: `${named}${wrote}${spent}` }
  },
  async invoke(input, deps) {
    // Reached with no port only by an in-layer caller; the refusal is the same named error.
    const shelf = deps.draftShelf
    const read = deps.authoringRead
    // Both halves checked by one name, so a host missing the read half never compiles from nothing.
    if (shelf === undefined || read === undefined) {
      throw new FunctionNotBoundError(AUTHORING_DRAFT_WRITE_FUNCTION_ID)
    }

    // Scope resolves here, once, before the loop; a host with no deriver refuses by name.
    const scope = input.scope ?? await (async () => {
      if (deps.authoringScope === undefined) {
        throw new FunctionNotBoundError(AUTHORING_DRAFT_WRITE_FUNCTION_ID)
      }
      return await deps.authoringScope.deriveDefault()
    })()

    const result = await runAuthoringLoop(
      {
        intent: input.intent,
        scope,
        ...(input.draftMode === undefined ? {} : { draftMode: input.draftMode }),
        // Passed as supplied: the dispatching surface stamps its own session, so no default here.
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      },
      { read, shelf },
    )

    // The refusal payload is read off the dedup screening, so a refusal names what it matched.
    const outcome = result.outcome
    const dedup = result.dedup

    // The loop already wrote the final draft; stopped and refused arms write nothing.
    return {
      outcome: outcome.kind,
      fanOut: result.fanOut,
      ...(outcome.draftRef === undefined ? {} : { draftRef: outcome.draftRef }),
      ...(outcome.receipt === undefined ? {} : { receipt: outcome.receipt }),
      ...(outcome.kind === 'stopped' ? { stop: projectStop(outcome) } : {}),
      ...(outcome.kind === 'drafted' || outcome.kind === 'repaired'
        ? { written: outcome.written }
        : {}),
      ...(outcome.kind === 'refused' && outcome.statedValueRefusal !== undefined
        ? {
          statedValueRefusal: {
            stage: outcome.statedValueRefusal.stage,
            missingValues: [...outcome.statedValueRefusal.missingValues],
          },
        }
        : {}),
      ...(dedup.kind === 'duplicate'
        ? {
          refusal: {
            filePath: dedup.evidence.matched.filePath,
            testName: dedup.evidence.matched.testName,
            matchedRef: dedup.evidence.matchedRef,
            score: dedup.evidence.score,
            threshold: dedup.evidence.threshold,
            sharedTokens: dedup.evidence.sharedTokens,
            comparedTests: dedup.comparedTests,
            continuations: [...dedup.continuations],
          },
        }
        : {}),
    }
  },
}
