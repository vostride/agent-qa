import { join } from 'node:path'

import { credential, z } from '@vostride/agent-qa-plugin-kit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { describePlugin } from '../describe.js'
import { resolvePluginEntry, type ResolvedPluginEntry } from '../resolve-entries.js'
import {
  createFixtureRoot,
  inProcessManifest,
  installPluginPackage,
  remoteManifest,
  writeFile,
  writePluginPackage,
  type FixtureRoot,
} from './plugin-fixtures.js'

const ACME = '@acme/agent-qa-plugin-scripted'
const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

let fixture: FixtureRoot

beforeEach(() => {
  fixture = createFixtureRoot('plugin-describe-')
})

afterEach(() => {
  fixture.remove()
})

function objectSchema(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { $schema: DRAFT, type: 'object', properties, additionalProperties: false, ...extra }
}

function resolve(entry: { package?: string; path?: string }): ResolvedPluginEntry {
  return resolvePluginEntry(
    { name: 'acme', ...entry },
    { configDir: fixture.configDir, agentQaVersion: '1.4.0' },
  )
}

function installWithSchemas(
  options: unknown,
  settings: unknown = objectSchema({}),
  manifest: Record<string, unknown> = {},
): ResolvedPluginEntry {
  const dir = installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest(manifest))
  writeFile(join(dir, 'dist', 'options.schema.json'), JSON.stringify(options))
  writeFile(join(dir, 'dist', 'settings.schema.json'), JSON.stringify(settings))
  return resolve({ package: ACME })
}

describe('describePlugin fields', () => {
  it('lists each option with its type, required, default, description and credential mark', () => {
    const resolved = installWithSchemas(
      objectSchema(
        {
          apiKey: { type: 'string', credential: true, description: 'The account key' },
          apiUrl: {
            type: 'string',
            default: 'https://api.acme.test',
            description: 'The API endpoint',
          },
        },
        { required: ['apiKey'] },
      ),
    )

    expect(describePlugin(resolved).options).toEqual([
      {
        path: 'apiKey',
        type: 'string',
        required: true,
        description: 'The account key',
        credential: true,
      },
      {
        path: 'apiUrl',
        type: 'string',
        required: false,
        default: 'https://api.acme.test',
        description: 'The API endpoint',
        credential: false,
      },
    ])
  })

  it('lists nested object fields by dotted path and follows $ref into $defs', () => {
    const resolved = installWithSchemas(
      objectSchema({}),
      objectSchema(
        {
          proxy: {
            type: 'object',
            description: 'The proxy the browser uses',
            properties: {
              host: { type: 'string', description: 'The proxy host' },
              port: { type: 'integer', default: 8080 },
              login: { $ref: '#/$defs/login' },
            },
            required: ['host'],
          },
          region: { $ref: '#/$defs/region' },
        },
        {
          required: ['region'],
          $defs: {
            region: { type: 'string', enum: ['eu', 'us'], description: 'Where sessions run' },
            login: {
              type: 'object',
              properties: { password: { type: 'string', credential: true } },
            },
          },
        },
      ),
    )

    expect(describePlugin(resolved).settings).toEqual([
      {
        path: 'proxy',
        type: 'object',
        required: false,
        description: 'The proxy the browser uses',
        credential: false,
      },
      {
        path: 'proxy.host',
        type: 'string',
        required: true,
        description: 'The proxy host',
        credential: false,
      },
      { path: 'proxy.port', type: 'integer', required: false, default: 8080, credential: false },
      { path: 'proxy.login', type: 'object', required: false, credential: false },
      { path: 'proxy.login.password', type: 'string', required: false, credential: true },
      {
        path: 'region',
        type: "'eu' | 'us'",
        required: true,
        description: 'Where sessions run',
        credential: false,
      },
    ])
  })

  it('reads a schema the kit emits, arrays and nullable choices included', () => {
    const options = z.strictObject({
      apiKey: credential('The account key'),
      apiUrl: z.url().default('https://api.acme.test').describe('The API endpoint'),
      tags: z.array(z.string()).optional(),
      mode: z.enum(['fast', 'safe']).nullable().optional(),
    })
    const resolved = installWithSchemas(
      z.toJSONSchema(options, { io: 'input', target: 'draft-2020-12' }),
    )

    expect(describePlugin(resolved).options).toEqual([
      {
        path: 'apiKey',
        type: 'string',
        required: true,
        description: 'The account key',
        credential: true,
      },
      {
        path: 'apiUrl',
        type: 'string',
        required: false,
        default: 'https://api.acme.test',
        description: 'The API endpoint',
        credential: false,
      },
      { path: 'tags', type: 'string[]', required: false, credential: false },
      { path: 'mode', type: "'fast' | 'safe' | null", required: false, credential: false },
    ])
  })
})

describe('describePlugin facts', () => {
  it('shows what a package plugin serves, its methods and the run facts it receives', () => {
    const resolved = installWithSchemas(objectSchema({}), objectSchema({}), {
      serves: ['playwright', 'cdp'],
      methods: ['check', 'end'],
      runFacts: ['testName', 'runId', 'failure'],
      skill: './skill',
    })

    const described = describePlugin(resolved)
    expect({ ...described, options: undefined, settings: undefined }).toEqual({
      entry: 'acme',
      package: ACME,
      origin: 'third-party',
      version: '2.0.0',
      protocol: 1,
      serves: ['playwright', 'cdp'],
      methods: ['check', 'end'],
      runFacts: ['testName', 'runId', 'failure'],
      skill: './skill',
      options: undefined,
      settings: undefined,
    })
  })

  it('names a path plugin by its path and gives no run facts when it declares none', () => {
    const dir = join(fixture.configDir, 'tools', 'grid')
    const manifest = { 'agent-qa': { plugin: remoteManifest() } }
    writePluginPackage(dir, { name: 'grid', version: '0.1.0', ...manifest })
    writeFile(join(dir, 'dist', 'options.schema.json'), JSON.stringify(objectSchema({})))
    writeFile(join(dir, 'dist', 'settings.schema.json'), JSON.stringify(objectSchema({})))

    const described = describePlugin(resolve({ path: './tools/grid' }))
    expect(described.path).toBe('./tools/grid')
    expect(described.package).toBeUndefined()
    expect(described.origin).toBe('path')
    expect(described.runFacts).toEqual([])
    expect(described.skill).toBeUndefined()
  })

  it('describes an in-process plugin with no schemas as serving nothing', () => {
    const auth = '@vostride/agent-qa-auth'
    installPluginPackage(fixture.configDir, auth, '1.4.0', inProcessManifest('model-auth'))

    const described = describePlugin(resolve({ package: auth }))
    expect(described).toEqual({
      entry: 'acme',
      package: auth,
      origin: 'first-party',
      version: '1.4.0',
      serves: [],
      methods: [],
      runFacts: [],
      options: [],
      settings: [],
    })
  })

  it('refuses an entry with no readable manifest with its reason', () => {
    expect(() => describePlugin(resolve({ package: ACME }))).toThrow(
      `Plugin entry acme names ${ACME}, which is not installed. Run npm install --save-dev ${ACME}.`,
    )
  })

  it('refuses a schema that is not valid JSON', () => {
    const dir = installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest())
    writeFile(join(dir, 'dist', 'options.schema.json'), '{ not json')
    writeFile(join(dir, 'dist', 'settings.schema.json'), JSON.stringify(objectSchema({})))

    expect(() => describePlugin(resolve({ package: ACME }))).toThrow(
      'Plugin entry acme: ./dist/options.schema.json is not readable JSON.',
    )
  })
})
