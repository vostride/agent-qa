import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, stat, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAuth, writeAuth, removeAuth, getCredential } from '../auth/store.js'
import type { AuthCredential } from '../auth/types.js'

describe('auth store', () => {
  let tempDir: string
  let authPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-test-'))
    authPath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty store when file does not exist', async () => {
    const store = await readAuth(authPath)
    expect(store).toEqual({})
  })

  it('writes and reads a credential', async () => {
    const cred: AuthCredential = {
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: { access: 'tok_a', refresh: 'tok_r', expires: Date.now() + 3600000 },
    }
    await writeAuth('anthropic', cred, authPath)
    const store = await readAuth(authPath)
    expect(store['anthropic']).toEqual(cred)
  })

  it('writes and reads bearer token credentials', async () => {
    const cred: AuthCredential = {
      type: 'bearer',
      provider: 'anthropic-compatible',
      token: 'bearer-test',
    }
    await writeAuth('sonnet-compatible', cred, authPath)
    const result = await getCredential('sonnet-compatible', authPath)
    expect(result).toEqual(cred)
  })

  it('writes file with 0o600 permissions', async () => {
    const cred: AuthCredential = { type: 'api', provider: 'openai', key: 'sk-test' }
    await writeAuth('openai', cred, authPath)
    const s = await stat(authPath)
    // 0o600 = 0o100600 on files, check lower 9 bits
    expect(s.mode & 0o777).toBe(0o600)
  })

  it('merges multiple credentials', async () => {
    const credA: AuthCredential = { type: 'api', provider: 'openai', key: 'sk-a' }
    const credB: AuthCredential = {
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: { access: 'a', refresh: 'r', expires: 0 },
    }
    await writeAuth('openai', credA, authPath)
    await writeAuth('anthropic', credB, authPath)
    const store = await readAuth(authPath)
    expect(Object.keys(store)).toHaveLength(2)
    expect(store['openai']).toEqual(credA)
    expect(store['anthropic']).toEqual(credB)
  })

  it('removes a credential', async () => {
    const cred: AuthCredential = { type: 'api', provider: 'openai', key: 'sk-test' }
    await writeAuth('openai', cred, authPath)
    await removeAuth('openai', authPath)
    const store = await readAuth(authPath)
    expect(store['openai']).toBeUndefined()
  })

  it('deletes file when last credential is removed', async () => {
    const cred: AuthCredential = { type: 'api', provider: 'openai', key: 'sk-test' }
    await writeAuth('openai', cred, authPath)
    await removeAuth('openai', authPath)
    await expect(stat(authPath)).rejects.toThrow()
  })

  it('getCredential returns single provider', async () => {
    const cred: AuthCredential = { type: 'api', provider: 'openai', key: 'sk-test' }
    await writeAuth('openai', cred, authPath)
    const result = await getCredential('openai', authPath)
    expect(result).toEqual(cred)
  })

  it('getCredential returns null for missing provider', async () => {
    const result = await getCredential('missing', authPath)
    expect(result).toBeNull()
  })

  it('creates parent directory if needed', async () => {
    const deepPath = join(tempDir, 'nested', 'dir', 'auth.json')
    const cred: AuthCredential = { type: 'api', provider: 'openai', key: 'sk-test' }
    await writeAuth('openai', cred, deepPath)
    const data = await readFile(deepPath, 'utf-8')
    expect(JSON.parse(data)['openai']).toEqual(cred)
  })
})
