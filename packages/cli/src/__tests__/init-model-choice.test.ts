// Checks the model question's sections, the entry each pick writes, its name and the pre-selection.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLLMAuthProviderPlugins,
  clearLoadedLLMAuthPluginModules,
  getAgentQaVersion,
  getAuthPath,
  listSavedCredentials,
  type SavedCredential,
} from '@vostride/agent-qa-core'
import { getProvider } from '@vostride/agent-qa-model'
import { CliRefusal } from '../composition/cli-refusal.js'
import {
  INIT_MODEL_CHOICES,
  SAVED_PROVIDER_TO_CONFIG,
  initModelSections,
  modelEntryFor,
  modelStatus,
  preselectedModel,
  resolveLlmFlag,
  type InitModelChoice,
  type InitModelFlags,
  type InitModelPick,
} from '../commands/init-model-choice.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from '../commands/scaffold-content.js'
import { cleanupTempProjects, tempProject, writeInstalledPackage } from './project-fixtures.js'

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

// The saved section's options; a store with nothing listed gives the new choices alone.
function savedOptions(saved: readonly SavedCredential[]) {
  return initModelSections(saved)
    .slice(1)
    .flatMap((section) => section.options)
}

afterEach(() => {
  vi.restoreAllMocks()
  clearLLMAuthProviderPlugins()
  clearLoadedLLMAuthPluginModules()
  cleanupTempProjects()
})

