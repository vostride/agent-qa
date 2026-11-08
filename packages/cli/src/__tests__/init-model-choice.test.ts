// Checks the model question's options, the entry each pick writes, its name and the pre-selection.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAuthPath, listSavedCredentials, type SavedCredential } from '@vostride/agent-qa-core'
import {
  INIT_MODEL_CHOICES,
  initModelOptions,
  type InitModelOption,
} from '../commands/init-model-choice.js'
import { cleanupTempProjects, tempProject } from './project-fixtures.js'

const DUMMY_TOKEN = 'DUMMY-TOKEN-A'
const DUMMY_KEY = 'DUMMY-KEY-B'

const oauthTokens = { access: DUMMY_TOKEN, refresh: DUMMY_TOKEN, expires: 0 }

const FIXTURE_STORE = {
  'claude-code': { type: 'oauth', provider: 'anthropic-subscription', tokens: oauthTokens },
  work: { type: 'api', provider: 'openai-compatible', key: DUMMY_KEY },
  g: { type: 'api', provider: 'gemini', key: DUMMY_KEY },
  'a b': { type: 'oauth', provider: 'anthropic-subscription', tokens: oauthTokens },
  other: { type: 'api', provider: 'some-unknown-provider', key: DUMMY_KEY },
}

function writeStore(home: string, store: Record<string, unknown>): string {
  const path = getAuthPath({ env: {}, homeDir: home })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store), 'utf-8')
  return path
}

async function savedFrom(store: Record<string, unknown>): Promise<SavedCredential[]> {
  const { home } = tempProject('init-model-choice')
  return listSavedCredentials(writeStore(home, store))
}

function newChoiceRows(options: InitModelOption[]): Array<[string, string, string]> {
  return options.flatMap((option) =>
    option.value.kind === 'new' ? [[option.value.choice, option.label, option.hint]] : [],
  )
}

afterEach(() => {
  cleanupTempProjects()
})

describe('model question options', () => {
  it('lists saved credentials first by name and kind, then the seven new choices', async () => {
    const options = initModelOptions(await savedFrom(FIXTURE_STORE))

    expect(options.slice(0, 3).map((option) => [option.value, option.hint])).toEqual([
      [
        { kind: 'saved', name: 'claude-code', provider: 'anthropic-subscription', type: 'oauth' },
        'saved · signed in',
      ],
      [{ kind: 'saved', name: 'g', provider: 'gemini', type: 'api' }, 'saved · key saved'],
      [
        { kind: 'saved', name: 'work', provider: 'openai-compatible', type: 'api' },
        'saved · key saved',
      ],
    ])
    expect(options[0]?.label).toContain('claude-code')
    expect(options[2]?.label).toContain('work')
    expect(options.slice(3).map((option) => option.value)).toEqual(
      INIT_MODEL_CHOICES.map((choice) => ({ kind: 'new', choice })),
    )
  })

  it('leaves out a stored name that fails the name rule and a provider outside the table', async () => {
    const options = initModelOptions(await savedFrom(FIXTURE_STORE))
    const savedNames = options.flatMap((option) =>
      option.value.kind === 'saved' ? [option.value.name] : [],
    )
    expect(savedNames).not.toContain('a b')
    expect(savedNames).not.toContain('other')
  })

  it('carries no secret from the store into any option', async () => {
    const text = JSON.stringify(initModelOptions(await savedFrom(FIXTURE_STORE)))
    expect(text).not.toContain(DUMMY_TOKEN)
    expect(text).not.toContain(DUMMY_KEY)
  })

  it('maps a saved ChatGPT sign-in to the OpenAI subscription and marks a token as saved', async () => {
    const options = initModelOptions(
      await savedFrom({
        codex: { type: 'oauth', provider: 'openai-subscription-oauth', tokens: oauthTokens },
        proxy: { type: 'bearer', provider: 'anthropic-compatible', token: DUMMY_TOKEN },
      }),
    )
    expect(options.slice(0, 2).map((option) => [option.value, option.hint])).toEqual([
      [
        { kind: 'saved', name: 'codex', provider: 'openai-subscription', type: 'oauth' },
        'saved · signed in',
      ],
      [
        { kind: 'saved', name: 'proxy', provider: 'anthropic-compatible', type: 'bearer' },
        'saved · token saved',
      ],
    ])
  })

  it('labels the seven new choices with what each sets up', () => {
    expect(newChoiceRows(initModelOptions([]))).toEqual([
      ['claude-code', 'Claude subscription (Claude Code)', 'sign in now'],
      ['codex', 'ChatGPT subscription (Codex)', 'sign in now'],
      ['anthropic', 'Anthropic API', 'key in the dashboard'],
      ['openai', 'OpenAI API', 'key in the dashboard'],
      ['gemini', 'Gemini API', 'key in the dashboard'],
      ['openai-compatible', 'OpenAI-compatible endpoint', 'set up in the dashboard'],
      ['anthropic-compatible', 'Anthropic-compatible endpoint', 'set up in the dashboard'],
    ])
  })
})
