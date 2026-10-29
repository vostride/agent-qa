// `runs.list` — the tracer capability, widened by 431 D-08.
//
// A pure function of (validated input, injected deps): it filters ONE completed-run snapshot,
// orders it newest-finished first under a total order (endedAt, then runId) so a fixed fixture
// always renders byte-identically, and caps what it returns only after every filter has run.
//
// Test names are stored text, masked with the host's declared mask exactly as runs.overview masks
// them, and the title filter only ever sees the masked name.

import {
  RUNS_LIST_DEFAULT_LIMIT,
  RunsListInputSchema,
  RunsListOutputContract,
  RunsListOutputSchema,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  MaskFn,
  RecordedTargets,
  RunSummary,
  RunsListInput,
} from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionSpec } from '../spec.js'
import { requireSecretMask } from './secret-mask.js'

export const RUNS_LIST_FUNCTION_ID = 'runs.list'

export function toRunSummary(
  document: CompletedRunHandoff,
  recordedTargets: RecordedTargets,
  mask: MaskFn,
): RunSummary {
  return {
    runId: document.runId,
    scope: document.scope,
    buildOrdinal: document.buildOrdinal,
    executionContext: document.executionContext,
    aggregateVerdict: document.aggregateVerdict,
    startedAt: document.startedAt,
    endedAt: document.endedAt,
    testCount: document.tests.length,
    tests: document.tests.map((test) => ({
      testIndex: test.testIndex,
      testId: test.testId,
      testName: mask(test.testName),
    })),
    recordedTargets,
  }
}

/** Latest finished first: `endedAt` descending, then `runId` descending, so the order is total. */
export function compareLatestFinished(
  left: { readonly endedAt: number; readonly runId: string },
  right: { readonly endedAt: number; readonly runId: string },
): number {
  if (left.endedAt !== right.endedAt) return right.endedAt - left.endedAt
  return left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0
}

function namesTest(document: CompletedRunHandoff, filter: string, mask: MaskFn): boolean {
  const needle = filter.toLowerCase()
  return document.tests.some((test) => (
    test.testId === filter || mask(test.testName).toLowerCase().includes(needle)
  ))
}

function recordsTarget(targets: RecordedTargets, target: string): boolean {
  return targets.status === 'recorded' && targets.names.includes(target)
}

export const runsListSpec: FunctionSpec<RunsListInput, RunSummary[]> = {
  id: RUNS_LIST_FUNCTION_ID,
  summary:
    'List completed runs, newest finished first (20 by default, at most 200), each naming its '
    + 'tests; filter by verdict, test id or title, recorded target, or completion time.',
  resultKind: 'unary',
  input: RunsListInputSchema,
  // the NAMED array schema, not `z.array(RunSummarySchema)` composed
  // here. The two are the same shape; only one of them is an object a surface can also name, and
  // D-16's whole claim is that the advertised schema and the validated schema are one object.
  output: RunsListOutputSchema,
  // 431-03 (D-03, A1): the canonical companion, tied to `output` above. It changes only what a
  // declaration publishes; `output` is still what `invokeFunction` validates with.
  outputRepresentation: RunsListOutputContract,
  // Read ops declare `readOnly` so the static classifier lands them on the read-only
  // tier — allow in every execution context. The verdict is still computed and audited
  // there is no read bypass, only a read classification.
  risk: { name: `fn:${RUNS_LIST_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * A listing that answered — the count, and nothing out of a run.
   */
  classify(output): ClauseVerdict {
    return { status: 'executed', outcome: `${output.length} completed run(s)` }
  },
  async invoke(input, deps) {
    const limit = input.limit ?? RUNS_LIST_DEFAULT_LIMIT
    const mask = requireSecretMask(deps, RUNS_LIST_FUNCTION_ID)
    const documents = await deps.runs.list()
    const candidates = documents
      .filter((document) => (
        (input.verdict === undefined || document.aggregateVerdict === input.verdict)
        && (input.since === undefined || document.endedAt >= input.since)
        && (input.test === undefined || namesTest(document, input.test, mask))
      ))
      .sort(compareLatestFinished)
    const summarize = (documents: readonly CompletedRunHandoff[]): Promise<RunSummary[]> =>
      Promise.all(documents.map(async (document) => toRunSummary(
        document,
        deps.runs.getRecordedTargets === undefined
          ? { status: 'unknown' }
          : await deps.runs.getRecordedTargets(document.runId),
        mask,
      )))

    const { target } = input
    if (target === undefined) return summarize(candidates.slice(0, limit))
    return (await summarize(candidates))
      .filter((row) => recordsTarget(row.recordedTargets, target))
      .slice(0, limit)
  },
}