describe('model question sections', () => {
  it('lists the seven new choices under their heading first, then the saved credentials', async () => {
    const sections = initModelSections(
      await savedFrom({
        'claude-code': FIXTURE_STORE['claude-code'],
        work: FIXTURE_STORE.work,
      }),
    )

    expect(sections.map((section) => section.heading)).toEqual([
      'Connect a new model',
      'Saved on this machine (2)',
    ])
    expect(sections[0]?.options.map((option) => option.value)).toEqual(
      INIT_MODEL_CHOICES.map((choice) => ({ kind: 'new', choice })),
    )
    expect(sections[1]?.options.map((option) => [option.value, option.status])).toEqual([
      [
        { kind: 'saved', name: 'claude-code', provider: 'anthropic-subscription', type: 'oauth' },
        'signed in',
      ],
      [{ kind: 'saved', name: 'work', provider: 'openai-compatible', type: 'api' }, 'key saved'],
    ])
    expect(sections[1]?.options[0]?.label).toContain('claude-code (')
    expect(sections[1]?.options[1]?.label).toContain('work (')
  })

  it('gives the new choices alone when nothing is saved', () => {
    expect(initModelSections([]).map((section) => section.heading)).toEqual(['Connect a new model'])
  })

  it('leaves out a stored name that fails the name rule and a provider outside the table', async () => {
    const sections = initModelSections(await savedFrom(FIXTURE_STORE))
    const savedNames = sections.flatMap((section) =>
      section.options.flatMap((option) =>
        option.value.kind === 'saved' ? [option.value.name] : [],
      ),
    )
    expect(savedNames).toEqual(['claude-code', 'g', 'work'])
    expect(sections[1]?.heading).toBe('Saved on this machine (3)')
  })

  it('carries no secret from the store into any section', async () => {
    const text = JSON.stringify(initModelSections(await savedFrom(FIXTURE_STORE)))
    expect(text).not.toContain(DUMMY_TOKEN)
    expect(text).not.toContain(DUMMY_KEY)
  })

  it('maps a saved ChatGPT sign-in to the OpenAI subscription and marks a token as saved', async () => {
    const options = savedOptions(
      await savedFrom({
        codex: { type: 'oauth', provider: 'openai-subscription-oauth', tokens: oauthTokens },
        proxy: { type: 'bearer', provider: 'anthropic-compatible', token: DUMMY_TOKEN },
      }),
    )
    expect(options.map((option) => [option.value, option.status])).toEqual([
      [
        { kind: 'saved', name: 'codex', provider: 'openai-subscription', type: 'oauth' },
        'signed in',
      ],
      [
        { kind: 'saved', name: 'proxy', provider: 'anthropic-compatible', type: 'bearer' },
        'token saved',
      ],
    ])
  })

  it('lists saved credentials by the new choice each acts as, then by name', async () => {
    const sections = initModelSections(
      await savedFrom({
        proxy: { type: 'api', provider: 'anthropic-compatible', key: DUMMY_KEY },
        z: { type: 'api', provider: 'gemini', key: DUMMY_KEY },
        chat: { type: 'oauth', provider: 'openai-subscription-oauth', tokens: oauthTokens },
        a: { type: 'api', provider: 'gemini', key: DUMMY_KEY },
        work: { type: 'api', provider: 'openai-compatible', key: DUMMY_KEY },
        claude: { type: 'oauth', provider: 'anthropic-subscription', tokens: oauthTokens },
      }),
    )

    expect(sections[1]?.heading).toBe('Saved on this machine (6)')
    expect(
      sections[1]?.options.map((option) =>
        option.value.kind === 'saved' ? [option.value.name, option.value.provider] : [],
      ),
    ).toEqual([
      ['claude', 'anthropic-subscription'],
      ['chat', 'openai-subscription'],
      ['a', 'gemini'],
      ['z', 'gemini'],
      ['work', 'openai-compatible'],
      ['proxy', 'anthropic-compatible'],
    ])
  })

  it('gives the new choices alone when nothing saved can be listed', async () => {
    const sections = initModelSections(
      await savedFrom({
        other: FIXTURE_STORE.other,
        'a b': FIXTURE_STORE['a b'],
      }),
    )
    expect(sections.map((section) => section.heading)).toEqual(['Connect a new model'])
  })

  it('labels the seven new choices and gives each its status', () => {
    const [newChoices] = initModelSections([])
    expect(
      newChoices?.options.map((option) => [
        option.value.kind === 'new' ? option.value.choice : option.value.name,
        option.label,
        option.status,
      ]),
    ).toEqual([
      ['claude-code', 'Claude subscription (Claude Code)', 'sign in after setup'],
      ['codex', 'ChatGPT subscription (Codex)', 'sign in after setup'],
      ['anthropic', 'Anthropic API', 'key in the dashboard'],
      ['openai', 'OpenAI API', 'key in the dashboard'],
      ['gemini', 'Gemini API', 'key in the dashboard'],
      ['openai-compatible', 'OpenAI-compatible endpoint', 'set up in the dashboard'],
      ['anthropic-compatible', 'Anthropic-compatible endpoint', 'set up in the dashboard'],
    ])
  })
})

function defaultModel(provider: string): string {
  const model = getProvider(provider)?.defaultModel
  if (model === undefined) throw new Error(`no default model for ${provider}`)
  return model
}

function newPick(choice: InitModelChoice): InitModelPick {
  return { kind: 'new', choice }
}

function refusalFrom(run: () => unknown): CliRefusal {
  try {
    run()
  } catch (error) {
    if (error instanceof CliRefusal) return error
    throw error
  }
  throw new Error('expected a refusal')
}

const api = (name: string, provider: string): SavedCredential => ({ name, type: 'api', provider })
const oauth = (name: string, provider: string): SavedCredential => ({
  name,
  type: 'oauth',
  provider,
})

