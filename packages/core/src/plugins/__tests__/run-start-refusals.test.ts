import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pluginRemoteRefusals, type PluginRemoteRefusalsInput } from '../run-start.js'
import {
  createFixtureRoot,
  installPluginPackage,
  remoteManifest,
  writeFile,
  type FixtureRoot,
} from './plugin-fixtures.js'

const FIRST_PARTY = '@vostride/agent-qa-plugin-scripted'
const THIRD_PARTY = '@acme/agent-qa-plugin-grid'
const VERSION = '1.4.0'
const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

let fixture: FixtureRoot

beforeEach(() => {
  fixture = createFixtureRoot('plugin-run-start-')
})

afterEach(() => {
  fixture.remove()
})

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { $schema: DRAFT, type: 'object', properties, additionalProperties: false }
}

function install(
  name: string,
  manifest: Record<string, unknown> = remoteManifest(),
  schemas: { options?: unknown; settings?: unknown } = {},
  version = VERSION,
): void {
  const dir = installPluginPackage(fixture.configDir, name, version, manifest)
  writeFile(
    join(dir, 'dist', 'options.schema.json'),
    JSON.stringify(schemas.options ?? objectSchema({})),
  )
  writeFile(
    join(dir, 'dist', 'settings.schema.json'),
    JSON.stringify(schemas.settings ?? objectSchema({})),
  )
}

function refusals(input: Partial<PluginRemoteRefusalsInput>) {
  return pluginRemoteRefusals({
    configDir: fixture.configDir,
    agentQaVersion: VERSION,
    plugins: [{ name: 'kit', package: FIRST_PARTY }],
    remotes: [{ name: 'farm', plugin: 'kit' }],
    uses: [{ remote: 'farm', place: 'web' }],
    ...input,
  })
}

describe('an entry the run cannot start', () => {
  it('refuses a missing first-party plugin with its pinned install line', () => {
    expect(refusals({})).toEqual([
      {
        remote: 'farm',
        entry: 'kit',
        kind: 'refused',
        message:
          `Remote farm cannot start: Plugin entry kit names ${FIRST_PARTY}, which is not `
          + `installed. Run npm install --save-dev --save-exact ${FIRST_PARTY}@${VERSION}.`,
      },
    ])
  })

  it('refuses a missing third-party plugin with its unpinned install line', () => {
    const [refusal] = refusals({ plugins: [{ name: 'kit', package: THIRD_PARTY }] })

    expect(refusal?.kind).toBe('refused')
    expect(refusal?.message).toBe(
      `Remote farm cannot start: Plugin entry kit names ${THIRD_PARTY}, which is not installed. `
        + `Run npm install --save-dev ${THIRD_PARTY}.`,
    )
  })

  it('refuses a first-party plugin at another version as a version refusal', () => {
    install(FIRST_PARTY, remoteManifest(), {}, '1.3.0')

    expect(refusals({})).toEqual([
      {
        remote: 'farm',
        entry: 'kit',
        kind: 'version',
        message:
          `Remote farm cannot start: Plugin entry kit names ${FIRST_PARTY} at 1.3.0, and `
          + `agent-qa is at ${VERSION}. Run npm install --save-dev --save-exact `
          + `${FIRST_PARTY}@${VERSION}.`,
      },
    ])
  })

  it('refuses a plugin outside the protocol window as a version refusal', () => {
    install(THIRD_PARTY, remoteManifest({ protocol: 99 }))

    const [refusal] = refusals({ plugins: [{ name: 'kit', package: THIRD_PARTY }] })

    expect(refusal?.kind).toBe('version')
    expect(refusal?.message).toMatch(
      /^Remote farm cannot start: Plugin entry kit names .* speaks plugin protocol 99, newer than/,
    )
  })

  it('refuses a plugin whose manifest is not valid', () => {
    install(THIRD_PARTY, { kind: 'remote', runs: 'process' })

    const [refusal] = refusals({ plugins: [{ name: 'kit', package: THIRD_PARTY }] })

    expect(refusal?.kind).toBe('refused')
    expect(refusal?.message).toMatch(
      /^Remote farm cannot start: Plugin entry kit names .*, whose package\.json has no valid agent-qa plugin manifest/,
    )
  })

  it('refuses a remote whose entry is not a remote plugin', () => {
    install(FIRST_PARTY, { kind: 'model-auth', runs: 'in-process', entry: './dist/index.js' })

    expect(refusals({}).map(({ kind, message }) => ({ kind, message }))).toEqual([
      {
        kind: 'refused',
        message:
          'Remote farm cannot start: plugin entry kit is a model-auth plugin, and a remote needs '
          + 'a remote plugin.',
      },
    ])
  })
})

