import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { parse as parseYaml } from 'yaml'
import pc from 'picocolors'
import { AgentQaConfigSchema, loadLLMAuthPlugins } from '@vostride/agent-qa-core'
import type { AgentQaConfig } from '@vostride/agent-qa-core'

const ENV_MAPPING: Record<string, string> = {
  AGENT_QA_DASHBOARD_PORT: 'services.dashboard.port',
  AGENT_QA_MCP_PORT: 'services.mcp.port',
  AGENT_QA_CACHE_DIR: 'services.cache.dir',
  AGENT_QA_CACHE_TTL: 'services.cache.ttl',
  AGENT_QA_LOG_LEVEL: 'services.logging.level',
  AGENT_QA_HEADLESS: 'use.browser.headless',
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function parseEnvValue(key: string, value: string): unknown {
  if (key === 'AGENT_QA_DASHBOARD_PORT' || key === 'AGENT_QA_MCP_PORT') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isInteger(parsed)) return parsed
  }
  if (key === 'AGENT_QA_HEADLESS') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return value
}

export async function loadConfigFile(configPath: string): Promise<unknown> {
  try {
    const content = await readFile(configPath, 'utf-8')
    return parseYaml(content) ?? {}
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export async function loadRequiredConfigFile(configPath: string): Promise<unknown> {
  try {
    const content = await readFile(configPath, 'utf-8')
    return parseYaml(content) ?? {}
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`)
    }
    throw err
  }
}

export function loadEnvOverrides(): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [envKey, configPath] of Object.entries(ENV_MAPPING)) {
    const value = process.env[envKey]
    if (value !== undefined) {
      setNestedValue(result, configPath, parseEnvValue(envKey, value))
    }
  }
  return result
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

export function mergeConfigs(
  file: unknown,
  env: Record<string, unknown>,
  flags: Record<string, unknown>,
): unknown {
  return deepMerge(deepMerge(file ?? {}, env), flags)
}

export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    if (key in result && isPlainObject(result[key]) && isPlainObject(override[key])) {
      result[key] = deepMerge(result[key], override[key])
    } else {
      result[key] = override[key]
    }
  }
  return result
}

export function mergeWithTestConfig(
  globalConfig: unknown,
  testConfig: unknown,
  flagOverrides: Record<string, unknown>,
): unknown {
  return deepMerge(deepMerge(globalConfig ?? {}, testConfig ?? {}), flagOverrides)
}

function normalizeConfigForValidation(config: unknown): unknown {
  if (!isPlainObject(config)) return config
  const normalized = deepMerge({}, config) as Record<string, unknown>
  const use = normalized.use
  if (isPlainObject(use)) {
    delete use.headless
  }
  return normalized
}

export function mergeUseBlocks(
  globalUse: Record<string, unknown> | undefined,
  suiteUse: Record<string, unknown> | undefined,
  testUse: Record<string, unknown> | undefined,
  cliFlags: Record<string, unknown>,
): Record<string, unknown> {
  return deepMerge(
    deepMerge(
      deepMerge(globalUse ?? {}, suiteUse ?? {}),
      testUse ?? {},
    ),
    cliFlags,
  ) as Record<string, unknown>
}

function flattenObject(obj: unknown, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    if (prefix) result[prefix] = obj
    return result
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, path))
    } else {
      result[path] = value
    }
  }
  return result
}

type ConfigSource = 'global config' | 'test yaml' | 'cli flag'

export function formatConfigDebug(
  globalConfig: unknown,
  testConfig: unknown,
  flagOverrides: Record<string, unknown>,
): string {
  const layers: { flat: Record<string, unknown>; label: ConfigSource }[] = [
    { flat: flattenObject(globalConfig), label: 'global config' },
    { flat: flattenObject(testConfig), label: 'test yaml' },
    { flat: flattenObject(flagOverrides), label: 'cli flag' },
  ]

  const merged = mergeWithTestConfig(globalConfig, testConfig, flagOverrides)
  const mergedFlat = flattenObject(merged)

  const colorize: Record<ConfigSource, (s: string) => string> = {
    'global config': pc.dim,
    'test yaml': pc.cyan,
    'cli flag': pc.green,
  }

  const rows: { key: string; value: string; source: ConfigSource }[] = []
  for (const key of Object.keys(mergedFlat).sort()) {
    let source: ConfigSource = 'global config'
    // Check layers in reverse priority order — last match wins
    for (const layer of layers) {
      if (key in layer.flat) {
        source = layer.label
      }
    }
    const valStr = typeof mergedFlat[key] === 'string' ? mergedFlat[key] : JSON.stringify(mergedFlat[key])
    rows.push({ key, value: valStr, source })
  }

  if (rows.length === 0) return pc.dim('  (no config values)')

  const maxKey = Math.max(...rows.map(r => r.key.length), 3)
  const maxVal = Math.max(...rows.map(r => r.value.length), 5)

  const header = `  ${'Key'.padEnd(maxKey)}  ${'Value'.padEnd(maxVal)}  Source`
  const sep = `  ${'─'.repeat(maxKey)}  ${'─'.repeat(maxVal)}  ${'─'.repeat(13)}`
  const lines = rows.map(r => {
    const color = colorize[r.source]
    return `  ${r.key.padEnd(maxKey)}  ${r.value.padEnd(maxVal)}  ${color(r.source)}`
  })

  return [header, sep, ...lines].join('\n')
}

export async function resolveConfig(options: {
  configPath?: string
  flags?: Record<string, unknown>
  loadAuthPlugins?: boolean
}): Promise<AgentQaConfig> {
  const configPath = options.configPath ?? 'agent-qa.config.yaml'
  const fileConfig = await loadRequiredConfigFile(configPath)
  const envOverrides = loadEnvOverrides()
  const merged = mergeConfigs(fileConfig, envOverrides, options.flags ?? {})
  const normalized = normalizeConfigForValidation(merged)

  const result = AgentQaConfigSchema.safeParse(normalized)
  if (!result.success) {
    const messages = result.error.issues.map((issue: { path: PropertyKey[]; message: string }) => {
      const path = issue.path.map(String).join('.')
      return `  ${path}: ${issue.message}`
    })
    const legacyDashboardEnabled =
      typeof merged === 'object'
      && merged !== null
      && !Array.isArray(merged)
      && typeof (merged as Record<string, unknown>).services === 'object'
      && (merged as Record<string, unknown>).services !== null
      && !Array.isArray((merged as Record<string, unknown>).services)
      && typeof ((merged as Record<string, unknown>).services as Record<string, unknown>).dashboard === 'object'
      && ((merged as Record<string, unknown>).services as Record<string, unknown>).dashboard !== null
      && !Array.isArray(((merged as Record<string, unknown>).services as Record<string, unknown>).dashboard)
      && 'enabled' in (((merged as Record<string, unknown>).services as Record<string, unknown>).dashboard as Record<string, unknown>)

    const dashboardHint = legacyDashboardEnabled
      ? `\n\nHint: services.dashboard.enabled was removed. Dashboard behavior is enabled by the presence of the services.dashboard block itself. Remove the enabled key and keep fields like port, dbPath, or artifactsDir.`
      : ''
    throw new Error(
      `Config validation failed:\n${messages.join('\n')}\n\n` +
      `Run 'agent-qa init' to generate a complete config file.` +
      dashboardHint
    )
  }
  if (options.loadAuthPlugins !== false) {
    await loadLLMAuthPlugins(result.data.plugins?.auth, {
      baseDir: dirname(resolvePath(configPath)),
    })
  }
  return result.data
}
