import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

vi.mock('monaco-editor', () => ({
  languages: {
    CompletionItemKind: {
      Module: 0,
      Value: 1,
      Property: 2,
      Enum: 3,
      EnumMember: 4,
    },
    CompletionItemInsertTextRule: {
      None: 0,
    },
    registerCompletionItemProvider: vi.fn(),
  },
}))

import { LLM_PROVIDER_COMPLETION_VALUES } from '../yaml-completions'

const EXPECTED_PROVIDER_MODES = [
  'openai-compatible',
  'anthropic-compatible',
  'openai-subscription',
  'anthropic-subscription',
  'gemini',
] as const

const completionSource = readFileSync(new URL('../yaml-completions.ts', import.meta.url), 'utf-8')

describe('LLM provider static contract', () => {
  it('yaml completions expose exactly five provider modes', () => {
    expect([...LLM_PROVIDER_COMPLETION_VALUES]).toEqual([...EXPECTED_PROVIDER_MODES])
  })

  it('yaml completions do not expose authMethod or inline apiKey', () => {
    expect(completionSource).not.toMatch(/\bauthMethod\b/)
    expect(completionSource).not.toMatch(/\bapiKey\b/)
  })
})
