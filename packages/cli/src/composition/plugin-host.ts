import { dirname, resolve } from 'node:path'

import {
  createPluginHostPool,
  formatLogEntry,
  getAgentQaVersion,
  pluginHostVersions,
  pluginSecretResolver,
  printRunText,
} from '@vostride/agent-qa-core'
import type { AgentQaConfig, PluginHostPool, PluginHostProgress } from '@vostride/agent-qa-core'
import { pluginMaskName } from '@vostride/agent-qa-runner'
import type {
  MaskExtra,
  RemoteLeaseSource,
  RemoteProgress,
  RemoteProgressRelay,
  RemoteSessionRegistry,
  SecretResolver,
} from '@vostride/agent-qa-runner'

export interface RunPluginHostInput {
  readonly config: AgentQaConfig
  readonly configPath: string
  readonly runId?: string
  // Every declared secret; a plugin's options and a remote's settings resolve against these only.
  readonly connectionSecrets?: SecretResolver
  readonly mask: (text: string) => string
  // Joins an answer's mask values to the run's mask, each under PLUGIN_<ENTRY>.
  readonly addMaskExtras?: (entries: readonly MaskExtra[]) => void
  // Each call's progress, masked and cut to one line.
  readonly onProgress?: (event: PluginHostProgress) => void
  readonly debugLog?: (line: string) => void
  readonly sessions?: RemoteSessionRegistry
}

function secretsFileOf(config: AgentQaConfig): string {
  const file = (config as { workspace?: { secretsFile?: unknown } }).workspace?.secretsFile
  return typeof file === 'string' && file.trim() !== '' ? file : 'workspace.secretsFile'
}

// The host has masked and named each line already. It prints on stderr; under GitHub Actions its
// guarded block shares the run's stream, which is stderr only while an action reserves stdout.
export function pluginDebugLog(logLevel: string): ((line: string) => void) | undefined {
  if (logLevel !== 'debug') return undefined
  return (line) => {
    const text = formatLogEntry({
      id: '',
      stepId: null,
      runId: '',
      level: 'debug',
      source: 'adapter',
      message: line,
      data: {},
      timestamp: new Date().toISOString(),
    })
    printRunText(text, (shown) => process.stderr.write(shown + '\n'))
  }
}

// The fold run's door and producer apply, for doors that have no producer.
export function doorLogLevel(
  flags: { logLevel?: string; verbose?: boolean; quiet?: boolean },
  config: unknown,
): string {
  if (flags.logLevel !== undefined) return flags.logLevel
  if (flags.verbose === true) return 'debug'
  if (flags.quiet === true) return 'silent'
  const level = (config as { services?: { logging?: { level?: unknown } } } | null)?.services
    ?.logging?.level
  return typeof level === 'string' ? level : 'warn'
}

// One per run invocation: it starts nothing until a remote asks its plugin for a session.
export function createRunPluginHost(input: RunPluginHostInput): PluginHostPool {
  const { addMaskExtras, onProgress } = input
  return createPluginHostPool({
    configDir: dirname(resolve(input.configPath)),
    configPath: input.configPath,
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
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(input.debugLog === undefined ? {} : { debugLog: input.debugLog }),
    ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
  })
}

export interface RemoteProgressEvent extends RemoteProgress {
  remote: string
  // The member whose session it is; a suite's shared session names none.
  testIndex?: number
}

export interface RemoteProgressSource extends RemoteProgressRelay {
  emit(event: RemoteProgressEvent): void
}

// The one path from a producer's plugin host to its run's bus. An emit while no bus is attached
// is dropped: the pool's own listener has already printed the line.
export function createRemoteProgressRelay(): RemoteProgressSource {
  let publish: ((event: RemoteProgressEvent) => void) | undefined
  return {
    attach(next) {
      publish = next
      return () => {
        if (publish === next) publish = undefined
      }
    },
    emit(event) {
      publish?.(event)
    },
  }
}

// Every request passed on reports each change of its progress to the sink under its remote's
// name, after the request's own listener.
export function withLeaseProgress(
  source: RemoteLeaseSource,
  sink: (event: RemoteProgressEvent) => void,
): RemoteLeaseSource {
  const relay = (remote: string, own: ((progress: RemoteProgress) => void) | undefined) => {
    let last: string | undefined
    return (progress: RemoteProgress): void => {
      own?.(progress)
      const seen = JSON.stringify([progress.message, progress.queued, progress.percent])
      if (seen === last) return
      last = seen
      sink({ remote, ...progress })
    }
  }
  const uploadApp = source.uploadApp?.bind(source)
  return {
    acquire: (request) =>
      source.acquire({
        ...request,
        onProgress: relay(request.remote, request.onProgress?.bind(request)),
      }),
    ...(uploadApp === undefined
      ? {}
      : {
          uploadApp: (request) =>
            uploadApp({
              ...request,
              onProgress: relay(request.remote, request.onProgress?.bind(request)),
            }),
        }),
  }
}
