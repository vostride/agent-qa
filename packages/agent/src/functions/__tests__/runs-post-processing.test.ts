import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import {
  asJobId,
  asRunId,
  POST_PROCESSING_CHIP_STATUSES,
  PostProcessingStatusSchema,
  CurationSnapshotSchema,
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  toRunNotificationView,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { CurationSnapshot, MaskFn, PostProcessingStageDetail, RunNotification } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { runsPostProcessingSpec } from '../ops/runs-post-processing.js'
import type { FunctionDeps, PostProcessingChainState } from '../spec.js'

const RUN_ID = asRunId('run-423-stage-details')

function declaredMask(secrets: Record<string, string>): MaskFn {
  const redactor = new SecretRedactor(new SecretStore(secrets))
  return text => redactor.redactString(text)
}
const identity: MaskFn = text => text

function read(state: PostProcessingChainState | undefined, secretMask?: MaskFn) {
  const deps: FunctionDeps = {
    runs: {
      list: async () => [],
      get: async () => undefined,
      readEvents: async () => [],
      readStepEvidence: async () => ({ kind: 'run-not-recorded' }),
    },
    knowledge: {
      listBundles: async () => [],
      inspectRecords: async () => [],
      diffSince: async () => [],
      showRecord: async ({ recordId }) => ({ kind: 'not-found', schemaVersion: 2, recordId }),
    },
    entities: {
      resolve: async () => ({ kind: 'none', reason: 'no-match' }),
      get: async () => undefined,
    },
    config: {
      getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: 'agent-qa.config.yaml', entries: [] }),
    },
    postProcessing: {
      idSource: { jobIdFor: (kind, key) => asJobId(`${kind}:${key}`) },
      readChain: async () => state,
    },
    ...(secretMask === undefined ? {} : { secretMask }),
  }
  return runsPostProcessingSpec.invoke({ runId: RUN_ID }, deps)
}

function snapshot(): CurationSnapshot {
  return CurationSnapshotSchema.parse({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [{ recordId: 'record-synthetic-snapshot-secret', bucket: 'superseded',
      byRecordId: 'replacement-synthetic-snapshot-secret',
      changes: [{ bucket: 'superseded', change: {
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-synthetic-snapshot-secret',
        change: 'superseded', byRecordId: 'replacement-synthetic-snapshot-secret',
        atOrdinal: 12, evidenceToken: 'token-synthetic-snapshot-secret',
        sourceRunId: 'run-synthetic-snapshot-secret', observationId: 'observation-synthetic-snapshot-secret',
      } }],
    }],
    breakdown: { added: 0, confirmed: 0, superseded: 1, deprecated: 0, proposed: 0 },
  })
}

