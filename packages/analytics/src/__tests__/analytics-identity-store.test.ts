// C447 (447-02, D-01..D-05, D-11, D-12): one installation id, shared, race-safe; CI personless

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ANALYTICS_RUNTIME_CONTEXTS } from '../events.js'
import { resolveAnalyticsAgentProduct, resolveAnalyticsIdentity } from '../identity.js'

const LOCAL_ID = /^u_([a-z]+-){9}[a-z]+$/
const VALID_ID = 'u_able-baker-cedar-delta-eagle-fable-gamma-hotel-india-juliet'
const CI_ID = /^ci_[0-9a-f-]{36}$/

type ResolveOptions = Parameters<typeof resolveAnalyticsIdentity>[0]

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDataHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-qa-analytics-447-'))
  roots.push(root)
  return root
}

function recordPath(home: string): string {
  return join(home, 'agent-qa', 'analytics.json')
}

async function writeRecord(home: string, bytes: string): Promise<void> {
  await mkdir(join(home, 'agent-qa'), { recursive: true })
  await writeFile(recordPath(home), bytes, { mode: 0o600 })
}

async function readStoredRecord(home: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(recordPath(home), 'utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

describe('concurrent first resolutions share one id', () => {
  it('five concurrent first resolutions on a fresh home all return the one stored id', async () => {
    const home = await tempDataHome()
    const env = { XDG_DATA_HOME: home }

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveAnalyticsIdentity({ env })),
    )
    const stored = await readStoredRecord(home)

    expect(new Set(results.map((result) => result.distinctId))).toEqual(
      new Set([stored?.distinctId]),
    )
    expect(Object.keys(stored ?? {}).sort()).toEqual(['distinctId', 'is_internal'])
    expect(stored?.distinctId).toMatch(LOCAL_ID)
  })
})

describe('a stored valid identity is adopted', () => {
  it('a valid record without is_internal is adopted with its bytes unchanged', async () => {
    const home = await tempDataHome()
    const bytes = `{"distinctId":"${VALID_ID}"}`
    await writeRecord(home, bytes)

    const resolved = await resolveAnalyticsIdentity({ env: { XDG_DATA_HOME: home } })

    expect(resolved.distinctId).toBe(VALID_ID)
    expect(resolved.isInternal).toBe(false)
    expect(await readFile(recordPath(home), 'utf8')).toBe(bytes)
  })
})

describe('a stored invalid identity is replaced', () => {
  it('a record that is not a valid id is replaced by a valid one that is read back', async () => {
    const fixtures = ['', '{', '{"distinctId":"u_not-the-scheme"}']
    let checked = 0

    for (const bytes of fixtures) {
      const home = await tempDataHome()
      await writeRecord(home, bytes)

      const resolved = await resolveAnalyticsIdentity({ env: { XDG_DATA_HOME: home } })
      const stored = await readStoredRecord(home)

      expect(resolved.distinctId).toMatch(LOCAL_ID)
      expect(resolved.distinctId).not.toBe('u_not-the-scheme')
      expect(stored?.distinctId).toBe(resolved.distinctId)
      checked += 1
    }

    expect(checked).toBe(fixtures.length)
  })
})

describe('one identity per data home', () => {
  it('every local caller under one home resolves the same id, and two homes resolve two', async () => {
    const home = await tempDataHome()
    const projectA = await tempDataHome()
    const projectB = await tempDataHome()
    const envs = [
      { XDG_DATA_HOME: home, CLAUDECODE: '1', PWD: projectA },
      { XDG_DATA_HOME: home, CODEX_SANDBOX: 'seatbelt', PWD: projectB },
      { XDG_DATA_HOME: home, PWD: projectA },
    ]

    const results = []
    for (const env of envs) results.push(await resolveAnalyticsIdentity({ env }))
    const stored = await readStoredRecord(home)

    expect(new Set(results.map((result) => result.distinctId))).toEqual(
      new Set([stored?.distinctId]),
    )
    expect(stored?.distinctId).toMatch(LOCAL_ID)
    expect(results.map((result) => result.runtimeContext)).toEqual(['user', 'user', 'user'])

    const first = await resolveAnalyticsIdentity({ env: { XDG_DATA_HOME: await tempDataHome() } })
    const second = await resolveAnalyticsIdentity({ env: { XDG_DATA_HOME: await tempDataHome() } })
    expect(first.distinctId).toMatch(LOCAL_ID)
    expect(second.distinctId).toMatch(LOCAL_ID)
    expect(first.distinctId).not.toBe(second.distinctId)
  })
})

describe('a CI identity is never stored', () => {
  it('a CI resolution mints a ci_ id and leaves an existing record byte-identical and a fresh home empty', async () => {
    const home = await tempDataHome()
    const bytes = JSON.stringify({ distinctId: VALID_ID, is_internal: false }, null, 2)
    await writeRecord(home, bytes)
    const ciOptions = { env: { XDG_DATA_HOME: home }, ci: true } as ResolveOptions

    const first = await resolveAnalyticsIdentity(ciOptions)
    const second = await resolveAnalyticsIdentity(ciOptions)

    expect(first.distinctId).toMatch(CI_ID)
    expect(second.distinctId).toMatch(CI_ID)
    expect(first.distinctId).not.toBe(second.distinctId)
    expect(first.runtimeContext).toBe('ci')
    expect(await readFile(recordPath(home), 'utf8')).toBe(bytes)

    const freshHome = await tempDataHome()
    const fresh = await resolveAnalyticsIdentity({
      env: { XDG_DATA_HOME: freshHome },
      ci: true,
    } as ResolveOptions)
    expect(fresh.distinctId).toMatch(CI_ID)
    expect(existsSync(join(freshHome, 'agent-qa'))).toBe(false)
  })
})

describe('runtime context and agent product', () => {
  it('a coding agent resolves as user with its product, an unrecognised AGENT as unknown, and the vocabulary is user and ci', async () => {
    expect([...ANALYTICS_RUNTIME_CONTEXTS]).toEqual(['user', 'ci'])

    const home = await tempDataHome()
    const local = await resolveAnalyticsIdentity({ env: { XDG_DATA_HOME: home, CLAUDECODE: '1' } })
    expect(local.runtimeContext).toBe('user')
    expect(local.agentProduct).toBe('claude_code')
    expect(local.distinctId).toMatch(LOCAL_ID)
    expect(Object.keys(local).sort()).toEqual([
      'agentProduct',
      'distinctId',
      'isInternal',
      'runtimeContext',
    ])

    expect(resolveAnalyticsAgentProduct({ AGENT: 'something-new' })).toBe('unknown')
    expect(resolveAnalyticsAgentProduct({ AGENT: '' })).toBeUndefined()
    const both = { CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt' }
    expect(resolveAnalyticsAgentProduct(both)).toBe('claude_code')
    expect(resolveAnalyticsAgentProduct(both)).toBe('claude_code')

    const ci = await resolveAnalyticsIdentity({
      env: { XDG_DATA_HOME: home, CLAUDECODE: '1' },
      ci: true,
    } as ResolveOptions)
    expect(ci.runtimeContext).toBe('ci')
    expect(ci.agentProduct).toBe('claude_code')
    expect(ci.distinctId).toMatch(CI_ID)
  })
})
