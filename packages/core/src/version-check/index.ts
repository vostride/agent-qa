import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getAgentQaVersion } from '../version.js'

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

const AGENT_QA_NPM_REGISTRY_URL = 'https://registry.npmjs.org/agent-qa'

export const VERSION_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const VERSION_CHECK_TIMEOUT_MS = 5000

export interface AgentQaUpdateStatus {
  installedVersion: string
  latestVersion?: string
  updateAvailable: boolean
  checkedAt?: string
}

type VersionCheckFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface VersionCheckOptions {
  cachePath?: string
  fetchImpl?: VersionCheckFetch
  now?: () => Date
  timeoutMs?: number
  cacheTtlMs?: number
  homeDir?: string
}

export interface VersionCheckResponse {
  statusCode?: number
  setEncoding(encoding: BufferEncoding): unknown
  on(event: string, listener: (...args: any[]) => void): unknown
  resume(): unknown
}

export interface VersionCheckClientRequest {
  on(event: string, listener: (...args: any[]) => void): unknown
  destroy(): unknown
}

// The shape of `https.get`. Core opens no socket itself: the host passes `https.get` in, and tests
// pass a stand-in for the registry.
export type VersionCheckRequest = (
  url: string,
  options: { headers: Record<string, string>; timeout: number },
  onResponse: (response: VersionCheckResponse) => void,
) => VersionCheckClientRequest

const MAX_REGISTRY_RESPONSE_CHARS = 4 * 1024 * 1024

interface VersionCheckCacheFile {
  latestVersion?: string
  checkedAt?: string
  lastAttemptedAt?: string
  refreshStartedAt?: string
}

interface SemverApi {
  valid(version: string): string | null
  gt(version: string, otherVersion: string): boolean
  compare(version: string, otherVersion: string): -1 | 0 | 1
  minVersion(range: string): { version: string } | null
  validRange(range: string): string | null
  major(version: string): number
  minor(version: string): number
}

let semverApi: SemverApi | undefined

export function getAgentQaVersionCheckCachePath(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.agent-qa', 'version-check.json')
}

export function compareSemverVersions(left: string, right: string): -1 | 0 | 1 | undefined {
  const semver = getSemverApi()
  if (!semver) return undefined
  const leftVersion = getValidVersion(left, semver)
  const rightVersion = getValidVersion(right, semver)
  if (leftVersion === undefined || rightVersion === undefined) return undefined
  return semver.compare(leftVersion, rightVersion)
}

export function validSemverVersion(version: unknown): string | undefined {
  const semver = getSemverApi()
  return semver ? getValidVersion(version, semver) : undefined
}

export interface AgentQaBreakingStep {
  from: string
  to: string
}

// A crafted version such as 0.9007199254740991.0 must not make the walk run for ever.
const MAX_BREAKING_STEPS = 100

// A breaking step is a minor bump in 0.x and a major bump from 1.0 on. Each side is named by its
// line: `<major>-<minor>` in 0.x, `<major>` from 1.0 on. A prerelease is on its release's line.
export function agentQaBreakingSteps(from: string, to: string): AgentQaBreakingStep[] {
  const semver = getSemverApi()
  if (!semver) return []
  const fromVersion = getValidVersion(from, semver)
  const toVersion = getValidVersion(to, semver)
  if (fromVersion === undefined || toVersion === undefined) return []
  try {
    if (semver.compare(toVersion, fromVersion) !== 1) return []
    const fromMajor = semver.major(fromVersion)
    const fromMinor = semver.minor(fromVersion)
    const toMajor = semver.major(toVersion)
    const toMinor = semver.minor(toVersion)
    const fromLine = fromMajor === 0 ? `0-${fromMinor}` : `${fromMajor}`
    const toLine = toMajor === 0 ? `0-${toMinor}` : `${toMajor}`
    if (fromLine === toLine) return []

    const stepCount =
      toMajor === 0
        ? toMinor - fromMinor
        : toMajor - Math.max(fromMajor, 1) + (fromMajor === 0 ? 1 : 0)
    if (stepCount > MAX_BREAKING_STEPS) return [{ from: fromLine, to: toLine }]

    const steps: AgentQaBreakingStep[] = []
    if (toMajor === 0) {
      for (let minor = fromMinor; minor < toMinor; minor += 1) {
        steps.push({ from: `0-${minor}`, to: `0-${minor + 1}` })
      }
      return steps
    }
    let major = fromMajor
    if (fromMajor === 0) {
      steps.push({ from: fromLine, to: '1' })
      major = 1
    }
    for (; major < toMajor; major += 1) {
      steps.push({ from: `${major}`, to: `${major + 1}` })
    }
    return steps
  } catch {
    return []
  }
}

