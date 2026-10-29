// Drives the real `runs.list` spec with build ordinals that disagree with completion order.

import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  RunSummary,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../../functions/invoke.js'
import { RUNS_DIGEST_FUNCTION_ID } from '../../functions/ops/runs-digest.js'
import { RUNS_LIST_FUNCTION_ID, runsListSpec } from '../../functions/ops/runs-list.js'
import { createRegistryFromSpecs } from '../../functions/registry.js'
import type { FunctionDeps } from '../../functions/spec.js'
import { composeBanner } from '../banner.js'
import type { ChatInvokeBinding } from '../ports.js'
import { CHAT_RESOLVER_TABLE, resolveClause } from '../resolver-table.js'

const CALLER: FunctionCaller = {
  surface: 'chat',
  origin: 'human',
}

function completion(runId: string, endedAt: number, buildOrdinal: number): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: endedAt - 10,
    endedAt,
    tests: [],
  }
}

/**
 * 25 completions whose build ordinals run AGAINST completion order, plus a tie at the newest end
 * time. The newest completion is `run-tie-b` (the larger runId of the tie); the highest build
 * ordinal belongs to the oldest run, which the default cap drops entirely.
 */
function boundaryFixture(): CompletedRunHandoff[] {
  const ordered = Array.from({ length: 23 }, (_, index) =>
    completion(`run-${String(index).padStart(2, '0')}`, 10_000 + index * 100, 1_000 - index))
  return [
    ...ordered,
    completion('run-tie-a', 20_000, 5),
    completion('run-tie-b', 20_000, 4),
  ]
}

const NEWEST = 'run-tie-b'

function listRegistry(documents: readonly CompletedRunHandoff[]) {
  return createRegistryFromSpecs([runsListSpec], {
    deps: {
      secretMask: (text: string) => text,
      runs: {
        list: () => Promise.resolve(documents),
        get: (runId: string) => Promise.resolve(documents.find((document) => document.runId === runId)),
        readEvents: () => Promise.resolve([]),
        readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
      },
    } as unknown as FunctionDeps,
  })
}

describe('CHAT-LATEST: the banner digests the newest completion', () => {
  it('chooses the newest endedAt and its runId tie-break beyond the default cap', async () => {
    const registry = listRegistry(boundaryFixture())
    const digested: string[] = []
    const invoke: ChatInvokeBinding = async (functionId, input, caller) => {
      if (functionId === RUNS_LIST_FUNCTION_ID) {
        return {
          payload: await invokeFunction(registry, functionId, input, caller),
          verdict: { status: 'executed', outcome: '' },
          foldLines: [],
        }
      }
      if (functionId === RUNS_DIGEST_FUNCTION_ID) {
        const runId = (input as { runId: string }).runId
        digested.push(runId)
        return { payload: { lines: [`digest — ${runId}`] }, verdict: { status: 'executed', outcome: '' }, foldLines: [] }
      }
      throw new Error(`unexpected ${functionId}`)
    }

    const line = await composeBanner(invoke, CALLER)

    expect(digested).toEqual([NEWEST])
    expect(line).toBe(`digest — ${NEWEST}`)
  })
})

describe('the resolver\'s empty-input list is the capped newest-first list', () => {
  it.each([['status'], ['/fn runs.list']])('%s resolves to runs.list with {} and answers 20 rows', async (clause) => {
    const resolution = resolveClause(CHAT_RESOLVER_TABLE, clause)
    expect(resolution).toMatchObject({
      kind: 'resolved',
      entry: { kind: 'op', functionId: RUNS_LIST_FUNCTION_ID, input: {} },
    })
    if (resolution.kind !== 'resolved' || resolution.entry.kind !== 'op') throw new Error('unresolved')

    const rows = await invokeFunction(
      listRegistry(boundaryFixture()),
      resolution.entry.functionId,
      resolution.entry.input,
      CALLER,
    ) as RunSummary[]

    expect(rows).toHaveLength(20)
    expect(rows[0]!.runId).toBe(NEWEST)
    expect(rows[1]!.runId).toBe('run-tie-a')
  })
})
