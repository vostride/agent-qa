import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { RemoteRefusalError, SecretStore } from '@vostride/agent-qa-runner'

import { installedPackageVersion, pluginHostVersions } from '../host-versions.js'
import { pluginSecretResolver } from '../secret-references.js'

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function project(): { root: string; caller: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-versions-')))
  roots.push(root)
  return { root, caller: pathToFileURL(join(root, 'caller.mjs')).href }
}

// A package whose entry sits in a subfolder and whose exports do not include its package.json.
function installPackage(nodeModules: string, name: string, version: string): void {
  const dir = join(nodeModules, ...name.split('/'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, exports: { '.': './lib/index.js' } }),
  )
  writeFileSync(join(dir, 'lib', 'index.js'), 'module.exports = {}\n')
}

describe('installedPackageVersion', () => {
  it('reads the version of a package that exports no package.json', () => {
    const { root, caller } = project()
    installPackage(join(root, 'node_modules'), 'fake-lib', '1.2.3')

    expect(installedPackageVersion('fake-lib', caller)).toBe('1.2.3')
  })

  it('answers unknown for a package the caller cannot resolve', () => {
    const { caller } = project()

    expect(installedPackageVersion('fake-lib', caller)).toBe('unknown')
  })
})

describe('pluginHostVersions', () => {
  it('reads each library where its adapter loads it', () => {
    const { root, caller } = project()
    const nodeModules = join(root, 'node_modules')
    installPackage(nodeModules, '@vostride/agent-qa-web', '1.0.0')
    installPackage(nodeModules, '@vostride/agent-qa-android', '1.0.0')
    const webModules = join(nodeModules, '@vostride', 'agent-qa-web', 'node_modules')
    installPackage(webModules, 'playwright-core', '9.9.9')
    installPackage(nodeModules, 'playwright-core', '1.0.0')
    installPackage(nodeModules, 'webdriverio', '8.1.0')

    expect(pluginHostVersions(caller)).toEqual({ playwright: '9.9.9', webdriverio: '8.1.0' })
  })
})

describe('pluginSecretResolver', () => {
  it('resolves references at any depth against the declared secrets', () => {
    const declared = new SecretStore({ LAB_KEY: 'lab-key-value' })
    const resolve = pluginSecretResolver(declared, '.env.secrets')
    const auth = { key: '{{secret:LAB_KEY}}', list: ['Bearer {{secret:LAB_KEY}}'] }

    expect(resolve({ auth, region: 'eu' })).toEqual({
      auth: { key: 'lab-key-value', list: ['Bearer lab-key-value'] },
      region: 'eu',
    })
  })

  it('refuses an undeclared secret as auth, naming the secrets file and not the value', () => {
    const resolve = pluginSecretResolver(new SecretStore({}), '.env.secrets')

    let refused: unknown
    try {
      resolve({ key: '{{secret:LAB_KEY}}' })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(RemoteRefusalError)
    expect((refused as RemoteRefusalError).message).toBe(
      'A plugin value needs LAB_KEY, which .env.secrets does not declare. Add it there.',
    )
    expect((refused as RemoteRefusalError).kind).toBe('auth')
  })
})
