import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_EMBEDDING_PROFILE,
  STATIC_FLOOR_EMBEDDING_PROFILE,
  type EmbeddingProfile,
} from '@vostride/agent-qa-schema'

import {
  type EmbedCacheMode,
  wrapEmbedderWithCache,
} from './embed-cache.js'
import { createFloorEmbedder, loadFloorAssets } from './embedder-floor.js'
import {
  createNativeEmbedder,
  NativeEmbeddingModuleLoadError,
} from './embedder-native.js'
import type { EmbedderPort } from './embedder-port.js'
import {
  asEmbeddingProfile,
  createEmbedderWorkerPort,
  embedderWorkerAgentQaRoot,
  embedderWorkerProcessIsAlive,
  embedderWorkerSocketPath,
  probeEmbedderWorkerSocket,
  readEmbedderWorkerRegistration,
  removeEmbedderWorkerRegistration,
} from './embedder-worker/worker-registration.js'
import { embeddingProfileKey } from './index-open.js'

export type WorkerDiscoveryResult = { kind: 'no-worker' } | { kind: 'worker' }
export type EmbedderRung = 'native' | 'floor'
export type EmbedderWorkerPolicy = 'preferred' | 'required'
export type DeferReason =
  | 'cold-artifact'
  | 'load-failure'
  | 'worker-unavailable'

export type AcquireEmbedderOutcome =
  | {
      kind: 'ready'
      rung: EmbedderRung
      profile: EmbeddingProfile
      embedder: EmbedderPort
    }
  | { kind: 'deferred'; reason: DeferReason }
  | { kind: 'lexical-only' }

// Test-only: production callers omit it so rung selection reflects the host.
export interface EmbedderProbes {
  discoverWorker?: (agentQaRoot: string) => Promise<WorkerDiscoveryResult>
  createNativeEmbedder?: (options: {
    profile: EmbeddingProfile
    allowDownload: boolean
  }) => Promise<EmbedderPort>
  createFloorEmbedder?: () => EmbedderPort | Promise<EmbedderPort>
}

export interface AcquireEmbedderOptions {
  preferredProfile?: EmbeddingProfile
  allowDownload: boolean
  /** Daemon posture requires the child; ordinary one-shot callers retain the preferred ladder. */
  workerPolicy?: EmbedderWorkerPolicy
  /** Explicit hosted runtime root. Required policy must never infer it from ambient cwd. */
  agentQaRoot?: string
  cache?: {
    db: DatabaseSync
    mode: EmbedCacheMode
  }
  probes?: EmbedderProbes
}

export interface ResolveEmbedderCapabilityOptions {
  preferredProfile?: EmbeddingProfile
  allowDownload: boolean
  /** Daemon posture requires the child; ordinary one-shot callers retain the preferred ladder. */
  workerPolicy?: EmbedderWorkerPolicy
  /** Explicit hosted runtime root. Required policy must never infer it from ambient cwd. */
  agentQaRoot?: string
  probes?: EmbedderProbes
}

type CapabilityOutcome = AcquireEmbedderOutcome

const processCapabilities = new Map<string, Promise<CapabilityOutcome>>()
const injectedCapabilities = new WeakMap<
  EmbedderProbes,
  Map<string, Promise<CapabilityOutcome>>
>()
const injectedCapabilityCaches = new Set<Map<string, Promise<CapabilityOutcome>>>()

/**
 * Invalidate process-lifetime capability resolution without touching process-local pipelines.
 *
 * A named profile clears only its memo entry. Omitting the profile clears every production and
 * probe-isolated entry so a long-lived host can re-probe after its worker or artifact state moves.
 */
export function resetEmbedderCapability(profile?: EmbeddingProfile): void {
  if (profile === undefined) {
    processCapabilities.clear()
    for (const capabilities of injectedCapabilityCaches) capabilities.clear()
    injectedCapabilityCaches.clear()
    return
  }

  const prefix = capabilityProfilePrefix(profile)
  for (const key of processCapabilities.keys()) {
    if (key.startsWith(prefix)) processCapabilities.delete(key)
  }
  for (const capabilities of injectedCapabilityCaches) {
    for (const key of capabilities.keys()) {
      if (key.startsWith(prefix)) capabilities.delete(key)
    }
  }
}