describe('the entry each new choice writes', () => {
  it.each([
    [
      'claude-code',
      { name: 'claude-code', provider: 'anthropic-subscription', model: 'anthropic-subscription' },
    ],
    ['codex', { name: 'codex', provider: 'openai-subscription', model: 'openai-subscription' }],
    [
      'anthropic',
      {
        name: 'anthropic',
        provider: 'anthropic-compatible',
        model: 'anthropic-compatible',
        baseURL: 'https://api.anthropic.com/v1',
      },
    ],
    [
      'openai',
      {
        name: 'openai',
        provider: 'openai-compatible',
        model: 'openai-compatible',
        baseURL: 'https://api.openai.com/v1',
      },
    ],
    ['gemini', { name: 'gemini', provider: 'gemini', model: 'gemini' }],
  ] as const)('%s writes its provider with the default model', (choice, expected) => {
    expect(modelEntryFor(newPick(choice), { saved: [] })).toEqual({
      entry: { ...expected, model: defaultModel(expected.model) },
    })
  })

  it.each([
    ['openai-compatible', 'openai-compatible-key'],
    ['anthropic-compatible', 'anthropic-compatible-key'],
  ] as const)('%s with no flags writes no entry and opens the dashboard', (choice, add) => {
    expect(modelEntryFor(newPick(choice), { saved: [] })).toEqual({ dashboard: { add } })
  })

  it('an endpoint given both --base-url and --model writes a complete entry', () => {
    expect(
      modelEntryFor(newPick('openai-compatible'), {
        baseUrl: 'https://llm.local/v1',
        model: 'm',
        saved: [],
      }),
    ).toEqual({
      entry: {
        name: 'openai-compatible',
        provider: 'openai-compatible',
        model: 'm',
        baseURL: 'https://llm.local/v1',
      },
    })
  })

  it('an endpoint given only one of --base-url and --model is refused with exit 2 naming the other', () => {
    const noBaseUrl = refusalFrom(() =>
      modelEntryFor(newPick('anthropic-compatible'), { model: 'm', saved: [] }),
    )
    expect(noBaseUrl).toMatchObject({
      exitCode: 2,
      message:
        '--base-url is missing: an endpoint takes --base-url and --model together, ' +
        'or neither to set it up in the dashboard',
    })
    const noModel = refusalFrom(() =>
      modelEntryFor(newPick('openai-compatible'), { baseUrl: 'https://llm.local/v1', saved: [] }),
    )
    expect(noModel).toMatchObject({ exitCode: 2 })
    expect(noModel.message).toMatch(/^--model is missing: /u)
  })

  it('a saved compatible key given only --model is refused the same way', () => {
    const saved = [api('work', 'openai-compatible')]
    const refusal = refusalFrom(() =>
      modelEntryFor(resolveLlmFlag('work', saved), { model: 'm', saved }),
    )
    expect(refusal.exitCode).toBe(2)
    expect(refusal.message).toMatch(/^--base-url is missing: /u)
  })

  it('--model and --base-url override an API choice', () => {
    expect(
      modelEntryFor(newPick('openai'), {
        model: 'gpt-x',
        baseUrl: 'https://proxy.local/v1',
        saved: [],
      }),
    ).toEqual({
      entry: {
        name: 'openai',
        provider: 'openai-compatible',
        model: 'gpt-x',
        baseURL: 'https://proxy.local/v1',
      },
    })
  })
})

describe('the entry a saved credential writes', () => {
  it('a saved Claude sign-in writes an entry under its name with the default model', () => {
    const saved = [oauth('claude-code', 'anthropic-subscription')]
    const [pick] = savedOptions(saved)
    expect(modelEntryFor(pick!.value, { saved })).toEqual({
      entry: {
        name: 'claude-code',
        provider: 'anthropic-subscription',
        model: defaultModel('anthropic-subscription'),
      },
    })
  })

  it('a saved ChatGPT sign-in and a saved Gemini key write entries under their names', () => {
    const saved = [oauth('chat', 'openai-subscription-oauth'), api('g', 'gemini')]
    const entries = savedOptions(saved).map(
      (option) => modelEntryFor(option.value, { saved }).entry,
    )
    expect(entries).toEqual([
      { name: 'chat', provider: 'openai-subscription', model: defaultModel('openai-subscription') },
      { name: 'g', provider: 'gemini', model: defaultModel('gemini') },
    ])
  })

  it('a saved compatible key writes no entry and names the dashboard page', () => {
    const saved = [api('work', 'openai-compatible')]
    const [pick] = savedOptions(saved)
    expect(modelEntryFor(pick!.value, { saved })).toEqual({
      dashboard: { add: 'openai-compatible-key', name: 'work' },
    })
  })
})

