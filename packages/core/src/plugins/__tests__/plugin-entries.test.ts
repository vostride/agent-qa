import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolvePluginEntries, resolvePluginEntry } from '../resolve-entries.js'
import {
  createFixtureRoot,
  inProcessManifest,
  installPluginPackage,
  remoteManifest,
  writeFile,
  writePluginPackage,
  type FixtureRoot,
} from './plugin-fixtures.js'

const VERSION = '1.4.0'
const ACME = '@acme/agent-qa-plugin-scripted'

let fixture: FixtureRoot
let options: { configDir: string; agentQaVersion: string }

beforeEach(() => {
  fixture = createFixtureRoot('plugin-entries-')
  options = { configDir: fixture.configDir, agentQaVersion: VERSION }
})

afterEach(() => {
  fixture.remove()
})

describe('resolving a package entry', () => {
  it('finds an installed package by its exact name and reads its manifest', () => {
    installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest())

    const resolved = resolvePluginEntry({ name: 'acme', package: ACME }, options)

    expect(resolved).toMatchObject({
      name: 'acme',
      label: ACME,
      origin: 'third-party',
      state: 'ok',
      version: '2.0.0',
      inProcess: false,
      packageJsonPath: join(fixture.configDir, 'node_modules', ACME, 'package.json'),
      manifest: { kind: 'remote', entry: './dist/main.js' },
    })
    expect(resolved.reason).toBeUndefined()
  })

  it('finds a package installed in a folder above the config', () => {
    installPluginPackage(fixture.root, ACME, '2.0.0', remoteManifest())

    expect(resolvePluginEntry({ name: 'acme', package: ACME }, options).state).toBe('ok')
  })

  it('reports a missing package as not installed with its plugins add line', () => {
    const resolved = resolvePluginEntry({ name: 'acme', package: ACME }, options)

    expect(resolved).toMatchObject({
      state: 'not_installed',
      origin: 'third-party',
      install: `npx agent-qa plugins add ${ACME}`,
      reason:
        `Plugin entry acme names ${ACME}, which is not installed. `
        + `Run npx agent-qa plugins add ${ACME}.`,
    })
  })

  it('never adds a prefix to find a package', () => {
    installPluginPackage(fixture.configDir, 'agent-qa-plugin-acme', '2.0.0', remoteManifest())

    expect(resolvePluginEntry({ name: 'acme', package: 'acme' }, options).state).toBe(
      'not_installed',
    )
  })

  it('never walks out of node_modules through a .. in a first-party name', () => {
    writePluginPackage(join(fixture.configDir, 'evil'), {
      name: '@vostride/agent-qa-x',
      version: VERSION,
      'agent-qa': { plugin: inProcessManifest('model-provider') },
    })

    const resolved = resolvePluginEntry(
      { name: 'x', package: '@vostride/agent-qa-x/../../../evil' },
      options,
    )

    expect(resolved).toMatchObject({ state: 'not_installed', origin: 'third-party' })
    expect(resolved.packageJsonPath).toBeUndefined()
  })

  it('refuses a package installed under the declared name that names another package', () => {
    const dir = join(fixture.configDir, 'node_modules', '@vostride', 'agent-qa-provider-acme')
    writePluginPackage(dir, {
      name: 'other-pkg',
      version: '9.0.0',
      'agent-qa': { plugin: inProcessManifest('model-provider') },
    })

    const resolved = resolvePluginEntry(
      { name: 'acme', package: '@vostride/agent-qa-provider-acme' },
      options,
    )

    expect(resolved).toMatchObject({
      state: 'bad_manifest',
      reason:
        'Plugin entry acme names @vostride/agent-qa-provider-acme, but the package installed '
        + 'under that name is other-pkg. Install @vostride/agent-qa-provider-acme itself, not an '
        + 'alias.',
    })
    expect(resolved.inProcess).toBe(false)
  })

  it('resolves a package whose entry throws on import, because nothing is imported', () => {
    installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest(), {
      exports: { '.': './dist/main.js' },
      main: './dist/main.js',
    })

    expect(resolvePluginEntry({ name: 'acme', package: ACME }, options).state).toBe('ok')
  })
})

