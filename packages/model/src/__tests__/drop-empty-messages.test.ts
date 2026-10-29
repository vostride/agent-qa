// Phase 364 RUNX-01 defense-in-depth — dropEmptyMessagesMiddleware strips empty-content
// messages from `params.prompt` just before the provider wire, so even if a caller
// reintroduces a `{ role:'system', content:'' }` message it can never reach the OpenAI
// Responses API (which rejects empty message content with HTTP 400). This is the second
// layer behind the runner-side assembly filter (planner-system-tiers).
//
// RED BY DESIGN: the middleware module does not exist until the fix lands. The failing
// reason must be the missing export, not a fixture typo.
import { describe, it, expect } from 'vitest'
import type { LanguageModelV3Prompt } from '@ai-sdk/provider'
import { dropEmptyMessagesMiddleware } from '../index.js'

async function transform(prompt: LanguageModelV3Prompt, extra: Record<string, unknown> = {}) {
  const mw = dropEmptyMessagesMiddleware()
  const result = await mw.transformParams!({
    type: 'generate',
    params: { prompt, ...extra } as never,
    model: {} as never,
  })
  return result as unknown as { prompt: LanguageModelV3Prompt } & Record<string, unknown>
}

describe('dropEmptyMessagesMiddleware — empty-content stripping', () => {
  it('drops a system message whose content is an empty string', async () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: '' },
      { role: 'system', content: 'You are a helpful agent.' },
    ]
    const result = await transform(prompt)
    expect(result.prompt).toHaveLength(1)
    expect(result.prompt[0]).toEqual({ role: 'system', content: 'You are a helpful agent.' })
  })

  it('drops a whitespace-only system message', async () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: '   \n ' },
      { role: 'system', content: 'stable tier' },
    ]
    const result = await transform(prompt)
    expect(result.prompt).toHaveLength(1)
    expect(result.prompt[0]).toEqual({ role: 'system', content: 'stable tier' })
  })

  it('retains non-empty system and user/assistant text messages, in order', async () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'identity' },
      { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    const result = await transform(prompt)
    expect(result.prompt).toEqual(prompt)
  })

  it('retains a user message that carries a non-text (image/file) part even if its text is empty', async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'file', data: 'aGVsbG8=', mediaType: 'image/png' },
        ],
      },
    ]
    const result = await transform(prompt)
    expect(result.prompt).toHaveLength(1)
    expect(result.prompt[0]).toEqual(prompt[0])
  })

  it('drops a user/assistant message whose only parts are empty text', async () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: '   ' }] },
      { role: 'user', content: [{ type: 'text', text: 'real content' }] },
    ]
    const result = await transform(prompt)
    expect(result.prompt).toHaveLength(1)
    expect(result.prompt[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'real content' }] })
  })

  it('returns the prompt unchanged (same messages, same order) when nothing is empty', async () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ]
    const result = await transform(prompt)
    expect(result.prompt).toEqual(prompt)
  })

  it('passes every other param field through untouched', async () => {
    const prompt: LanguageModelV3Prompt = [{ role: 'system', content: 'keep' }]
    const tools = [{ type: 'function', name: 'click', inputSchema: {} }]
    const result = await transform(prompt, { tools, temperature: 0.5, toolChoice: { type: 'required' } })
    expect(result.tools).toEqual(tools)
    expect(result.temperature).toBe(0.5)
    expect(result.toolChoice).toEqual({ type: 'required' })
  })
})
