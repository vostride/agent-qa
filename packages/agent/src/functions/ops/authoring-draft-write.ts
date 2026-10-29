// `authoring.draft.write` — the authoring loop as a catalogued capability (394, D-01).
//
// THE ONE PUBLIC ENTRY, AND THAT IS THE DESIGN. D-01 puts all six stages inside a single
// registered op rather than registering a stage each, because the stage ORDER is an invariant and
// a caller that could reach the stages independently could break it. 392 D-07 binds every registry
// op into the chat planner's toolset 1:1, so a `authoring.draft.compile` beside a
// `authoring.draft.verify` would be a planner that can verify a draft it never deduplicated, or
// author one it never read a brief for — and "dedup-before-author" would degrade from a property
// of the code into a hope about the plan the model happened to make. Everything below the surface
// still crosses the function layer: the loop reaches `authoring.draft.verify` through
// `invokeFunction`, so SC1's "every stage is a gated function-layer call" holds without the stages
// being separately dispatchable.
//
// THE ID IS `authoring.draft.write`, three lowercase dot segments, no underscore — the spelling
// `authoring-verify-draft.ts` reserved beside itself when it chose `authoring.draft.verify`. The
// two shipped mechanisms that force it are unchanged and were re-measured for this op:
//   1. `parity-coverage.test.ts` requires every registered id to match `^[a-z]+(?:\.[a-z]+)+$`
//      off the registry. `authoring.draft.write` matches; `authoring.draft_write` does not.
//   2. `chat/tool-names.ts` maps ids to provider-safe tool names by `.` ↔ `_` and REFUSES an id
//      that already carries `_`, because such a name has two pre-images under the inverse. Since
//      the planner binds every op, an underscore id would raise `ChatToolNameError` for the WHOLE
//      projection rather than merely looking unconventional.
// `draft` is the subject and `write` is the verb, so the pair reads `authoring.draft.{write,
// verify}` and 394's edit op joins as `authoring.draft.edit` (plan 09) with no renaming.
//
// NO SCOPES. This op once declared `test-write`, `run` and `read`, so a
// caller holding only `run` + `read` could not reach a file write through a nested call (394-01
// minted `test-write` for it). Every door can call every operation now, so there is nothing to
// declare and nothing for a nested call to widen.
//
// THE MINTED CALLER IS ATTRIBUTION ONLY (T-394-05, re-spelled by 432-20/432-23). Stage 4 dispatches
// `authoring.draft.verify` on a caller the composition mints with a surface and an origin; it
// carries no grant, and the inner call reaches exactly what `authoring.draft.verify` itself does.
//
// INPUT REFUSAL IS THE FIRST HALF OF `invoke`, for the reason the evaluator states and one more:
// `intent` is free text from an arbitrary caller that reaches an LLM and then becomes bytes on
// disk. The schema refuses the shape; the shelf refuses what the model produced, by
// parsing before it writes.

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

