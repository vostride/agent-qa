import { existsSync, readFileSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import type { AgentQaConfig } from '@vostride/agent-qa-core'
import { basicAuthMaskEntries, SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import type { MaskFn } from '@vostride/agent-qa-schema'
import { loadEnvOverrides, mergeConfigs } from '../config.js'

export class DeclaredSecretsUnavailableError extends Error {
  readonly lines: readonly string[]

  constructor(lines: readonly string[]) {
    super(lines.join(' '))
    this.name = 'DeclaredSecretsUnavailableError'
    this.lines = lines
  }

  static required(): DeclaredSecretsUnavailableError {
    return new DeclaredSecretsUnavailableError([
      'Error: workspace.secretsFile is required. Run `agent-qa init` or set it in agent-qa.config.yaml.',
    ])
  }
}

export interface DeclaredSecretMask {
  readonly mask: MaskFn
  redactor(): SecretRedactor
}

export function readDeclaredSecrets(secretsPath: string): SecretStore {
  if (!existsSync(secretsPath)) {
    throw new DeclaredSecretsUnavailableError([
      `Error: Secrets file not found: ${secretsPath}`,
      'Create the file before running tests. It may be empty, but it must exist.',
    ])
  }
  let content: string
  try {
    content = readFileSync(secretsPath, 'utf-8')
  } catch {
    throw new DeclaredSecretsUnavailableError([
      `Error: Secrets file could not be read: ${secretsPath}`,
      'Check the path and file permissions before running tests.',
    ])
  }
  try {
    return SecretStore.fromEnvContent(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new DeclaredSecretsUnavailableError([`Error: Secrets file is invalid: ${message}`])
  }
}

export function maskWithDeclaredSecrets(store: SecretStore): MaskFn {
  const redactor = new SecretRedactor(store)
  return (text) => redactor.redactString(text)
}

export type MaskExtra = readonly [name: string, value: string]

export function pluginMaskName(entry: string): string {
  return `PLUGIN_${entry.toUpperCase().replace(/\W/g, '_')}`
}

// A run's redactor. Values handed over during the run, such as a plugin's answer mask, are masked
// from the moment they are added until the run ends; a declared secret keeps its own name.
export class RunSecretRedactor extends SecretRedactor {
  private readonly declared: SecretStore
  private readonly extras: MaskExtra[]
  private generation = 0
  private widened: { generation: number; redactor: SecretRedactor } | undefined

  constructor(store: SecretStore, extras: readonly MaskExtra[] = []) {
    super(store, extras)
    this.declared = store
    this.extras = [...extras]
  }

  addMaskExtras(entries: readonly MaskExtra[]): void {
    const added = entries.filter(([, value]) => value.length > 0)
    if (added.length === 0) return
    this.extras.push(...added)
    this.generation += 1
  }

  override redactString(value: string): string {
    if (this.generation === 0) return super.redactString(value)
    if (this.widened?.generation !== this.generation) {
      this.widened = {
        generation: this.generation,
        redactor: new SecretRedactor(this.declared, this.extras),
      }
    }
    return this.widened.redactor.redactString(value)
  }
}

type RemoteBasicAuth = { basicAuth?: { user: string; password: string } }

interface ResolvedConfig {
  readonly secretsPath: string
  readonly remotes: readonly RemoteBasicAuth[]
}

function basicAuthRemotes(remotes: unknown): RemoteBasicAuth[] {
  if (!Array.isArray(remotes)) return []
  return remotes.map((entry: unknown) => {
    const basicAuth = (entry as { basicAuth?: { user?: unknown; password?: unknown } } | null)
      ?.basicAuth
    const user = basicAuth?.user
    const password = basicAuth?.password
    return typeof user === 'string' && typeof password === 'string'
      ? { basicAuth: { user, password } }
      : {}
  })
}

function resolveConfig(configPath: string): ResolvedConfig {
  // yaml's warnings quote the file's text, so only its errors are reported.
  const file = parseYaml(readFileSync(configPath, 'utf-8'), { logLevel: 'error' }) ?? {}
  const config = mergeConfigs(file, loadEnvOverrides(), {}) as AgentQaConfig | null
  const configured: unknown = config?.workspace?.secretsFile
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    throw DeclaredSecretsUnavailableError.required()
  }
  const workspace = resolveWorkspacePaths({ config: config!, configPath })
  return {
    secretsPath: workspace.secretsFile.absolutePath,
    remotes: basicAuthRemotes((config?.registry as { remotes?: unknown } | undefined)?.remotes),
  }
}

function statKey(path: string): string {
  const stat = statSync(path)
  return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
}

// The secrets path and the remotes re-resolve when the config changes; an unreadable config is
// never cached. Each remote's Basic value is masked under the secret it names.
export function createDeclaredSecretMask(configPath: string): DeclaredSecretMask {
  let resolved: (ResolvedConfig & { configKey: string }) | undefined
  let cached: { key: string; redactor: SecretRedactor } | undefined

  const currentConfig = (): ResolvedConfig & { configKey: string } => {
    const configKey = statKey(configPath)
    if (resolved?.configKey !== configKey) {
      resolved = undefined
      resolved = { configKey, ...resolveConfig(configPath) }
    }
    return resolved
  }

  const redactor = (): SecretRedactor => {
    const { configKey, secretsPath, remotes } = currentConfig()
    let key: string | undefined
    try {
      key = `${configKey}\0${secretsPath}\0${statKey(secretsPath)}`
    } catch {
      key = undefined
    }
    if (key !== undefined && cached?.key === key) return cached.redactor
    const store = readDeclaredSecrets(secretsPath)
    const current = new SecretRedactor(store, basicAuthMaskEntries(remotes, store))
    cached = key === undefined ? undefined : { key, redactor: current }
    return current
  }

  return { mask: (text) => redactor().redactString(text), redactor }
}
