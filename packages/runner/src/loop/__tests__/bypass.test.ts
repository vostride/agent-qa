import { describe, expect, it } from 'vitest'

import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import { makeAdapter, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'

import { classifyStep } from '../../cache/classify.js'

interface CacheSpy {
  getCalls: number
  setCalls: number
  get(): Promise<null>
  set(): Promise<void>
  invalidate(): Promise<void>
}

function makeCacheSpy(): CacheSpy {
  return {
    getCalls: 0,
    setCalls: 0,
    async get() {
      this.getCalls += 1
      return null
    },
    async set() {
      this.setCalls += 1
    },
    async invalidate() {},
  }
}

describe('env/secret-set step bypasses the cache', () => {
  it('classifies the set-variable step as non-cacheable', () => {
    const result = classifyStep({ stepText: 'set SESSION token', envSets: ['SESSION'] })
    expect(result.cacheable).toBe(false)
  })

  it('records cacheStatus=bypass and never calls cache get/set for the bypassed step', async () => {
    const cache = makeCacheSpy()
    const ports = {
      adapter: makeAdapter(),
      planner: makePlanner(),
      verifier: makeVerifier(),
      cache: cache as unknown as LoopPorts['cache'],
    } as unknown as LoopPorts

    const result = await executeStep('set SESSION token', ports, makeStepContext({ stepInstruction: 'set SESSION token' }))

    expect(result.evidence?.cacheStatus).toBe('bypass')
    expect(cache.getCalls).toBe(0)
    expect(cache.setCalls).toBe(0)
  })
})