describe('423 checkpoint-backed snapshot projection', () => {
  it('NOTIFICATION-MASK: terminal-only snapshot crosses the same strict live mask without mutation', async () => {
    const mask = declaredMask({ SNAP_441: 'synthetic-snapshot-secret' })
    const recorded = snapshot()
    const notification = {
      schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, runId: RUN_ID, outcome: 'done' as const,
      verdictSummary: { total: 0, byClass: {} },
      stages: { analysis: { status: 'done' as const }, curation: { status: 'done' as const,
        curationSnapshot: recorded } },
    } satisfies RunNotification
    const before = JSON.stringify(notification)
    const result = await read({ notification }, mask)
    expect(JSON.stringify(result)).not.toContain('synthetic-snapshot-secret')
    expect(result.notification).toEqual(toRunNotificationView(JSON.parse(before.replaceAll('synthetic-snapshot-secret',
      '[secret:SNAP_441]'))))
    expect(PostProcessingStatusSchema.parse(result)).toEqual(result)
    expect(JSON.stringify(notification)).toBe(before)
    expect(result).not.toHaveProperty('curationSnapshot')
  })

  it('NOTIFICATION-MASK-COLLISION: nested identity collisions withhold generically without deleting history', async () => {
    const recorded: CurationSnapshot = { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: [{ recordId: 'synthetic-record', bucket: 'confirmed', changes: [
        { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'synthetic-record',
          change: 'confirmed', atOrdinal: 1, evidenceToken: 'synthetic-secret-one' } },
        { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'synthetic-record',
          change: 'confirmed', atOrdinal: 1, evidenceToken: 'synthetic-secret-two' } },
      ] }], breakdown: { added: 0, confirmed: 1, superseded: 0, deprecated: 0, proposed: 0 } }
    const notification = { schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
      runId: RUN_ID, outcome: 'done' as const, verdictSummary: { total: 0, byClass: {} },
      stages: { analysis: { status: 'done' as const },
        curation: { status: 'done' as const, curationSnapshot: recorded } } } satisfies RunNotification
    const before = JSON.stringify(notification)
    const collapsing: MaskFn = () => '[secret:COLLAPSED_441]'
    await expect(read({ notification }, collapsing)).resolves.toHaveProperty('curationSnapshotWithheld', { reason: 'projection-refused' })
    const result = await read({ notification }, collapsing)
    expect(result.notification?.stages.curation).toEqual({ status: 'complete' })
    expect(JSON.stringify(notification)).toBe(before)
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(PostProcessingStatusSchema.parse(result)).toEqual(result)
  })

  it('POSTPROCESSING-SNAPSHOT-EARLY copies exact masked facts beside the stage details and two chips', async () => {
    const mask = declaredMask({ SNAP_441: 'synthetic-snapshot-secret' })
    const recorded = snapshot()
    const before = structuredClone(recorded)
    const result = await read({
      analyzeRun: { status: 'done', claimed: false, attempts: 1 },
      curateMemory: { status: 'done', claimed: false, attempts: 2 },
      curationSnapshot: recorded,
    }, mask)
    const expected = JSON.parse(JSON.stringify(before).replaceAll('synthetic-snapshot-secret',
      '[secret:SNAP_441]'))
    expect(result).toHaveProperty('curationSnapshot', expected)
    expect(result.chips).toEqual({ analysis: 'complete', curation: 'complete' })
    expect(result.stageDetails).toEqual({ analysis: { attempts: 1 }, curation: { attempts: 2 } })
    expect(result).not.toHaveProperty('notification')
    expect(JSON.stringify(result)).not.toContain('synthetic-snapshot-secret')
    expect(PostProcessingStatusSchema.parse(result)).toEqual(result)
    expect(recorded).toEqual(before)
    expect(runsPostProcessingSpec.classify!(result).status).toBe('executed')
  })

  it.each(['done', 'failed'] as const)('POSTPROCESSING-HISTORICAL-COUNTS %s preserves legacy counts without a snapshot', async outcome => {
    const notification: RunNotification = {
      schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, runId: RUN_ID, outcome,
      verdictSummary: { total: 1, byClass: { timeout: 1 } },
      stages: { analysis: { status: 'done' }, curation: { status: outcome, curated: 7, deprecated: 3 } },
    }
    const result = await read({
      analyzeRun: { status: 'done', claimed: false },
      curateMemory: { status: outcome, claimed: false },
      notification,
    })
    expect(result.notification).toEqual(toRunNotificationView(notification))
    expect(result).not.toHaveProperty('curationSnapshot')
    expect(result.chips).toEqual({ analysis: 'complete', curation: outcome === 'done' ? 'complete' : 'failed' })
    expect(runsPostProcessingSpec.classify!(result).status).toBe('executed')
    expect(PostProcessingStatusSchema.parse(result)).toEqual(result)
  })

  it('POSTPROCESSING-SNAPSHOT-STRICT rejects malformed optional snapshots and extra fields', () => {
    const base = { runId: RUN_ID, chips: { analysis: 'complete', curation: 'complete' }, curationSnapshot: snapshot() }
    expect(PostProcessingStatusSchema.safeParse(base).success).toBe(true)
    for (const invalid of [null, { ...snapshot(), schemaVersion: 1 }, { ...snapshot(), extra: true },
      { ...snapshot(), breakdown: { ...snapshot().breakdown, superseded: 0 } }]) {
      expect(PostProcessingStatusSchema.safeParse({ ...base, curationSnapshot: invalid }).success).toBe(false)
    }
  })

  it('POSTPROCESSING-SNAPSHOT-WITHHELD degrades the snapshot, never the read', async () => {
    const recorded = CurationSnapshotSchema.parse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: ['first-record', 'second-record'].map(recordId => ({ recordId, bucket: 'added',
        changes: [{ bucket: 'added', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId, change: 'added', atOrdinal: 1 } }],
      })),
      breakdown: { added: 2, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
    })
    const pending = { analysis: 'pending', curation: 'pending' }

    await expect(read({ curationSnapshot: recorded })).resolves.toEqual({ runId: RUN_ID, chips: pending,
      curationSnapshotWithheld: { reason: 'masking-unavailable' } })
    const unavailable = await read({ curationSnapshot: recorded })
    expect(PostProcessingStatusSchema.safeParse(unavailable).success).toBe(true)
    expect(JSON.stringify(await read({ curationSnapshot: snapshot() }))).not.toContain('synthetic-snapshot-secret')

    const notification = { schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, runId: RUN_ID,
      outcome: 'done' as const, verdictSummary: { total: 0, byClass: {} },
      stages: { analysis: { status: 'done' as const },
        curation: { status: 'done' as const, curated: 2, deprecated: 0, curationSnapshot: recorded } },
    } satisfies RunNotification
    const nested = await read({ notification })
    expect(nested).toHaveProperty('curationSnapshotWithheld', { reason: 'masking-unavailable' })
    expect(nested).not.toHaveProperty('curationSnapshot')
    expect(nested.notification?.stages.curation).toEqual({ status: 'complete', curated: 2, deprecated: 0 })
    expect(notification.stages.curation.curationSnapshot).toBe(recorded)
    expect(PostProcessingStatusSchema.safeParse(nested).success).toBe(true)

    const collided = await read({
      analyzeRun: { status: 'done', claimed: false, attempts: 1 },
      curateMemory: { status: 'done', claimed: false, attempts: 2 },
      curationSnapshot: recorded,
    }, () => 'collided-identity')
    expect(collided).toEqual({ runId: RUN_ID, chips: { analysis: 'complete', curation: 'complete' },
      stageDetails: { analysis: { attempts: 1 }, curation: { attempts: 2 } },
      curationSnapshotWithheld: { reason: 'projection-refused' } })
    expect(PostProcessingStatusSchema.safeParse(collided).success).toBe(true)

    const invalid = { ...recorded, 'synthetic-raw-secret-key': 'synthetic-raw-secret-value' }
    const refused = await read({ curationSnapshot: invalid }, identity)
    expect(refused).toEqual({ runId: RUN_ID, chips: pending,
      curationSnapshotWithheld: { reason: 'projection-refused' } })
    expect(JSON.stringify(refused)).not.toContain('synthetic-raw-secret-key')
    expect(JSON.stringify(refused)).not.toContain('synthetic-raw-secret-value')
    for (const identity of ['first-record', 'second-record']) {
      expect(JSON.stringify(collided)).not.toContain(identity)
      expect(JSON.stringify(refused)).not.toContain(identity)
    }

    const empty = CurationSnapshotSchema.parse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [],
      breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 } })
    const served = await read({ curationSnapshot: empty }, identity)
    expect(served).toEqual({ runId: RUN_ID, chips: pending, curationSnapshot: empty })
    expect(served).not.toHaveProperty('curationSnapshotWithheld')
    expect(await read({ curationSnapshot: empty })).toEqual({ runId: RUN_ID, chips: pending,
      curationSnapshotWithheld: { reason: 'masking-unavailable' } })
  })
})

