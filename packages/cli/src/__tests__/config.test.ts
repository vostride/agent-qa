import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadConfigFile, loadRequiredConfigFile, loadEnvOverrides, mergeConfigs, mergeWithTestConfig, mergeUseBlocks, resolveConfig } from '../config.js'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TMP_DIR = join(tmpdir(), 'agent-qa-config-test-' + process.pid)

function makeValidConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      agentRules: './agent-rules.md',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    services: {
      cache: { dir: '.agent-qa/cache', ttl: '7d' },
      logging: { level: 'warn' },
    },
    registry: {
      llms: [{
        name: 'default',
        provider: 'openai-compatible',
        model: 'gpt-4o',
        baseURL: 'https://api.openai.com/v1',
        screenshotSize: '1m',
      }],
    },
    use: {
      browser: { name: 'chromium', headless: true },
      mobile: { appState: 'preserve' },
      timeout: { step: '30s', test: '10m', navigation: '10s' },
      healing: { maxAttempts: 3 },
      planner: { maxSubActions: 10, previousStepCount: 5 },
      llm: 'default',
    },
    ...overrides,
  }
}

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AGENT_QA_')) delete process.env[key]
  }
})

describe('loadConfigFile', () => {
  it('parses valid YAML config', async () => {
    const configPath = join(TMP_DIR, 'agent-qa.config.yaml')
    await writeFile(
      configPath,
      `workspace:
  testMatch:
    - "tests/**/*.yaml"
`,
    )
    const result = await loadConfigFile(configPath)
    expect(result).toEqual({ workspace: { testMatch: ['tests/**/*.yaml'] } })
  })

  it('returns empty object for missing file', async () => {
    const result = await loadConfigFile(join(TMP_DIR, 'nonexistent.yaml'))
    expect(result).toEqual({})
  })

  it('throws for missing required config file', async () => {
    await expect(loadRequiredConfigFile(join(TMP_DIR, 'nonexistent.yaml'))).rejects.toThrow('Config file not found')
  })

  it('throws on invalid YAML (non-ENOENT errors)', async () => {
    const dir = join(TMP_DIR, 'is-a-dir.yaml')
    await mkdir(dir)
    await expect(loadConfigFile(dir)).rejects.toThrow()
  })
})

describe('loadEnvOverrides', () => {
  it('maps AGENT_QA_DASHBOARD_PORT to services.dashboard.port', () => {
    process.env.AGENT_QA_DASHBOARD_PORT = '4000'
    const result = loadEnvOverrides()
    expect(result).toEqual({
      services: { dashboard: { port: 4000 } },
    })
  })

  it('maps AGENT_QA_MCP_PORT to services.mcp.port', () => {
    process.env.AGENT_QA_MCP_PORT = '3472'
    const result = loadEnvOverrides()
    expect(result).toEqual({
      services: { mcp: { port: 3472 } },
    })
  })

  it('maps AGENT_QA_CACHE_DIR to services.cache.dir', () => {
    process.env.AGENT_QA_CACHE_DIR = '/tmp/cache'
    process.env.AGENT_QA_CACHE_TTL = '24h'
    const result = loadEnvOverrides()
    expect(result).toEqual({ services: { cache: { dir: '/tmp/cache', ttl: '24h' } } })
  })

  it('maps AGENT_QA_HEADLESS=true to use.browser.headless boolean true', () => {
    process.env.AGENT_QA_HEADLESS = 'true'
    const result = loadEnvOverrides()
    expect(result).toEqual({ use: { browser: { headless: true } } })
  })

  it('maps AGENT_QA_HEADLESS=false to use.browser.headless boolean false', () => {
    process.env.AGENT_QA_HEADLESS = 'false'
    const result = loadEnvOverrides()
    expect(result).toEqual({ use: { browser: { headless: false } } })
  })

  it('returns empty object when no AGENT_QA_ vars set', () => {
    expect(loadEnvOverrides()).toEqual({})
  })
})