interface WorkerBackedDiscoveryResult {
  readonly kind: 'worker'
  readonly profile: EmbeddingProfile
  readonly embedder: EmbedderPort
}

export interface DiscoverEmbedderWorkerOptions {
  /** Test-only shortening seam; production omits this and uses the pinned request deadline. */
  readonly requestTimeoutMs?: number
}

function isWorkerBackedDiscovery(
  result: WorkerDiscoveryResult,
): result is WorkerDiscoveryResult & WorkerBackedDiscoveryResult {
  if (result.kind !== 'worker') return false
  const candidate = result as WorkerDiscoveryResult & Partial<WorkerBackedDiscoveryResult>
  return candidate.profile !== undefined && candidate.embedder !== undefined
}

// Rooted in the hosted project, not the process cwd.
export async function discoverEmbedderWorker(
  agentQaRoot: string,
  options: DiscoverEmbedderWorkerOptions = {},
): Promise<WorkerDiscoveryResult> {
  const projectRoot = dirname(agentQaRoot)
  const outcome = readEmbedderWorkerRegistration(agentQaRoot)
  if (outcome.kind !== 'parsed') return { kind: 'no-worker' }

  const { registration } = outcome
  let expectedSocketPath: string
  try {
    expectedSocketPath = embedderWorkerSocketPath(
      agentQaRoot,
      projectRoot,
      registration.instanceId,
    )
  } catch {
    return { kind: 'no-worker' }
  }
  if (registration.socketPath !== expectedSocketPath) return { kind: 'no-worker' }

  let pidIsLive: boolean
  try {
    pidIsLive = embedderWorkerProcessIsAlive(registration.pid)
  } catch {
    return { kind: 'no-worker' }
  }
  if (!pidIsLive) {
    removeEmbedderWorkerRegistration(agentQaRoot, registration)
    return { kind: 'no-worker' }
  }

  if (!await probeEmbedderWorkerSocket(registration.socketPath)) {
    removeEmbedderWorkerRegistration(agentQaRoot, registration)
    return { kind: 'no-worker' }
  }

  return {
    kind: 'worker',
    profile: asEmbeddingProfile(registration.profile),
    embedder: createEmbedderWorkerPort(
      registration.socketPath,
      registration.profile.dim,
      {
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        onUnavailable: () => {
          removeEmbedderWorkerRegistration(agentQaRoot, registration)
          resetEmbedderCapability(asEmbeddingProfile(registration.profile))
        },
      },
    ),
  } as WorkerDiscoveryResult
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNativeModuleUnavailable(error: unknown): boolean {
  if (error instanceof NativeEmbeddingModuleLoadError) return true

  const code = errorRecord(error)?.code
  if (
    code === 'ERR_MODULE_NOT_FOUND'
    || code === 'MODULE_NOT_FOUND'
    || code === 'ERR_DLOPEN_FAILED'
  ) {
    return true
  }

  const message = errorText(error).toLowerCase()
  return message.includes('cannot find package')
    || message.includes('cannot find module')
    || message.includes('could not locate the bindings file')
}

function isColdArtifact(error: unknown, allowDownload: boolean): boolean {
  if (allowDownload) return false

  const code = errorRecord(error)?.code
  if (code === 'ENOENT') return true

  const message = errorText(error).toLowerCase()
  return message.includes('local_files_only')
    || message.includes('not found locally')
    || message.includes('not present in the local cache')
    || message.includes('not found in the local cache')
    || message.includes('could not locate file')
}

function cacheFor(probes: EmbedderProbes | undefined): Map<string, Promise<CapabilityOutcome>> {
  if (probes === undefined) return processCapabilities

  const existing = injectedCapabilities.get(probes)
  if (existing !== undefined) {
    injectedCapabilityCaches.add(existing)
    return existing
  }

  const created = new Map<string, Promise<CapabilityOutcome>>()
  injectedCapabilities.set(probes, created)
  injectedCapabilityCaches.add(created)
  return created
}

function capabilityCacheKey(
  profile: EmbeddingProfile,
  workerPolicy: EmbedderWorkerPolicy,
  agentQaRoot: string,
): string {
  const profileKey = embeddingProfileKey(profile)
  return `${profileKey.length}:${profileKey}:${workerPolicy}:${agentQaRoot}`
}

function capabilityProfilePrefix(profile: EmbeddingProfile): string {
  const profileKey = embeddingProfileKey(profile)
  return `${profileKey.length}:${profileKey}:`
}

async function probeFloor(
  factory: NonNullable<EmbedderProbes['createFloorEmbedder']>,
): Promise<CapabilityOutcome> {
  try {
    const embedder = await factory()
    return {
      kind: 'ready',
      rung: 'floor',
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
      embedder,
    }
  } catch {
    return { kind: 'lexical-only' }
  }
}

async function probeCapability({
  preferredProfile,
  allowDownload,
  workerPolicy,
  agentQaRoot,
  probes,
}: Required<Pick<
  ResolveEmbedderCapabilityOptions,
  'preferredProfile' | 'allowDownload' | 'workerPolicy' | 'agentQaRoot'
>> & Pick<ResolveEmbedderCapabilityOptions, 'probes'>): Promise<CapabilityOutcome> {
  const discoverWorker = probes?.discoverWorker ?? discoverEmbedderWorker
  const nativeFactory = probes?.createNativeEmbedder ?? createNativeEmbedder
  const floorFactory = probes?.createFloorEmbedder ?? (async () => {
    await loadFloorAssets()
    return createFloorEmbedder()
  })

  try {
    const worker = await discoverWorker(agentQaRoot)
    if (
      isWorkerBackedDiscovery(worker)
      && embeddingProfileKey(worker.profile) === embeddingProfileKey(preferredProfile)
    ) {
      return {
        kind: 'ready',
        rung: worker.profile.backend === 'static' ? 'floor' : 'native',
        profile: worker.profile,
        embedder: worker.embedder,
      }
    }
    if (workerPolicy === 'required') {
      return { kind: 'deferred', reason: 'worker-unavailable' }
    }
  } catch {
    return {
      kind: 'deferred',
      reason: workerPolicy === 'required' ? 'worker-unavailable' : 'load-failure',
    }
  }

  if (preferredProfile.backend === 'static') return probeFloor(floorFactory)

  try {
    const embedder = await nativeFactory({ profile: preferredProfile, allowDownload })
    return { kind: 'ready', rung: 'native', profile: preferredProfile, embedder }
  } catch (error) {
    if (isNativeModuleUnavailable(error)) return probeFloor(floorFactory)
    if (isColdArtifact(error, allowDownload)) {
      return { kind: 'deferred', reason: 'cold-artifact' }
    }
    return { kind: 'deferred', reason: 'load-failure' }
  }
}

// Memoised per profile; injected test seams get an isolated memo.
export function resolveEmbedderCapability(
  options: ResolveEmbedderCapabilityOptions,
): Promise<CapabilityOutcome> {
  const preferredProfile = options.preferredProfile ?? DEFAULT_EMBEDDING_PROFILE
  const workerPolicy = options.workerPolicy ?? 'preferred'
  if (workerPolicy === 'required' && options.agentQaRoot === undefined) {
    throw new TypeError('workerPolicy required needs an explicit agentQaRoot')
  }
  const agentQaRoot = options.agentQaRoot
    ?? embedderWorkerAgentQaRoot(process.cwd())
  const capabilities = cacheFor(options.probes)
  const key = capabilityCacheKey(preferredProfile, workerPolicy, agentQaRoot)
  const existing = capabilities.get(key)
  if (existing !== undefined) return existing

  const pending = probeCapability({
    preferredProfile,
    allowDownload: options.allowDownload,
    workerPolicy,
    agentQaRoot,
    probes: options.probes,
  })
  capabilities.set(key, pending)
  return pending
}

export async function acquireEmbedder(
  options: AcquireEmbedderOptions,
): Promise<AcquireEmbedderOutcome> {
  const outcome = await resolveEmbedderCapability(options)
  if (outcome.kind !== 'ready' || options.cache === undefined) return outcome

  return {
    ...outcome,
    embedder: wrapEmbedderWithCache({
      embedder: outcome.embedder,
      profile: outcome.profile,
      db: options.cache.db,
      mode: options.cache.mode,
    }),
  }
}
