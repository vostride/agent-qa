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
    const packageDir = join(tempDir, 'node_modules', '@scope', 'auth-plugin')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: '@scope/auth-plugin',
      type: 'module',
      exports: './index.mjs',
    }))
    await writeFile(join(packageDir, 'index.mjs'), `
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

    await loadLLMAuthPlugins([{ package: '@scope/auth-plugin' }], { baseDir: tempDir })

    expect(getLLMAuthProviderPlugin('package-provider')?.label).toBe('Package provider')
  })

  it('loads ESM-only packages with import-only exports from config directory', async () => {
    const packageDir = join(tempDir, 'node_modules', '@scope', 'esm-auth-plugin')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: '@scope/esm-auth-plugin',
      type: 'module',
      exports: {
        '.': {
          import: './index.mjs',
        },
      },
    }))
    await writeFile(join(packageDir, 'index.mjs'), `
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
    `)

    await loadLLMAuthPlugins([{ package: '@scope/esm-auth-plugin' }], { baseDir: tempDir })

    expect(getLLMAuthProviderPlugin('esm-package-provider')?.label).toBe('ESM package provider')
  })

  it('does not register the same declaration twice', async () => {
    const pluginPath = join(tempDir, 'once-plugin.mjs')
    await writeFile(pluginPath, `
      export const providers = [{
        providerId: 'once-provider',
        credentialProviderId: 'once-credential',
        label: 'Once provider',
        modelAdapter: 'openai-responses',
        dashboardAuth: { mode: 'browser-poll' },
        createAuthFetch() { return globalThis.fetch },
      }]
    `)

    const first = await loadLLMAuthPlugins([{ path: pluginPath }], { baseDir: tempDir })
    const second = await loadLLMAuthPlugins([{ path: pluginPath }], { baseDir: tempDir })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })
})
