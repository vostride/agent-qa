// `runs.get` — one completed run, projected in full.
//
// A pure function of (validated input, injected deps). The port resolves the id against the
// runs it already enumerates and reports absence as `undefined`; turning that absence into a
// typed refusal is this module's job, so every surface sees the same error vocabulary.

import { RunDetailSchema, RunsGetInputSchema, resolveRunVerdicts } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  PerTestOutcome,
  RunDetail,
  RunId,
  RunTestDetail,
  RunsGetInput,
  Verdict,
} from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionDeps, FunctionSpec, ReplayedRunEvent } from '../spec.js'

export const RUNS_GET_FUNCTION_ID = 'runs.get'

/**
 * No completed run is recorded under the requested id.
 *
 * A caller-facing refusal rather than an internal invariant violation: asking for a run that
 * has not happened is an ordinary thing for a surface to do, and the answer has to be
 * distinguishable from a run that exists and recorded no member tests.
 */
export class RunNotFoundError extends Error {
  constructor(readonly runId: string, where = '') {
    super(`No completed run recorded for id: ${runId}${where}`)
    this.name = 'RunNotFoundError'
  }
}

// the run exists but never reached a verdict. `recorded` says whether
// its runs.db row exists (the dashboard holds its record) or only its event log does.
export class RunEndedWithoutVerdictError extends Error {
  constructor(readonly runId: string, readonly recorded: boolean) {
    super(recorded
      ? `Run ${runId} ended before it reached a verdict. Its record is in the dashboard.`
      : `Run ${runId} did not reach a verdict.`)
    this.name = 'RunEndedWithoutVerdictError'
  }
}

export class RunNotFinishedError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} has not reached a verdict yet.`)
    this.name = 'RunNotFinishedError'
  }
}

const IN_FLIGHT_ROW_STATUSES: ReadonlySet<string> = new Set(['running', 'pending'])

// the refusal for a run with no handoff. A sentence is given only when
// the row and the log were both read and the log holds no verdict; an unbound port or a failed
// read falls back to not-found, because absence is not a status.
export async function refuseMissingHandoff(runId: RunId, deps: FunctionDeps): Promise<never> {
  const id = String(runId)
  const reader = deps.runDetail
  if (reader?.readRecord === undefined) throw new RunNotFoundError(id)
  let record: { status: string } | undefined
  let events: readonly ReplayedRunEvent[]
  try {
    record = await reader.readRecord(runId)
    events = await deps.runs.readEvents(runId, 1)
  } catch {
    throw new RunNotFoundError(id)
  }
  if (events.some(event => event.type === 'verdict')) throw new RunNotFoundError(id)
  if (record !== undefined) {
    throw IN_FLIGHT_ROW_STATUSES.has(record.status)
      ? new RunNotFinishedError(id)
      : new RunEndedWithoutVerdictError(id, true)
  }
  if (events.length > 0) throw new RunEndedWithoutVerdictError(id, false)
  throw new RunNotFoundError(id)
}

/** Where `runs.detail` and `runs.evidence` looked. */
export const IN_RUNS_DATABASE = ' in the runs database'


function toRunTestDetail(
  test: PerTestOutcome,
  resolved: Verdict | undefined,
): RunTestDetail {
  return {
    testId: test.testId,
    testName: test.testName,
    filePath: test.filePath,
    testIndex: test.testIndex,
    outcome: test.outcome,
    // Step evidence stays in the handoff document; 389's evidence links address it by
    // runId + testIndex. Projecting it here would make the cheapest read the most expensive.
    // The same law covers sentences: this projection carries class/producer/
    // confidence from the resolved verdict and NEVER a rendered sentence — an unbound
    // analysis port answers as artifact-absent (the deterministic floor), so the cheapest
    // read stays cheap in every composition.
    stepCount: test.steps.length,
    ...(resolved === undefined ? {} : {
      rootCause: {
        class: resolved.class,
        producer: resolved.producer,
        confidence: resolved.confidence,
        rationale: resolved.evidence.rationale,
      },
    }),
  }
}

/**
 * Project one handoff over its RESOLVED verdicts: the summary block sources
 * class/producer/confidence from `resolveRunVerdicts` — artifact verdicts when the analysis
 * upgraded them, the handoff's deterministic floor when not — joined per member by `perTest`.
 * A member the accessor holds no verdict for (clean pass, skipped, cancelled) projects no
 * `rootCause`, exactly as the handoff's own absence used to read.
 */
export function toRunDetail(
  document: CompletedRunHandoff,
  resolvedVerdicts: readonly Verdict[] = resolveRunVerdicts(undefined, document),
): RunDetail {
  const verdictByPerTest = new Map(
    resolvedVerdicts.map((verdict) => [verdict.perTest, verdict]),
  )
  return {
    runId: document.runId,
    scope: document.scope,
    buildOrdinal: document.buildOrdinal,
    executionContext: document.executionContext,
    aggregateVerdict: document.aggregateVerdict,
    configDigests: document.configDigests,
    startedAt: document.startedAt,
    endedAt: document.endedAt,
    // Both durable markers are copied VERBATIM and stay independent axes: absence in the
    // handoff is absence in the projection, never a rendered `false`.
    ...(document.gateRun === undefined ? {} : { gateRun: document.gateRun }),
    ...(document.excludedFromOutcomes === undefined
      ? {}
      : { excludedFromOutcomes: document.excludedFromOutcomes }),
    tests: document.tests.map((test) => (
      toRunTestDetail(test, verdictByPerTest.get(test.testIndex))
    )),
  }
}

export const runsGetSpec: FunctionSpec<RunsGetInput, RunDetail> = {
  id: RUNS_GET_FUNCTION_ID,
  summary: 'Read one completed run in full, including its member-test outcomes.',
  resultKind: 'unary',
  input: RunsGetInputSchema,
  output: RunDetailSchema,
  risk: { name: `fn:${RUNS_GET_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * A run that came back is a run that was found.
   *
   * Absence is `RunNotFoundError`, a throw, which already reaches the engine's `failed` mapping.
   * The verdict a run ENDED with is not this clause's verdict: a failing run is a successful read.
   */
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `${output.runId} — ${output.aggregateVerdict}, ${output.tests.length} test(s)`,
    }
  },
  async invoke(input, deps) {
    const document = await deps.runs.get(input.runId)
    if (document === undefined) {
      throw new RunNotFoundError(input.runId)
    }
    // the rootCause block reads through the ONE accessor. An unbound analysis
    // port is treated as artifact-absent — the floor — never as a refusal: this op stays
    // bound in every composition, and its answer off the floor is honest, not degraded.
    return toRunDetail(
      document,
      resolveRunVerdicts(deps.analysis?.getArtifact(String(input.runId)), document),
    )
  },
}
