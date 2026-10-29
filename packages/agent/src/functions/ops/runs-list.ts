// Ordered by (endedAt, runId), newest first, and capped only after every filter.

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
  // The named array schema, so the advertised and validated schema are one object.
  output: RunsListOutputSchema,
  // The canonical companion changes only what a declaration publishes; `output` still validates.
  outputRepresentation: RunsListOutputContract,
  risk: { name: `fn:${RUNS_LIST_FUNCTION_ID}`, recognized: true, readOnly: true },
  // The count only, nothing out of a run.
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
