import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearLoadedProviderPluginModules } from '@vostride/agent-qa-core'
import { clearProviderRegistry, getProvider } from '@vostride/agent-qa-model'
import { loadProviderPluginsForRawConfig } from '../provider-plugins.js'

async function withTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-qa-cli-provider-plugin-'))
}

async function writeProviderPackage(root: string, name: string, source: string): Promise<void> {
  const packageDir = join(root, 'node_modules', ...name.split('/'))
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name,
      version: '0.0.0',
      type: 'module',
      exports: './index.mjs',
      'agent-qa': { plugin: { kind: 'model-provider', runs: 'in-process', entry: './index.mjs' } },
    }),
  )
  await writeFile(join(packageDir, 'index.mjs'), source)
}

describe('loadProviderPluginsForRawConfig', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const tempDirs: string[] = []

  afterEach(async () => {
    clearProviderRegistry()
    clearLoadedProviderPluginModules()
    warnSpy.mockClear()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('loads a provider plugin descriptor and registers it in the model registry', async () => {
    const tempDir = await withTempDir()
    tempDirs.push(tempDir)
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-gateway', `
      export default {
        id: 'test-gateway',
        label: 'Test Gateway',
        needsBaseURL: true,
        authModes: ['api-key'],
        adapter(transport, modelId) {
          return { transport, modelId, source: 'test-gateway' }
        },
      }
    `)

    await loadProviderPluginsForRawConfig(
      { plugins: [{ name: 'gateway', package: '@vostride/agent-qa-acme-gateway' }] },
      join(tempDir, 'agent-qa.config.yaml'),
    )

    const registered = getProvider('test-gateway')
    expect(registered).toEqual(expect.objectContaining({
      id: 'test-gateway',
      label: 'Test Gateway',
      needsBaseURL: true,
      authModes: ['api-key'],
    }))
    expect(registered?.adapter({ baseURL: 'https://gateway.example' }, 'demo-model')).toEqual({
      transport: { baseURL: 'https://gateway.example' },
      modelId: 'demo-model',
      source: 'test-gateway',
    })
  })

  it('registers descriptors in declaration order so later providers win', async () => {
    const tempDir = await withTempDir()
    tempDirs.push(tempDir)
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-gateway', `
      export default {
        id: 'test-gateway',
        label: 'First Gateway',
        needsBaseURL: true,
        authModes: ['api-key'],
        adapter() { return { source: 'first' } },
      }
    `)
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-second-gateway', `
      export default {
        id: 'test-gateway',
        label: 'Second Gateway',
        needsBaseURL: false,
        authModes: ['none'],
        adapter() { return { source: 'second' } },
      }
    `)

    await loadProviderPluginsForRawConfig(
      {
        plugins: [
          { name: 'gateway', package: '@vostride/agent-qa-acme-gateway' },
          { name: 'second-gateway', package: '@vostride/agent-qa-acme-second-gateway' },
        ],
      },
      join(tempDir, 'agent-qa.config.yaml'),
    )

    const registered = getProvider('test-gateway')
    expect(registered).toEqual(expect.objectContaining({
      id: 'test-gateway',
      label: 'Second Gateway',
      needsBaseURL: false,
      authModes: ['none'],
    }))
    expect(registered?.adapter({}, 'demo-model')).toEqual({ source: 'second' })
  })
})
