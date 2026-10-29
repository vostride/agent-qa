// a per-run read that refuses a missing handoff says what happened to a
// run that never reached a verdict, instead of claiming the run does not exist.

import { asJobId, CURRENT_BUS_SCHEMA_VERSION, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, FunctionCaller, RunEventEnvelope } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../../invoke.js'
import { createFunctionRegistry } from '../../registry.js'
import type { FunctionDeps, ReplayedRunEvent, RunDetailReaderPort } from '../../spec.js'
import { RUNS_DIGEST_FUNCTION_ID } from '../runs-digest.js'
import { RUNS_OVERVIEW_FUNCTION_ID } from '../runs-overview.js'

const RUN_ID = 'run-444-verdictless'

const CALLER: FunctionCaller = { surface: 'test', origin: 'agent' }

const READS = [RUNS_OVERVIEW_FUNCTION_ID, RUNS_DIGEST_FUNCTION_ID] as const

function envelope(seq: number, type: RunEventEnvelope['type'], payload: unknown): ReplayedRunEvent {
  return { seq, ts: seq, runId: RUN_ID, type, payload } as unknown as ReplayedRunEvent
}

const STARTED_ONLY = [envelope(1, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION })]
const WITH_VERDICT = [...STARTED_ONLY, envelope(2, 'verdict', { verdict: 'failed' })]

const ENDED = `Run ${RUN_ID} ended before it reached a verdict. Its record is in the dashboard.`
const NOT_YET = `Run ${RUN_ID} has not reached a verdict yet.`
const NO_VERDICT = `Run ${RUN_ID} did not reach a verdict.`
const NOT_FOUND = `No completed run recorded for id: ${RUN_ID}`

interface Fixture {
  handoff?: CompletedRunHandoff
  row?: { status: string }
  events?: readonly ReplayedRunEvent[]
  eventsThrow?: boolean
  runDetail?: RunDetailReaderPort | 'absent'
}

interface Asked {
  records: string[]
  events: string[]
}

function deps(f: Fixture, asked: Asked): FunctionDeps {
  const runDetail: RunDetailReaderPort | undefined = f.runDetail === 'absent'
    ? undefined
    : f.runDetail ?? {
        read: () => Promise.resolve(undefined),
        readRecord: (runId) => {
          asked.records.push(String(runId))
          return Promise.resolve(f.row)
        },
      }
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(f.handoff),
      readEvents: (runId) => {
        asked.events.push(String(runId))
        return f.eventsThrow === true
          ? Promise.reject(new Error('replay incomplete'))
          : Promise.resolve(f.events ?? [])
      },
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: 'agent-qa.config.yaml', entries: [] }),
    },
    postProcessing: {
      idSource: { jobIdFor: (kind, key) => asJobId(`verdictless_${kind}_${key}`) },
      readChain: () => Promise.resolve(undefined),
    },
    secretMask: (text: string) => text,
    ...(runDetail === undefined ? {} : { runDetail }),
  }
}

async function refusal(
  functionId: string,
  f: Fixture,
): Promise<{ error: { name: string; message: string }; asked: Asked }> {
  const asked: Asked = { records: [], events: [] }
  try {
    await invokeFunction(createFunctionRegistry({ deps: deps(f, asked) }), functionId, { runId: RUN_ID }, CALLER)
  } catch (error) {
    const { name, message } = error as Error
    return { error: { name, message }, asked }
  }
  throw new Error(`${functionId} answered instead of refusing`)
}

describe('reads of a run with no verdict', () => {
  it('a finished row with no handoff answers that it ended before a verdict', async () => {
    for (const functionId of READS) {
      for (const status of ['failed', 'cancelled', 'passed', 'timeout']) {
        const { error, asked } = await refusal(functionId, { row: { status }, events: STARTED_ONLY })
        expect(error, `${functionId} ${status}`).toEqual({ name: 'RunEndedWithoutVerdictError', message: ENDED })
        expect(asked.records, functionId).toEqual([RUN_ID])
      }
      const unlogged = await refusal(functionId, { row: { status: 'cancelled' } })
      expect(unlogged.error, functionId).toEqual({ name: 'RunEndedWithoutVerdictError', message: ENDED })
    }
  })

  it('a running row with no handoff answers that it has not reached a verdict yet', async () => {
    for (const functionId of READS) {
      for (const status of ['running', 'pending']) {
        const { error, asked } = await refusal(functionId, { row: { status }, events: STARTED_ONLY })
        expect(error, `${functionId} ${status}`).toEqual({ name: 'RunNotFinishedError', message: NOT_YET })
        expect(asked.records, functionId).toEqual([RUN_ID])
      }
    }
  })

  it('a run directory with no row and no verdict answers that it did not reach a verdict', async () => {
    for (const functionId of READS) {
      const { error, asked } = await refusal(functionId, { events: STARTED_ONLY })
      expect(error, functionId).toEqual({ name: 'RunEndedWithoutVerdictError', message: NO_VERDICT })
      expect(asked.records, functionId).toEqual([RUN_ID])
      expect(asked.events, functionId).toEqual([RUN_ID])
    }
  })

  it('an id with no row and no run directory is still not found', async () => {
    for (const functionId of READS) {
      const { error, asked } = await refusal(functionId, {})
      expect(error, functionId).toEqual({ name: 'RunNotFoundError', message: NOT_FOUND })
      expect(asked.records, functionId).toEqual([RUN_ID])
      expect(asked.events, functionId).toEqual([RUN_ID])
    }
  })

  it('a host without the run detail port is still not found', async () => {
    const readOnly: RunDetailReaderPort = { read: () => Promise.resolve(undefined) }
    for (const functionId of READS) {
      const { error, asked } = await refusal(functionId, { runDetail: readOnly, events: STARTED_ONLY })
      expect(error, functionId).toEqual({ name: 'RunNotFoundError', message: NOT_FOUND })
      expect(asked.events, functionId).toEqual([])
    }
    const unbound = await refusal(RUNS_DIGEST_FUNCTION_ID, { runDetail: 'absent', events: STARTED_ONLY })
    expect(unbound.error).toEqual({ name: 'RunNotFoundError', message: NOT_FOUND })
  })

  it('a logged verdict or an unreadable record is still not found', async () => {
    const throwing: RunDetailReaderPort = {
      read: () => Promise.resolve(undefined),
      readRecord: () => Promise.reject(new Error('runs.db unreadable')),
    }
    for (const functionId of READS) {
      const cases: readonly Fixture[] = [
        { row: { status: 'failed' }, events: WITH_VERDICT },
        { row: { status: 'running' }, events: WITH_VERDICT },
        { events: WITH_VERDICT },
        { row: { status: 'failed' }, eventsThrow: true },
        { eventsThrow: true },
        { runDetail: throwing, events: STARTED_ONLY },
      ]
      for (const [index, fixture] of cases.entries()) {
        const { error, asked } = await refusal(functionId, fixture)
        expect(error, `${functionId} case ${String(index)}`).toEqual({ name: 'RunNotFoundError', message: NOT_FOUND })
        if (fixture.runDetail === undefined) expect(asked.records, functionId).toEqual([RUN_ID])
      }
    }
  })
})