describe('resolving a path entry', () => {
  it('resolves a folder inside the config folder', () => {
    writePluginPackage(join(fixture.configDir, 'tools', 'acme'), {
      name: 'acme-local',
      version: '0.0.1',
      'agent-qa': { plugin: remoteManifest() },
    })

    const resolved = resolvePluginEntry({ name: 'local', path: './tools/acme' }, options)

    expect(resolved).toMatchObject({
      origin: 'path',
      label: './tools/acme',
      state: 'ok',
      version: '0.0.1',
    })
    expect(resolved.install).toBeUndefined()
  })

  it('reports a path with no package.json as not installed, naming the path', () => {
    mkdirSync(join(fixture.configDir, 'tools', 'acme'), { recursive: true })

    const resolved = resolvePluginEntry({ name: 'local', path: './tools/acme' }, options)

    expect(resolved).toMatchObject({
      state: 'not_installed',
      origin: 'path',
      reason:
        'Plugin entry local names the path ./tools/acme, which has no package.json inside this '
        + 'project. Fix the path in plugins, or make the plugin a workspace package and name it '
        + 'with package.',
    })
    expect(resolved.install).toBeUndefined()
  })

  it('refuses a path outside the config folder', () => {
    writePluginPackage(join(fixture.root, 'elsewhere'), {
      name: 'acme-elsewhere',
      version: '0.0.1',
      'agent-qa': { plugin: remoteManifest() },
    })

    const resolved = resolvePluginEntry({ name: 'local', path: '../elsewhere' }, options)

    expect(resolved.state).toBe('not_installed')
    expect(resolved.packageJsonPath).toBeUndefined()
  })

  it('refuses a symlinked path whose target is outside the project', () => {
    const outside = writePluginPackage(join(fixture.root, 'elsewhere', 'acme'), {
      name: 'acme-elsewhere',
      version: '0.0.1',
      'agent-qa': { plugin: remoteManifest() },
    })
    mkdirSync(join(fixture.configDir, 'tools'), { recursive: true })
    symlinkSync(outside, join(fixture.configDir, 'tools', 'acme'), 'dir')

    const resolved = resolvePluginEntry({ name: 'local', path: './tools/acme' }, options)

    expect(resolved).toMatchObject({
      state: 'not_installed',
      reason: expect.stringContaining('names the path ./tools/acme, which has no package.json'),
    })
  })
})

describe('reading the manifest', () => {
  it('refuses a manifest whose entry resolves outside the package', () => {
    installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest({ entry: '../x.js' }))

    expect(resolvePluginEntry({ name: 'acme', package: ACME }, options)).toMatchObject({
      state: 'bad_manifest',
      reason:
        `Plugin entry acme names ${ACME}, whose package.json has no valid agent-qa plugin `
        + "manifest (entry resolves outside the package). Fix the plugin's manifest.",
    })
  })

  it('refuses a manifest whose schema file is a symlink out of the package', () => {
    writeFile(join(fixture.root, 'elsewhere', 'settings.schema.json'), '{}')
    const dir = installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest())
    symlinkSync(
      join(fixture.root, 'elsewhere', 'settings.schema.json'),
      join(dir, 'dist', 'settings.schema.json'),
    )

    expect(resolvePluginEntry({ name: 'acme', package: ACME }, options).reason).toContain(
      '(settings resolves outside the package)',
    )
  })

  it('refuses a skill that resolves outside the package', () => {
    installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest({ skill: '../../skill' }))

    expect(resolvePluginEntry({ name: 'acme', package: ACME }, options).reason).toContain(
      '(skill resolves outside the package)',
    )
  })

  it('refuses a manifest with an unknown key, naming its position', () => {
    installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest({ install: 'curl x' }))

    const resolved = resolvePluginEntry({ name: 'acme', package: ACME }, options)

    expect(resolved.state).toBe('bad_manifest')
    expect(resolved.reason).toContain('(agent-qa.plugin.install)')
    expect(resolved.reason).not.toContain('curl')
  })

  it('refuses a package with no manifest', () => {
    installPluginPackage(fixture.configDir, ACME, '2.0.0', undefined)

    expect(resolvePluginEntry({ name: 'acme', package: ACME }, options).reason).toContain(
      '(agent-qa.plugin is missing)',
    )
  })

  it('refuses a package.json that is not JSON without quoting it', () => {
    const dir = installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest())
    writeFile(join(dir, 'package.json'), '{ "name": SEKRET }')

    const resolved = resolvePluginEntry({ name: 'acme', package: ACME }, options)

    expect(resolved.state).toBe('bad_manifest')
    expect(resolved.reason).toContain('(package.json is not readable JSON)')
    expect(resolved.reason).not.toContain('SEKRET')
  })
})

describe('entries no remote uses', () => {
  it('marks a remote plugin entry that no remote names as unused', () => {
    installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest())
    installPluginPackage(
      fixture.configDir,
      '@vostride/agent-qa-acme-auth',
      VERSION,
      inProcessManifest('model-auth'),
    )

    const resolved = resolvePluginEntries(
      {
        plugins: [
          { name: 'used', package: ACME },
          { name: 'spare', package: ACME },
          { name: 'auth', package: '@vostride/agent-qa-acme-auth' },
          { name: 'gone', package: '@acme/never-installed' },
        ],
        remotes: [{ name: 'farm', plugin: 'used' }, { name: 'local' }],
      },
      options,
    )

    expect(resolved.map((entry) => [entry.name, entry.state])).toEqual([
      ['used', 'ok'],
      ['spare', 'unused'],
      ['auth', 'ok'],
      ['gone', 'not_installed'],
    ])
    expect(resolved[1]?.reason).toBe(
      'Plugin entry spare is used by no remote. Name it from a remote in registry.remotes, or '
      + 'remove it.',
    )
  })
})
