import { describe, it, expect } from 'vitest'
import { computeSwipe, computePinch, computeFingerPositions } from '../gestures.js'

describe('computeSwipe', () => {
  it('computes correct swipe up coordinates', () => {
    const result = computeSwipe(200, 400, 'up', 300)
    expect(result.startX).toBe(200)
    expect(result.startY).toBe(550)
    expect(result.endX).toBe(200)
    expect(result.endY).toBe(250)
  })

  it('computes correct swipe down coordinates', () => {
    const result = computeSwipe(200, 400, 'down', 300)
    expect(result.startX).toBe(200)
    expect(result.startY).toBe(250)
    expect(result.endX).toBe(200)
    expect(result.endY).toBe(550)
  })

  it('computes correct swipe left coordinates', () => {
    const result = computeSwipe(200, 400, 'left', 300)
    expect(result.startX).toBe(350)
    expect(result.startY).toBe(400)
    expect(result.endX).toBe(50)
    expect(result.endY).toBe(400)
  })

  it('computes correct swipe right coordinates', () => {
    const result = computeSwipe(200, 400, 'right', 300)
    expect(result.startX).toBe(50)
    expect(result.startY).toBe(400)
    expect(result.endX).toBe(350)
    expect(result.endY).toBe(400)
  })
})

describe('computePinch', () => {
  it('zoom in (scale=2.0): fingers end farther apart than start', () => {
    const result = computePinch(200, 300, 2.0)
    // Default startDistance = 100, half = 50
    // Start: finger1 at (150, 300), finger2 at (250, 300)
    expect(result.finger1Start).toEqual({ x: 150, y: 300 })
    expect(result.finger2Start).toEqual({ x: 250, y: 300 })
    // End: halfEnd = (100 * 2) / 2 = 100
    // finger1 at (100, 300), finger2 at (300, 300)
    expect(result.finger1End).toEqual({ x: 100, y: 300 })
    expect(result.finger2End).toEqual({ x: 300, y: 300 })
  })

  it('zoom out (scale=0.5): fingers end closer together than start', () => {
    const result = computePinch(200, 300, 0.5)
    // Start: halfStart = 50 → (150, 300) and (250, 300)
    expect(result.finger1Start).toEqual({ x: 150, y: 300 })
    expect(result.finger2Start).toEqual({ x: 250, y: 300 })
    // End: halfEnd = (100 * 0.5) / 2 = 25
    expect(result.finger1End).toEqual({ x: 175, y: 300 })
    expect(result.finger2End).toEqual({ x: 225, y: 300 })
  })

  it('scale=1.0: no change in finger positions', () => {
    const result = computePinch(200, 300, 1.0)
    expect(result.finger1Start).toEqual(result.finger1End)
    expect(result.finger2Start).toEqual(result.finger2End)
  })

  it('custom startDistance changes proportionally', () => {
    const result = computePinch(200, 300, 2.0, 200)
    // halfStart = 100, halfEnd = 200
    expect(result.finger1Start).toEqual({ x: 100, y: 300 })
    expect(result.finger2Start).toEqual({ x: 300, y: 300 })
    expect(result.finger1End).toEqual({ x: 0, y: 300 })
    expect(result.finger2End).toEqual({ x: 400, y: 300 })
  })
})

describe('computeFingerPositions', () => {
  it('fingers=2: returns exactly 2 positions spaced horizontally', () => {
    const positions = computeFingerPositions(200, 300, 2)
    expect(positions).toHaveLength(2)
    // Default spacing = 40, half = 20
    expect(positions[0]).toEqual({ x: 180, y: 300 })
    expect(positions[1]).toEqual({ x: 220, y: 300 })
  })

  it('fingers=3: returns exactly 3 positions in triangle arrangement', () => {
    const positions = computeFingerPositions(200, 300, 3)
    expect(positions).toHaveLength(3)
    // Top center, bottom-left, bottom-right
    expect(positions[0]).toEqual({ x: 200, y: 280 })
    expect(positions[1]).toEqual({ x: 180, y: 320 })
    expect(positions[2]).toEqual({ x: 220, y: 320 })
  })

  it('positions are centered around the given center point', () => {
    const positions2 = computeFingerPositions(100, 100, 2)
    const avgX = positions2.reduce((s, p) => s + p.x, 0) / positions2.length
    expect(avgX).toBe(100)

    const positions3 = computeFingerPositions(100, 100, 3)
    const avgX3 = positions3.reduce((s, p) => s + p.x, 0) / positions3.length
    expect(avgX3).toBeCloseTo(100, 5)
  })

  it('custom spacing changes finger distance', () => {
    const positions = computeFingerPositions(200, 300, 2, 80)
    expect(positions[0]).toEqual({ x: 160, y: 300 })
    expect(positions[1]).toEqual({ x: 240, y: 300 })
  })
})
