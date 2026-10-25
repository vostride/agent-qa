import { describe, expect, test } from 'vitest'

import {
  CURATION_SNAPSHOT_SCHEMA_VERSION,
  CURATION_SNAPSHOT_WITHHELD_REASONS,
  CurationSnapshotWithheldSchema,
  POST_PROCESSING_CHIP_STATUSES,
  POST_PROCESSING_DETAIL_STAGES,
  PostProcessingStageDetailSchema,
  PostProcessingStatusSchema,
} from '../index'
import * as notification from '../notification/index'

const legacy = { runId: 'stage-contract-fixture', chips: { analysis: 'complete', curation: 'pending' } }

describe('STAGE-DETAIL-OPTIONAL', () => {
  test('parses both recorded stage details through the public result schema', () => {
    const payload = {
      ...legacy,
      stageDetails: {
        analysis: {
          attempts: 1,
          createdAt: '2026-09-14T00:00:00Z',
          updatedAt: '2026-09-14T00:01:00Z',
          conclusionKind: 'no_issue',
        },
        curation: {
          attempts: 2,
          claimedAt: '2026-09-14T00:02:00Z',
          lastFailureKind: 'retryable',
          lastFailureReason: 'Synthetic masked failure',
        },
      },
    }
    const parsed = PostProcessingStatusSchema.safeParse(payload)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(payload)
  })

  test('keeps historical absence and partial recorded facts without defaults', () => {
    expect(PostProcessingStatusSchema.parse(legacy)).toEqual(legacy)
    const payload = { ...legacy, stageDetails: { analysis: { attempts: 0 } } }
    const parsed = PostProcessingStatusSchema.safeParse(payload)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(payload)
  })

  test.each([
    { stageDetails: null },
    { stageDetails: { analysis: null } },
    { stageDetails: { analysis: { attempts: -1 } } },
    { stageDetails: { analysis: { attempts: 1.5 } } },
    { stageDetails: { analysis: { claimedAt: null } } },
    { stageDetails: { analysis: { conclusionKind: 'invented' } } },
    { stageDetails: { analysis: { cancelRequestedAt: '2026-09-14T00:00:00Z' } } },
    { stageDetails: { analysis: { unexpected: true } } },
  ])('rejects invalid or unowned detail facts: %j', (extra) => {
    expect(PostProcessingStatusSchema.safeParse({ ...legacy, ...extra }).success).toBe(false)
  })
})

describe('C423-STAGES-EXACT', () => {
  test('pins the public detail list and schema to independent exact vocabularies', () => {
    expect(POST_PROCESSING_DETAIL_STAGES).toEqual(['analysis', 'curation'])
    expect(notification.POST_PROCESSING_DETAIL_STAGES).toBe(POST_PROCESSING_DETAIL_STAGES)
    expect(notification.PostProcessingStageDetailSchema).toBe(PostProcessingStageDetailSchema)
    expect(Object.keys(PostProcessingStageDetailSchema.shape)).toEqual([
      'attempts',
      'createdAt',
      'claimedAt',
      'startedAt',
      'updatedAt',
      'conclusionKind',
      'lastFailureKind',
      'lastFailureReason',
    ])
    expect(PostProcessingStageDetailSchema.parse({})).toEqual({})
    expect(
      PostProcessingStageDetailSchema.safeParse({ cancelRequestedAt: 'recorded' }).success,
    ).toBe(false)
  })

  test('accepts the hand-spelled two detail stages and rejects a third', () => {
    for (const stage of ['analysis', 'curation']) {
      expect(
        PostProcessingStatusSchema.safeParse({ ...legacy, stageDetails: { [stage]: {} } }).success,
      ).toBe(true)
    }
    expect(
      PostProcessingStatusSchema.safeParse({ ...legacy, stageDetails: { admission: {} } }).success,
    ).toBe(false)
  })

  test('keeps exactly two required chips with exactly four statuses', () => {
    expect(POST_PROCESSING_CHIP_STATUSES).toEqual(['pending', 'running', 'complete', 'failed'])
    expect(Object.keys(PostProcessingStatusSchema.shape.chips.shape)).toEqual([
      'analysis',
      'curation',
    ])
    for (const status of ['pending', 'running', 'complete', 'failed']) {
      expect(
        PostProcessingStatusSchema.safeParse({
          ...legacy,
          chips: { analysis: status, curation: status },
        }).success,
      ).toBe(true)
    }
    for (const chips of [
      { analysis: 'complete' },
      { analysis: 'complete', curation: 'unknown' },
      { analysis: 'done', curation: 'done' },
      { ...legacy.chips, admission: 'complete' },
    ]) {
      expect(PostProcessingStatusSchema.safeParse({ ...legacy, chips }).success).toBe(false)
    }
  })
})

describe('C423-WITHHELD-EXACT', () => {
  const emptySnapshot = {
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [],
    breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
  }

  test('pins the withheld reasons to an independent exact list through both barrels', () => {
    expect(CURATION_SNAPSHOT_WITHHELD_REASONS).toEqual(['masking-unavailable', 'projection-refused'])
    expect(notification.CURATION_SNAPSHOT_WITHHELD_REASONS).toBe(CURATION_SNAPSHOT_WITHHELD_REASONS)
    expect(notification.CurationSnapshotWithheldSchema).toBe(CurationSnapshotWithheldSchema)
    expect(Object.keys(CurationSnapshotWithheldSchema.shape)).toEqual(['reason'])
  })

  test('accepts each hand-spelled reason and rejects a third reason or an extra key', () => {
    for (const reason of ['masking-unavailable', 'projection-refused']) {
      expect(CurationSnapshotWithheldSchema.safeParse({ reason }).success).toBe(true)
    }
    expect(CurationSnapshotWithheldSchema.safeParse({ reason: 'fold-failed' }).success).toBe(false)
    expect(
      CurationSnapshotWithheldSchema.safeParse({ reason: 'projection-refused', detail: 'raw' }).success,
    ).toBe(false)
  })

  test('parses a served snapshot alone and a withheld flag alone on the public result', () => {
    const served = { ...legacy, curationSnapshot: emptySnapshot }
    const withheld = { ...legacy, curationSnapshotWithheld: { reason: 'masking-unavailable' } }
    expect(PostProcessingStatusSchema.safeParse(served).data).toEqual(served)
    expect(PostProcessingStatusSchema.safeParse(withheld).data).toEqual(withheld)
    expect(
      PostProcessingStatusSchema.safeParse({ ...legacy, curationSnapshotWithheld: { reason: 'fold-failed' } })
        .success,
    ).toBe(false)
  })
})
