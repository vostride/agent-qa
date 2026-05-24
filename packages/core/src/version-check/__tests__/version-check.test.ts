import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentQaVersion } from '../../version.js'
import {
  VERSION_CHECK_CACHE_TTL_MS,
  VERSION_CHECK_TIMEOUT_MS,
  getAgentQaUpdateStatus,
  getAgentQaVersionCheckCachePath,
} from '../index.js'

interface VersionCheckCacheFile {
  latestVersion?: string
  checkedAt?: string
  lastAttemptedAt?: string
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

  it('D-01/D-03 uses fresh cache younger than 24 hours without calling npm', async () => {
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

  it('D-01/D-02 refreshes stale cache from npm and writes latestVersion freshness separately', async () => {
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
    'D-04/D-05 records lastAttemptedAt and returns stale latestVersion for %s',
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

  it('D-03/D-04 throttles stale refresh attempts for 24 hours via lastAttemptedAt', async () => {
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
  ])('D-05 returns no update data without throwing for %s plus registry failure', async (_name, rawCache) => {
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

  it('D-01 returns updateAvailable false when installed version is greater than or equal to latestVersion', async () => {
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

  it('D-05 returns computed status when cache write fails after a successful registry response', async () => {
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

  it('D-03 defaults timeoutMs to 5000 and cacheTtlMs to 24 hours', async () => {
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