describe('mergeConfigs', () => {
  it('deep merges three layers with correct precedence', () => {
    const file = { use: { platform: 'web', llm: 'default' }, services: { cache: { dir: '.cache' } } }
    const env = { use: { platform: 'android' } }
    const flags = { use: { llm: 'gpt4' } }
    const result = mergeConfigs(file, env, flags) as Record<string, unknown>
    expect((result.use as Record<string, unknown>).platform).toBe('android')
    expect((result.use as Record<string, unknown>).llm).toBe('gpt4')
    expect((result.services as Record<string, unknown>).cache).toEqual({ dir: '.cache' })
  })

  it('flags override env which override file', () => {
    const result = mergeConfigs(
      { use: { platform: 'web' } },
      { use: { platform: 'android' } },
      { use: { platform: 'ios' } },
    )
    expect((result as Record<string, unknown>).use).toEqual({ platform: 'ios' })
  })

  it('arrays are replaced not merged', () => {
    const result = mergeConfigs(
      { registry: { llms: [{ name: 'a' }] } },
      { registry: { llms: [{ name: 'b' }] } },
      {},
    )
    expect((result as any).registry.llms).toEqual([{ name: 'b' }])
  })

  it('handles null/empty base gracefully', () => {
    const result = mergeConfigs(null, { use: { platform: 'web' } }, {})
    expect(result).toEqual({ use: { platform: 'web' } })
  })
})

describe('mergeUseBlocks', () => {
  it('4-layer merge: global < suite < test < CLI flags', () => {
    const globalUse = { platform: 'web', timeout: { step: '30s', test: '5m' } } as Record<string, unknown>
    const suiteUse = { timeout: { step: '1m' } } as Record<string, unknown>
    const testUse = { llm: 'gpt4' } as Record<string, unknown>
    const cliFlags = { timeout: { step: '90s' } } as Record<string, unknown>
    const result = mergeUseBlocks(globalUse, suiteUse, testUse, cliFlags)
    expect((result.timeout as any).step).toBe('90s')
    expect((result.timeout as any).test).toBe('5m')
    expect(result.platform).toBe('web')
    expect(result.llm).toBe('gpt4')
  })

  it('handles undefined layers gracefully', () => {
    const result = mergeUseBlocks(undefined, undefined, { llm: 'claude' }, {})
    expect(result).toEqual({ llm: 'claude' })
  })

  it('deep merges mobile app state with test overriding suite and global', () => {
    const globalUse = { mobile: { appState: 'preserve' }, timeout: { test: '10m' } }
    const suiteUse = { mobile: { appState: 'reset' } }
    const testUse = { mobile: { appState: 'preserve' } }
    const cliFlags = {}

    const result = mergeUseBlocks(globalUse, suiteUse, testUse, cliFlags)

    expect((result.mobile as any).appState).toBe('preserve')
    expect((result.timeout as any).test).toBe('10m')
  })

  it('deep merges mobile app state with suite overriding global when test has no mobile override', () => {
    const globalUse = { mobile: { appState: 'preserve' }, timeout: { test: '10m' } }
    const suiteUse = { mobile: { appState: 'reset' } }
    const testUse = {}
    const cliFlags = {}

    const result = mergeUseBlocks(globalUse, suiteUse, testUse, cliFlags)

    expect((result.mobile as any).appState).toBe('reset')
    expect((result.timeout as any).test).toBe('10m')
  })
})

describe('mergeWithTestConfig', () => {
  it('3-layer merge: global < test YAML < CLI flags', () => {
    const global = makeValidConfig()
    const testYaml = { use: { timeout: { step: '1m' } } }
    const flags = { use: { timeout: { step: '90s' } } }
    const result = mergeWithTestConfig(global, testYaml, flags) as Record<string, unknown>
    expect((result.use as any).timeout.step).toBe('90s')
  })

  it('test YAML overrides global config', () => {
    const global = makeValidConfig()
    const testYaml = { use: { healing: { strategy: 'two-tier' } } }
    const result = mergeWithTestConfig(global, testYaml, {}) as Record<string, unknown>
    expect((result.use as any).healing.strategy).toBe('two-tier')
  })

  it('handles null testConfig gracefully', () => {
    const global = makeValidConfig()
    const result = mergeWithTestConfig(global, null, {}) as Record<string, unknown>
    expect((result.use as any).timeout.step).toBe('30s')
  })
})

