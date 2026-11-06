import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearLoadedProviderPluginModules,
  loadProviderPlugins,
} from '../providers/plugin-loader.js'

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

describe('loadProviderPlugins', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-provider-plugin-loader-'))
  })

  afterEach(async () => {
    clearLoadedProviderPluginModules()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads provider descriptors from a package entry resolved from the config directory', async () => {
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-provider', `
      export const provider = {
        id: 'package-provider',
        label: 'Package provider',
        authModes: ['bearer-token'],
        needsBaseURL: true,
        adapter(transport, modelId) { return { transport, modelId, source: 'package' } },
      }
    `)

    const providers = await loadProviderPlugins(
      [{ name: 'provider', package: '@vostride/agent-qa-acme-provider' }],
      { baseDir: tempDir },
    )

    expect(providers.map((provider) => provider.id)).toEqual(['package-provider'])
    expect(providers[0]?.needsBaseURL).toBe(true)
  })

  it('accepts a single default descriptor and providers array bundle shapes', async () => {
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-default-provider', `
      export default {
        id: 'default-descriptor',
        label: 'Default descriptor',
        authModes: ['none'],
        adapter() { return { source: 'default' } },
      }
    `)
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-array-provider', `
      export default {
        providers: [{
          id: 'array-provider',
          label: 'Array provider',
          authModes: ['api-key'],
          adapter() { return { source: 'array' } },
        }],
      }
    `)

    const providers = await loadProviderPlugins([
      { name: 'default', package: '@vostride/agent-qa-acme-default-provider' },
      { name: 'array', package: '@vostride/agent-qa-acme-array-provider' },
    ], { baseDir: tempDir })

    expect(providers.map((provider) => provider.id)).toEqual(['default-descriptor', 'array-provider'])
  })

  it('does not return descriptors for the same entry twice', async () => {
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-once-provider', `
      export const providers = [{
        id: 'once-provider',
        label: 'Once provider',
        authModes: ['api-key'],
        adapter() { return { source: 'once' } },
      }]
    `)

    const entries = [{ name: 'once', package: '@vostride/agent-qa-acme-once-provider' }]
    const first = await loadProviderPlugins(entries, { baseDir: tempDir })
    const second = await loadProviderPlugins(entries, { baseDir: tempDir })

    expect(first.map((provider) => provider.id)).toEqual(['once-provider'])
    expect(second).toHaveLength(0)
  })

  it('returns descriptors without registering them in core', async () => {
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-return-only-provider', `
      globalThis.__agentQaProviderPluginRegisterCalls = (globalThis.__agentQaProviderPluginRegisterCalls ?? 0) + 1
      export default {
        id: 'return-only-provider',
        label: 'Return-only provider',
        authModes: ['api-key'],
        adapter() { return { source: 'return-only' } },
      }
    `)

    const providers = await loadProviderPlugins(
      [{ name: 'provider', package: '@vostride/agent-qa-acme-return-only-provider' }],
      { baseDir: tempDir },
    )

    expect(providers.map((provider) => provider.id)).toEqual(['return-only-provider'])
    expect((globalThis as { __agentQaProviderPluginRegisterCalls?: number }).__agentQaProviderPluginRegisterCalls).toBe(1)
  })

  it('returns nothing for an empty or missing list', async () => {
    await expect(loadProviderPlugins([], { baseDir: tempDir })).resolves.toEqual([])
    await expect(loadProviderPlugins(undefined, { baseDir: tempDir })).resolves.toEqual([])
  })

  it('refuses a third-party package with an in-process manifest and returns nothing', async () => {
    await writeProviderPackage(tempDir, '@acme/agent-qa-provider', `
      globalThis.__agentQaThirdPartyProviderImported = true
      export default {
        id: 'third-party-provider',
        label: 'Third-party provider',
        authModes: ['api-key'],
        adapter() { return { source: 'third-party' } },
      }
    `)

    await expect(
      loadProviderPlugins([{ name: 'acme', package: '@acme/agent-qa-provider' }], {
        baseDir: tempDir,
      }),
    ).rejects.toThrow(
      'Plugin entry acme names @acme/agent-qa-provider, which declares a model-provider plugin; '
        + 'only @vostride/agent-qa-* packages load inside agent-qa. Remove the entry.',
    )
    expect(
      (globalThis as { __agentQaThirdPartyProviderImported?: boolean })
        .__agentQaThirdPartyProviderImported,
    ).toBeUndefined()
  })

  it('refuses a declared plugin that is not installed, naming its entry and install line', async () => {
    const entries = [{ name: 'p', package: '@vostride/agent-qa-provider-missing' }]

    await expect(loadProviderPlugins(entries, { baseDir: tempDir })).rejects.toThrow(
      'Plugin entry p names @vostride/agent-qa-provider-missing, which is not installed. Run npm '
        + 'install --save-dev @vostride/agent-qa-provider-missing.',
    )
  })

  it('leaves a missing entry a remote names to run start', async () => {
    const entries = [{ name: 'farm', package: '@acme/agent-qa-plugin-farm' }]

    await expect(
      loadProviderPlugins(entries, { baseDir: tempDir, remotes: [{ name: 'lab', plugin: 'farm' }] }),
    ).resolves.toEqual([])
  })
})
