import { describe, expect, it } from 'vitest'
import { AgentQaConfigSchema } from '../schema/config-schema.js'

const workspace = {
  testMatch: ['tests/**/*.yaml'],
  suiteMatch: ['suites/**/*.suite.yaml'],
  hooksFile: 'hooks.yaml',
  envFile: '.env',
  secretsFile: '.env.secrets.local',
}

function parse(plugins: unknown) {
  return AgentQaConfigSchema.safeParse({ workspace, plugins })
}

function messages(plugins: unknown): string[] {
  const result = parse(plugins)
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

describe('plugins is a list of named entries', () => {
  it('parses a package entry, a path entry and an entry with options', () => {
    const plugins = [
      { name: 'subscription', package: '@vostride/agent-qa-subscription-auth' },
      { name: 'local', path: './plugins/local' },
      { name: 'acme', package: '@acme/agent-qa-plugin', options: { region: 'eu', retries: 2 } },
    ]

    const result = parse(plugins)

    expect(result.success).toBe(true)
    expect(result.data?.plugins).toEqual(plugins)
  })

  it('refuses two entries with the same name', () => {
    const result = parse([
      { name: 'acme', package: '@acme/agent-qa-plugin' },
      { name: 'acme', path: './plugins/acme' },
    ])

    expect(result.success).toBe(false)
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['plugins'],
        message: 'Duplicate plugin entry name: "acme"',
      }),
    )
  })

  it('gives the shape sentence before the strict parse sees an entry with both package and path', () => {
    expect(
      messages([{ name: 'acme', package: '@acme/agent-qa-plugin', path: './plugins/acme' }]),
    ).toEqual(['Plugin entry acme names both package and path; an entry names one or the other.'])
  })

  it('refuses settings on an entry with the sentence that says where settings go', () => {
    expect(
      messages([{ name: 'acme', package: '@acme/agent-qa-plugin', settings: { region: 'eu' } }]),
    ).toEqual([
      "Plugin entry acme has settings; an entry's values go under options, and settings go on each remote that names the entry.",
    ])
  })

  it('refuses a literal credential in options and accepts a secret reference', () => {
    const entry = { name: 'acme', package: '@acme/agent-qa-plugin', options: { apiKey: 'sk-live' } }
    expect(messages([entry])).toEqual([
      'Plugin entry acme: options "apiKey" names a credential, so its value must be a {{secret:NAME}} reference.',
    ])
    expect(
      parse([
        {
          name: 'acme',
          package: '@acme/agent-qa-plugin',
          options: { apiKey: '{{secret:ACME_API_KEY}}' },
        },
      ]).success,
    ).toBe(true)
  })
})
