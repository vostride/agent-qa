import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentQaVersion } from '../../version.js'
import {
  VERSION_CHECK_CACHE_TTL_MS,
  VERSION_CHECK_TIMEOUT_MS,
  getAgentQaUpdateStatus,
  getAgentQaVersionCheckCachePath,
  readCachedAgentQaUpdateStatus,
  VERSION_REFRESH_START_WINDOW_MS,
  claimAgentQaVersionRefresh,
  refreshAgentQaVersionCheck,
  type VersionCheckRequest,
  type VersionCheckResponse,
} from '../index.js'

interface VersionCheckCacheFile {
  latestVersion?: string
  checkedAt?: string
  lastAttemptedAt?: string
  refreshStartedAt?: string
}

type FetchCall = [string | URL | Request, RequestInit | undefined]

const hourMs = 60 * 60 * 1000
const now = new Date('2026-05-24T10:00:00.000Z')
const freshCheckedAt = new Date(now.getTime() - hourMs).toISOString()
const staleCheckedAt = new Date(now.getTime() - (VERSION_CHECK_CACHE_TTL_MS + hourMs)).toISOString()
const recentAttemptAt = new Date(now.getTime() - hourMs).toISOString()

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

async function readCache(cachePath: string): Promise<VersionCheckCacheFile> {
  return JSON.parse(await readFile(cachePath, 'utf-8')) as VersionCheckCacheFile
}

async function writeCache(cachePath: string, cache: VersionCheckCacheFile): Promise<void> {
  await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
}

function expectPublicStatusShape(status: object & { latestVersion?: unknown }): void {
  expect(Object.keys(status).sort()).toEqual(
    status.latestVersion
      ? ['checkedAt', 'installedVersion', 'latestVersion', 'updateAvailable']
      : ['installedVersion', 'updateAvailable'],
  )
  expect(status).not.toHaveProperty('error')
  expect(status).not.toHaveProperty('cachePath')
  expect(status).not.toHaveProperty('registry')
  expect(status).not.toHaveProperty('response')
  expect(status).not.toHaveProperty('config')
  expect(status).not.toHaveProperty('environment')
  expect(status).not.toHaveProperty('metadata')
  expect(status).not.toHaveProperty('lastAttemptedAt')
}

function getAcceptHeader(init: RequestInit | undefined): string | null {
  const headers = init?.headers
  if (!headers) return null
  if (headers instanceof Headers) return headers.get('accept')
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === 'accept')?.[1] ?? null
  }
  return (headers as Record<string, string>).accept ?? null
}

describe('getAgentQaVersionCheckCachePath', () => {
  let tempHome: string

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agent-qa-version-home-'))
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  it('returns tempHome/.agent-qa/version-check.json', () => {
    expect(getAgentQaVersionCheckCachePath(tempHome)).toBe(
      join(tempHome, '.agent-qa', 'version-check.json'),
    )
  })
})