describe('a saved compatible key given both flags', () => {
  it('writes a complete entry under the saved name', () => {
    const saved = [api('work', 'openai-compatible')]
    expect(
      modelEntryFor(resolveLlmFlag('work', saved), {
        baseUrl: 'https://llm.local/v1',
        model: 'm',
        saved,
      }),
    ).toEqual({
      entry: {
        name: 'work',
        provider: 'openai-compatible',
        model: 'm',
        baseURL: 'https://llm.local/v1',
      },
    })
  })
})

describe('the name a new choice writes', () => {
  it('takes <name>-2 when the store holds the stable name for another provider', () => {
    const saved = [api('openai', 'gemini')]
    expect(modelEntryFor(newPick('openai'), { saved }).entry?.name).toBe('openai-2')
  })

  it('takes the first free name past every taken one', () => {
    const saved = [api('openai', 'gemini'), oauth('openai-2', 'anthropic-subscription')]
    expect(modelEntryFor(newPick('openai'), { saved }).entry?.name).toBe('openai-3')
  })

  it('keeps the stable name when the store holds it for the same provider', () => {
    const codex = [oauth('codex', 'openai-subscription-oauth')]
    expect(modelEntryFor(newPick('codex'), { saved: codex }).entry?.name).toBe('codex')
    const gemini = [api('gemini', 'gemini')]
    expect(modelEntryFor(newPick('gemini'), { saved: gemini }).entry?.name).toBe('gemini')
  })

  it.each([
    ['openai', 'openai-compatible'],
    ['anthropic', 'anthropic-compatible'],
  ] as const)(
    'never points the official %s host at a compatible key saved under its name',
    (choice, storedProvider) => {
      const saved = [api(choice, storedProvider)]
      const { entry } = modelEntryFor(newPick(choice), { saved })
      expect(entry?.name).toBe(`${choice}-2`)
    },
  )

  it('never shares a compatible key saved under an endpoint choice name either', () => {
    const saved = [api('openai-compatible', 'openai-compatible')]
    const entry = modelEntryFor(newPick('openai-compatible'), {
      baseUrl: 'https://llm.local/v1',
      model: 'm',
      saved,
    }).entry
    expect(entry?.name).toBe('openai-compatible-2')
  })

  it('reuses a saved compatible key when the person picks it', () => {
    const saved = [api('openai', 'openai-compatible')]
    const [pick] = savedOptions(saved)
    expect(modelEntryFor(pick!.value, { saved })).toEqual({
      dashboard: { add: 'openai-compatible-key', name: 'openai' },
    })
  })

  it('gives a flag-built endpoint entry a free name too', () => {
    const saved = [api('openai-compatible', 'gemini')]
    const entry = modelEntryFor(newPick('openai-compatible'), {
      baseUrl: 'https://llm.local/v1',
      model: 'm',
      saved,
    }).entry
    expect(entry?.name).toBe('openai-compatible-2')
  })

  it('writes a name that is free or held by the same provider and never a compatible key, for every choice and store', async () => {
    const stores: SavedCredential[][] = [
      [],
      await savedFrom(FIXTURE_STORE),
      INIT_MODEL_CHOICES.map((choice) => api(choice, 'some-unknown-provider')),
      INIT_MODEL_CHOICES.map((choice) => oauth(choice, 'anthropic-subscription')),
      INIT_MODEL_CHOICES.flatMap((choice) => [api(choice, 'gemini'), api(`${choice}-2`, 'gemini')]),
      INIT_MODEL_CHOICES.map((choice) => api(choice, 'openai-compatible')),
    ]
    for (const saved of stores) {
      for (const choice of INIT_MODEL_CHOICES) {
        const { entry } = modelEntryFor(newPick(choice), {
          baseUrl: choice.endsWith('-compatible') ? 'https://llm.local/v1' : undefined,
          model: choice.endsWith('-compatible') ? 'm' : undefined,
          saved,
        })
        expect(entry).toBeDefined()
        const holder = saved.find((credential) => credential.name === entry!.name)
        if (holder !== undefined) {
          expect(SAVED_PROVIDER_TO_CONFIG[holder.provider]).toBe(entry!.provider)
          expect(holder.provider).not.toMatch(/-compatible$/u)
        }
      }
    }
  })
})

