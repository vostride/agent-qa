import { describe, it, expect } from 'vitest'
import { BaseObservationSchema, SuiteObservationSchema } from '../schema.js'

const CANONICAL_OBSERVATION_ID = 'obs_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const CANONICAL_SUITE_OBSERVATION_ID = 'obs_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const LEGACY_OBSERVATION_ID = 'obs_amber-birch-coral-delta-ember-falcon'

const validBase = {
  id: CANONICAL_OBSERVATION_ID,
  title: 'Login page: modal appears after a short delay',
  content: 'Login modal appears after ~2s delay',
  trust: 0.5,
  created: '2026-04-10T12:00:00Z',
  last_confirmed: '2026-04-10T12:00:00Z',
  confirmed_count: 1,
  contradicted_count: 0,
  source_test: 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
}

const validSuite = {
  ...validBase,
  id: CANONICAL_SUITE_OBSERVATION_ID,
  position: 4,
  suite_snapshot: [
    { test: 'tests/web/auth.yaml', id: 't_lack-auto-quit-dow-boat-urus' },
    { test: 'tests/web/checkout.yaml', id: 't_pile-reak-bun-ended-joch-crate' },
  ],
}

describe('BaseObservationSchema', () => {
  it('accepts valid observation with title, content, and metadata', () => {
    const result = BaseObservationSchema.safeParse(validBase)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(validBase)
    }
  })

  it('rejects object missing id', () => {
    const { id, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects object missing content', () => {
    const { content, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects object missing title', () => {
    const { title, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects object missing trust', () => {
    const { trust, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects object missing created', () => {
    const { created, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects object missing last_confirmed', () => {
    const { last_confirmed, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects object missing confirmed_count', () => {
    const { confirmed_count, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects object missing contradicted_count', () => {
    const { contradicted_count, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects object missing source_test', () => {
    const { source_test, ...rest } = validBase
    expect(BaseObservationSchema.safeParse(rest).success).toBe(false)
  })

  it('strips unknown fields instead of rejecting (backward compat)', () => {
    const result = BaseObservationSchema.safeParse({ ...validBase, source_run: 'old-value', extra_field: 'whatever' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('source_run')
      expect(result.data).not.toHaveProperty('extra_field')
    }
  })

  it('accepts legacy 6-word observation ids for read compatibility', () => {
    const result = BaseObservationSchema.safeParse({ ...validBase, id: LEGACY_OBSERVATION_ID })
    expect(result.success).toBe(true)
  })

  it('rejects ids outside the shared observation contract', () => {
    expect(BaseObservationSchema.safeParse({ ...validBase, id: 'bad_id' }).success).toBe(false)
    expect(BaseObservationSchema.safeParse({ ...validBase, id: 'obs_one-two-three' }).success).toBe(false)
    expect(BaseObservationSchema.safeParse({
      ...validBase,
      id: 'obs_ONE-TWO-THREE-FOUR-FIVE-SIX-SEVEN-EIGHT-NINE-TEN',
    }).success).toBe(false)
  })

  it('rejects trust outside [0, 1] range', () => {
    expect(BaseObservationSchema.safeParse({ ...validBase, trust: -0.1 }).success).toBe(false)
    expect(BaseObservationSchema.safeParse({ ...validBase, trust: 1.1 }).success).toBe(false)
  })

  it('rejects non-integer confirmed_count and contradicted_count', () => {
    expect(BaseObservationSchema.safeParse({ ...validBase, confirmed_count: 1.5 }).success).toBe(false)
    expect(BaseObservationSchema.safeParse({ ...validBase, contradicted_count: 0.7 }).success).toBe(false)
  })

  it('rejects non-ISO-8601 created and last_confirmed', () => {
    expect(BaseObservationSchema.safeParse({ ...validBase, created: 'not-a-date' }).success).toBe(false)
    expect(BaseObservationSchema.safeParse({ ...validBase, last_confirmed: '2026/04/10' }).success).toBe(false)
  })

  it('rejects empty content string', () => {
    expect(BaseObservationSchema.safeParse({ ...validBase, content: '' }).success).toBe(false)
  })

  it('rejects empty title string', () => {
    expect(BaseObservationSchema.safeParse({ ...validBase, title: '' }).success).toBe(false)
  })
})

describe('SuiteObservationSchema', () => {
  it('accepts valid suite observation with base fields + position + suite_snapshot', () => {
    const result = SuiteObservationSchema.safeParse(validSuite)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(validSuite)
    }
  })

  it('rejects negative position', () => {
    expect(SuiteObservationSchema.safeParse({ ...validSuite, position: -1 }).success).toBe(false)
  })

  it('rejects non-integer position', () => {
    expect(SuiteObservationSchema.safeParse({ ...validSuite, position: 2.5 }).success).toBe(false)
  })

  it('rejects empty suite_snapshot array', () => {
    expect(SuiteObservationSchema.safeParse({ ...validSuite, suite_snapshot: [] }).success).toBe(false)
  })

  it('rejects suite_snapshot entries missing test or id fields', () => {
    expect(SuiteObservationSchema.safeParse({
      ...validSuite,
      suite_snapshot: [{ test: 'tests/web/auth.yaml' }],
    }).success).toBe(false)
    expect(SuiteObservationSchema.safeParse({
      ...validSuite,
      suite_snapshot: [{ id: 't_some-id-here-now-yes-go' }],
    }).success).toBe(false)
  })

  it('strips unknown fields on suite observations (backward compat)', () => {
    const result = SuiteObservationSchema.safeParse({ ...validSuite, source_run: 'old-value', extra: 'nope' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('source_run')
      expect(result.data).not.toHaveProperty('extra')
    }
  })
})
