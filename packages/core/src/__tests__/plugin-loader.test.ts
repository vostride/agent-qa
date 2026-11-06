import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginNotInstalledError } from '../plugin-loader-util.js'
import {
  clearLLMAuthProviderPlugins,
  clearLoadedLLMAuthPluginModules,
  getLLMAuthProviderPlugin,
  loadLLMAuthPlugins,
} from '../auth/index.js'

async function writeAuthPackage(
  root: string,
  name: string,
  source: string,
  exportsField: unknown = './index.mjs',
): Promise<void> {
  const packageDir = join(root, 'node_modules', ...name.split('/'))
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name,
      version: '0.0.0',
      type: 'module',
      exports: exportsField,
      'agent-qa': { plugin: { kind: 'model-auth', runs: 'in-process', entry: './index.mjs' } },
    }),
  )
  await writeFile(join(packageDir, 'index.mjs'), source)
}

describe('loadLLMAuthPlugins', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-auth-plugin-loader-'))
  })

  afterEach(async () => {
    clearLoadedLLMAuthPluginModules()
    clearLLMAuthProviderPlugins()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads auth providers from a package entry resolved from the config directory', async () => {
    await writeAuthPackage(tempDir, '@vostride/agent-qa-acme-auth', `
      export default {
        providers: [{
          providerId: 'package-provider',
          credentialProviderId: 'package-credential',
          label: 'Package provider',
          modelAdapter: 'anthropic-messages',
          dashboardAuth: { mode: 'manual-code' },
          createAuthFetch() { return globalThis.fetch },
        }],
      }
    `)

    await loadLLMAuthPlugins([{ name: 'acme', package: '@vostride/agent-qa-acme-auth' }], {
      baseDir: tempDir,
    })

    expect(getLLMAuthProviderPlugin('package-provider')?.label).toBe('Package provider')
  })

  it('loads ESM-only packages with import-only exports from config directory', async () => {
    await writeAuthPackage(tempDir, '@vostride/agent-qa-acme-esm-auth', `
      export function createAuthPlugin() {
        return {
          providers: [{
            providerId: 'esm-package-provider',
            credentialProviderId: 'esm-package-credential',
            label: 'ESM package provider',
            modelAdapter: 'openai-responses',
            dashboardAuth: { mode: 'browser-poll' },
            createAuthFetch() { return globalThis.fetch },
          }],
        }
      }
    `, { '.': { import: './index.mjs' } })

    await loadLLMAuthPlugins([{ name: 'acme', package: '@vostride/agent-qa-acme-esm-auth' }], {
      baseDir: tempDir,
    })

    expect(getLLMAuthProviderPlugin('esm-package-provider')?.label).toBe('ESM package provider')
  })

  it('does not register the same entry twice', async () => {
    await writeAuthPackage(tempDir, '@vostride/agent-qa-acme-once-auth', `
      export const providers = [{
        providerId: 'once-provider',
        credentialProviderId: 'once-credential',
        label: 'Once provider',
        modelAdapter: 'openai-responses',
        dashboardAuth: { mode: 'browser-poll' },
        createAuthFetch() { return globalThis.fetch },
      }]
    `)

    const entries = [{ name: 'acme', package: '@vostride/agent-qa-acme-once-auth' }]
    const first = await loadLLMAuthPlugins(entries, { baseDir: tempDir })
    const second = await loadLLMAuthPlugins(entries, { baseDir: tempDir })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('refuses a third-party package with an in-process manifest and registers nothing', async () => {
    await writeAuthPackage(tempDir, '@acme/agent-qa-auth', `
      export const providers = [{
        providerId: 'third-party-provider',
        credentialProviderId: 'third-party-credential',
        label: 'Third-party provider',
        modelAdapter: 'openai-responses',
        dashboardAuth: { mode: 'browser-poll' },
        createAuthFetch() { return globalThis.fetch },
      }]
    `)

    await expect(
      loadLLMAuthPlugins([{ name: 'acme', package: '@acme/agent-qa-auth' }], { baseDir: tempDir }),
    ).rejects.toThrow(
      'Plugin entry acme names @acme/agent-qa-auth, which declares a model-auth plugin; only '
        + '@vostride/agent-qa-* packages load inside agent-qa. Remove the entry.',
    )
    expect(getLLMAuthProviderPlugin('third-party-provider')).toBeUndefined()
  })

  it('refuses a declared auth plugin that is not installed, naming its entry', async () => {
    const entries = [{ name: 'acme', package: '@vostride/agent-qa-acme-missing-auth' }]

    await expect(loadLLMAuthPlugins(entries, { baseDir: tempDir })).rejects.toThrow(
      'Plugin entry acme names @vostride/agent-qa-acme-missing-auth, which is not installed. Run '
        + 'npm install --save-dev @vostride/agent-qa-acme-missing-auth.',
    )
  })

  it('throws PluginNotInstalledError naming the entry when subscription-auth is missing', async () => {
    const entries = [{ name: 'subscription', package: '@vostride/agent-qa-subscription-auth' }]

    const error = await loadLLMAuthPlugins(entries, { baseDir: tempDir }).catch((err) => err)

    expect(error).toBeInstanceOf(PluginNotInstalledError)
    expect(error.message).toContain('remove the plugins entry subscription.')
  })
})