/**
 * The `stopped` arm, projected onto the result's `stop` payload.
 *
 * THE OP PROJECTS; IT NEVER RE-DERIVES EVIDENCE. Every field here is copied from the route the
 * router derived or from the receipt's own LAST gate run — the same run stage 5 routed on and the
 * same one the attribution below borrows, so the verdict a caller reads and the evidence the
 * routing read are one answer rather than two. The abandonment's own error object is NOT read here
 * — its prose ends in the model's own bytes — and the payload has no prose field for model output
 * to arrive through at all.
 *
 * `String(verdictSource)` is the bridge the retired carrier used: the router's `VerdictSource` is
 * the run's own enum and the payload keeps the free-string posture, because the runner owns that
 * vocabulary and grows it.
 */
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
    // ONE SPREAD, so the kind and the spend are present on exactly the same payloads.
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
  // the per-invocation `disclose` method is deleted. It rendered the
  // fan-out preview for the dispatch confirm, which 432-19 deleted, and nothing called it since; the
  // fan-out report on the verdict below is what a caller reads.
  /**
   * This op's own outcome enum, folded into a clause verdict,
   * carrying the invocation's FAN-OUT REPORT (394-14 · WTST-08 · D-18's one exception).
   *
   * `refused` IS THE MEASURED WITNESS. 399's live acceptance recorded this op returning its stage-2
   * dedup refusal while chat printed `executed  authoring.draft.write completed`: the screen declined
   * to author, nothing was written, and the person was told it had been. The screen WORKED, so the
   * honest word is `refused` and not `failed` — the same reading D-02 minted the status for.
   *
   * THE OUTCOME CARRIES THE REFERENCE, because 394 D-04's requirement is refuse AND LINK: a person
   * told only "duplicate" has nothing to open, and `matchedRef` is precisely the string
   * `entities.resolve` takes. The refusal payload is optional on the contract, so an arm that says
   * `refused` without one still says `refused` — the status is the claim that must not be lost, and
   * a missing link degrades the sentence rather than the verdict.
   *
   * THE OTHER THREE ARMS RAN TO COMPLETION. `drafted`, `repaired` and `stopped` all end with a draft
   * and a receipt — a correctly-failing draft is a VERDICT about the application, not a failure of
   * this op — so each is `executed`, and the outcome names the test that was authored. A `stopped`
   * invocation therefore renders `stopped <testName> — <fan-out sentence>` under a status chat and
   * the parity walk already read: a spelling, never a shape.
   *
   * ---- the fan-out, migrated here from `turn-engine.ts` by 399.1-03 -----------------------------
   *
   * IT ARRIVES ON THE VERDICT AND NOT ON A RENDER FOLD, and the choice is load-bearing rather than
   * incidental. 394-14's second cell requires the sentence to reach the APPEND-ONLY LOG — "the
   * return value is what one caller sees; the log is the triage report several surfaces render" —
   * and the log carries `ClauseReceipt.outcome`, not the turn's answer. A `renderResult` fold would
   * have put this disclosure on the answer channel only, silently costing it the half that is
   * readable after the fact. `summariseOutcome` composed a RECEIPT LINE, so the seat it vacates is
   * this one; `explainAnswerLines` composed ANSWER TEXT, so its seat is `renderResult`. The two
   * hardcodes were never the same kind of thing.
   *
   * IT IS ADMITTED BY THE CHARTER RATHER THAN EXCEPTED FROM IT. D-18 says the receipt is a MAP, and
   * `FanOutReport` is counts, run REFERENCES and one boolean — no draft body, no receipt payload, no
   * step evidence. The written file and its receipt ride the op's `written` field, not this line.
   *
   * IT IS ONE FIELD ON ONE OP, AND NOW BY CONSTRUCTION. That used to be enforced by an id
   * comparison inside a shared function — a claim a later edit could widen by deleting one line. It
   * is a member of THIS spec now: no other op's line is touched, because no other op declares this.
   *
   * WHY THE DISCLOSURE IS THE WHOLE CONTROL. WTST-08's owner decision was preview plus honest
   * reporting with NO enforced budget, so the number a person is shown is all there is. The same
   * surface rendered the dispatch confirm they approved; a receipt omitting what was actually spent
   * would be the half that makes the other half checkable, missing. They agreed to nine runs and
   * had no way to learn eleven were taken.
   *
   * PARSED, NEVER CAST, AND THE PARSE CANNOT MOVE THE STATUS. `FanOutReportSchema` is `.strict()`,
   * so a malformed result cannot smuggle prose into a file several surfaces render; an unparsable
   * report costs the SENTENCE and never the verdict, which is `classify`'s fail-closed contract read
   * correctly — the disclosure degrades, the claim about what happened does not.
   *
   * THE SENTENCE IS `renderFanOutReport`'S AND NOTHING ELSE. A line composed here would be a second
   * prose form of one report, free to drift from the confirm's own wording the moment a phrase
   * moves — and mutation R of the phase's mutation driver (since removed) was the differential
   * that caught it.
   */
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
    // the written file is part of the claim. A draft the writer refused or failed to
    // write is not reported as executed — the author asked for a test file and did not get one.
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
    // `invokeFunction` already refused this composition on `draftShelf`, so reaching here with no
    // port means an in-layer caller holding the spec directly; the refusal is the same named error
    // either way (384, D-09).
    const shelf = deps.draftShelf
    const read = deps.authoringRead
    // BOTH halves, by the SAME name. `boundThrough` names one key, and a host missing the read
    // half would otherwise list this op `bound` and then serve an EMPTY brief — a draft compiled
    // against nothing this project knows, indistinguishable at the caller from one compiled
    // against everything it knows. That is the answer this check exists to make impossible.
    //
    // THE FILE HALF RIDES THE SHELF. The writer is `draftShelf.publish`, so a host that
    // can author is a host that can write what it authored — checked here, before any run is spent,
    // by the shelf's presence. 394-18's separate proposals port is no longer consulted: nothing is
    // filed for anybody to accept.
    if (shelf === undefined || read === undefined) {
      throw new FunctionNotBoundError(AUTHORING_DRAFT_WRITE_FUNCTION_ID)
    }

    // SCOPE IS RESOLVED HERE, ABOVE THE LOOP, AND NOWHERE ELSE.
    //
    // The registry contract makes `scope` optional on the `runs.start` law — absent resolves from
    // the host — because a model cannot know this project's product keys and refuses the whole
    // call over a field it can only guess at. `AuthoringLoopInput.scope` stays REQUIRED: the loop
    // reads the brief at it and names it in the compile prompt, so it must be concrete by the
    // time the loop starts, and every read inside one invocation is then at one scope.
    //
    // A HOST WITH NO DERIVER REFUSES BY NAME. Not a default, and not the first configured
    // product: authoring against a guessed product writes a test for the wrong application, so
    // the missing binding is reported where the composition forgot it — the same named error the
    // three halves above use, checked only when the caller supplied nothing.
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
        // handed on exactly as supplied, and this op invents nothing. The session
        // is a fact about the SURFACE that dispatched the call — the chat engine stamps its own
        // id at the invoke boundary — so a default here would attribute a CLI draft to a session
        // that never asked for it.
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      },
      { read, shelf },
    )

    // Projected arm-agnostically, which is what lets plans 05-06 land a branch inside the loop and
    // reach this line unchanged. The two optional spreads carry a `drafted` invocation's draft and
    // receipt and are simply absent on a stage-2 refusal, which has neither.
    //
    // THE REFUSAL PAYLOAD IS READ OFF THE SCREENING, not off the outcome. The `refused` arm of
    // `AuthoringLoopOutcome` stays exactly the shape 394-02 declared — it is a discriminant, not a
    // carrier — and what a refusal has to NAME is a fact about the dedup screening that produced
    // it. Reading it here is what makes D-04's refuse-and-LINK reach a caller at all: a chat
    // surface told `refused` with no `refusal` could report that something matched but never say
    // what, and re-invoking is the only continuation this stateless design offers.
    //
    // THE FAN-OUT REPORT RIDES OUT. The report is the recorded exception to the
    // output schema's no-payload rule and the argument is written there: it is counts and run refs
    // about the run budget, and WTST-08's owner decision made the honest report the second half of
    // the only control this op has. It is carried on EVERY arm the loop answers with a routing,
    // refusals included, because "this invocation ran nothing" is a number a caller is entitled to.
    const outcome = result.outcome
    const dedup = result.dedup

    // THE FINAL DRAFT IS ALREADY WRITTEN BY THE TIME THIS OP ANSWERS (432 D-06, superseding
    // 394-18's proposal filing). The loop wrote it — or, for a rejected final receipt, did not — and
    // the written-test receipt rides out on the `drafted` and `repaired` arms. Nothing is filed for a
    // person to accept, and the stopped and refused arms write nothing.
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
