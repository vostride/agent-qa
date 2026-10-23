import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { MARKER_WRITTEN_BACK_SENTENCE } from '@vostride/agent-qa-schema'
import { formatConfigDebug, loadConfigFile, loadRequiredConfigFile, loadEnvOverrides, mergeConfigs, mergeWithTestConfig, mergeUseBlocks, resolveConfig } from '../config.js'
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
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    services: {
      cache: { dir: '.agent-qa/cache', ttl: '7d' },
      logging: { level: 'warn' },
      vision: { screenshotSize: '1m' },
    },
    registry: {
      llms: [{
        name: 'default',
        provider: 'openai-compatible',
        model: 'gpt-4o',
        baseURL: 'https://api.openai.com/v1',
      }],
    },
    use: {
      browser: { name: 'chromium', headless: true },
      mobile: { appState: 'preserve' },
      timeout: { step: '30s', test: '10m', navigation: '10s' },
      planner: { maxActions: 10, maxPlanningTurns: 10, previousStepCount: 5 },
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
  it.each([undefined, {}, { keepFailuresOnly: true }, { enabled: true }, { enabled: false }])(
    'resolves recording defaults without rewriting the authored file: %j', async recording => {
      const configPath = join(TMP_DIR, 'recording-default.yaml')
      const input = makeValidConfig({ services: recording === undefined ? undefined : { recording } })
      const source = JSON.stringify(input)
      await writeFile(configPath, source)
      const config = await resolveConfig({ configPath, loadAuthPlugins: false })
      expect(config.services?.recording).toEqual({ enabled: true, ...recording })
      expect(await readFile(configPath, 'utf8')).toBe(source)
    },
  )

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
    const testYaml = { use: { planner: { maxActions: 42 } } }
    const result = mergeWithTestConfig(global, testYaml, {}) as Record<string, unknown>
    expect((result.use as any).planner).toEqual({ maxActions: 42, maxPlanningTurns: 10, previousStepCount: 5 })
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

  // Phase 408 plan 16, W-2 / CR-02. 408-10 refined `services.dashboard.baseUrl` to an absolute
  // http(s) URL at the parse boundary, which makes two previously-legal values fail EVERY
  // `agent-qa` command through the one `safeParse` that throws. These cells assert the migration
  // path an operator reads, and the negative control asserts it attaches to nothing else.
  it('adds a migration hint when services.dashboard.baseUrl is a schemeless host', async () => {
    const configPath = join(TMP_DIR, 'baseurl-schemeless.yaml')
    const { stringify } = await import('yaml')
    const cfg = makeValidConfig()
    ;(cfg.services as Record<string, unknown>).dashboard = { baseUrl: 'localhost:3470' }
    await writeFile(configPath, stringify(cfg))

    try {
      await resolveConfig({ configPath })
      throw new Error('expected resolveConfig to reject')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('services.dashboard.baseUrl must be an absolute http(s) URL')
      expect(msg).toContain('Hint:')
      expect(msg).toContain('http://127.0.0.1:3470')
      expect(msg).toContain('remove the key')
    }
  })

  it('adds the same migration hint when services.dashboard.baseUrl is an empty string', async () => {
    const configPath = join(TMP_DIR, 'baseurl-empty.yaml')
    const { stringify } = await import('yaml')
    const cfg = makeValidConfig()
    ;(cfg.services as Record<string, unknown>).dashboard = { baseUrl: '' }
    await writeFile(configPath, stringify(cfg))

    try {
      await resolveConfig({ configPath })
      throw new Error('expected resolveConfig to reject')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('services.dashboard.baseUrl must be an absolute http(s) URL')
      expect(msg).toContain('Hint:')
      expect(msg).toContain('http://127.0.0.1:3470')
      expect(msg).toContain('remove the key')
    }
  })

  // Negative control: the hint is a function of the parse result's issue set, not of the failure.
  // An unconditional hint reds here rather than shipping.
  it('does not add the baseUrl hint to an unrelated validation failure', async () => {
    const configPath = join(TMP_DIR, 'unrelated-invalid.yaml')
    await writeFile(configPath, 'invalid: true\n')

    try {
      await resolveConfig({ configPath })
      throw new Error('expected resolveConfig to reject')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('Config validation failed')
      expect(msg).not.toContain('services.dashboard.baseUrl must now carry a scheme')
      expect(msg).not.toContain('http://127.0.0.1:3470')
    }
  })

  it('still resolves a config whose services.dashboard.baseUrl is an absolute http(s) URL', async () => {
    const configPath = join(TMP_DIR, 'baseurl-absolute.yaml')
    const { stringify } = await import('yaml')
    const cfg = makeValidConfig()
    ;(cfg.services as Record<string, unknown>).dashboard = { baseUrl: 'http://127.0.0.1:3470' }
    await writeFile(configPath, stringify(cfg))

    const config = await resolveConfig({ configPath })
    expect(config.services?.dashboard?.baseUrl).toBe('http://127.0.0.1:3470')
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

async function runConfigCommand(
  dir: string,
  args: string[],
): Promise<{ output: string; stdout: string; stderr: string; exitCode: number }> {
  const cwd = process.cwd()
  const exitCodeBefore = process.exitCode
  process.exitCode = undefined
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    process.chdir(dir)
    const { createConfigCommand } = await import('../commands/config.js')
    await createConfigCommand().parseAsync(['node', 'config', ...args], { from: 'node' })
    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => call.join(' '))
      .join('\n')
    const stdout = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    const stderr = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    return { output, stdout, stderr, exitCode: Number(process.exitCode ?? 0) }
  } finally {
    process.chdir(cwd)
    process.exitCode = exitCodeBefore
    logSpy.mockRestore()
    errorSpy.mockRestore()
  }
}

describe('C441-CONFIG', () => {
  it('config show prints an undeclared credential-named value as written and a declared value as its marker', async () => {
    const dir = join(TMP_DIR, 'show-441')
    await mkdir(dir, { recursive: true })
    const config = makeValidConfig({
      registry: {
        llms: [{
          name: 'default',
          provider: 'openai-compatible',
          model: 'gpt-4o',
          baseURL: 'https://api.openai.com/v1',
          providerHeaders: { 'X-Api-Key': 'plain-441-value' },
        }],
      },
    })
    ;(config.use as Record<string, unknown>).buildTag = 'Hunter-42-zz'
    await writeFile(join(dir, 'agent-qa.config.yaml'), JSON.stringify(config))
    await writeFile(join(dir, '.env.secrets.local'), 'PW_441=Hunter-42-zz\n')

    const { output, exitCode } = await runConfigCommand(dir, ['show'])

    expect(output).toContain('registry.llms[0].providerHeaders.X-Api-Key')
    expect(output).toContain('plain-441-value')
    expect(output).toContain('[secret:PW_441]')
    expect(output).not.toContain('Hunter-42-zz')
    expect(output).not.toContain('<redacted>')
    expect(exitCode).toBe(0)
  })

  it('config show refuses at start when the secrets file cannot be read', async () => {
    const dir = join(TMP_DIR, 'show-refuse-441')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent-qa.config.yaml'), JSON.stringify(makeValidConfig()))

    const { output, exitCode } = await runConfigCommand(dir, ['show'])

    expect(output).toContain('Secrets file not found')
    expect(output).not.toContain('Resolved Configuration')
    expect(exitCode).toBe(1)
  })

  it('config set writes a credential-named key and a credential-shaped value', async () => {
    const dir = join(TMP_DIR, 'set-441')
    await mkdir(dir, { recursive: true })

    const named = await runConfigCommand(dir, ['set', 'apiToken', 'sk-test-441'])
    const shaped = await runConfigCommand(dir, ['set', 'use.buildTag', 'AKIAIOSFODNN7EXAMPLE'])

    expect(named.exitCode).toBe(0)
    expect(shaped.exitCode).toBe(0)
    const written = await readFile(join(dir, 'agent-qa.config.yaml'), 'utf-8')
    expect(written).toContain('apiToken: sk-test-441')
    expect(written).toContain('buildTag: AKIAIOSFODNN7EXAMPLE')
  })

  it("the --debug table masks with the run's declared secrets", () => {
    const redactor = new SecretRedactor(SecretStore.fromEnvContent('PW_441=Hunter-42-zz\n'))
    process.env.AGENT_QA_CACHE_DIR = 'sk-env-only-441-cache'
    const globalConfig = mergeConfigs(makeValidConfig(), loadEnvOverrides(), {})

    const table = formatConfigDebug(
      globalConfig,
      { buildTag: 'Hunter-42-zz' },
      {},
      (text) => redactor.redactString(text),
    )

    expect(table).toContain('[secret:PW_441]')
    expect(table).not.toContain('Hunter-42-zz')
    expect(table).toContain('services.cache.dir')
    expect(table).toContain('sk-env-only-441-cache')
    expect(table).not.toContain('<redacted>')
  })
})

describe('C441-GAP-CONFIG', () => {
  it('config set prints a declared value only as its marker and writes it as typed', async () => {
    const dir = join(TMP_DIR, 'set-gap-declared')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent-qa.config.yaml'), JSON.stringify(makeValidConfig()))
    await writeFile(join(dir, '.env.secrets.local'), 'PW_441=Hunter-42-zz\n')

    const { output, exitCode } = await runConfigCommand(dir, [
      'set',
      'use.buildTag',
      'Hunter-42-zz',
    ])

    const written = await readFile(join(dir, 'agent-qa.config.yaml'), 'utf-8')
    expect(written).toContain('Hunter-42-zz')
    expect(output).toContain('use.buildTag = [secret:PW_441] saved to')
    expect(output).not.toContain('Hunter-42-zz')
    expect(exitCode).toBe(0)
  })

  it('config set still writes without a secrets file and prints its line without the value', async () => {
    const dir = join(TMP_DIR, 'set-gap-missing')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent-qa.config.yaml'), JSON.stringify(makeValidConfig()))

    const { output, exitCode } = await runConfigCommand(dir, [
      'set',
      'use.buildTag',
      'Hunter-42-zz',
    ])

    const written = await readFile(join(dir, 'agent-qa.config.yaml'), 'utf-8')
    expect(written).toContain('Hunter-42-zz')
    expect(output).toContain('use.buildTag saved to')
    expect(output).not.toContain('Hunter-42-zz')
    expect(exitCode).toBe(0)
  })
})

describe('C441-GAP2-CONFIG', () => {
  async function markerWorkspace(name: string): Promise<{ dir: string; before: string }> {
    const dir = join(TMP_DIR, name)
    await mkdir(dir, { recursive: true })
    const config = makeValidConfig()
    ;(config.use as Record<string, unknown>).buildTag = 'real-tag'
    await writeFile(join(dir, 'agent-qa.config.yaml'), JSON.stringify(config))
    await writeFile(join(dir, '.env.secrets.local'), 'PW_441=Hunter-42-zz\n')
    return { dir, before: await readFile(join(dir, 'agent-qa.config.yaml'), 'utf-8') }
  }

  it('config set refuses a value holding a shown marker and leaves the file unchanged', async () => {
    const { dir, before } = await markerWorkspace('set-gap2-value')

    const { stdout, stderr, exitCode } = await runConfigCommand(dir, [
      'set',
      'use.buildTag',
      '[secret:PW_441]',
    ])

    expect(exitCode).toBe(1)
    expect(stderr).toContain('marker_written_back')
    expect(stderr).toContain(MARKER_WRITTEN_BACK_SENTENCE)
    expect(stdout).not.toContain('saved to')
    expect(await readFile(join(dir, 'agent-qa.config.yaml'), 'utf-8')).toBe(before)
  })

  it('config set refuses a key path holding a shown marker and leaves the file unchanged', async () => {
    const { dir, before } = await markerWorkspace('set-gap2-key')

    const { stdout, stderr, exitCode } = await runConfigCommand(dir, [
      'set',
      'registry.targets.[secret:X]-web.url',
      'https://shop.test',
    ])

    expect(exitCode).toBe(1)
    expect(stderr).toContain('marker_written_back')
    expect(stderr).toContain(MARKER_WRITTEN_BACK_SENTENCE)
    expect(stdout).not.toContain('saved to')
    expect(await readFile(join(dir, 'agent-qa.config.yaml'), 'utf-8')).toBe(before)
  })
})

// 2026-10-19 (445-07, D-23, D-15): a config with keys removed in v2 closes with the hard-cut
// steps; any other invalid config names the key and the fix.
describe('C445-CONFIG-HINT', () => {
  const RE_INITIALIZE_URL = 'https://vostride.com/docs/agent-qa/migrate/v0-1-to-v0-2'
  const OLD_INIT_LINE = "Run 'agent-qa init' to generate a complete config file."
  const BASE_YAML = [
    'registry:',
    '  llms:',
    '    - name: default',
    '      provider: openai-compatible',
    '      model: gpt-4o',
    '      baseURL: https://api.openai.com/v1',
  ].join('\n')
  const WORKSPACE_YAML = [
    'workspace:',
    '  testMatch:',
    '    - tests/**/*.yaml',
    '  suiteMatch:',
    '    - suites/**/*.suite.yaml',
    '  hooksFile: hooks.yaml',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
  ].join('\n')
  const V1_YAML = [
    WORKSPACE_YAML,
    '  agentRules: ./agent-rules.md',
    'services:',
    '  memory:',
    '    enabled: true',
    '    provider: local',
    '    dir: agent-qa-memory',
    BASE_YAML,
    'use:',
    '  llm: default',
    '  planner:',
    '    maxSubActions: 10',
    '',
  ].join('\n')
  const UNKNOWN_KEY_YAML = [WORKSPACE_YAML, BASE_YAML, 'use:', '  llm: default', 'planer: {}', ''].join('\n')

  async function failureOf(name: string, source: string): Promise<{ configPath: string; text: string }> {
    const configPath = join(TMP_DIR, name)
    await writeFile(configPath, source)
    const error = await resolveConfig({ configPath, loadAuthPlugins: false }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(Error)
    return { configPath, text: (error as Error).message }
  }

  it('a config with keys removed in v2 closes with the hard cut steps', async () => {
    const { text } = await failureOf('v1.yaml', V1_YAML)
    expect(text).toContain('Config validation failed')
    expect(text).toContain('agent-qa init --force')
    expect(text).toContain('.agent-qa/')
    expect(text).toContain('agent-qa-knowledge/')
    expect(text).toContain('agent-qa-memory/')
    expect(text).toContain('agent-qa daemon stop')
    expect(text).toContain(RE_INITIALIZE_URL)
    expect(text).not.toContain(OLD_INIT_LINE)
    expect(text).not.toContain('./agent-rules.md')
  })

  it('the removed-key messages name no internal phase or spec section', async () => {
    const { text } = await failureOf('v1.yaml', V1_YAML)
    expect(text).toContain('services.memory.dir')
    expect(text).toContain('workspace.agentRules')
    expect(text).toContain('knowledge.dir')
    expect(text).toContain('policies/<scope>.md')
    expect(text).not.toMatch(/Phase \d+/)
    expect(text).not.toMatch(/knowledge-store\.md/)
  })

  it('an invalid config that is not from v1 names the key and the fix, not the init line', async () => {
    const { configPath, text } = await failureOf('unknown-key.yaml', UNKNOWN_KEY_YAML)
    expect(text).toContain('Config validation failed')
    expect(text).toContain('planer')
    expect(text).toContain(`Fix or remove the key named above in ${configPath}`)
    expect(text).toContain('agent-qa validate')
    expect(text).toContain('agent-qa init --force')
    expect(text).not.toContain(OLD_INIT_LINE)
    expect(text).not.toContain('agent-qa daemon stop')
    expect(text).not.toContain(RE_INITIALIZE_URL)
  })
})
