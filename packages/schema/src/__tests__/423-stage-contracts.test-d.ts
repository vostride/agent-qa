import { describe, expectTypeOf, test } from 'vitest'
import type { z } from 'zod'

import {
  CURATION_SNAPSHOT_WITHHELD_REASONS,
  CurationSnapshotWithheldSchema,
  POST_PROCESSING_CHIP_STATUSES,
  POST_PROCESSING_DETAIL_STAGES,
  PostProcessingStageDetailSchema,
  PostProcessingStatusSchema,
} from '../index'
import type {
  CurationSnapshotWithheldReason,
  JobConclusionKind,
  PostProcessingChips,
  PostProcessingChipStatus,
  PostProcessingDetailStage,
  PostProcessingStageDetail,
  PostProcessingStatus,
} from '../index'
import type * as Notification from '../notification/index'

// Independent literal unions: neither expected vocabulary is derived from production.
describe('C423-STAGES-EXACT', () => {
  test('pins two detail stages in both directions through public exports', () => {
    expectTypeOf<PostProcessingDetailStage>().toEqualTypeOf<'analysis' | 'curation'>()
    expectTypeOf<(typeof POST_PROCESSING_DETAIL_STAGES)[number]>().toEqualTypeOf<
      'analysis' | 'curation'
    >()
    expectTypeOf<
      Exclude<PostProcessingDetailStage, (typeof POST_PROCESSING_DETAIL_STAGES)[number]>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Exclude<(typeof POST_PROCESSING_DETAIL_STAGES)[number], PostProcessingDetailStage>
    >().toEqualTypeOf<never>()
    expectTypeOf<Notification.PostProcessingDetailStage>().toEqualTypeOf<PostProcessingDetailStage>()
  })

  test('pins exactly two chip keys and four statuses independently', () => {
    expectTypeOf<keyof PostProcessingChips>().toEqualTypeOf<'analysis' | 'curation'>()
    expectTypeOf<PostProcessingChipStatus>().toEqualTypeOf<'pending' | 'running' | 'complete' | 'failed'>()
    expectTypeOf<
      Exclude<PostProcessingChipStatus, (typeof POST_PROCESSING_CHIP_STATUSES)[number]>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Exclude<(typeof POST_PROCESSING_CHIP_STATUSES)[number], PostProcessingChipStatus>
    >().toEqualTypeOf<never>()
    expectTypeOf<PostProcessingChips>().toEqualTypeOf<{
      analysis: 'pending' | 'running' | 'complete' | 'failed'
      curation: 'pending' | 'running' | 'complete' | 'failed'
    }>()
  })

  test('refuses a third stage and third chip at the type boundary', () => {
    expectTypeOf<Extract<PostProcessingDetailStage, 'admission'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<keyof PostProcessingChips, 'admission'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<PostProcessingChipStatus, 'unknown'>>().toEqualTypeOf<never>()
  })

  test('keeps each stage optional on the DTO and inferred result', () => {
    type Expected = Partial<Record<'analysis' | 'curation', PostProcessingStageDetail>>
    expectTypeOf<PostProcessingStatus['stageDetails']>().toEqualTypeOf<Expected | undefined>()
    expectTypeOf<z.infer<typeof PostProcessingStatusSchema>>().toEqualTypeOf<PostProcessingStatus>()
    expectTypeOf<keyof NonNullable<PostProcessingStatus['stageDetails']>>().toEqualTypeOf<
      'analysis' | 'curation'
    >()
  })

  test('carries only the eight optional recorded facts through both barrels', () => {
    expectTypeOf<PostProcessingStageDetail>().toEqualTypeOf<{
      attempts?: number
      createdAt?: string
      claimedAt?: string
      startedAt?: string
      updatedAt?: string
      conclusionKind?: JobConclusionKind
      lastFailureKind?: string
      lastFailureReason?: string
    }>()
    expectTypeOf<z.infer<typeof PostProcessingStageDetailSchema>>().toEqualTypeOf<
      PostProcessingStageDetail
    >()
    expectTypeOf<Notification.PostProcessingStageDetail>().toEqualTypeOf<PostProcessingStageDetail>()
    expectTypeOf<Extract<keyof PostProcessingStageDetail, 'cancelRequestedAt'>>().toEqualTypeOf<never>()
  })
})

type ExactlyEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

// Independent literal union; the never-bar fails to compile the moment either side grows.
describe('C423-WITHHELD-EXACT', () => {
  test('pins exactly two withheld reasons in both directions through both barrels', () => {
    const listMatchesUnion: ExactlyEqual<
      (typeof CURATION_SNAPSHOT_WITHHELD_REASONS)[number],
      CurationSnapshotWithheldReason
    > = true
    expectTypeOf(listMatchesUnion).toEqualTypeOf<true>()
    expectTypeOf<CurationSnapshotWithheldReason>().toEqualTypeOf<
      'masking-unavailable' | 'projection-refused'
    >()
    expectTypeOf<Notification.CurationSnapshotWithheldReason>().toEqualTypeOf<
      CurationSnapshotWithheldReason
    >()
    expectTypeOf<z.infer<typeof CurationSnapshotWithheldSchema>>().toEqualTypeOf<{
      reason: 'masking-unavailable' | 'projection-refused'
    }>()
    expectTypeOf<PostProcessingStatus['curationSnapshotWithheld']>().toEqualTypeOf<
      { reason: CurationSnapshotWithheldReason } | undefined
    >()
  })

  test('refuses a third withheld reason at the type boundary', () => {
    // @ts-expect-error a third reason is not a member of the closed withheld set
    const third: CurationSnapshotWithheldReason = 'fold-failed'
    expectTypeOf(third).toEqualTypeOf<CurationSnapshotWithheldReason>()
    expectTypeOf<Extract<CurationSnapshotWithheldReason, 'fold-failed'>>().toEqualTypeOf<never>()
  })
})