describe('options and settings', () => {
  it('refuses a setting the plugin does not take, naming the remote once', () => {
    install(FIRST_PARTY, remoteManifest(), {
      settings: objectSchema({ region: { type: 'string' } }),
    })

    const found = refusals({
      remotes: [{ name: 'farm', plugin: 'kit', settings: { colour: 'red' } }],
    })

    expect(found).toEqual([
      {
        remote: 'farm',
        entry: 'kit',
        kind: 'refused',
        message:
          'Remote farm cannot start: settings.colour is not a setting this plugin takes.',
      },
    ])
  })

  it('refuses a literal in a credential option without echoing it', () => {
    install(FIRST_PARTY, remoteManifest(), {
      options: objectSchema({ token: { type: 'string', credential: true } }),
    })

    const found = refusals({
      plugins: [{ name: 'kit', package: FIRST_PARTY, options: { token: 'sk_live_literal' } }],
    })

    expect(found.map(({ kind, message }) => ({ kind, message }))).toEqual([
      {
        kind: 'refused',
        message:
          'Remote farm cannot start: Plugin entry kit: options.token is a credential; write it '
          + 'as a {{secret:NAME}} reference to workspace.secretsFile.',
      },
    ])
    expect(JSON.stringify(found)).not.toContain('sk_live_literal')
  })

  it('refuses a reference to a secret the secrets file does not declare', () => {
    install(FIRST_PARTY, remoteManifest(), {
      options: objectSchema({ token: { type: 'string', credential: true } }),
      settings: objectSchema({ project: { type: 'string' } }),
    })

    const found = refusals({
      plugins: [{ name: 'kit', package: FIRST_PARTY, options: { token: '{{secret:GRID_TOKEN}}' } }],
      remotes: [
        { name: 'farm', plugin: 'kit', settings: { project: 'p-{{secret:GRID_PROJECT}}' } },
      ],
      declaredSecrets: new Set(['GRID_PROJECT']),
    })

    expect(found).toEqual([
      {
        remote: 'farm',
        entry: 'kit',
        kind: 'auth',
        message:
          'Remote farm cannot start: plugin entry kit uses secret GRID_TOKEN, which '
          + 'workspace.secretsFile does not declare.',
      },
    ])
  })

  it('accepts references the secrets file declares', () => {
    install(FIRST_PARTY, remoteManifest(), {
      options: objectSchema({ token: { type: 'string', credential: true } }),
    })

    expect(
      refusals({
        plugins: [
          { name: 'kit', package: FIRST_PARTY, options: { token: '{{secret:GRID_TOKEN}}' } },
        ],
        declaredSecrets: new Set(['GRID_TOKEN']),
      }),
    ).toEqual([])
  })
})

describe('what the plugin serves', () => {
  it('refuses a web test on a plugin that serves only appium', () => {
    install(FIRST_PARTY, remoteManifest({ serves: ['appium'] }))

    expect(refusals({}).map(({ message }) => message)).toEqual([
      'Remote farm cannot start: plugin entry kit serves appium, and a web test needs playwright '
        + 'or cdp.',
    ])
  })

  it('refuses a device on a plugin that serves no appium', () => {
    install(FIRST_PARTY, remoteManifest({ serves: ['playwright', 'cdp'] }))

    expect(refusals({ uses: [{ remote: 'farm', place: 'device' }] })).toEqual([
      {
        remote: 'farm',
        entry: 'kit',
        kind: 'refused',
        message:
          'Remote farm cannot start: plugin entry kit serves playwright and cdp, and a device '
          + 'needs appium.',
      },
    ])
  })

  it('accepts a web test on cdp and a device on appium', () => {
    install(FIRST_PARTY, remoteManifest({ serves: ['cdp', 'appium'] }))

    expect(
      refusals({
        uses: [
          { remote: 'farm', place: 'web' },
          { remote: 'farm', place: 'device' },
        ],
      }),
    ).toEqual([])
  })
})

describe('which remotes are refused', () => {
  it('refuses every remote on a broken entry and none on another entry', () => {
    install(THIRD_PARTY)

    const found = refusals({
      plugins: [
        { name: 'kit', package: FIRST_PARTY },
        { name: 'grid', package: THIRD_PARTY },
      ],
      remotes: [
        { name: 'farm', plugin: 'kit' },
        { name: 'barn', plugin: 'kit' },
        { name: 'lab', plugin: 'grid' },
        { name: 'url-remote' },
      ],
      uses: [
        { remote: 'farm', place: 'web' },
        { remote: 'barn', place: 'web' },
        { remote: 'lab', place: 'web' },
        { remote: 'url-remote', place: 'web' },
      ],
    })

    expect(found.map(({ remote, entry, kind }) => ({ remote, entry, kind }))).toEqual([
      { remote: 'farm', entry: 'kit', kind: 'refused' },
      { remote: 'barn', entry: 'kit', kind: 'refused' },
    ])
  })

  it('checks only the remotes the run uses', () => {
    expect(refusals({ uses: [] })).toEqual([])
  })
})
