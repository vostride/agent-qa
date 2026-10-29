import { describe, expect, it } from 'vitest'

import { DEFAULT_PARALLEL_WORKERS, resolveEffectiveWorkers } from '../config/use'

// The one formula that turns a config's `parallel` and `workers` into a worker count. That a
// caller cannot name either field is checked in `runs-start-input-posture.test.ts`.
describe('resolveEffectiveWorkers — the one formula', () => {
  it('resolves 1 when parallel is absent, whatever workers says', () => {
    expect(resolveEffectiveWorkers({ memberCount: 8 })).toBe(1)
    expect(resolveEffectiveWorkers({ workers: 6, memberCount: 8 })).toBe(1)
  })

  it('resolves 1 when parallel is explicitly false', () => {
    expect(resolveEffectiveWorkers({ parallel: false, workers: 6, memberCount: 8 })).toBe(1)
  })

  it('resolves the default ceiling when parallel is true and workers is absent', () => {
    expect(DEFAULT_PARALLEL_WORKERS).toBe(3)
    expect(resolveEffectiveWorkers({ parallel: true, memberCount: 8 })).toBe(DEFAULT_PARALLEL_WORKERS)
  })

  it('is bounded by the member count — 8 workers over 4 members is 4', () => {
    expect(resolveEffectiveWorkers({ parallel: true, workers: 8, memberCount: 4 })).toBe(4)
  })

  it('is bounded by the requested count — 2 workers over 9 members is 2', () => {
    expect(resolveEffectiveWorkers({ parallel: true, workers: 2, memberCount: 9 })).toBe(2)
  })

  it('never resolves below 1, including for a zero-member run', () => {
    expect(resolveEffectiveWorkers({ parallel: true, workers: 4, memberCount: 0 })).toBe(1)
    expect(resolveEffectiveWorkers({ parallel: true, memberCount: 0 })).toBe(1)
  })

  it('resolves the default ceiling for a value the schema would have refused', () => {
    // Defence in depth: inputs the schema refuses resolve to the default worker count.
    expect(resolveEffectiveWorkers({ parallel: true, workers: 0, memberCount: 8 })).toBe(DEFAULT_PARALLEL_WORKERS)
    expect(resolveEffectiveWorkers({ parallel: true, workers: -4, memberCount: 8 })).toBe(DEFAULT_PARALLEL_WORKERS)
    expect(resolveEffectiveWorkers({ parallel: true, workers: Number.NaN, memberCount: 8 })).toBe(DEFAULT_PARALLEL_WORKERS)
    expect(resolveEffectiveWorkers({ parallel: true, workers: Number.POSITIVE_INFINITY, memberCount: 8 }))
      .toBe(DEFAULT_PARALLEL_WORKERS)
  })

  it('floors a fractional worker count rather than handing the pool a fraction', () => {
    expect(resolveEffectiveWorkers({ parallel: true, workers: 2.9, memberCount: 8 })).toBe(2)
  })
})

describe('the source pin: one declaration of the formula', () => {
  it('declares resolveEffectiveWorkers exactly once, in the module that owns the fields', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(import.meta.dirname, '..', 'config', 'use.ts'), 'utf8')

    expect(source.match(/export function resolveEffectiveWorkers/g)).toHaveLength(1)
    // The default lives with the formula and is exported, so no consumer needs to retype a 3.
    expect(source.match(/export const DEFAULT_PARALLEL_WORKERS = 3/g)).toHaveLength(1)
  })
})