describe('resolveConfig', () => {
  it('loads and validates a complete 4-bucket config', async () => {
    const configPath = join(TMP_DIR, 'agent-qa.config.yaml')
    const { stringify } = await import('yaml')
    await writeFile(configPath, stringify(makeValidConfig({
      registry: {
        llms: [{
          name: 'default',
          provider: 'openai-compatible',
          model: 'gpt-4o',
          baseURL: 'https://api.openai.com/v1',
          screenshotSize: '1m',
        }],
        targets: {
          myapp: { platform: 'web', url: 'https://example.com' },
        },
      },
    })))
    const config = await resolveConfig({ configPath })
    expect(config.registry?.llms[0]).toMatchObject({
      name: 'default',
      provider: 'openai-compatible',
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
    })
    expect(config.use?.llm).toBe('default')
    expect(config.registry?.targets?.myapp).toBeDefined()
  })

  it('throws formatted error with field paths on invalid config', async () => {
    const configPath = join(TMP_DIR, 'bad.yaml')
    await writeFile(configPath, 'invalid: true\n')
    await expect(resolveConfig({ configPath })).rejects.toThrow('Config validation failed')
    try {
      await resolveConfig({ configPath })
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('agent-qa init')
    }
  })

  it('throws a clear error when runtime config is missing', async () => {
    await expect(resolveConfig({ configPath: join(TMP_DIR, 'missing.yaml') })).rejects.toThrow('Config file not found')
  })

  it('adds a targeted hint for legacy services.dashboard.enabled configs', async () => {
    const configPath = join(TMP_DIR, 'legacy-dashboard.yaml')
    await writeFile(configPath, `services:\n  dashboard:\n    enabled: true\n`)

    await expect(resolveConfig({ configPath })).rejects.toThrow('services.dashboard.enabled was removed')
  })

  it('merges env vars into config (services paths)', async () => {
    const configPath = join(TMP_DIR, 'partial.yaml')
    const { stringify } = await import('yaml')
    await writeFile(configPath, stringify(makeValidConfig()))
    process.env.AGENT_QA_CACHE_DIR = '/custom/cache'
    const config = await resolveConfig({ configPath })
    expect(config.services?.cache?.dir).toBe('/custom/cache')
  })

  it('normalizes legacy root use.headless out of resolved config without copying it', async () => {
    const configPath = join(TMP_DIR, 'legacy-headless.yaml')
    const { stringify } = await import('yaml')
    await writeFile(configPath, stringify(makeValidConfig({
      use: {
        browser: { name: 'chromium', headless: false },
        mobile: { appState: 'preserve' },
        headless: true,
        llm: 'default',
      },
    })))

    const config = await resolveConfig({ configPath })

    expect((config.use as any).headless).toBeUndefined()
    expect(config.use?.browser?.headless).toBe(false)
  })
})

describe('config command', () => {
  it.each([
    'openai.apiKey',
    'registry.llms.0.authToken',
    'registry.providers.browserstack.accessKey',
    'openai.apikey',
    'credentials.secret',
    'credentials.password',
  ])('rejects credential-like key %s and routes users to auth set', async (key) => {
    const cwd = process.cwd()
    const dir = join(TMP_DIR, key.replace(/[^a-z0-9]+/gi, '-'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await mkdir(dir, { recursive: true })
      process.chdir(dir)
      const { createConfigCommand } = await import('../commands/config.js')
      await createConfigCommand().parseAsync(['node', 'config', 'set', key, 'sk-test'], { from: 'node' })

      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(output).toContain('Credential values are not written by config set.')
      expect(output).toContain('agent-qa auth set --config <name> --type api-key|bearer-token')
      expect(output).not.toContain('sk-test')
      await expect(readFile(join(dir, 'agent-qa.config.yaml'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      process.chdir(cwd)
      errorSpy.mockRestore()
    }
  })
})
