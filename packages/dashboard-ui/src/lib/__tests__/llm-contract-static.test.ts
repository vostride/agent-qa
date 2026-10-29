import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import type { LLMProviderMetadata } from '../api'

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
// The model workspace: the add row and the saved row.
const MODEL_WORKSPACE_FILES = ['add-model-row.tsx', 'model-row.tsx'] as const
const modelWorkspaceSources = MODEL_WORKSPACE_FILES.map((file) =>
  readFileSync(new URL(`../../components/config-manager/${file}`, import.meta.url), 'utf-8'),
)
const modelWorkspaceSource = modelWorkspaceSources.join('\n')
const DELETED_MODAL = new URL('../../components/config-manager/llm-section.tsx', import.meta.url)

describe('LLM provider static contract', () => {
  it('yaml completions expose exactly five provider modes', () => {
    expect([...LLM_PROVIDER_COMPLETION_VALUES]).toEqual([...EXPECTED_PROVIDER_MODES])
  })

  it('yaml completions do not expose authMethod or inline apiKey', () => {
    expect(completionSource).not.toMatch(/\bauthMethod\b/)
    expect(completionSource).not.toMatch(/\bapiKey\b/)
  })

  it('accepts descriptor metadata fields from the provider endpoint', () => {
    const provider: LLMProviderMetadata = {
      id: 'plugin-compatible',
      label: 'Plugin compatible',
      auth: { kind: 'api-key', credentialTypes: ['api-key', 'bearer-token'], optional: true },
      modelAdapter: 'openai-responses',
      needsBaseURL: true,
      authModes: ['api-key', 'bearer-token'],
      subscription: false,
      baseURLPlaceholder: 'https://plugin.example/v1',
      defaultModel: 'plugin-model',
    }

    expect(provider.needsBaseURL).toBe(true)
    expect(provider.authModes).toEqual(['api-key', 'bearer-token'])
    expect(provider.baseURLPlaceholder).toBe('https://plugin.example/v1')
  })

  it('config UI branches on provider metadata instead of a compatible-provider literal set', () => {
    const modelPackageImport = '@vostride/' + 'agent-qa-model'

    expect(modelWorkspaceSource).not.toMatch(/COMPATIBLE_PROVIDERS\s*=\s*new Set/)
    expect(modelWorkspaceSource).toContain('metadata.needsBaseURL === true')
    expect(modelWorkspaceSource).toContain('facts?.needsBaseURL === true')
    expect(modelWorkspaceSource).toContain('?.baseURLPlaceholder}')
    expect(modelWorkspaceSource).not.toContain(modelPackageImport)
  })

  it('offline fallback marks compatible providers as needing a base URL', () => {
    expect(modelWorkspaceSource).toMatch(/const compatible = id === "openai-compatible" \|\| id === "anthropic-compatible"/)
    expect(modelWorkspaceSource).toMatch(/needsBaseURL = metadata \? metadata\.needsBaseURL === true : compatible/)
    // The placeholder comes from the provider endpoint only; the modal's hard-coded offline placeholders are gone.
    expect(modelWorkspaceSource).not.toContain('https://openrouter.ai/api/v1')
    expect(modelWorkspaceSource).not.toContain('https://anthropic-proxy.example/messages')
  })

  it('LLM-CONTRACT-ON-NEW-FILES: the contract cells read the add row and the saved row', () => {
    expect(modelWorkspaceSources).toHaveLength(MODEL_WORKSPACE_FILES.length)
    const [addRow, savedRow] = modelWorkspaceSources
    expect(addRow).toContain('export function AddModelRow(')
    expect(savedRow).toContain('export function ModelRow(')
    expect(savedRow).toContain('export function providerFacts(')
  })

  it('LLM-MODAL-GONE: the model modal file is deleted', () => {
    expect(existsSync(DELETED_MODAL)).toBe(false)
  })
})