describe('423 durable stage projection', () => {
  it('STAGE-ROWS projects exact recorded facts and masks failure text', async () => {
    const mask = declaredMask({ STAGE_441: 'synthetic-stage-secret' })
    const analysis: PostProcessingStageDetail = {
      attempts: 2,
      createdAt: '2026-09-14T00:00:01.000Z',
      updatedAt: '2026-09-14T00:00:04.000Z',
      lastFailureKind: 'retry',
      lastFailureReason: 'retry synthetic-stage-secret for operator@example.test',
    }
    const curation: PostProcessingStageDetail = {
      attempts: 1,
      createdAt: '2026-09-14T00:00:05.000Z',
      claimedAt: '2026-09-14T00:00:07.000Z',
      updatedAt: '2026-09-14T00:00:05.000Z',
      conclusionKind: 'unreadable_kind',
    }
    const state = {
      analyzeRun: { status: 'done' as const, claimed: false, ...analysis },
      curateMemory: { status: 'failed' as const, claimed: false, ...curation },
    }
    const before = structuredClone(state)
    const result = await read(state, mask)
    expect(result.stageDetails).toEqual({
      analysis: { ...analysis, lastFailureReason: 'retry [secret:STAGE_441] for operator@example.test' },
      curation,
    })
    expect(JSON.stringify(result)).not.toContain('synthetic-stage-secret')
    expect(JSON.stringify(result)).toContain('operator@example.test')
    expect(state).toEqual(before)
    expect(PostProcessingStatusSchema.parse(result)).toEqual(result)
  })

  it('TWO-CHIPS keeps exactly two chips and four statuses with their detail stages', async () => {
    const result = await read({
      analyzeRun: { status: 'queued', claimed: true },
      curateMemory: { status: 'cancelled', claimed: false },
    })
    expect(result.chips).toEqual({ analysis: 'running', curation: 'failed' })
    expect(POST_PROCESSING_CHIP_STATUSES).toEqual(['pending', 'running', 'complete', 'failed'])
    expect(result.stageDetails).toEqual({ analysis: {}, curation: {} })
    expect(runsPostProcessingSpec.classify!(result).status).toBe('executed')
  })

  it('ROW-ABSENT omits missing stage keys and the whole absent map', async () => {
    expect(await read(undefined)).toEqual({
      runId: RUN_ID,
      chips: { analysis: 'pending', curation: 'pending' },
    })
    expect(await read({})).not.toHaveProperty('stageDetails')
    const result = await read({ analyzeRun: { status: 'queued', claimed: false } })
    expect(result.stageDetails).toEqual({ analysis: {} })
  })

  it('MASK-NO-CONTEXT fails closed for recorded failure prose', async () => {
    const state = {
      analyzeRun: {
        status: 'failed' as const,
        claimed: false,
        lastFailureKind: 'permanent',
        lastFailureReason: 'synthetic-unregistered-secret',
      },
    }
    const result = await read(state)
    expect(result.stageDetails).toEqual({ analysis: {} })
    expect(JSON.stringify(result)).not.toContain('synthetic-unregistered-secret')
    expect(JSON.stringify(result)).not.toContain('masked:')
  })

  it('CHIP-CONTROL terminal status wins over a stale claim', async () => {
    const result = await read({ analyzeRun: { status: 'done', claimed: true } })
    expect(result.chips).toEqual({ analysis: 'complete', curation: 'pending' })
  })
})

describe('C441-COLD-READ', () => {
  it('runs.post-processing withholds without a mask', async () => {
    const recorded = snapshot()
    const failing = { status: 'failed' as const, claimed: false, lastFailureKind: 'permanent',
      lastFailureReason: 'synthetic-cold-secret for qa@example.com' }
    const throwing: MaskFn = () => { throw new Error('synthetic unreadable secrets file') }
    const unbound = await read({ curationSnapshot: recorded })
    expect(unbound).toEqual({ runId: RUN_ID, chips: { analysis: 'pending', curation: 'pending' },
      curationSnapshotWithheld: { reason: 'masking-unavailable' } })
    const failed = await read({ analyzeRun: failing, curationSnapshot: recorded }, throwing)
    expect(failed).toEqual({ runId: RUN_ID, chips: { analysis: 'failed', curation: 'pending' },
      stageDetails: { analysis: {} }, curationSnapshotWithheld: { reason: 'masking-unavailable' } })
    for (const result of [unbound, failed]) {
      expect(JSON.stringify(result)).not.toContain('synthetic-snapshot-secret')
      expect(JSON.stringify(result)).not.toContain('synthetic-cold-secret')
      expect(PostProcessingStatusSchema.parse(result)).toEqual(result)
    }
  })
})
