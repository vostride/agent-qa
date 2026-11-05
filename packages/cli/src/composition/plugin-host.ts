import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { createPluginHostPool, getAgentQaVersion } from '@vostride/agent-qa-core'
import type { AgentQaConfig, PluginHostPool } from '@vostride/agent-qa-core'
import { RemoteRefusalError } from '@vostride/agent-qa-runner'
import type { RemoteSessionRegistry, SecretResolver } from '@vostride/agent-qa-runner'
import { SECRET_REFERENCE_PATTERN } from '@vostride/agent-qa-schema'

export interface RunPluginHostInput {
  readonly config: AgentQaConfig
  readonly configPath: string
  readonly runId?: string
  // Every declared secret; a plugin's options and a remote's settings resolve against these only.
  readonly connectionSecrets?: SecretResolver
  readonly mask: (text: string) => string
  readonly debugLog?: (line: string) => void
  readonly sessions?: RemoteSessionRegistry
}

// The package a version is read from may not export its package.json, so the folder is found.
function packageVersion(name: string, from: string): string | undefined {
  let entry: string
  try {
    entry = createRequire(from).resolve(name)
  } catch {
    return undefined
  }
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (parsed.name === name && typeof parsed.version === 'string') return parsed.version
      } catch {
        return undefined
      }
    }
    if (dirname(dir) === dir) return undefined
  }
}

// What the adapters load, so a plugin is told the versions its session will be driven with.
function installedVersion(name: string, adapterPackage: string): string {
  const here = import.meta.url
  let adapter: string | undefined
  try {
    adapter = createRequire(here).resolve(adapterPackage)
  } catch {
    adapter = undefined
  }
  return (
    (adapter === undefined ? undefined : packageVersion(name, adapter)) ??
    packageVersion(name, here) ??
    'unknown'
  )
}

function readHostVersions(): { playwright: string; webdriverio: string } {
  return {
    playwright: installedVersion('playwright-core', '@vostride/agent-qa-web'),
    webdriverio: installedVersion('webdriverio', '@vostride/agent-qa-android'),
  }
}

function secretsFileOf(config: AgentQaConfig): string {
  const file = (config as { workspace?: { secretsFile?: unknown } }).workspace?.secretsFile
  return typeof file === 'string' && file.trim() !== '' ? file : 'workspace.secretsFile'
}

function resolveReferences(
  value: unknown,
  secrets: SecretResolver | undefined,
  secretsFile: string,
): unknown {
  if (typeof value === 'string') {
    const pattern = new RegExp(SECRET_REFERENCE_PATTERN.source, 'g')
    return value.replace(pattern, (_found, name: string) => {
      if (secrets?.has(name) !== true) {
        throw new RemoteRefusalError(
          `A plugin value needs ${name}, which ${secretsFile} does not declare. Add it there.`,
          { kind: 'auth' },
        )
      }
      return secrets.require(name)
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, secrets, secretsFile))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReferences(item, secrets, secretsFile),
      ]),
    )
  }
  return value
}

// One per run invocation: it starts nothing until a remote asks its plugin for a session.
export function createRunPluginHost(input: RunPluginHostInput): PluginHostPool {
  const secretsFile = secretsFileOf(input.config)
  return createPluginHostPool({
    configDir: dirname(resolve(input.configPath)),
    plugins: input.config.plugins ?? [],
    agentQaVersion: getAgentQaVersion(),
    hostVersions: readHostVersions(),
    resolveSecrets: (value) =>
      resolveReferences(value, input.connectionSecrets, secretsFile) as Record<string, unknown>,
    runFacts: input.runId === undefined ? {} : { runId: input.runId },
    mask: input.mask,
    ...(input.debugLog === undefined ? {} : { debugLog: input.debugLog }),
    ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
  })
}
