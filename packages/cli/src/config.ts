import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { parse as parseYaml } from 'yaml'
import pc from 'picocolors'
import {
  AgentQaConfigSchema,
  KnowledgeConfigSchema,
  loadLLMAuthPlugins,
  resolveKnowledgeRoot,
  yamlParseFailureMessage,
} from '@vostride/agent-qa-core'
import type { AgentQaConfig } from '@vostride/agent-qa-core'
import type { MaskFn } from '@vostride/agent-qa-schema'
import { HARD_CUT_STEPS, INVALID_CONFIG_FIX, isHardCutIssue } from './hard-cut.js'

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

/**
 * A committed config the parser cannot read, named by WHERE and never by WHAT (395-14 · F-01).
 *
 * WHY A NAMED CLASS AND NOT A BARE `Error`. This throw leaves the loader through every config op,
 * through `resolveConfig`, and — via `refusalMessage` — into a chat turn's answer and its session
 * jsonl. A caller that wants to recognise the case (F-03's typed-refusal arm, later) needs
 * something better than a substring match on a sentence; `name` and `configPath` are that. The
 * message itself carries the path because the surfaces this reaches print a message and nothing
 * else.
 *
 * NO MEMBER INTERPOLATES THE CAUGHT ERROR'S OWN TEXT. `yaml` pretty-prints its parse errors with a
 * verbatim excerpt of the person's source, which was measured carrying a planted credential out of
 * three ops.
 *
 * AND THE CAUSE IS SANITIZED TOO, BECAUSE THE RUNTIME READS THE CAUSE CHAIN (395-16 · CR-01).
 * An earlier revision of this class attached the raw `YAMLParseError` as `cause` on the reasoning
 * that no composed member reads it. That reasoning was false of the runtime, and shipped as a
 * defect: a thrown value is read by far more than the code that composed it. Node's DEFAULT
 * UNCAUGHT PRINTER renders an error with `util.inspect`, which walks `cause` and prints it under a
 * `[cause]:` header — `agent-qa config show` awaited this loader bare and crash-printed the
 * person's own file back at them. `console.error(err)` does the same thing, structured loggers
 * (pino, winston) serialize the chain, and crash reporters upload it. So the cause carried here is
 * a fresh `Error` holding THE SAME POSITION-ONLY SENTENCE as the message: a debugger still gets a
 * chain to walk, and every one of those readers gets a position and nothing else. The caught value
 * is not reachable from this error by any property.
 */
export class ConfigFileNotYamlError extends Error {
  readonly configPath: string

  constructor(configPath: string, cause: unknown) {
    const positionOnly = `${configPath}: ${yamlParseFailureMessage(cause)}`
    super(positionOnly, { cause: new Error(positionOnly) })
    this.name = 'ConfigFileNotYamlError'
    this.configPath = configPath
  }
}

/**
 * THE READ AND THE PARSE GET SEPARATE CATCHES, and that separation is load-bearing.
 *
 * `Config file not found: <path>` is matched verbatim by the live lane's third-arm detection
 * (`scripts/395-live-from-zero.sh:514`) and folded by `coveringGrantInForce`; a non-ENOENT read
 * fault (EISDIR, EACCES) is a fact about the filesystem and not about the file's content, and is
 * rethrown untouched. Only the PARSE throw is reworded — one guard, aimed at one channel.
 */
