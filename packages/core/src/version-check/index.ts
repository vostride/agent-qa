import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getAgentQaVersion } from '../version.js'

const require = createRequire(import.meta.url)

const AGENT_QA_NPM_REGISTRY_URL = 'https://registry.npmjs.org/agent-qa'

export const VERSION_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const VERSION_CHECK_TIMEOUT_MS = 5000

export interface AgentQaUpdateStatus {
  installedVersion: string
  latestVersion?: string
  updateAvailable: boolean
  checkedAt?: string
}

type VersionCheckFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface VersionCheckOptions {
  cachePath?: string
  fetchImpl?: VersionCheckFetch
  now?: () => Date
  timeoutMs?: number
  cacheTtlMs?: number
  homeDir?: string
}

interface VersionCheckCacheFile {
  latestVersion?: string
  checkedAt?: string
  lastAttemptedAt?: string
}

interface SemverApi {
  valid(version: string): string | null
  gt(version: string, otherVersion: string): boolean
}

let semverApi: SemverApi | undefined

export function getAgentQaVersionCheckCachePath(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.agent-qa', 'version-check.json')
}

export async function getAgentQaUpdateStatus(
  options: VersionCheckOptions = {},
): Promise<AgentQaUpdateStatus> {
  const installedVersion = getInstalledVersion()

  try {
    return await getAgentQaUpdateStatusInternal(installedVersion, options)
  } catch {
    return createStatus(installedVersion)
  }
}

async function getAgentQaUpdateStatusInternal(
  installedVersion: string,
  options: VersionCheckOptions,
): Promise<AgentQaUpdateStatus> {
  const semver = getSemverApi()
  if (!semver) {
    return createStatus(installedVersion)
  }

  const now = getNow(options.now)
  const nowMs = now.getTime()
  const nowIso = now.toISOString()
  const cacheTtlMs = getPositiveNumber(options.cacheTtlMs, VERSION_CHECK_CACHE_TTL_MS)
  const timeoutMs = getPositiveNumber(options.timeoutMs, VERSION_CHECK_TIMEOUT_MS)
  const cachePath = options.cachePath ?? getAgentQaVersionCheckCachePath(options.homeDir)
  const cache = await readVersionCheckCache(cachePath)
  const cachedLatestVersion = getValidVersion(cache?.latestVersion, semver)
  const checkedAtMs = getTimestamp(cache?.checkedAt)

  if (cachedLatestVersion && checkedAtMs !== undefined && nowMs - checkedAtMs < cacheTtlMs) {
    return createStatus(installedVersion, semver, cachedLatestVersion, cache?.checkedAt)
  }

  const lastAttemptedAtMs = getTimestamp(cache?.lastAttemptedAt)
  if (lastAttemptedAtMs !== undefined && nowMs - lastAttemptedAtMs < cacheTtlMs) {
    if (cachedLatestVersion && checkedAtMs !== undefined) {
      return createStatus(installedVersion, semver, cachedLatestVersion, cache?.checkedAt)
    }

    return createStatus(installedVersion)
  }

  const nextCache = { ...cache, lastAttemptedAt: nowIso }
  const refreshedLatestVersion = await fetchLatestVersion(options.fetchImpl, timeoutMs, semver)
  if (refreshedLatestVersion) {
    const refreshedCache = {
      latestVersion: refreshedLatestVersion,
      checkedAt: nowIso,
      lastAttemptedAt: nowIso,
    }
    await writeVersionCheckCache(cachePath, refreshedCache)
    return createStatus(installedVersion, semver, refreshedLatestVersion, nowIso)
  }

  await writeVersionCheckCache(cachePath, nextCache)
  if (cachedLatestVersion && checkedAtMs !== undefined) {
    return createStatus(installedVersion, semver, cachedLatestVersion, cache?.checkedAt)
  }

  return createStatus(installedVersion)
}

function getInstalledVersion(): string {
  try {
    return getAgentQaVersion().trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function getSemverApi(): SemverApi | undefined {
  if (semverApi) return semverApi

  try {
    semverApi = require('semver') as SemverApi
    return semverApi
  } catch {
    return undefined
  }
}

function getValidVersion(version: unknown, semver: SemverApi): string | undefined {
  if (typeof version !== 'string') return undefined

  try {
    return semver.valid(version) ?? undefined
  } catch {
    return undefined
  }
}

function getTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function getPositiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function getNow(now: (() => Date) | undefined): Date {
  try {
    const candidate = now?.()
    if (candidate instanceof Date && Number.isFinite(candidate.getTime())) {
      return candidate
    }
  } catch {
    // Fall through to the system clock.
  }

  return new Date()
}

function createStatus(
  installedVersion: string,
  semver?: SemverApi,
  latestVersion?: string,
  checkedAt?: string,
): AgentQaUpdateStatus {
  if (!latestVersion) {
    return {
      installedVersion,
      updateAvailable: false,
    }
  }

  const installedSemver = semver ? getValidVersion(installedVersion, semver) : undefined
  const updateAvailable = Boolean(
    installedSemver &&
      semver &&
      safeSemverGreaterThan(semver, latestVersion, installedSemver),
  )

  return {
    installedVersion,
    latestVersion,
    updateAvailable,
    checkedAt,
  }
}

function safeSemverGreaterThan(semver: SemverApi, version: string, otherVersion: string): boolean {
  try {
    return semver.gt(version, otherVersion)
  } catch {
    return false
  }
}

async function readVersionCheckCache(cachePath: string): Promise<VersionCheckCacheFile | undefined> {
  try {
    const raw = await readFile(cachePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return undefined

    return {
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : undefined,
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : undefined,
      lastAttemptedAt:
        typeof parsed.lastAttemptedAt === 'string' ? parsed.lastAttemptedAt : undefined,
    }
  } catch {
    return undefined
  }
}

async function writeVersionCheckCache(
  cachePath: string,
  cache: VersionCheckCacheFile,
): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify(cache, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    try {
      await chmod(cachePath, 0o600)
    } catch {
      // Cache permissions are best effort.
    }
  } catch {
    // Version checks must never block CLI or dashboard work.
  }
}

async function fetchLatestVersion(
  fetchImpl: VersionCheckFetch | undefined,
  timeoutMs: number,
  semver: SemverApi,
): Promise<string | undefined> {
  try {
    const fetcher = fetchImpl ?? globalThis.fetch?.bind(globalThis)
    if (typeof fetcher !== 'function') return undefined

    const response = await fetcher(AGENT_QA_NPM_REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined

    const body = (await response.json()) as unknown
    if (!isRecord(body) || !isRecord(body['dist-tags'])) return undefined

    return getValidVersion(body['dist-tags'].latest, semver)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
