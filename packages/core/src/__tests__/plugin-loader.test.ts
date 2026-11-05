import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

  it('loads auth providers from an explicit path declaration', async () => {
    const pluginPath = join(tempDir, 'path-plugin.mjs')
    await writeFile(pluginPath, `
      export function createAuthPlugin() {
        return {
          providers: [{
            providerId: 'path-provider',
            credentialProviderId: 'path-credential',
            label: 'Path provider',
            modelAdapter: 'openai-responses',
            dashboardAuth: { mode: 'browser-poll' },
            createAuthFetch() { return globalThis.fetch },
          }],
        }
      }
    `)

    const providers = await loadLLMAuthPlugins([{ path: pluginPath }], { baseDir: tempDir })

    expect(providers.map((provider) => provider.providerId)).toEqual(['path-provider'])
    expect(getLLMAuthProviderPlugin('path-provider')?.credentialProviderId).toBe('path-credential')
  })

  it('loads auth providers from a package declaration resolved from config directory', async () => {
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

    await loadLLMAuthPlugins([{ package: '@vostride/agent-qa-acme-auth' }], { baseDir: tempDir })

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

    await loadLLMAuthPlugins([{ package: '@vostride/agent-qa-acme-esm-auth' }], {
      baseDir: tempDir,
    })

    expect(getLLMAuthProviderPlugin('esm-package-provider')?.label).toBe('ESM package provider')
  })

  it('does not register the same declaration twice', async () => {
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

    const declarations = [{ package: '@vostride/agent-qa-acme-once-auth' }]
    const first = await loadLLMAuthPlugins(declarations, { baseDir: tempDir })
    const second = await loadLLMAuthPlugins(declarations, { baseDir: tempDir })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })
})