export async function loadConfigFile(configPath: string): Promise<unknown> {
  let content: string
  try {
    content = await readFile(configPath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  try {
    return parseYaml(content) ?? {}
  } catch (err: unknown) {
    throw new ConfigFileNotYamlError(configPath, err)
  }
}

/**
 * The absent-file case, RECOGNISABLE WITHOUT A SUBSTRING MATCH ON ITS OWN SENTENCE (395-27 · WR-02).
 *
 * The message is BYTE-IDENTICAL to the bare `Error` this replaces, because that exact string is
 * matched by the live lane's third-arm detection (`scripts/395-live-from-zero.sh:514`), folded by
 * `coveringGrantInForce`, and pinned by `(E1)`. Nothing about what any surface PRINTS changes.
 *
 * What changes is that `showAction` can now ask WHICH fault this is by `instanceof` instead of by
 * `message.startsWith(...)` — the reasoning `ConfigFileNotYamlError` above already wrote down: a
 * caller that wants to recognise the case needs something better than a substring match on a
 * sentence, and a sentence-matching caller is one rewording away from silently taking the wrong arm.
 */
export class ConfigFileNotFoundError extends Error {
  readonly configPath: string

  constructor(configPath: string) {
    super(`Config file not found: ${configPath}`)
    this.name = 'ConfigFileNotFoundError'
    this.configPath = configPath
  }
}

export async function loadRequiredConfigFile(configPath: string): Promise<unknown> {
  let content: string
  try {
    content = await readFile(configPath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigFileNotFoundError(configPath)
    }
    throw err
  }
  try {
    return parseYaml(content) ?? {}
  } catch (err: unknown) {
    throw new ConfigFileNotYamlError(configPath, err)
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

/**
 * The one shaping `resolveConfig` applies before validating (395-01: exported, not moved).
 *
 * EXPORTED so the config-mutation validate port can run the SAME three steps a real run runs —
 * merge, normalize, parse. A port that skipped this would refuse a candidate whose only problem is
 * a key `resolveConfig` deletes, which is a proposal blocked by a rule nothing enforces.
 */
export function normalizeConfigForValidation(config: unknown): unknown {
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

// Every scalar is its own row (`registry.llms[0].baseURL`); an empty array stays a `[]` leaf.
// The cycle guard is path-scoped, so a repeated YAML alias renders in full and only a node that
// contains itself becomes `<circular>` (395-27 · WR-03).
const CIRCULAR_MARKER = '<circular>'

function flattenObject(
  obj: unknown,
  prefix = '',
  ancestors: readonly object[] = [],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (typeof obj !== 'object' || obj === null) {
    if (prefix) result[prefix] = obj
    return result
  }
  // BEFORE EITHER CONTAINER ARM, so a cyclic array terminates on the same rule a cyclic object does.
  if (ancestors.includes(obj)) {
    if (prefix) result[prefix] = CIRCULAR_MARKER
    return result
  }
  const path = [...ancestors, obj]
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      if (prefix) result[prefix] = obj
      return result
    }
    obj.forEach((element, index) => {
      Object.assign(result, flattenObject(element, `${prefix}[${index}]`, path))
    })
    return result
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    Object.assign(result, flattenObject(value, prefix ? `${prefix}.${key}` : key, path))
  }
  return result
}

type ConfigSource = 'global config' | 'test yaml' | 'cli flag'

// 2026-10-15 (441-20, D-29): values print as written, through the caller's declared-secret mask.
export function formatConfigDebug(
  globalConfig: unknown,
  testConfig: unknown,
  flagOverrides: Record<string, unknown>,
  mask: MaskFn,
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
    rows.push({ key, value: mask(String(valStr)), source })
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

/**
 * The privacy declaration alone, read out of the RAW document without validating it
 * (Phase 398 gap round — finding F-1 / review CR-01).
 *
 * WHY THIS EXISTS. The composition roots that emit telemetry read their config through a tolerant
 * `try { resolveConfig() } catch { undefined }`, because refusing a surface over its telemetry
 * configuration would be refusing the capability over the telemetry (T-398-32). That posture is
 * right and is unchanged. What was wrong is that the `catch` collapsed TWO different states into
 * one `undefined`:
 *
 *   1. there is no config file — nothing was ever declared, and
 *   2. there IS one, it declares `analytics.privacy: true`, and it failed schema validation for
 *      some unrelated reason (a missing `use.mobile.appState`, a legacy key, a typo three levels
 *      away).
 *
 * In state 2 a user set a shipped privacy control and was transmitted anyway, silently, with the
 * surface working normally so nothing ever looked wrong. A product cannot ship a config field and
 * then honour it only when the REST of the document happens to validate.
 *
 * READING IS NOT VALIDATING. Extracting one boolean from a parsed document does not require the
 * document to be well-formed anywhere else, so honouring the declaration costs the availability
 * posture nothing: the surface still opens, still scaffolds, still runs.
 *
 * IT READS THE SAME FILE THE VALIDATOR READ. The path expression and the loader are literally the
 * ones `resolveConfig` uses, immediately below — not a second spelling of "where the config lives".
 * A privacy read that consults a different file than the validator did would be a new defect
 * wearing this fix's clothes.
 *
 * THE UNPARSEABLE ARM FAILS CLOSED. If the file exists but is not YAML at all, no reader can tell
 * whether the declaration is in there. The cost of opting out is lost telemetry; the cost of the
 * other choice is transmitting against a declaration that may be sitting in the file. For a
 * privacy control the doubt resolves toward the user. A MISSING file is not doubt — nothing was
 * declared — so it stays `undefined`.
 */
export async function readAnalyticsPrivacyDeclaration(
  configPath?: string,
): Promise<{ analytics: { privacy: boolean } } | undefined> {
  const resolvedPath = configPath ?? 'agent-qa.config.yaml'
  let raw: unknown
  try {
    raw = await loadRequiredConfigFile(resolvedPath)
  } catch (err: unknown) {
    if (err instanceof ConfigFileNotFoundError) return undefined
    // Present but unreadable (ConfigFileNotYamlError, or an I/O error): fail closed.
    return { analytics: { privacy: true } }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const analytics = (raw as Record<string, unknown>).analytics
  if (typeof analytics !== 'object' || analytics === null || Array.isArray(analytics)) return undefined
  return (analytics as Record<string, unknown>).privacy === true
    ? { analytics: { privacy: true } }
    : undefined
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

    // Phase 408 plan 16 (W-2 / CR-02). 408-10 refined `services.dashboard.baseUrl` to an absolute
    // http(s) URL at this same parse boundary, so two previously-legal values now fail EVERY
    // `agent-qa` command through the one `safeParse` above. This is the migration path that
    // refinement shipped without, delivered through the same `Hint:` mechanism the branch directly
    // above already uses.
    //
    // WHY THIS BRANCH KEYS ON THE ISSUE SET WHILE THE `enabled` BRANCH KEYS ON THE RAW INPUT, and
    // the two must not be unified: the `enabled` branch detects a key the schema no longer knows
    // about, which therefore CANNOT appear in `result.error.issues` at all and has to be found by
    // walking `merged`. This branch detects a value the schema DOES know and refuses, so the parse
    // result itself already carries the path that objected — asking it is both narrower and more
    // honest than re-deriving the answer from the input, and it is what keeps the hint from firing
    // on failures it has nothing to do with.
    const baseUrlRefused = result.error.issues.some(
      (issue: { path: PropertyKey[] }) => issue.path.map(String).join('.') === 'services.dashboard.baseUrl',
    )
    const baseUrlHint = baseUrlRefused
      ? `\n\nHint: services.dashboard.baseUrl must now carry a scheme — write an absolute URL such as http://127.0.0.1:3470 rather than a bare host like localhost:3470, or remove the key entirely. An empty string is not an absence: absence is a legal and deliberate posture here — a standalone \`agent-qa mcp\` with no dashboard has no base, and the carrier tool result then names that absence rather than fabricating a URL. The value is refused because it is assigned to an href inside the served App document and appended verbatim to every carrier tool result, so a schemeless or empty base composes a link that resolves against nothing.`
      : ''

    // `init` refuses an existing config without --force, so the closing line is the hard cut for
    // keys removed in v2 and the key fix for any other refused config, later removals included.
    const closing = result.error.issues.some(isHardCutIssue)
      ? HARD_CUT_STEPS
      : INVALID_CONFIG_FIX(configPath)

    throw new Error(
      `Config validation failed:\n${messages.join('\n')}\n\n` +
      closing +
      dashboardHint +
      baseUrlHint
    )
  }
  if (options.loadAuthPlugins !== false) await loadConfigPlugins(result.data, configPath)
  return result.data
}

export async function loadConfigPlugins(config: AgentQaConfig, configPath: string): Promise<void> {
  await loadLLMAuthPlugins(config.plugins?.auth, {
    baseDir: dirname(resolvePath(configPath)),
  })
  const { loadProviderPluginsForRawConfig } = await import('./provider-plugins.js')
  await loadProviderPluginsForRawConfig(config, configPath)
}

/** Resolve the writer-gated knowledge root without making each CLI surface import core directly. */
export function resolveConfiguredKnowledgeRoot(
  config: AgentQaConfig,
  configDir: string,
): string {
  return resolveKnowledgeRoot(config.knowledge, configDir)
}

/**
 * The same root, from a RAW config (407 D-18/D-19).
 *
 * `doctor` deliberately loads the config unvalidated so it can REPORT on a broken one, so it
 * never has an `AgentQaConfig` to hand the resolver above. The schema's own `dir` default is what
 * makes the root knowable from a config that never mentions `knowledge` at all — reproducing that
 * default at a call site would be a second answer to "where does this project keep its knowledge".
 *
 * `null` means the question has no answer for this host: the config could not be read, or its
 * `knowledge` block is malformed enough that the directory cannot be named. It does NOT mean the
 * directory is missing — that is the caller's own existence check, because "configured but absent"
 * and "not configured" read the same to a resolver and differently to a person.
 */
export function resolveRawConfigKnowledgeRoot(
  config: Record<string, unknown> | null,
  configPath: string,
): string | null {
  if (config === null) return null
  try {
    return resolveKnowledgeRoot(
      KnowledgeConfigSchema.parse(config.knowledge ?? {}),
      dirname(resolvePath(configPath)),
    )
  } catch {
    return null
  }
}
