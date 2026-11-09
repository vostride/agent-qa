import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import { parse } from 'yaml'

import { describe, expect, it } from 'vitest'

import { configWithModelEntry } from '../commands/config-model-edit.js'
import { CliRefusal } from '../composition/cli-refusal.js'

const GIVEN = 'agent-qa.config.yaml'

const WORKSPACE = `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: secrets.yaml
`

const WITH_MODEL = `# The project's agent-qa config.
${WORKSPACE}registry:
  # The models this project can use.
  llms:
    - name: gemini
      provider: gemini
      model: gemini-old
use:
  llm: gemini # the active model
`

const GEMINI = { name: 'gemini', provider: 'gemini', model: 'gemini-new' }
const OPENAI = {
  name: 'openai',
  provider: 'openai-compatible',
  model: 'gpt-x',
  baseURL: 'https://api.openai.com/v1',
}

function refusalOf(run: () => unknown): CliRefusal {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(CliRefusal)
  return caught as CliRefusal
}

describe('the comment-keeping edit of the config model', () => {
  it('appends an entry, sets use.llm to it and keeps every comment and the other entries', () => {
    const edited = configWithModelEntry(WITH_MODEL, GIVEN, OPENAI, { subscription: false })

    expect(edited).toContain("# The project's agent-qa config.")
    expect(edited).toContain('# The models this project can use.')
    expect(edited).toContain('# the active model')
    const config = parse(edited) as { registry: { llms: unknown[] }; use: { llm: string } }
    expect(config.registry.llms).toEqual([
      { name: 'gemini', provider: 'gemini', model: 'gemini-old' },
      OPENAI,
    ])
    expect(config.use.llm).toBe('openai')
    expect(AgentQaConfigSchema.safeParse(config).success).toBe(true)
  })

  it('replaces the entry with the same name in place', () => {
    const text = WITH_MODEL.replace(
      'use:',
      '    - name: other\n      provider: gemini\n      model: gemini-other\nuse:',
    )

    const edited = configWithModelEntry(text, GIVEN, GEMINI, { subscription: false })

    const config = parse(edited) as { registry: { llms: { name: string; model: string }[] } }
    expect(config.registry.llms.map((entry) => `${entry.name} ${entry.model}`)).toEqual([
      'gemini gemini-new',
      'other gemini-other',
    ])
  })

  it('keeps the order of the keys around the edit', () => {
    const edited = configWithModelEntry(WITH_MODEL, GIVEN, OPENAI, { subscription: false })

    expect(Object.keys(parse(edited) as object)).toEqual(['workspace', 'registry', 'use'])
    expect(edited.startsWith(`# The project's agent-qa config.\n${WORKSPACE}`)).toBe(true)
  })

  it('keeps every byte it does not change, trailing comments and blank lines included', () => {
    const text = `${WORKSPACE}  # Optional: more patterns.\n\n# Models\n${WITH_MODEL.slice(
      WITH_MODEL.indexOf('registry:'),
    )}\n\n`

    const replaced = configWithModelEntry(text, GIVEN, GEMINI, { subscription: false })
    const appended = configWithModelEntry(text, GIVEN, OPENAI, { subscription: false })

    expect(replaced).toBe(text.replace('model: gemini-old', 'model: gemini-new'))
    expect(appended).toBe(
      text
        .replace(
          '      model: gemini-old\n',
          '      model: gemini-old\n    - name: openai\n      provider: openai-compatible\n' +
            '      model: gpt-x\n      baseURL: https://api.openai.com/v1\n',
        )
        .replace('llm: gemini #', 'llm: openai #'),
    )
  })

  it('creates registry.llms as a block list when the config has no model', () => {
    const text = `# Set up by hand.\n${WORKSPACE}`

    const edited = configWithModelEntry(text, GIVEN, GEMINI, { subscription: false })

    expect(edited).toContain('# Set up by hand.')
    expect(edited).toContain('  llms:\n    - name: gemini\n')
    const config = parse(edited) as { registry: { llms: unknown[] }; use: { llm: string } }
    expect(config.registry.llms).toEqual([GEMINI])
    expect(config.use.llm).toBe('gemini')
    expect(AgentQaConfigSchema.safeParse(config).success).toBe(true)
  })

  it('declares the subscription plugin with a subscription model', () => {
    const claude = { name: 'claude-code', provider: 'anthropic-subscription', model: 'claude-x' }

    const edited = configWithModelEntry(WITH_MODEL, GIVEN, claude, { subscription: true })

    expect(edited).toContain('# the active model')
    const config = parse(edited) as { plugins: unknown[]; use: { llm: string } }
    expect(config.plugins).toEqual([
      { name: 'subscription', package: '@vostride/agent-qa-subscription-auth' },
    ])
    expect(config.use.llm).toBe('claude-code')
    expect(edited).toBe(
      `${WITH_MODEL.replace(
        '      model: gemini-old\n',
        '      model: gemini-old\n    - name: claude-code\n' +
          '      provider: anthropic-subscription\n      model: claude-x\n',
      ).replace('llm: gemini #', 'llm: claude-code #')}plugins:\n  - name: subscription\n` +
        '    package: "@vostride/agent-qa-subscription-auth"\n',
    )
    expect(AgentQaConfigSchema.safeParse(config).success).toBe(true)
  })

  it('keeps a plugins entry that already declares the subscription package', () => {
    const text = `${WITH_MODEL}plugins:\n  - name: mine\n    package: "@vostride/agent-qa-subscription-auth"\n`
    const claude = { name: 'claude-code', provider: 'anthropic-subscription', model: 'claude-x' }

    const edited = configWithModelEntry(text, GIVEN, claude, { subscription: true })

    expect((parse(edited) as { plugins: unknown[] }).plugins).toEqual([
      { name: 'mine', package: '@vostride/agent-qa-subscription-auth' },
    ])
  })

  it('refuses a config that is not valid YAML with one line', () => {
    const refusal = refusalOf(() =>
      configWithModelEntry('registry: [unclosed\n', GIVEN, GEMINI, { subscription: false }),
    )

    expect(refusal.exitCode).toBe(2)
    expect(refusal.lines).toHaveLength(1)
    expect(refusal.message).toMatch(/^agent-qa\.config\.yaml is not valid YAML: /u)
  })

  it('refuses a config that is not a mapping with one line', () => {
    const refusal = refusalOf(() =>
      configWithModelEntry('- one\n- two\n', GIVEN, GEMINI, { subscription: false }),
    )

    expect(refusal.exitCode).toBe(2)
    expect(refusal.message).toBe('agent-qa.config.yaml must hold a YAML mapping.')
  })

  it('refuses an edit the config schema does not accept with one line', () => {
    const refusal = refusalOf(() =>
      configWithModelEntry(
        WITH_MODEL,
        GIVEN,
        { name: 'endpoint', provider: 'openai-compatible', model: 'x' },
        { subscription: false },
      ),
    )

    expect(refusal.exitCode).toBe(2)
    expect(refusal.lines).toHaveLength(1)
    expect(refusal.message).toContain('registry.llms.1.baseURL')
  })
})
