import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-provider-plugin-loader-'))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    clearLoadedProviderPluginModules()
    warnSpy.mockRestore()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads provider descriptors from an explicit path declaration', async () => {
    const pluginPath = join(tempDir, 'path-plugin.mjs')
    await writeFile(pluginPath, `
      export default {
        id: 'path-provider',
        label: 'Path provider',
        authModes: ['api-key'],
        adapter(transport, modelId) { return { transport, modelId, source: 'path' } },
      }
    `)

    const providers = await loadProviderPlugins([{ path: pluginPath }], { baseDir: tempDir })

    expect(providers).toHaveLength(1)
    expect(providers[0]?.id).toBe('path-provider')
    expect(providers[0]?.label).toBe('Path provider')
    expect(providers[0]?.authModes).toEqual(['api-key'])
    expect(providers[0]?.adapter({ baseURL: 'http://local' }, 'demo-model')).toEqual({
      transport: { baseURL: 'http://local' },
      modelId: 'demo-model',
      source: 'path',
    })
  })

  it('loads provider descriptors from a package declaration resolved from config directory', async () => {
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
      [{ package: '@vostride/agent-qa-acme-provider' }],
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
      { package: '@vostride/agent-qa-acme-default-provider' },
      { package: '@vostride/agent-qa-acme-array-provider' },
    ], { baseDir: tempDir })

    expect(providers.map((provider) => provider.id)).toEqual(['default-descriptor', 'array-provider'])
  })

  it('does not return descriptors for the same declaration twice', async () => {
    await writeProviderPackage(tempDir, '@vostride/agent-qa-acme-once-provider', `
      export const providers = [{
        id: 'once-provider',
        label: 'Once provider',
        authModes: ['api-key'],
        adapter() { return { source: 'once' } },
      }]
    `)

    const declarations = [{ package: '@vostride/agent-qa-acme-once-provider' }]
    const first = await loadProviderPlugins(declarations, { baseDir: tempDir })
    const second = await loadProviderPlugins(declarations, { baseDir: tempDir })

    expect(first.map((provider) => provider.id)).toEqual(['once-provider'])
    expect(second).toHaveLength(0)
  })

  it('warns once for non-empty provider declarations and not for empty loads', async () => {
    const firstPath = join(tempDir, 'first-plugin.mjs')
    await writeFile(firstPath, `
      export default {
        id: 'first-provider',
        label: 'First provider',
        authModes: ['api-key'],
        adapter() { return { source: 'first' } },
      }
    `)
    const secondPath = join(tempDir, 'second-plugin.mjs')
    await writeFile(secondPath, `
      export default {
        id: 'second-provider',
        label: 'Second provider',
        authModes: ['api-key'],
        adapter() { return { source: 'second' } },
      }
    `)

    await expect(loadProviderPlugins([], { baseDir: tempDir })).resolves.toEqual([])
    await expect(loadProviderPlugins(undefined, { baseDir: tempDir })).resolves.toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()

    await loadProviderPlugins([{ path: firstPath }], { baseDir: tempDir })
    await loadProviderPlugins([{ path: secondPath }], { baseDir: tempDir })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/first-party/i)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/in-process/i)
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
      [{ package: '@vostride/agent-qa-acme-return-only-provider' }],
      { baseDir: tempDir },
    )

    expect(providers.map((provider) => provider.id)).toEqual(['return-only-provider'])
    expect((globalThis as { __agentQaProviderPluginRegisterCalls?: number }).__agentQaProviderPluginRegisterCalls).toBe(1)
  })

  it('rejects ambiguous provider plugin declarations before import', async () => {
    await expect(loadProviderPlugins([
      { package: '@vostride/agent-qa-acme-provider', path: './plugin.mjs' } as never,
    ], { baseDir: tempDir })).rejects.toThrow(/either package or path/)

    await expect(loadProviderPlugins([
      {} as never,
    ], { baseDir: tempDir })).rejects.toThrow(/specify package or path/)
  })
})
