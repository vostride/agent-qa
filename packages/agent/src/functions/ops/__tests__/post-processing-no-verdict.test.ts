// 2026-10-18 (444-12, D-14): a run that ended with no verdict reads `skipped (no verdict)`, derived
// from the run's own record (its runs.db row and its event log), never from missing job rows.

import {
  asJobId,
  PostProcessingStatusSchema,
  CURRENT_BUS_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  PostProcessingStatus,
  RunEventEnvelope,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../../invoke.js'
import { createFunctionRegistry } from '../../registry.js'
import type { FunctionDeps, ReplayedRunEvent, RunDetailReaderPort } from '../../spec.js'
import { RUNS_POST_PROCESSING_FUNCTION_ID } from '../runs-post-processing.js'

const RUN_ID = 'run-444-no-verdict'

const CALLER: FunctionCaller = { surface: 'test', origin: 'agent' }

function envelope(seq: number, type: RunEventEnvelope['type'], payload: unknown): ReplayedRunEvent {
  return { seq, ts: seq, runId: RUN_ID, type, payload } as unknown as ReplayedRunEvent
}

const STARTED_ONLY = [envelope(1, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION })]
const WITH_VERDICT = [...STARTED_ONLY, envelope(2, 'verdict', { verdict: 'failed' })]

interface Fixture {
  handoff?: CompletedRunHandoff
  row?: { status: string }
  events?: readonly ReplayedRunEvent[]
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
        return Promise.resolve(f.events ?? [])
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
      idSource: { jobIdFor: (kind, key) => asJobId(`no_verdict_${kind}_${key}`) },
      readChain: () => Promise.resolve(undefined),
    },
    secretMask: (text: string) => text,
    ...(runDetail === undefined ? {} : { runDetail }),
  }
}

async function served(f: Fixture): Promise<{ status: PostProcessingStatus; asked: Asked }> {
  const asked: Asked = { records: [], events: [] }
  const status = await invokeFunction(
    createFunctionRegistry({ deps: deps(f, asked) }),
    RUNS_POST_PROCESSING_FUNCTION_ID,
    { runId: RUN_ID },
    CALLER,
  ) as PostProcessingStatus
  return { status, asked }
}

describe('C444-NO-VERDICT', () => {
  it('a finished row with no handoff and no logged verdict reads skipped (no verdict)', async () => {
    const { status, asked } = await served({ row: { status: 'failed' }, events: STARTED_ONLY })
    expect(status.skipped).toEqual({ reason: 'no-verdict' })
    expect(status.chips).toEqual({ analysis: 'pending', curation: 'pending' })
    expect(PostProcessingStatusSchema.parse(status)).toEqual(status)
    expect(asked.records).toEqual([RUN_ID])
    expect(asked.events).toEqual([RUN_ID])
    for (const terminal of ['cancelled', 'passed', 'timeout']) {
      const other = await served({ row: { status: terminal }, events: STARTED_ONLY })
      expect(other.status.skipped, terminal).toEqual({ reason: 'no-verdict' })
    }
  })

  it('a running row with no handoff is never skipped', async () => {
    for (const inFlight of ['running', 'pending']) {
      const { status, asked } = await served({ row: { status: inFlight }, events: STARTED_ONLY })
      expect(asked.records, inFlight).toEqual([RUN_ID])
      expect(status, inFlight).toEqual({
        runId: RUN_ID,
        chips: { analysis: 'pending', curation: 'pending' },
      })
      expect('skipped' in status, inFlight).toBe(false)
    }
  })

  it('a logged verdict without a handoff is never no-verdict', async () => {
    const { status, asked } = await served({ row: { status: 'failed' }, events: WITH_VERDICT })
    expect(asked.events).toEqual([RUN_ID])
    expect('skipped' in status).toBe(false)
    expect(status.chips).toEqual({ analysis: 'pending', curation: 'pending' })
  })

  it("a gate run's handoff still reads skipped (gate run)", async () => {
    const handoff = { runId: RUN_ID, gateRun: true } as unknown as CompletedRunHandoff
    const { status } = await served({ handoff, row: { status: 'failed' }, events: STARTED_ONLY })
    expect(status.skipped).toEqual({ reason: 'gate-run' })
    const excluded = { runId: RUN_ID, excludedFromOutcomes: true } as unknown as CompletedRunHandoff
    const second = await served({ handoff: excluded, row: { status: 'failed' }, events: STARTED_ONLY })
    expect(second.status.skipped).toEqual({ reason: 'outcome-excluded' })
    const ordinary = await served({
      handoff: { runId: RUN_ID } as unknown as CompletedRunHandoff,
      row: { status: 'failed' },
      events: STARTED_ONLY,
    })
    expect('skipped' in ordinary.status).toBe(false)
    expect(ordinary.asked.records).toEqual([])
  })

  it('no row and no handoff derives nothing', async () => {
    const { status, asked } = await served({ events: STARTED_ONLY })
    expect(asked.records).toEqual([RUN_ID])
    expect('skipped' in status).toBe(false)
    const unbound = await served({ runDetail: 'absent', events: STARTED_ONLY })
    expect('skipped' in unbound.status).toBe(false)
    const readOnly = await served({
      runDetail: { read: () => Promise.resolve(undefined) },
      events: STARTED_ONLY,
    })
    expect('skipped' in readOnly.status).toBe(false)
  })
})