describe('the pre-selected model', () => {
  it('is a saved claude-code sign-in when there is one', async () => {
    expect(preselectedModel(await savedFrom(FIXTURE_STORE))).toEqual({
      kind: 'saved',
      name: 'claude-code',
      provider: 'anthropic-subscription',
      type: 'oauth',
    })
  })

  it('is another saved working model when claude-code is not saved', () => {
    expect(preselectedModel([api('g', 'gemini')])).toEqual({
      kind: 'saved',
      name: 'g',
      provider: 'gemini',
      type: 'api',
    })
  })

  it('is never a compatible key, which needs the dashboard', () => {
    expect(preselectedModel([api('work', 'openai-compatible')])).toEqual(newPick('claude-code'))
  })

  it('is the Claude subscription when nothing is saved', () => {
    expect(preselectedModel([])).toEqual(newPick('claude-code'))
  })
})

describe('--llm', () => {
  const saved = [api('work', 'openai-compatible'), oauth('a b', 'anthropic-subscription')]

  it('takes one of the seven ids as a new choice', () => {
    expect(resolveLlmFlag('openai', saved)).toEqual(newPick('openai'))
  })

  it('takes a listed saved name as that credential', () => {
    expect(resolveLlmFlag('work', saved)).toEqual({
      kind: 'saved',
      name: 'work',
      provider: 'openai-compatible',
      type: 'api',
    })
  })

  it('refuses anything else with exit 2, naming the seven ids', () => {
    for (const value of ['nope', 'a b']) {
      const refusal = refusalFrom(() => resolveLlmFlag(value, saved))
      expect(refusal.exitCode).toBe(2)
      for (const choice of INIT_MODEL_CHOICES) expect(refusal.message).toContain(choice)
    }
  })
})

describe('--model and --base-url', () => {
  it('refuses an empty or blank --model with exit 2', () => {
    for (const model of ['', '   ']) {
      expect(
        refusalFrom(() => modelEntryFor(newPick('gemini'), { model, saved: [] })).exitCode,
      ).toBe(2)
    }
  })

  it('trims --model and --base-url', () => {
    expect(
      modelEntryFor(newPick('openai-compatible'), {
        model: '  m  ',
        baseUrl: '  https://llm.local/v1 ',
        saved: [],
      }).entry,
    ).toMatchObject({ model: 'm', baseURL: 'https://llm.local/v1' })
  })

  it('refuses --base-url on a provider without a base URL with exit 2', () => {
    for (const pick of [newPick('gemini'), newPick('claude-code')]) {
      const refusal = refusalFrom(() =>
        modelEntryFor(pick, { baseUrl: 'https://llm.local/v1', saved: [] }),
      )
      expect(refusal.exitCode).toBe(2)
      expect(refusal.message).toContain('--base-url')
    }
  })

  it('refuses a --base-url that is not absolute http or https with exit 2', () => {
    const refusal = refusalFrom(() =>
      modelEntryFor(newPick('openai'), { baseUrl: 'ftp://llm.local/v1', saved: [] }),
    )
    expect(refusal.exitCode).toBe(2)
    expect(refusal.message).toBe('--base-url must be an absolute http or https URL')
  })
})

