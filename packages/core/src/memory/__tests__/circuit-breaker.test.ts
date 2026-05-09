import { describe, it, expect } from 'vitest'
import { CircuitBreaker } from '../circuit-breaker.js'

describe('CircuitBreaker', () => {
  it('stays closed when no outcomes recorded', () => {
    const cb = new CircuitBreaker()
    expect(cb.isTripped()).toBe(false)
  })

  it('stays closed when failure rate difference is below 15% threshold', () => {
    const cb = new CircuitBreaker()
    // 3 baseline: 2 pass, 1 fail (33% fail rate)
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: false })
    // 3 memory: 2 pass, 1 fail (33% fail rate) — difference = 0%, below 15%
    cb.record({ withMemory: true, passed: true })
    cb.record({ withMemory: true, passed: true })
    cb.record({ withMemory: true, passed: false })
    expect(cb.isTripped()).toBe(false)
  })

  it('trips when memory failure rate exceeds baseline by >15%', () => {
    const cb = new CircuitBreaker()
    // 3 baseline: all pass (0% fail rate)
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    // 3 memory: all fail (100% fail rate) — difference = 100%, above 15%
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    expect(cb.isTripped()).toBe(true)
  })

  it('requires minimum baselineSize baseline runs before evaluating', () => {
    const cb = new CircuitBreaker() // baselineSize=3
    // Only 2 baseline runs (below minimum of 3)
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    // 3 memory runs all fail
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    expect(cb.isTripped()).toBe(false)
  })

  it('requires minimum baselineSize memory runs before evaluating', () => {
    const cb = new CircuitBreaker() // baselineSize=3
    // 3 baseline runs all pass
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    // Only 2 memory runs (below minimum of 3)
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    expect(cb.isTripped()).toBe(false)
  })

  it('window slides and drops oldest entries when exceeding windowSize', () => {
    const cb = new CircuitBreaker({ windowSize: 6 })
    // Fill window: 3 baseline pass, 3 memory fail -> would trip
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    // Not yet tripped since we'll now push old entries out
    // Actually the above should trip. Let's verify a different scenario:
    // Start fresh — push 6 entries that DON'T trip, then slide in entries that change the picture
    const cb2 = new CircuitBreaker({ windowSize: 6, baselineSize: 3 })
    // 3 baseline pass + 3 memory pass = no trip
    cb2.record({ withMemory: false, passed: true })
    cb2.record({ withMemory: false, passed: true })
    cb2.record({ withMemory: false, passed: true })
    cb2.record({ withMemory: true, passed: true })
    cb2.record({ withMemory: true, passed: true })
    cb2.record({ withMemory: true, passed: true })
    expect(cb2.isTripped()).toBe(false)
    // Now add 3 more memory failures — oldest 3 baseline entries slide out
    cb2.record({ withMemory: true, passed: false })
    cb2.record({ withMemory: true, passed: false })
    cb2.record({ withMemory: true, passed: false })
    // Window now has the 3 original memory passes + 3 new memory failures,
    // but baseline count dropped below baselineSize so no evaluation
    expect(cb2.isTripped()).toBe(false)
  })

  it('stays tripped permanently once triggered', () => {
    const cb = new CircuitBreaker()
    // 3 baseline pass, 3 memory fail -> trip
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: false, passed: true })
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    cb.record({ withMemory: true, passed: false })
    expect(cb.isTripped()).toBe(true)
    // Record more passing memory outcomes — should stay tripped
    cb.record({ withMemory: true, passed: true })
    cb.record({ withMemory: true, passed: true })
    cb.record({ withMemory: true, passed: true })
    expect(cb.isTripped()).toBe(true)
  })

  it('respects custom config overrides', () => {
    const cb = new CircuitBreaker({ windowSize: 10, baselineSize: 5, threshold: 0.20 })
    // 4 baseline (below custom baselineSize of 5) — should not evaluate
    for (let i = 0; i < 4; i++) cb.record({ withMemory: false, passed: true })
    for (let i = 0; i < 5; i++) cb.record({ withMemory: true, passed: false })
    expect(cb.isTripped()).toBe(false)
    // Add 5th baseline — now 5 baseline pass (0% fail), 5 memory fail (100% fail) -> diff=100% > 20%
    cb.record({ withMemory: false, passed: true })
    expect(cb.isTripped()).toBe(true)
  })
})
