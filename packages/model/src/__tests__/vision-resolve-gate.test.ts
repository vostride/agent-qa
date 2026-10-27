import { describe, expect, it } from 'vitest'

import { resolveVisionGate } from '../vision/resolve-gate.js'

describe('resolveVisionGate', () => {
  it('allows full image attachment for vision-capable models', () => {
    expect(resolveVisionGate({ vision: true })).toEqual({
      attachImage: true,
      captureMode: 'full',
      promptNote: '',
    })
  })

  it('returns the text-only contract for text-only models', () => {
    const gate = resolveVisionGate({ vision: false })

    expect(gate.attachImage).toBe(false)
    expect(gate.captureMode).toBe('textOnly')
    expect(gate.promptNote).toMatch(/accessibility tree/i)
  })
})
