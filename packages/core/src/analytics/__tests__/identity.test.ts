import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getAnalyticsIdentityPath,
  readAnalyticsIdentity,
  resolveAnalyticsAgentProduct,
  resolveAnalyticsIdentity,
  writeAnalyticsIdentity,
} from '../identity.js'

const LOCAL_ANALYTICS_ID_PATTERN = /^u_([a-z]+-){9}[a-z]+$/
const FORBIDDEN_RETURN_KEYS = [
  'envVar',
  'envValue',
  'CLAUDECODE',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'AUGMENT_AGENT',
  'GOOSE_TERMINAL',
  'OPENCODE_CLIENT',
  'CODEX_SANDBOX',
  'CLINE_ACTIVE',
  'AGENT',
]

describe('analytics identity', () => {
  let tempDir: string
  let identityPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-analytics-'))
    identityPath = join(tempDir, 'analytics.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('resolves XDG_DATA_HOME before falling back to ~/.agent-qa', () => {
    expect(getAnalyticsIdentityPath({ XDG_DATA_HOME: join(tempDir, 'xdg') }, '/home/tester')).toBe(
      join(tempDir, 'xdg', 'agent-qa', 'analytics.json'),
    )
    expect(getAnalyticsIdentityPath({}, '/home/tester')).toBe(
      join('/home/tester', '.agent-qa', 'analytics.json'),
    )
  })

  it('creates and persists a missing local identity', async () => {
    const identity = await resolveAnalyticsIdentity({ env: {}, identityPath })

    expect(identity).toEqual({
      distinctId: expect.stringMatching(LOCAL_ANALYTICS_ID_PATTERN),
      runtimeContext: 'user',
      isInternal: false,
    })
    const data = JSON.parse(await readFile(identityPath, 'utf-8'))
    expect(data).toEqual({ distinctId: identity.distinctId, is_internal: false })
  })

  it('reuses an existing local identity', async () => {
    const existingId = 'u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
    await writeAnalyticsIdentity(existingId, identityPath)

    const identity = await resolveAnalyticsIdentity({ env: {}, identityPath })

    expect(identity).toEqual({ distinctId: existingId, runtimeContext: 'user', isInternal: false })
  })

  it('preserves a manually marked internal local identity', async () => {
    const existingId = 'u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
    await writeAnalyticsIdentity(existingId, identityPath, true)

    const identity = await resolveAnalyticsIdentity({ env: {}, identityPath })

    expect(identity).toEqual({ distinctId: existingId, runtimeContext: 'user', isInternal: true })
    expect(await readAnalyticsIdentity(identityPath)).toEqual({
      distinctId: existingId,
      is_internal: true,
    })
  })

  it('migrates legacy local identities to is_internal false', async () => {
    const existingId = 'u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
    await writeFile(identityPath, JSON.stringify({ distinctId: existingId }, null, 2))

    const identity = await resolveAnalyticsIdentity({ env: {}, identityPath })

    expect(identity).toEqual({ distinctId: existingId, runtimeContext: 'user', isInternal: false })
    const data = JSON.parse(await readFile(identityPath, 'utf-8'))
    expect(data).toEqual({ distinctId: existingId, is_internal: false })
    const s = await stat(identityPath)
    expect(s.mode & 0o777).toBe(0o600)
  })

  it('writes file with 0o600 permissions', async () => {
    await writeAnalyticsIdentity('u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet', identityPath)

    const s = await stat(identityPath)
    expect(s.mode & 0o777).toBe(0o600)
  })

  it('returns null when the local identity is missing or invalid', async () => {
    expect(await readAnalyticsIdentity(identityPath)).toBeNull()
    await writeAnalyticsIdentity('u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet', identityPath)
    expect(await readAnalyticsIdentity(identityPath)).toEqual({
      distinctId: 'u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet',
      is_internal: false,
    })
  })

  it('uses CI identity without creating a local identity file', async () => {
    const identity = await resolveAnalyticsIdentity({
      env: { CI: 'true', CLAUDECODE: '1' },
      identityPath,
    })

    expect(identity).toEqual({ distinctId: 'u_CI', runtimeContext: 'ci' })
    await expect(stat(identityPath)).rejects.toThrow()
  })

  it('maps allowlisted agent products to product-specific IDs', async () => {
    const cases = [
      [{ CLAUDECODE: '1' }, 'claude_code'],
      [{ CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'claude_code'],
      [{ CURSOR_AGENT: '1' }, 'cursor'],
      [{ GEMINI_CLI: '1' }, 'gemini_cli'],
      [{ AUGMENT_AGENT: '1' }, 'augment'],
      [{ GOOSE_TERMINAL: '1' }, 'goose'],
      [{ OPENCODE_CLIENT: '1' }, 'opencode'],
      [{ CODEX_SANDBOX: 'seatbelt' }, 'codex'],
      [{ CLINE_ACTIVE: 'true' }, 'cline'],
      [{ AGENT: 'amp' }, 'amp'],
    ] as const

    for (const [env, product] of cases) {
      const identity = await resolveAnalyticsIdentity({ env, identityPath })
      expect(identity).toEqual({
        distinctId: `u_AGENT-${product}`,
        runtimeContext: 'agent',
        agentProduct: product,
      })
      await expect(stat(identityPath)).rejects.toThrow()
    }
  })

  it('maps AGENT=goose to the goose product', () => {
    expect(resolveAnalyticsAgentProduct({ AGENT: 'goose' })).toBe('goose')
  })

  it('falls back to aggregate agent identity for unknown agent signals', async () => {
    const identity = await resolveAnalyticsIdentity({ env: { AGENT: 'unknown-product' }, identityPath })

    expect(identity).toEqual({ distinctId: 'u_AGENT', runtimeContext: 'agent' })
    await expect(stat(identityPath)).rejects.toThrow()
  })

  it('never exposes raw agent env keys or values in returned identity objects', async () => {
    const identity = await resolveAnalyticsIdentity({ env: { CLAUDECODE: '1' }, identityPath })
    for (const key of FORBIDDEN_RETURN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(identity, key)).toBe(false)
    }
    const serialized = JSON.stringify(identity)
    expect(serialized).not.toContain('CLAUDECODE')
    expect(serialized).not.toContain('CURSOR_AGENT')
    expect(serialized).not.toContain('AGENT=goose')
  })
})