describe('getAgentQaUpdateStatus', () => {
  let tempDir: string
  let cachePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-version-check-'))
    cachePath = join(tempDir, 'version-check.json')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('uses fresh cache younger than 24 hours without calling npm', async () => {
    await writeCache(cachePath, {
      latestVersion: '9.9.9',
      checkedAt: freshCheckedAt,
      lastAttemptedAt: freshCheckedAt,
    })
    const fetchImpl = vi.fn()

    const status = await getAgentQaUpdateStatus({
      cachePath,
      fetchImpl,
      now: () => now,
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(status).toEqual({
      installedVersion: getAgentQaVersion(),
      latestVersion: '9.9.9',
      updateAvailable: true,
      checkedAt: freshCheckedAt,
    })
    expectPublicStatusShape(status)
  })

  it('refreshes stale cache from npm and writes latestVersion freshness separately', async () => {
    await writeCache(cachePath, {
      latestVersion: '1.0.0',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: staleCheckedAt,
    })
    const calls: FetchCall[] = []
    const fetchImpl = vi.fn(async (...args: FetchCall) => {
      calls.push(args)
      return createJsonResponse({ 'dist-tags': { latest: '9.9.9' } })
    })

    const status = await getAgentQaUpdateStatus({
      cachePath,
      fetchImpl,
      now: () => now,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(calls[0][0])).toBe('https://registry.npmjs.org/agent-qa')
    expect(getAcceptHeader(calls[0][1])).toBe('application/json')
    expect(calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    expect(status).toEqual({
      installedVersion: getAgentQaVersion(),
      latestVersion: '9.9.9',
      updateAvailable: true,
      checkedAt: now.toISOString(),
    })
    expect(await readCache(cachePath)).toEqual({
      latestVersion: '9.9.9',
      checkedAt: now.toISOString(),
      lastAttemptedAt: now.toISOString(),
    })
    expectPublicStatusShape(status)
  })

  it.each([
    ['rejected fetch', async () => {
      throw new Error('registry offline')
    }],
    ['non-ok response', async () => new Response('unavailable', { status: 503 })],
    ['malformed registry JSON', async () => new Response('{not json', { status: 200 })],
    ['missing dist-tags.latest', async () => createJsonResponse({ 'dist-tags': {} })],
    ['invalid latest semver', async () => createJsonResponse({ 'dist-tags': { latest: 'not-a-version' } })],
  ])(
    'records lastAttemptedAt and returns stale latestVersion for %s',
    async (_name, fetchImpl) => {
      await writeCache(cachePath, {
        latestVersion: '9.9.9',
        checkedAt: staleCheckedAt,
        lastAttemptedAt: staleCheckedAt,
      })

      const status = await getAgentQaUpdateStatus({
        cachePath,
        fetchImpl,
        now: () => now,
      })

      expect(status).toEqual({
        installedVersion: getAgentQaVersion(),
        latestVersion: '9.9.9',
        updateAvailable: true,
        checkedAt: staleCheckedAt,
      })
      expect(await readCache(cachePath)).toEqual({
        latestVersion: '9.9.9',
        checkedAt: staleCheckedAt,
        lastAttemptedAt: now.toISOString(),
      })
      expectPublicStatusShape(status)
    },
  )

  it('throttles stale refresh attempts for 24 hours via lastAttemptedAt', async () => {
    await writeCache(cachePath, {
      latestVersion: '9.9.9',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: recentAttemptAt,
    })
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not fetch inside attempt cooldown')
    })

    const status = await getAgentQaUpdateStatus({
      cachePath,
      fetchImpl,
      now: () => now,
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(status).toEqual({
      installedVersion: getAgentQaVersion(),
      latestVersion: '9.9.9',
      updateAvailable: true,
      checkedAt: staleCheckedAt,
    })
    expect(await readCache(cachePath)).toEqual({
      latestVersion: '9.9.9',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: recentAttemptAt,
    })
    expectPublicStatusShape(status)
  })

  it.each([
    ['missing cache', null],
    ['malformed cache', 'not json{{{'],
  ])('returns no update data without throwing for %s plus registry failure', async (_name, rawCache) => {
    if (typeof rawCache === 'string') {
      await writeFile(cachePath, rawCache, 'utf-8')
    }
    const fetchImpl = vi.fn(async () => {
      throw new Error('registry unavailable')
    })

    const status = await getAgentQaUpdateStatus({
      cachePath,
      fetchImpl,
      now: () => now,
    })

    expect(status).toEqual({
      installedVersion: getAgentQaVersion(),
      updateAvailable: false,
    })
    expectPublicStatusShape(status)
  })

  it('returns updateAvailable false when installed version is greater than or equal to latestVersion', async () => {
    await writeCache(cachePath, {
      latestVersion: getAgentQaVersion(),
      checkedAt: freshCheckedAt,
      lastAttemptedAt: freshCheckedAt,
    })

    const status = await getAgentQaUpdateStatus({
      cachePath,
      fetchImpl: vi.fn(),
      now: () => now,
    })

    expect(status).toEqual({
      installedVersion: getAgentQaVersion(),
      latestVersion: getAgentQaVersion(),
      updateAvailable: false,
      checkedAt: freshCheckedAt,
    })
    expectPublicStatusShape(status)
  })

  it('returns computed status when cache write fails after a successful registry response', async () => {
    const blockedParent = join(tempDir, 'blocked-parent')
    await writeFile(blockedParent, 'not a directory', 'utf-8')
    const blockedCachePath = join(blockedParent, 'version-check.json')
    const fetchImpl = vi.fn(async () => createJsonResponse({ 'dist-tags': { latest: '9.9.9' } }))

    const status = await getAgentQaUpdateStatus({
      cachePath: blockedCachePath,
      fetchImpl,
      now: () => now,
    })

    expect(status).toEqual({
      installedVersion: getAgentQaVersion(),
      latestVersion: '9.9.9',
      updateAvailable: true,
      checkedAt: now.toISOString(),
    })
    expectPublicStatusShape(status)
  })

  it('defaults timeoutMs to 5000 and cacheTtlMs to 24 hours', async () => {
    expect(VERSION_CHECK_TIMEOUT_MS).toBe(5000)
    expect(VERSION_CHECK_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000)
    await writeCache(cachePath, {
      latestVersion: '1.0.0',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: staleCheckedAt,
    })
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fetchImpl = vi.fn(async () => createJsonResponse({ 'dist-tags': { latest: '9.9.9' } }))

    await getAgentQaUpdateStatus({
      cachePath,
      fetchImpl,
      now: () => now,
    })

    expect(timeoutSpy).toHaveBeenCalledWith(5000)
  })
})

interface FakeRegistry {
  request: VersionCheckRequest
  calls: string[]
  cacheAtRequest: string[]
  destroys: number
  answer(body: unknown, statusCode?: number): void
  fail(): void
}

// A registry stand-in that records each request and answers only when told to.
function fakeRegistry(cachePath: string): FakeRegistry {
  const pending: Array<(response: VersionCheckResponse) => void> = []
  const requests: EventEmitter[] = []
  const registry: FakeRegistry = {
    calls: [],
    cacheAtRequest: [],
    destroys: 0,
    request: (url, _options, onResponse) => {
      registry.calls.push(url)
      registry.cacheAtRequest.push(readFileSync(cachePath, 'utf-8'))
      pending.push(onResponse)
      const req = Object.assign(new EventEmitter(), {
        destroy: () => {
          registry.destroys += 1
        },
      })
      requests.push(req)
      return req
    },
    answer(body, statusCode = 200) {
      const response = Object.assign(new EventEmitter(), {
        statusCode,
        setEncoding: () => undefined,
        resume: () => undefined,
      })
      for (const onResponse of pending.splice(0)) onResponse(response)
      response.emit('data', JSON.stringify(body))
      response.emit('end')
    },
    fail() {
      for (const req of requests.splice(0)) req.emit('error', new Error('getaddrinfo EAI_AGAIN'))
    },
  }
  return registry
}

describe('readCachedAgentQaUpdateStatus', () => {
  let tempHome: string
  let cachePath: string

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agent-qa-version-home-'))
    cachePath = getAgentQaVersionCheckCachePath(tempHome)
    await mkdir(join(tempHome, '.agent-qa'), { recursive: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(tempHome, { recursive: true, force: true })
  })

  it('returns the cached answer from a stale cache without reaching the registry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await writeCache(cachePath, {
      latestVersion: '9.9.9',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: staleCheckedAt,
    })

    const status = await readCachedAgentQaUpdateStatus({
      homeDir: tempHome,
      currentVersion: '0.3.4',
    })

    expect(status).toEqual({
      installedVersion: '0.3.4',
      latestVersion: '9.9.9',
      updateAvailable: true,
      checkedAt: staleCheckedAt,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports no update without a cache file', async () => {
    const status = await readCachedAgentQaUpdateStatus({
      homeDir: tempHome,
      currentVersion: '0.3.4',
    })

    expect(status).toEqual({ installedVersion: '0.3.4', updateAvailable: false })
  })
})

describe('claimAgentQaVersionRefresh', () => {
  let tempHome: string
  let cachePath: string

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agent-qa-version-home-'))
    cachePath = getAgentQaVersionCheckCachePath(tempHome)
    await mkdir(join(tempHome, '.agent-qa'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  it('claims a stale cache once and marks the start without recording an attempt', async () => {
    await writeCache(cachePath, {
      latestVersion: '9.9.9',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: staleCheckedAt,
    })

    expect(await claimAgentQaVersionRefresh({ homeDir: tempHome, now: now.getTime() })).toBe(true)
    expect(await readCache(cachePath)).toEqual({
      latestVersion: '9.9.9',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: staleCheckedAt,
      refreshStartedAt: now.toISOString(),
    })
    expect(await claimAgentQaVersionRefresh({ homeDir: tempHome, now: now.getTime() + 1000 })).toBe(
      false,
    )
  })

  it('claims again once a started refresh is older than its window', async () => {
    await writeCache(cachePath, {
      lastAttemptedAt: staleCheckedAt,
      refreshStartedAt: now.toISOString(),
    })

    expect(
      await claimAgentQaVersionRefresh({
        homeDir: tempHome,
        now: now.getTime() + VERSION_REFRESH_START_WINDOW_MS,
      }),
    ).toBe(true)
  })

  it('claims nothing over a fresh cache and leaves it byte for byte', async () => {
    await writeCache(cachePath, {
      latestVersion: '9.9.9',
      checkedAt: freshCheckedAt,
      lastAttemptedAt: freshCheckedAt,
    })
    const before = await readFile(cachePath, 'utf-8')

    expect(await claimAgentQaVersionRefresh({ homeDir: tempHome, now: now.getTime() })).toBe(false)
    expect(await readFile(cachePath, 'utf-8')).toBe(before)
  })

  it('claims nothing within a day of a finished attempt', async () => {
    await writeCache(cachePath, { lastAttemptedAt: recentAttemptAt })

    expect(await claimAgentQaVersionRefresh({ homeDir: tempHome, now: now.getTime() })).toBe(false)
  })
})

describe('refreshAgentQaVersionCheck', () => {
  let tempHome: string
  let cachePath: string

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agent-qa-version-home-'))
    cachePath = getAgentQaVersionCheckCachePath(tempHome)
    await mkdir(join(tempHome, '.agent-qa'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  it('waits for a late registry answer and only then records the version and the attempt', async () => {
    await writeCache(cachePath, {
      latestVersion: '1.0.0',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: staleCheckedAt,
      refreshStartedAt: now.toISOString(),
    })
    const before = await readFile(cachePath, 'utf-8')
    const registry = fakeRegistry(cachePath)
    let finished = false

    const refresh = refreshAgentQaVersionCheck({
      homeDir: tempHome,
      now: now.getTime(),
      request: registry.request,
    }).then(() => {
      finished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(registry.calls).toEqual(['https://registry.npmjs.org/agent-qa'])
    expect(registry.cacheAtRequest).toEqual([before])
    expect(finished).toBe(false)
    expect(await readFile(cachePath, 'utf-8')).toBe(before)

    registry.answer({ 'dist-tags': { latest: '9.9.9' } })
    await refresh

    expect(await readCache(cachePath)).toEqual({
      latestVersion: '9.9.9',
      checkedAt: now.toISOString(),
      lastAttemptedAt: now.toISOString(),
    })
  })

  it('keeps the cached version and records the attempt when the registry answers with an error', async () => {
    await writeCache(cachePath, {
      latestVersion: '1.0.0',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: staleCheckedAt,
    })
    const registry = fakeRegistry(cachePath)

    const refresh = refreshAgentQaVersionCheck({
      homeDir: tempHome,
      now: now.getTime(),
      request: registry.request,
    })
    await new Promise((resolve) => setImmediate(resolve))
    registry.answer({ error: 'not found' }, 404)
    await refresh

    expect(await readCache(cachePath)).toEqual({
      latestVersion: '1.0.0',
      checkedAt: staleCheckedAt,
      lastAttemptedAt: now.toISOString(),
    })
  })

  it('records the attempt when the lookup fails', async () => {
    const registry = fakeRegistry(cachePath)
    await writeCache(cachePath, {})

    const refresh = refreshAgentQaVersionCheck({
      homeDir: tempHome,
      now: now.getTime(),
      request: registry.request,
    })
    await new Promise((resolve) => setImmediate(resolve))
    registry.fail()
    await refresh

    expect(await readCache(cachePath)).toEqual({ lastAttemptedAt: now.toISOString() })
  })

  it('gives up on a request that never answers at its deadline and records the attempt', async () => {
    await writeCache(cachePath, {})
    const registry = fakeRegistry(cachePath)

    await refreshAgentQaVersionCheck({
      homeDir: tempHome,
      now: now.getTime(),
      request: registry.request,
      deadlineMs: 20,
    })

    expect(registry.destroys).toBe(1)
    expect(await readCache(cachePath)).toEqual({ lastAttemptedAt: now.toISOString() })
  })
})
