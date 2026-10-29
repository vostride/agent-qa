import { describe, expectTypeOf, test } from 'vitest'
import type { z } from 'zod'

import {
  POST_PROCESSING_SKIP_REASON_WORDS,
  POST_PROCESSING_SKIP_REASONS,
  PostProcessingSkippedSchema,
} from '../index'
import type {
  PostProcessingChipStatus,
  PostProcessingSkipReason,
  PostProcessingStatus,
  RunDigestChainOutcomes,
} from '../index'
import type * as Notification from '../notification/index'

type ExactlyEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

// Independent literal union; the never-bar fails to compile the moment either side grows.
describe('C425-EXCLUSION-REASONS-EXACT', () => {
  test('pins exactly three skip reasons in both directions through both barrels', () => {
    const listMatchesUnion: ExactlyEqual<
      (typeof POST_PROCESSING_SKIP_REASONS)[number],
      PostProcessingSkipReason
    > = true
    expectTypeOf(listMatchesUnion).toEqualTypeOf<true>()
    expectTypeOf<PostProcessingSkipReason>().toEqualTypeOf<'gate-run' | 'outcome-excluded' | 'no-verdict'>()
    expectTypeOf<(typeof POST_PROCESSING_SKIP_REASONS)[number]>().toEqualTypeOf<
      'gate-run' | 'outcome-excluded' | 'no-verdict'
    >()
    expectTypeOf<
      Exclude<PostProcessingSkipReason, (typeof POST_PROCESSING_SKIP_REASONS)[number]>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Exclude<(typeof POST_PROCESSING_SKIP_REASONS)[number], PostProcessingSkipReason>
    >().toEqualTypeOf<never>()
    expectTypeOf<Notification.PostProcessingSkipReason>().toEqualTypeOf<
      PostProcessingSkipReason
    >()
    expectTypeOf<z.infer<typeof PostProcessingSkippedSchema>>().toEqualTypeOf<{
      reason: 'gate-run' | 'outcome-excluded' | 'no-verdict'
    }>()
  })

  test('refuses an unknown reason at the type boundary', () => {
    // @ts-expect-error an unknown reason is not a member of the closed skip set
    const invented: PostProcessingSkipReason = 'excluded'
    expectTypeOf(invented).toEqualTypeOf<PostProcessingSkipReason>()
    expectTypeOf<Extract<PostProcessingSkipReason, 'excluded'>>().toEqualTypeOf<never>()
  })

  test('rides beside the untouched chip words on both DTOs', () => {
    expectTypeOf<PostProcessingStatus['skipped']>().toEqualTypeOf<
      { reason: PostProcessingSkipReason } | undefined
    >()
    expectTypeOf<RunDigestChainOutcomes['skipped']>().toEqualTypeOf<
      { reason: PostProcessingSkipReason } | undefined
    >()
    expectTypeOf<PostProcessingChipStatus>().toEqualTypeOf<
      'pending' | 'running' | 'complete' | 'failed'
    >()
    expectTypeOf<Extract<PostProcessingChipStatus, 'excluded'>>().toEqualTypeOf<never>()
    expectTypeOf<RunDigestChainOutcomes['analysis']>().toEqualTypeOf<PostProcessingChipStatus>()
    expectTypeOf<Extract<keyof PostProcessingStatus, 'exclusion'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<keyof RunDigestChainOutcomes, 'exclusion'>>().toEqualTypeOf<never>()
    expectTypeOf<keyof typeof POST_PROCESSING_SKIP_REASON_WORDS>().toEqualTypeOf<PostProcessingSkipReason>()
  })
})
