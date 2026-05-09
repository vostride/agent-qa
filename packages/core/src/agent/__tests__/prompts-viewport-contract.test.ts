import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../prompts.js'

describe('rule #9 viewport-space coord-space contract (D-15)', () => {
  const systemPrompt = buildSystemPrompt('web')

  it('rule #9 references [Viewport: WxH] header for coord space', () => {
    expect(systemPrompt).toContain('[Viewport: WxH]')
  })

  it('rule #9 no longer references image-pixel space', () => {
    expect(systemPrompt).not.toContain('image-pixel space')
  })

  it('rule #9 no longer references [Image: WxH]', () => {
    expect(systemPrompt).not.toContain('[Image: WxH]')
  })

  it('preserves worked example x=140, y=220 (from @(100,200 80x40))', () => {
    expect(systemPrompt).toContain('x=140, y=220')
  })
})
