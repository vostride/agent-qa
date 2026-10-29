import { describe, expect, it } from 'vitest'

import {
  ADD_MODEL_DRAFT_STORAGE_PREFIX,
  clearAddModelDraft,
  readAddModelDraft,
  suggestModelName,
  writeAddModelDraft,
} from '../add-model-draft'

const CONFIG_PATH = '/work/agent-qa.config.yaml'
const STORAGE_KEY = `${ADD_MODEL_DRAFT_STORAGE_PREFIX}${CONFIG_PATH}`

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

describe('suggestModelName', () => {
  it('SUGGEST-MODEL-NAME: lowercases, turns runs outside [a-z0-9.-] into a hyphen and trims a leading hyphen or dot', () => {
    expect(suggestModelName('gpt-5.6')).toBe('gpt-5.6')
    expect(suggestModelName('models/gemini-2.5-pro')).toBe('models-gemini-2.5-pro')
    expect(suggestModelName('Claude Sonnet 4.5')).toBe('claude-sonnet-4.5')
    expect(suggestModelName('.hidden')).toBe('hidden')
    expect(suggestModelName('  //Mixed__Case  ')).toBe('mixed-case-')
    expect(suggestModelName('')).toBe('')
  })
})

describe('the add-row draft store', () => {
  it('ADD-DRAFT-NEVER-HOLDS-SECRETS: only the listed non-secret fields are stored, whatever else the draft carries', () => {
    const storage = memoryStorage()
    const draft = {
      choice: 'anthropic-compatible-key',
      baseURL: 'https://llm.example.com/v1',
      model: 'claude-sonnet-4.5',
      name: 'claude-sonnet-4.5',
      nameEdited: false,
      keyType: 'bearer-token',
      headerNames: ['X-Team'],
      createdCredential: false,
      key: 'sk-typed-secret',
      token: 'tok-typed-secret',
      code: 'sign-in-code-secret',
      headerValues: { 'X-Team': 'header-secret' },
      headers: { 'X-Team': 'header-secret' },
    } as unknown as Parameters<typeof writeAddModelDraft>[1]
    writeAddModelDraft(CONFIG_PATH, draft, storage)
    const stored = storage.items.get(STORAGE_KEY)
    expect(stored).toBeDefined()
    for (const secret of ['sk-typed-secret', 'tok-typed-secret', 'sign-in-code-secret', 'header-secret']) {
      expect(stored).not.toContain(secret)
    }
    expect(Object.keys(JSON.parse(stored!)).sort()).toEqual(
      ['baseURL', 'choice', 'createdCredential', 'headerNames', 'keyType', 'model', 'name', 'nameEdited'].sort(),
    )
    expect(readAddModelDraft(CONFIG_PATH, storage)).toEqual({
      choice: 'anthropic-compatible-key',
      baseURL: 'https://llm.example.com/v1',
      model: 'claude-sonnet-4.5',
      name: 'claude-sonnet-4.5',
      nameEdited: false,
      keyType: 'bearer-token',
      headerNames: ['X-Team'],
      createdCredential: false,
    })
  })

  it('ADD-DRAFT-NEVER-HOLDS-SECRETS: a secret planted in storage never reads back, and an off-shape value reads as none', () => {
    const storage = memoryStorage()
    storage.setItem(STORAGE_KEY, JSON.stringify({ choice: 'gemini-key', model: 'gemini-2.5-pro', key: 'planted-secret' }))
    const read = readAddModelDraft(CONFIG_PATH, storage)
    expect(read).toEqual({ choice: 'gemini-key', model: 'gemini-2.5-pro' })
    expect(JSON.stringify(read)).not.toContain('planted-secret')

    for (const offShape of [
      'not json',
      JSON.stringify(null),
      JSON.stringify(['gemini-key']),
      JSON.stringify({ choice: 'not-a-choice' }),
      JSON.stringify({ choice: 'gemini-key', model: 42 }),
      JSON.stringify({ choice: 'gemini-key', nameEdited: 'yes' }),
      JSON.stringify({ choice: 'anthropic-compatible-key', keyType: 'password' }),
      JSON.stringify({ choice: 'anthropic-compatible-key', headerNames: ['X-Team', 7] }),
      JSON.stringify({ choice: 'gemini-key', createdCredential: 'true' }),
    ]) {
      storage.setItem(STORAGE_KEY, offShape)
      expect(readAddModelDraft(CONFIG_PATH, storage)).toBeUndefined()
    }
  })

  it('keys the draft by config file path, clears it, and survives storage that throws', () => {
    const storage = memoryStorage()
    writeAddModelDraft(CONFIG_PATH, { choice: 'gemini-key', model: 'gemini-2.5-pro' }, storage)
    expect(readAddModelDraft('/other/agent-qa.config.yaml', storage)).toBeUndefined()
    clearAddModelDraft(CONFIG_PATH, storage)
    expect(storage.items.has(STORAGE_KEY)).toBe(false)
    expect(readAddModelDraft(CONFIG_PATH, storage)).toBeUndefined()

    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(readAddModelDraft(CONFIG_PATH, throwing)).toBeUndefined()
    expect(() => writeAddModelDraft(CONFIG_PATH, { choice: 'gemini-key' }, throwing)).not.toThrow()
    expect(() => clearAddModelDraft(CONFIG_PATH, throwing)).not.toThrow()
  })
})
