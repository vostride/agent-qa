import { existsSync, readFileSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import type { AgentQaConfig } from '@vostride/agent-qa-core'
import { basicAuthMaskEntries, SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import type { MaskFn } from '@vostride/agent-qa-schema'
import { loadEnvOverrides, mergeConfigs } from '../config.js'

// 'required' and 'missing' mean no secrets are declared; 'unreadable' and 'invalid' mean some may be.
export type DeclaredSecretsGap = 'required' | 'missing' | 'unreadable' | 'invalid'

export class DeclaredSecretsUnavailableError extends Error {
  readonly lines: readonly string[]
  readonly gap: DeclaredSecretsGap

  constructor(lines: readonly string[], gap: DeclaredSecretsGap) {
    super(lines.join(' '))
    this.name = 'DeclaredSecretsUnavailableError'
    this.lines = lines
    this.gap = gap
  }

  static required(): DeclaredSecretsUnavailableError {
    return new DeclaredSecretsUnavailableError(
      [
        'Error: workspace.secretsFile is required. Run `agent-qa init` or set it in agent-qa.config.yaml.',
      ],
      'required',
    )
  }
}

export interface DeclaredSecretMask {
  readonly mask: MaskFn
  redactor(): SecretRedactor
}

export function readDeclaredSecrets(secretsPath: string): SecretStore {
  if (!existsSync(secretsPath)) {
    throw new DeclaredSecretsUnavailableError(
      [
        `Error: Secrets file not found: ${secretsPath}`,
        'Create the file before running tests. It may be empty, but it must exist.',
      ],
      'missing',
    )
  }
  let content: string
  try {
    content = readFileSync(secretsPath, 'utf-8')
  } catch {
    throw new DeclaredSecretsUnavailableError(
      [
        `Error: Secrets file could not be read: ${secretsPath}`,
        'Check the path and file permissions before running tests.',
      ],
      'unreadable',
    )
  }
  try {
    return SecretStore.fromEnvContent(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new DeclaredSecretsUnavailableError(
      [`Error: Secrets file is invalid: ${message}`],
      'invalid',
    )
  }
}

export function maskWithDeclaredSecrets(store: SecretStore): MaskFn {
  const redactor = new SecretRedactor(store)
  return (text) => redactor.redactString(text)
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

// With no loadable project there are no declared secrets to read.
export function createEmptyDeclaredSecretMask(): DeclaredSecretMask {
  const redactor = new SecretRedactor(SecretStore.empty())
  return { mask: (text) => redactor.redactString(text), redactor: () => redactor }
}
