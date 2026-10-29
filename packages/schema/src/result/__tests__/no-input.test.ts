// 2026-10-08 (437-03, D-05): the one reader of a skipped tap's no-input block, shared by the
// runner and the dashboard.
import { describe, expect, it } from 'vitest'

import { actionDidNotFail, readIdempotentNoopMeta } from '../../index'

const withNoop = (idempotentNoop: unknown) => ({ metadata: { idempotentNoop } })

describe('the no-input-sent block reader', () => {
  it('reads the block that marks no input sent', () => {
    expect(readIdempotentNoopMeta(withNoop({ currentState: 'checked', inputSent: false }))).toEqual({
      currentState: 'checked',
      inputSent: false,
    })
  })

  it('reads an older block that carries only the current state', () => {
    expect(readIdempotentNoopMeta(withNoop({ currentState: 'checked' }))).toEqual({
      currentState: 'checked',
    })
  })

  it('returns undefined for a missing block', () => {
    expect(readIdempotentNoopMeta(undefined)).toBeUndefined()
    expect(readIdempotentNoopMeta({})).toBeUndefined()
    expect(readIdempotentNoopMeta({ metadata: {} })).toBeUndefined()
    expect(readIdempotentNoopMeta(withNoop(null))).toBeUndefined()
    expect(readIdempotentNoopMeta(withNoop('checked'))).toBeUndefined()
  })

  it('returns undefined for a current state that is not a string', () => {
    expect(readIdempotentNoopMeta(withNoop({ currentState: true, inputSent: false }))).toBeUndefined()
    expect(readIdempotentNoopMeta(withNoop({ currentState: 1 }))).toBeUndefined()
  })

  it('returns undefined when the block says input was sent', () => {
    expect(readIdempotentNoopMeta(withNoop({ currentState: 'checked', inputSent: true }))).toBeUndefined()
    expect(readIdempotentNoopMeta(withNoop({ currentState: 'checked', inputSent: 'no' }))).toBeUndefined()
  })

  it('actionDidNotFail is true for a success and for a skipped tap', () => {
    expect(actionDidNotFail({ success: true })).toBe(true)
    expect(
      actionDidNotFail({
        success: false,
        metadata: { idempotentNoop: { currentState: 'checked', inputSent: false } },
      }),
    ).toBe(true)
    expect(
      actionDidNotFail({
        success: true,
        metadata: { idempotentNoop: { currentState: 'checked' } },
      }),
    ).toBe(true)
  })

  it('actionDidNotFail is false for a real failure', () => {
    const failed = { success: false, error: 'x' }
    expect(actionDidNotFail(failed)).toBe(false)
    expect(actionDidNotFail({ success: false })).toBe(false)
    expect(actionDidNotFail(undefined)).toBe(false)
    expect(
      actionDidNotFail({
        success: false,
        metadata: { idempotentNoop: { currentState: 'checked', inputSent: true } },
      }),
    ).toBe(false)
  })
})
