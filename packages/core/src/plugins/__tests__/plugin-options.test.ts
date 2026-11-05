import { join } from 'node:path'

import { credential, z } from '@vostride/agent-qa-plugin-kit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_PLUGIN_SCHEMA_BYTES,
  MAX_PLUGIN_SCHEMA_DEPTH,
  checkPluginConfig,
} from '../options-check.js'
import { resolvePluginEntry, type ResolvedPluginEntry } from '../resolve-entries.js'
import {
  createFixtureRoot,
  installPluginPackage,
  remoteManifest,
  writeFile,
  type FixtureRoot,
} from './plugin-fixtures.js'

const ACME = '@acme/agent-qa-plugin-scripted'
const OPTIONS_FILE = './dist/options.schema.json'
const SETTINGS_FILE = './dist/settings.schema.json'
const DRAFT = 'https://json-schema.org/draft/2020-12/schema'
const CREDENTIAL_ADVICE =
  'is a credential; write it as a {{secret:NAME}} reference to workspace.secretsFile.'

let fixture: FixtureRoot

beforeEach(() => {
  fixture = createFixtureRoot('plugin-options-')
})

afterEach(() => {
  fixture.remove()
})

function objectSchema(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { $schema: DRAFT, type: 'object', properties, additionalProperties: false, ...extra }
}

function pluginWithSchemaText(optionsText: string, settingsText: string): ResolvedPluginEntry {
  const dir = installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest())
  writeFile(join(dir, OPTIONS_FILE), optionsText)
  writeFile(join(dir, SETTINGS_FILE), settingsText)
  const resolved = resolvePluginEntry(
    { name: 'acme', package: ACME },
    { configDir: fixture.configDir, agentQaVersion: '1.4.0' },
  )
  expect(resolved.state).toBe('ok')
  return resolved
}

function pluginWithSchemas(options: unknown, settings: unknown = objectSchema({})) {
  return pluginWithSchemaText(JSON.stringify(options), JSON.stringify(settings))
}

describe('options', () => {
  const schema = objectSchema(
    {
      region: { type: 'string' },
      tunnel: objectSchema({ port: { type: 'integer' } }),
    },
    { required: ['region'] },
  )

  it('accepts options the schema allows', () => {
    const resolved = pluginWithSchemas(schema)

    expect(checkPluginConfig(resolved, { options: { region: 'eu' }, remotes: [] })).toEqual([])
  })

  it('refuses an option the plugin does not take', () => {
    const resolved = pluginWithSchemas(schema)

    expect(
      checkPluginConfig(resolved, { options: { region: 'eu', colour: 'red' }, remotes: [] }),
    ).toEqual([
      {
        scope: 'options',
        path: ['colour'],
        message: 'Plugin entry acme: options.colour is not an option this plugin takes.',
      },
    ])
  })

  it('names the path and the schema rule for a wrong type', () => {
    const resolved = pluginWithSchemas(schema)

    expect(
      checkPluginConfig(resolved, { options: { region: 5, tunnel: { port: 'x' } }, remotes: [] }),
    ).toEqual([
      {
        scope: 'options',
        path: ['region'],
        message: 'Plugin entry acme: options.region must be string.',
      },
      {
        scope: 'options',
        path: ['tunnel', 'port'],
        message: 'Plugin entry acme: options.tunnel.port must be integer.',
      },
    ])
  })

  it('names a missing required option', () => {
    const resolved = pluginWithSchemas(schema)

    expect(checkPluginConfig(resolved, { options: undefined, remotes: [] })).toEqual([
      {
        scope: 'options',
        path: ['region'],
        message: 'Plugin entry acme: options.region is required.',
      },
    ])
  })
})

describe('settings', () => {
  const settings = objectSchema({ os: { enum: ['android', 'ios'] } })

  it('checks each remote against the settings schema and names the remote', () => {
    const resolved = pluginWithSchemas(objectSchema({}), settings)

    expect(
      checkPluginConfig(resolved, {
        options: {},
        remotes: [
          { name: 'farm', settings: { os: 'beos' } },
          { name: 'phones', settings: { os: 'ios' } },
          { name: 'plain' },
        ],
      }),
    ).toEqual([
      {
        scope: 'settings',
        remote: 'farm',
        path: ['os'],
        message: 'Remote farm: settings.os must be equal to one of the allowed values.',
      },
    ])
  })

  it('refuses a setting the plugin does not take', () => {
    const resolved = pluginWithSchemas(objectSchema({}), settings)

    expect(
      checkPluginConfig(resolved, {
        options: {},
        remotes: [{ name: 'farm', settings: { pool: 2 } }],
      }),
    ).toEqual([
      {
        scope: 'settings',
        remote: 'farm',
        path: ['pool'],
        message: 'Remote farm: settings.pool is not a setting this plugin takes.',
      },
    ])
  })
})

