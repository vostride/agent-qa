// `runs.start` starts the requested tests through the run-invocation port and answers when the run
// has its verdict. Every acknowledgement field is read off the run's own completed record, so a
// host that reports a run it did not execute gets `RunNotRecordedError`. A host with no
// run-invocation port lists the op as unbound.

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
   * The op answers when the run has its verdict. The outcome line names the run, how many tests it
   * ran and its scope, and leaves how it went to the run's own record. A refusal to start is a
   * throw.
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
