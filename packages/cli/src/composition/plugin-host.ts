import { dirname, resolve } from 'node:path'

import {
  createPluginHostPool,
  getAgentQaVersion,
  pluginHostVersions,
  pluginSecretResolver,
} from '@vostride/agent-qa-core'
import type { AgentQaConfig, PluginHostPool } from '@vostride/agent-qa-core'
import type { RemoteSessionRegistry, SecretResolver } from '@vostride/agent-qa-runner'

import { pluginMaskName } from './declared-secrets.js'
import type { MaskExtra } from './declared-secrets.js'

export interface RunPluginHostInput {
  readonly config: AgentQaConfig
  readonly configPath: string
  readonly runId?: string
  // Every declared secret; a plugin's options and a remote's settings resolve against these only.
  readonly connectionSecrets?: SecretResolver
  readonly mask: (text: string) => string
  // Joins an answer's mask values to the run's mask, each under PLUGIN_<ENTRY>.
  readonly addMaskExtras?: (entries: readonly MaskExtra[]) => void
  readonly debugLog?: (line: string) => void
  readonly sessions?: RemoteSessionRegistry
}

function secretsFileOf(config: AgentQaConfig): string {
  const file = (config as { workspace?: { secretsFile?: unknown } }).workspace?.secretsFile
  return typeof file === 'string' && file.trim() !== '' ? file : 'workspace.secretsFile'
}

// One per run invocation: it starts nothing until a remote asks its plugin for a session.
export function createRunPluginHost(input: RunPluginHostInput): PluginHostPool {
  const { addMaskExtras } = input
  return createPluginHostPool({
    configDir: dirname(resolve(input.configPath)),
    plugins: input.config.plugins ?? [],
    agentQaVersion: getAgentQaVersion(),
    hostVersions: pluginHostVersions(import.meta.url),
    resolveSecrets: pluginSecretResolver(input.connectionSecrets, secretsFileOf(input.config)),
    runFacts: input.runId === undefined ? {} : { runId: input.runId },
    marksSessions: true,
    mask: input.mask,
    ...(addMaskExtras === undefined
      ? {}
      : {
          onMask: (entry: string, values: readonly string[]) =>
            addMaskExtras(values.map((value): MaskExtra => [pluginMaskName(entry), value])),
        }),
    ...(input.debugLog === undefined ? {} : { debugLog: input.debugLog }),
    ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
  })
}