describe('credential marks', () => {
  it('refuses a literal in a field the schema marks as a credential, without echoing it', () => {
    const resolved = pluginWithSchemas(
      objectSchema({ apiKey: { type: 'string', credential: true } }),
    )

    const issues = checkPluginConfig(resolved, {
      options: { apiKey: 'sk_live_123' },
      remotes: [],
    })

    expect(issues).toEqual([
      {
        scope: 'options',
        path: ['apiKey'],
        message: `Plugin entry acme: options.apiKey ${CREDENTIAL_ADVICE}`,
      },
    ])
    expect(JSON.stringify(issues)).not.toContain('sk_live_123')
  })

  it('accepts a reference even where the field would reject the text', () => {
    const resolved = pluginWithSchemas(
      objectSchema({
        apiKey: { type: 'string', pattern: '^sk_', minLength: 30, credential: true },
      }),
    )

    expect(
      checkPluginConfig(resolved, { options: { apiKey: '{{secret:ACME_KEY}}' }, remotes: [] }),
    ).toEqual([])
  })

  it('finds marks through items and $defs, naming the remote', () => {
    const settings = objectSchema(
      { accounts: { type: 'array', items: { $ref: '#/$defs/account' } } },
      { $defs: { account: objectSchema({ token: { type: 'string', credential: true } }) } },
    )
    const resolved = pluginWithSchemas(objectSchema({}), settings)

    expect(
      checkPluginConfig(resolved, {
        options: {},
        remotes: [
          {
            name: 'farm',
            settings: { accounts: [{ token: '{{secret:FIRST}}' }, { token: 'plain-token' }] },
          },
        ],
      }),
    ).toEqual([
      {
        scope: 'settings',
        remote: 'farm',
        path: ['accounts', 1, 'token'],
        message: `Remote farm: settings.accounts[1].token ${CREDENTIAL_ADVICE}`,
      },
    ])
  })

  it('reads the marks and formats of a schema the kit emits', () => {
    const options = z.strictObject({
      apiKey: credential('The account key'),
      apiUrl: z.url().optional(),
      region: z.enum(['eu', 'us']).default('eu'),
    })
    const emitted = z.toJSONSchema(options, { io: 'input', target: 'draft-2020-12' })
    const resolved = pluginWithSchemas(emitted)

    expect(
      checkPluginConfig(resolved, {
        options: { apiKey: '{{secret:ACME_KEY}}', apiUrl: 'https://api.acme.test' },
        remotes: [],
      }),
    ).toEqual([])
    expect(
      checkPluginConfig(resolved, { options: { apiKey: 'plain' }, remotes: [] }).map(
        (issue) => issue.message,
      ),
    ).toEqual([`Plugin entry acme: options.apiKey ${CREDENTIAL_ADVICE}`])
  })
})

describe('schema files', () => {
  it('refuses a schema file over the size cap without compiling it', () => {
    const big = objectSchema({}, { description: 'x'.repeat(MAX_PLUGIN_SCHEMA_BYTES) })
    const resolved = pluginWithSchemas(big)

    expect(MAX_PLUGIN_SCHEMA_BYTES).toBe(256 * 1024)
    expect(checkPluginConfig(resolved, { options: { unknown: 1 }, remotes: [] })).toEqual([
      {
        scope: 'options',
        path: [],
        message:
          `Plugin entry acme: ${OPTIONS_FILE} is larger than 256 KiB, the most a plugin schema `
          + 'may be.',
      },
    ])
  })

  it('refuses a schema nested deeper than the depth cap without compiling it', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let level = 0; level < MAX_PLUGIN_SCHEMA_DEPTH; level += 1) {
      deep = { type: 'object', properties: { next: deep } }
    }
    const resolved = pluginWithSchemas(objectSchema({}), { $schema: DRAFT, ...deep })

    expect(MAX_PLUGIN_SCHEMA_DEPTH).toBe(64)
    expect(
      checkPluginConfig(resolved, { options: {}, remotes: [{ name: 'farm', settings: 5 }] }),
    ).toEqual([
      {
        scope: 'settings',
        path: [],
        message:
          `Plugin entry acme: ${SETTINGS_FILE} nests deeper than 64 levels, the most a plugin `
          + 'schema may.',
      },
    ])
  })

  it('refuses a schema file that is not JSON', () => {
    const resolved = pluginWithSchemaText('{ nope', JSON.stringify(objectSchema({})))

    expect(checkPluginConfig(resolved, { options: {}, remotes: [] })).toEqual([
      {
        scope: 'options',
        path: [],
        message: `Plugin entry acme: ${OPTIONS_FILE} is not readable JSON.`,
      },
    ])
  })

  it('refuses a schema with a keyword strict mode does not know', () => {
    const resolved = pluginWithSchemas(objectSchema({ region: { type: 'string', colour: 'red' } }))

    const [issue, ...rest] = checkPluginConfig(resolved, { options: {}, remotes: [] })

    expect(rest).toEqual([])
    expect(issue).toMatchObject({ scope: 'options', path: [] })
    expect(issue?.message).toMatch(/\(.*colour.*\)\.$/)
    expect(
      issue?.message.startsWith(`Plugin entry acme: ${OPTIONS_FILE} is not a valid JSON Schema (`),
    ).toBe(true)
  })
})
