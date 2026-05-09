import { describe, expect, it } from 'vitest'
import { normalizePointerActionForStep } from '../pointer-action-normalization.js'

describe('normalizePointerActionForStep', () => {
  it('removes accidental top-left relativePosition and zero clickDelay from plain doubleClick', () => {
    const result = normalizePointerActionForStep(
      { type: 'doubleClick', ref: 'e21', relativePosition: { x: 0, y: 0 }, clickDelay: 0 },
      'Double-click the "Double Click Me" button',
    )

    expect(result).toEqual({ type: 'doubleClick', ref: 'e21' })
  })

  it('removes accidental top-left relativePosition and zero clickDelay from plain rightClick', () => {
    const result = normalizePointerActionForStep(
      { type: 'rightClick', ref: 'e22', relativePosition: { x: 0, y: 0 }, clickDelay: 0 },
      'Right-click the "Right Click Me" button',
    )

    expect(result).toEqual({ type: 'rightClick', ref: 'e22' })
  })

  it('preserves explicit non-zero relativePosition offsets', () => {
    const result = normalizePointerActionForStep(
      { type: 'doubleClick', ref: 'e21', relativePosition: { x: 50, y: 20 } },
      'Double-click the button at an offset of 50 pixels right and 20 pixels down from its top-left corner',
    )

    expect(result).toEqual({ type: 'doubleClick', ref: 'e21', relativePosition: { x: 50, y: 20 } })
  })

  it('preserves explicit top-left relativePosition intent', () => {
    const result = normalizePointerActionForStep(
      { type: 'doubleClick', ref: 'e21', relativePosition: { x: 0, y: 0 }, clickDelay: 0 },
      'Double-click the button at top-left',
    )

    expect(result).toEqual({ type: 'doubleClick', ref: 'e21', relativePosition: { x: 0, y: 0 } })
  })

  it('preserves explicit zero-offset relativePosition intent', () => {
    const result = normalizePointerActionForStep(
      { type: 'doubleClick', ref: 'e21', relativePosition: { x: 0, y: 0 }, clickDelay: 0 },
      'Double-click the button with zero-offset',
    )

    expect(result).toEqual({ type: 'doubleClick', ref: 'e21', relativePosition: { x: 0, y: 0 } })
  })

  it('preserves non-zero clickDelay values', () => {
    const result = normalizePointerActionForStep(
      { type: 'doubleClick', ref: 'e21', clickDelay: 250 },
      'Double-click the "Double Click Me" button',
    )

    expect(result).toEqual({ type: 'doubleClick', ref: 'e21', clickDelay: 250 })
  })

  it('does not normalize non-pointer actions', () => {
    const action = { type: 'click' as const, ref: 'e21', clickDelay: 0 }
    const result = normalizePointerActionForStep(action, 'Click the button')

    expect(result).toBe(action)
  })
})