// A stand-in for the subscription plugin: it registers the Claude subscription and makes no call.
function installFakeSubscriptionPlugin(root: string): void {
  writeInstalledPackage(root, SUBSCRIPTION_AUTH_PACKAGE, getAgentQaVersion().trim(), {
    packageJson: { type: 'module', exports: './index.js' },
    files: {
      'index.js': [
        'export const providers = [{',
        "  providerId: 'anthropic-subscription',",
        "  credentialProviderId: 'anthropic-subscription',",
        "  label: 'Claude subscription',",
        "  modelAdapter: 'anthropic-messages',",
        "  dashboardAuth: { mode: 'manual-code' },",
        '  createAuthFetch: () => async () => {',
        "    throw new Error('the fake plugin made a call')",
        '  },',
        '}]',
        '',
      ].join('\n'),
    },
  })
}

async function statusOf(
  llm: string,
  options: {
    store?: Record<string, unknown>
    plugin?: boolean
    flags?: Omit<InitModelFlags, 'saved'>
  } = {},
) {
  const { root, home } = tempProject('model-status')
  const authPath = writeStore(home, options.store ?? {})
  const saved = await listSavedCredentials(authPath)
  if (options.plugin === true) installFakeSubscriptionPlugin(root)
  const setup = modelEntryFor(resolveLlmFlag(llm, saved), { ...options.flags, saved })
  return await modelStatus({
    ...setup,
    configPath: join(root, 'agent-qa.config.yaml'),
    projectDir: root,
    authPath,
    pluginInstalled: options.plugin === true,
  })
}

describe('the model reads ready or pending from the local store', () => {
  it('an endpoint choice with no entry is pending on the dashboard', async () => {
    expect(await statusOf('openai-compatible')).toEqual({
      status: 'pending',
      reason: "set up on the dashboard's model page",
    })
  })

  it('a Claude subscription without its plugin installed is pending on the plugin', async () => {
    const store = { 'claude-code': FIXTURE_STORE['claude-code'] }

    expect(await statusOf('claude-code', { store })).toEqual({
      status: 'pending',
      reason: 'the subscription plugin is not installed',
    })
  })

  it('a Claude subscription with its plugin and a saved sign-in is ready', async () => {
    const store = { 'claude-code': FIXTURE_STORE['claude-code'] }

    expect(await statusOf('claude-code', { store, plugin: true })).toEqual({ status: 'ready' })
  })

  it('a Claude subscription with its plugin and no sign-in is pending', async () => {
    expect(await statusOf('claude-code', { plugin: true })).toEqual({
      status: 'pending',
      reason: 'not signed in',
    })
  })

  it('a Gemini entry is ready with a saved Gemini key of its name and pending without one', async () => {
    const store = { gemini: { type: 'api', provider: 'gemini', key: DUMMY_KEY } }

    expect(await statusOf('gemini', { store })).toEqual({ status: 'ready' })
    expect(await statusOf('gemini')).toEqual({
      status: 'pending',
      reason: "add the key on the dashboard's model page",
    })
  })

  it('a keyless OpenAI-compatible endpoint on localhost is ready', async () => {
    const flags = { baseUrl: 'http://localhost:11434/v1', model: 'llama3' }

    expect(await statusOf('openai-compatible', { flags })).toEqual({ status: 'ready' })
  })

  it('makes no network call', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const store = {
      'claude-code': FIXTURE_STORE['claude-code'],
      gemini: { type: 'api', provider: 'gemini', key: DUMMY_KEY },
    }

    await statusOf('claude-code', { store, plugin: true })
    await statusOf('gemini', { store })
    await statusOf('openai-compatible', {
      flags: { baseUrl: 'http://localhost:11434/v1', model: 'm' },
    })

    expect(fetch).not.toHaveBeenCalled()
  })
})
