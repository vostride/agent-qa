import {
  createPluginHostPool,
  getAgentQaVersion,
  pluginHostVersions,
  pluginSecretResolver,
  resolvePluginEntry,
  type PluginEntryInput,
  type ResolvedPluginEntry,
} from '@vostride/agent-qa-core'

import { maskWithDeclaredSecrets, readDeclaredSecrets } from '../composition/declared-secrets.js'
import type { CheckResult, DoctorCheck } from './doctor.js'
import { listedRemotes } from './doctor-remote-checks.js'

export const PLUGIN_CHECK_TIMEOUT_MS = 15_000

export interface PluginChecksInput {
  config: Record<string, unknown> | null
  configDir: string
  secretsFile?: { configuredPath: string; absolutePath: string }
  only?: string
  checkTimeoutMs?: number
}

interface PluginRemote {
  name: string
  plugin: string
  settings?: Record<string, unknown>
}

const PLUGIN_FIX =
  'Check the entry under plugins in agent-qa.config.yaml; `agent-qa plugins describe <name>` shows what it takes.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listedPlugins(config: Record<string, unknown> | null): PluginEntryInput[] {
  const plugins = config?.plugins
  if (!Array.isArray(plugins)) return []
  return plugins.filter(isRecord).flatMap((entry) =>
    typeof entry.name === 'string'
      ? [
          {
            name: entry.name,
            ...(typeof entry.package === 'string' ? { package: entry.package } : {}),
            ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
            ...(entry.options === undefined ? {} : { options: entry.options }),
          },
        ]
      : [],
  )
}

function pluginRemotes(config: Record<string, unknown> | null): PluginRemote[] {
  return listedRemotes(config).flatMap((remote) => {
    const fields = remote as unknown as Record<string, unknown>
    if (typeof fields.plugin !== 'string') return []
    return [
      {
        name: remote.name,
        plugin: fields.plugin,
        ...(isRecord(fields.settings) ? { settings: fields.settings } : {}),
      },
    ]
  })
}

// Plugin text reaches a terminal and a coding agent, so it is masked and kept to one line.
function oneLine(text: string, mask: (text: string) => string): string {
  return mask(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()
}

function identity(resolved: ResolvedPluginEntry): string {
  const protocol = resolved.manifest?.kind === 'remote' ? resolved.manifest.protocol : undefined
  return [
    resolved.label,
    resolved.origin,
    ...(resolved.version === undefined ? [] : [`version ${resolved.version}`]),
    ...(protocol === undefined ? [] : [`protocol ${protocol}`]),
  ].join(', ')
}

function declaredStore(secretsFile: PluginChecksInput['secretsFile']) {
  if (!secretsFile) return undefined
  try {
    return readDeclaredSecrets(secretsFile.absolutePath)
  } catch {
    // A missing or invalid file is the Secrets file row's to report.
    return undefined
  }
}

interface AccountCheck {
  warn: boolean
  lines: string[]
}

// `check` is session-free by the protocol, so the pool is asked for nothing else and is shut down
// before the row returns.
async function accountCheck(
  entry: PluginEntryInput,
  using: readonly PluginRemote[],
  input: PluginChecksInput,
  timeoutMs: number,
): Promise<AccountCheck> {
  const store = declaredStore(input.secretsFile)
  const mask = store === undefined ? (text: string) => text : maskWithDeclaredSecrets(store)
  const pool = createPluginHostPool({
    configDir: input.configDir,
    plugins: [entry],
    agentQaVersion: getAgentQaVersion(),
    hostVersions: pluginHostVersions(import.meta.url),
    resolveSecrets: pluginSecretResolver(
      store,
      input.secretsFile?.configuredPath ?? 'workspace.secretsFile',
    ),
    mask,
    bounds: { checkMs: timeoutMs, shutdownMs: 5_000, releaseMs: 5_000 },
  })
  try {
    const result = await pool.check(
      entry.name,
      using.map((remote) => ({
        name: remote.name,
        ...(remote.settings === undefined ? {} : { settings: remote.settings }),
      })),
    )
    if (result === undefined) return { warn: false, lines: ['no account check'] }
    const lines = result.lines.map((line) => oneLine(line, mask)).filter((line) => line !== '')
    const warn = result.state === 'warn'
    if (lines.length > 0) return { warn, lines }
    return { warn, lines: [warn ? 'the account check warned' : 'the account check passed'] }
  } catch (error) {
    return { warn: true, lines: [oneLine(error instanceof Error ? error.message : String(error), mask)] }
  } finally {
    await pool.shutdown().catch(() => undefined)
  }
}

async function pluginRow(
  entry: PluginEntryInput,
  using: readonly PluginRemote[],
  input: PluginChecksInput,
  timeoutMs: number,
): Promise<CheckResult> {
  const resolved = resolvePluginEntry(entry, {
    configDir: input.configDir,
    agentQaVersion: getAgentQaVersion(),
  })
  const parts = [identity(resolved)]
  const problems: string[] = []
  let checked: AccountCheck | undefined

  if (resolved.state !== 'ok') problems.push(resolved.state)
  const manifest = resolved.manifest
  if (manifest?.kind === 'remote') {
    const facts = manifest.runFacts ?? []
    parts.push(`receives ${facts.length === 0 ? 'session facts only' : facts.join(', ')}`)
    parts.push(`remotes ${using.length === 0 ? 'none' : using.map((remote) => remote.name).join(', ')}`)
    if (problems.length === 0) {
      checked = manifest.methods.includes('check')
        ? await accountCheck(entry, using, input, timeoutMs)
        : { warn: false, lines: ['no account check'] }
    }
  } else if (manifest !== undefined) {
    parts.push(`a ${manifest.kind} plugin that runs inside agent-qa`)
  }

  const message = [...parts, ...problems, ...(checked?.lines ?? [])].join('; ')
  return {
    status: problems.length > 0 || checked?.warn === true ? 'warn' : 'pass',
    message,
  }
}

// One row per plugins entry. Each row only reads the manifest, except the account check, which
// starts the plugin for `check` alone. A row never fails.
export function createPluginChecks(input: PluginChecksInput): DoctorCheck[] {
  const timeoutMs = input.checkTimeoutMs ?? PLUGIN_CHECK_TIMEOUT_MS
  const remotes = pluginRemotes(input.config).filter(
    (remote) => input.only === undefined || remote.name === input.only,
  )
  return listedPlugins(input.config)
    .filter(
      (entry) =>
        input.only === undefined || remotes.some((remote) => remote.plugin === entry.name),
    )
    .map((entry) => {
      const using = remotes.filter((remote) => remote.plugin === entry.name)
      return {
        name: `Plugin ${entry.name}`,
        fixInstructions: PLUGIN_FIX,
        check: async () => {
          try {
            return await pluginRow(entry, using, input, timeoutMs)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            return { status: 'warn', message: oneLine(reason, (text) => text) }
          }
        },
      }
    })
}
