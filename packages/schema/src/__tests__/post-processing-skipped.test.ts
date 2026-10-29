import { describe, expect, test } from 'vitest'

import {
  POST_PROCESSING_CHIP_STATUSES,
  POST_PROCESSING_SKIP_REASON_WORDS,
  POST_PROCESSING_SKIP_REASONS,
  PostProcessingSkippedSchema,
  PostProcessingStatusSchema,
  RunDigestChainOutcomesSchema,
} from '../index'
import * as notification from '../notification/index'

const legacy = { runId: 'skipped-fixture', chips: { analysis: 'pending', curation: 'pending' } }

describe('EXCLUSION-SCHEMA-ROUNDTRIP', () => {
  test('round-trips each reason beside the untouched chip words', () => {
    for (const reason of ['gate-run', 'outcome-excluded', 'no-verdict']) {
      const payload = { ...legacy, skipped: { reason } }
      const parsed = PostProcessingStatusSchema.safeParse(payload)
      expect(parsed.success).toBe(true)
      expect(parsed.data).toEqual(payload)
      expect(parsed.data?.chips).toEqual({ analysis: 'pending', curation: 'pending' })
    }
  })

  test('keeps a status without the key parsing equal to itself', () => {
    const parsed = PostProcessingStatusSchema.parse(legacy)
    expect(parsed).toEqual(legacy)
    expect(parsed).not.toHaveProperty('skipped')
  })

  test.each([
    { skipped: null },
    { skipped: { reason: 'invented' } },
    { skipped: { reason: 'gate-run', extra: 1 } },
    { skipped: {} },
    { exclusion: { reason: 'gate-run' } },
  ])('rejects an invalid or unowned skipped fact: %j', (extra) => {
    expect(PostProcessingStatusSchema.safeParse({ ...legacy, ...extra }).success).toBe(false)
  })
})

describe('post-processing skip reasons', () => {
  test('pins the reason list to an independent exact vocabulary through both barrels', () => {
    expect(POST_PROCESSING_SKIP_REASONS).toEqual(['gate-run', 'outcome-excluded', 'no-verdict'])
    expect(POST_PROCESSING_SKIP_REASONS).toHaveLength(3)
    expect(notification.POST_PROCESSING_SKIP_REASONS).toBe(POST_PROCESSING_SKIP_REASONS)
    expect(notification.PostProcessingSkippedSchema).toBe(PostProcessingSkippedSchema)
    expect(notification.POST_PROCESSING_SKIP_REASON_WORDS).toBe(POST_PROCESSING_SKIP_REASON_WORDS)
    expect(Object.keys(PostProcessingSkippedSchema.shape)).toEqual(['reason'])
    expect(POST_PROCESSING_SKIP_REASON_WORDS).toEqual({
      'gate-run': 'gate run',
      'outcome-excluded': 'outcome-excluded',
      'no-verdict': 'no verdict',
    })
  })

  test('leaves the four chip words untouched', () => {
    expect(POST_PROCESSING_CHIP_STATUSES).toEqual(['pending', 'running', 'complete', 'failed'])
    expect(POST_PROCESSING_CHIP_STATUSES).toHaveLength(4)
  })

  test('accepts each hand-spelled reason and rejects an unknown reason or an extra key', () => {
    for (const reason of ['gate-run', 'outcome-excluded', 'no-verdict']) {
      expect(PostProcessingSkippedSchema.safeParse({ reason }).success).toBe(true)
    }
    expect(PostProcessingSkippedSchema.safeParse({ reason: 'excluded' }).success).toBe(false)
    expect(
      PostProcessingSkippedSchema.safeParse({ reason: 'gate-run', detail: 'raw' }).success,
    ).toBe(false)
  })
})

describe('EXCLUSION-ON-DIGEST-CHAIN', () => {
  test('carries the same optional fact on the digest chain outcomes', () => {
    const payload = { analysis: 'pending', curation: 'pending', skipped: { reason: 'outcome-excluded' } }
    const parsed = RunDigestChainOutcomesSchema.safeParse(payload)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(payload)
    expect(RunDigestChainOutcomesSchema.safeParse({
      analysis: 'pending',
      curation: 'pending',
      exclusion: { reason: 'outcome-excluded' },
    }).success).toBe(false)
  })

  test('refuses a fifth chip word on either chain arm', () => {
    for (const chain of [
      { analysis: 'excluded', curation: 'pending' },
      { analysis: 'pending', curation: 'excluded' },
    ]) {
      expect(RunDigestChainOutcomesSchema.safeParse(chain).success).toBe(false)
    }
  })
})
