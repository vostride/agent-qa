// `runs.start` — the first unbound→bound transition of 384's binding vocabulary (D-16).
//
// Everything declared here in 384 is unchanged: the input contract (including the D-10
// `gateRun` carrier), the acknowledgment it resolves, and the risk descriptor the classifier
// reads. What arrived in 385 is the implementation, and with it the one line that says what the
// implementation NEEDS — `boundThrough: 'runInvocation'`. 2026-10-01 (432-23, D-12): the `run`
// scope it once cost is gone; every door can start a run, and the run core refuses only a
// production target the config has not opted into (432-03, D-18).
//
// That is the whole of this module's say in whether it is bound. The ANSWER belongs to a
// composition: a host that supplies a run-invocation port lists this op as `bound` and can
// run it; a host that does not lists it as `unbound` and refuses it by name. The 384 state
// is therefore not gone, it is one of the two states, and every registry built without an
// executor still proves D-09's visible-unbound invariant on this very capability.
//
// The implementation joins TWO ports on purpose. The invocation port reports only the id of
// the run it started; every field of the acknowledgment is then read off that run's own
// durable record through the same reader `runs.get` answers from. A host that resolved an id
// without running anything gets `RunNotRecordedError` here rather than a fabricated
// acknowledgment — which is the difference between "the call returned" and "a run happened".

import { RunStartAcknowledgementSchema, RunsStartInputSchema } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  RunStartAcknowledgement,
  RunsStartInput,
} from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const RUNS_START_FUNCTION_ID = 'runs.start'

/**
 * A run was started but no completed-run record can be read back for it.
 *
 * A caller-facing refusal, and the op's anti-fabrication control: the acknowledgment names
 * facts about a run — its scope, its build ordinal, how many member tests it admitted — and
 * every one of them is read off the record the run itself wrote. If the record is absent the
 * honest answer is that nothing is known about the run, never a plausible-looking object
 * assembled from the request. Distinct from `RunNotFoundError`, which answers a caller who
 * asked about a run that was never started here.
 */
export class RunNotRecordedError extends Error {
  constructor(readonly runId: string) {
    super(
      `runs.start started ${runId} but no completed-run record was written for it: ` +
        'the run did not finish, or the host reported a run it did not execute.',
    )
    this.name = 'RunNotRecordedError'
  }
}

/**
 * Project the run's own durable record into the acknowledgment.
 *
 * Both durable markers are copied from the RECORD rather than echoed from the request, which
 * is what makes the acknowledgment worth reading: it tells a caller the kind of run that
 * actually started, not the kind it asked for.
 */
function toAcknowledgement(document: CompletedRunHandoff): RunStartAcknowledgement {
  return {
    runId: document.runId,
    scope: document.scope,
    executionContext: document.executionContext,
    buildOrdinal: document.buildOrdinal,
    startedAt: document.startedAt,
    testCount: document.tests.length,
    ...(document.gateRun === undefined ? {} : { gateRun: document.gateRun }),
    ...(document.excludedFromOutcomes === undefined
      ? {}
      : { excludedFromOutcomes: document.excludedFromOutcomes }),
    ...(document.plannerLimits === undefined ? {} : { limits: document.plannerLimits }),
  }
}

export const runsStartSpec: FunctionSpec<RunsStartInput, RunStartAcknowledgement> = {
  id: RUNS_START_FUNCTION_ID,
  summary: 'Start a test run and acknowledge the run a caller can then read or stream.',
  resultKind: 'unary',
  boundThrough: 'runInvocation',
  input: RunsStartInputSchema,
  output: RunStartAcknowledgementSchema,
  risk: {
    name: `fn:${RUNS_START_FUNCTION_ID}`,
    recognized: true,
  },
  /**
   * AN ACKNOWLEDGEMENT IS A START, NOT AN OUTCOME (399.1 D-01).
   *
   * This op returns when the run has been ACCEPTED, long before it has a verdict — so the outcome
   * names the run a person can follow and how much it took on, and says nothing about how it went.
   * A refusal to start is a throw and already reaches the engine's `failed` mapping.
   */
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `started ${output.runId} — ${output.testCount} test(s) on ${output.scope}`,
    }
  },
  async invoke(input, deps) {
    // `invokeFunction` already refused this composition on the same fact, so reaching here
    // with no port means an in-layer caller holding the spec directly. The unbound state has
    // no back door: the refusal is the same named error either way (384, D-09).
    const runInvocation = deps.runInvocation
    if (runInvocation === undefined) {
      throw new FunctionNotBoundError(RUNS_START_FUNCTION_ID)
    }

    const started = await runInvocation.start(input)
    const document = await deps.runs.get(started.runId)
    if (document === undefined) {
      throw new RunNotRecordedError(started.runId)
    }
    return toAcknowledgement(document)
  },
}