export function semverRangeFloor(range: string): string | undefined {
  const semver = getSemverApi()
  if (!semver) return undefined
  try {
    if (semver.validRange(range) === null) return undefined
    return semver.minVersion(range)?.version
  } catch {
    return undefined
  }
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

export async function readCachedAgentQaUpdateStatus(options: {
  homeDir?: string
  currentVersion: string
}): Promise<AgentQaUpdateStatus> {
  const installedVersion = options.currentVersion.trim()
  try {
    const semver = getSemverApi()
    if (!semver) return createStatus(installedVersion)
    const cache = await readVersionCheckCache(getAgentQaVersionCheckCachePath(options.homeDir))
    const latestVersion = getValidVersion(cache?.latestVersion, semver)
    if (!latestVersion || getTimestamp(cache?.checkedAt) === undefined) {
      return createStatus(installedVersion)
    }
    return createStatus(installedVersion, semver, latestVersion, cache?.checkedAt)
  } catch {
    return createStatus(installedVersion)
  }
}

export interface LatestAgentQaAnswer {
  source: 'registry' | 'cache' | 'none'
  latestVersion?: string
}

// Asks the registry once under the deadline. Only a fresh answer is written back, so a failed ask
// never holds back the daily refresh.
export async function askLatestAgentQaVersion(options: {
  homeDir?: string
  fetchImpl: VersionCheckFetch
  timeoutMs: number
  now?: () => Date
}): Promise<LatestAgentQaAnswer> {
  try {
    const semver = getSemverApi()
    if (!semver) return { source: 'none' }
    const cachePath = getAgentQaVersionCheckCachePath(options.homeDir)
    const timeoutMs = getPositiveNumber(options.timeoutMs, VERSION_CHECK_TIMEOUT_MS)
    const latestVersion =
      typeof options.fetchImpl === 'function'
        ? await withDeadline(fetchLatestVersion(options.fetchImpl, timeoutMs, semver), timeoutMs)
        : undefined
    const cache = await readVersionCheckCache(cachePath)
    if (latestVersion !== undefined) {
      const nowIso = getNow(options.now).toISOString()
      await writeVersionCheckCache(cachePath, {
        ...cache,
        latestVersion,
        checkedAt: nowIso,
        lastAttemptedAt: nowIso,
      })
      return { source: 'registry', latestVersion }
    }
    const cachedLatestVersion = getValidVersion(cache?.latestVersion, semver)
    return cachedLatestVersion === undefined
      ? { source: 'none' }
      : { source: 'cache', latestVersion: cachedLatestVersion }
  } catch {
    return { source: 'none' }
  }
}

// A fetch that ignores its abort signal must not hold the caller past the deadline either.
function withDeadline<T>(work: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

// A refresh that started this recently is still running, or its process was stopped; either way
// the next command leaves it alone.
export const VERSION_REFRESH_START_WINDOW_MS = 10 * 60 * 1000
export const VERSION_REFRESH_DEADLINE_MS = 15_000

// Decides whether the caller should start a refresh, and marks it started. The daily attempt is
// recorded only by the refresh itself, once its request ends.
export async function claimAgentQaVersionRefresh(options: {
  homeDir?: string
  now: number
}): Promise<boolean> {
  try {
    const semver = getSemverApi()
    if (!semver) return false
    const cachePath = getAgentQaVersionCheckCachePath(options.homeDir)
    const cache = await readVersionCheckCache(cachePath)
    const checkedAtMs = getTimestamp(cache?.checkedAt)
    if (
      getValidVersion(cache?.latestVersion, semver) &&
      checkedAtMs !== undefined &&
      options.now - checkedAtMs < VERSION_CHECK_CACHE_TTL_MS
    ) {
      return false
    }
    const lastAttemptedAtMs = getTimestamp(cache?.lastAttemptedAt)
    if (
      lastAttemptedAtMs !== undefined &&
      options.now - lastAttemptedAtMs < VERSION_CHECK_CACHE_TTL_MS
    ) {
      return false
    }
    const refreshStartedAtMs = getTimestamp(cache?.refreshStartedAt)
    if (
      refreshStartedAtMs !== undefined &&
      options.now - refreshStartedAtMs < VERSION_REFRESH_START_WINDOW_MS
    ) {
      return false
    }
    return await writeVersionCheckCache(cachePath, {
      ...cache,
      refreshStartedAt: new Date(options.now).toISOString(),
    })
  } catch {
    return false
  }
}

// Asks the registry once and waits for the request to end, then records the attempt, and the
// version when one came back. Meant for a process of its own, so nothing here unrefs.
export async function refreshAgentQaVersionCheck(options: {
  homeDir?: string
  now: number
  request: VersionCheckRequest
  deadlineMs?: number
}): Promise<void> {
  try {
    const semver = getSemverApi()
    if (!semver) return
    const cachePath = getAgentQaVersionCheckCachePath(options.homeDir)
    const latestVersion = await requestLatestVersion(
      options.request,
      semver,
      getPositiveNumber(options.deadlineMs, VERSION_REFRESH_DEADLINE_MS),
    )
    const nowIso = new Date(options.now).toISOString()
    const cache = await readVersionCheckCache(cachePath)
    await writeVersionCheckCache(cachePath, {
      latestVersion: latestVersion ?? cache?.latestVersion,
      checkedAt: latestVersion === undefined ? cache?.checkedAt : nowIso,
      lastAttemptedAt: nowIso,
    })
  } catch {
    // Version checks must never block CLI work.
  }
}

function requestLatestVersion(
  request: VersionCheckRequest,
  semver: SemverApi,
  deadlineMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let req: VersionCheckClientRequest | undefined
    let settled = false
    const settle = (latestVersion?: string) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(latestVersion)
    }
    // A resolver that never answers is not covered by the request's own idle timeout.
    const deadline = setTimeout(() => {
      req?.destroy()
      settle()
    }, deadlineMs)
    try {
      req = request(
        AGENT_QA_NPM_REGISTRY_URL,
        {
          headers: {
            accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
          },
          timeout: VERSION_CHECK_TIMEOUT_MS,
        },
        (response) => {
          try {
            if (response.statusCode !== 200) {
              response.resume()
              settle()
              return
            }
            response.setEncoding('utf8')
            let body = ''
            response.on('data', (chunk: string) => {
              body += chunk
              if (body.length > MAX_REGISTRY_RESPONSE_CHARS) {
                req?.destroy()
                settle()
              }
            })
            response.on('error', () => settle())
            response.on('close', () => settle())
            response.on('end', () => {
              try {
                const parsed = JSON.parse(body) as unknown
                if (!isRecord(parsed) || !isRecord(parsed['dist-tags'])) return settle()
                settle(getValidVersion(parsed['dist-tags'].latest, semver))
              } catch {
                settle()
              }
            })
          } catch {
            settle()
          }
        },
      )
      req.on('timeout', () => {
        req?.destroy()
        settle()
      })
      req.on('error', () => settle())
      req.on('close', () => settle())
    } catch {
      settle()
    }
  })
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
    installedSemver && semver && safeSemverGreaterThan(semver, latestVersion, installedSemver),
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

async function readVersionCheckCache(
  cachePath: string,
): Promise<VersionCheckCacheFile | undefined> {
  try {
    const raw = await readFile(cachePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return undefined

    return {
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : undefined,
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : undefined,
      lastAttemptedAt:
        typeof parsed.lastAttemptedAt === 'string' ? parsed.lastAttemptedAt : undefined,
      refreshStartedAt:
        typeof parsed.refreshStartedAt === 'string' ? parsed.refreshStartedAt : undefined,
    }
  } catch {
    return undefined
  }
}

async function writeVersionCheckCache(
  cachePath: string,
  cache: VersionCheckCacheFile,
): Promise<boolean> {
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
    return true
  } catch {
    // Version checks must never block CLI or dashboard work.
    return false
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
