import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  readFile,
  stat,
  lstat,
  rm,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getAuthPath,
  getCredential,
  listSavedCredentials,
  readAuth,
  removeAuth,
  writeAuth,
} from '../auth/store.js'
import type { AuthCredential } from '../auth/types.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

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

  it('WRITE-AUTH-ATOMIC: writeAuth and removeAuth rename a same-directory temp file onto auth.json', async () => {
    const renameSpy = vi.mocked(rename)
    renameSpy.mockClear()
    const cred: AuthCredential = { type: 'api', provider: 'openai-compatible', key: 'k' }
    await writeAuth('gpt-5.6', cred, authPath)

    expect(renameSpy).toHaveBeenCalledTimes(1)
    const [from, to] = renameSpy.mock.calls[0] as [string, string]
    expect(to).toBe(authPath)
    expect(dirname(from)).toBe(dirname(authPath))
    expect(from).not.toBe(authPath)
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)
    expect((await readAuth(authPath))['gpt-5.6']).toEqual(cred)

    await writeAuth('other', { type: 'api', provider: 'openai', key: 'o' }, authPath)
    renameSpy.mockClear()
    await removeAuth('other', authPath)
    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect((renameSpy.mock.calls[0] as [string, string])[1]).toBe(authPath)
    expect(await readAuth(authPath)).toEqual({ 'gpt-5.6': cred })
    expect((await readdir(tempDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('WRITE-AUTH-ATOMIC: readAuth still swallows an unreadable store', async () => {
    await writeAuth('gpt-5.6', { type: 'api', provider: 'openai-compatible', key: 'k' }, authPath)
    await rm(authPath)
    await (await import('node:fs/promises')).writeFile(authPath, '{"trunc', 'utf-8')
    expect(await readAuth(authPath)).toEqual({})
  })

  describe('saved credential list', () => {
    const dummyToken = 'DUMMY-TOKEN-A'
    const dummyKey = 'DUMMY-KEY-B'

    beforeEach(async () => {
      await writeFile(
        authPath,
        JSON.stringify({
          'claude-code': {
            type: 'oauth',
            provider: 'anthropic-subscription',
            tokens: { access: dummyToken, refresh: dummyToken, expires: 0 },
          },
          work: { type: 'api', provider: 'openai-compatible', key: dummyKey },
          g: { type: 'api', provider: 'gemini', key: dummyKey },
          'a b': {
            type: 'oauth',
            provider: 'anthropic-subscription',
            tokens: { access: dummyToken, refresh: dummyToken, expires: 0 },
          },
          other: { type: 'api', provider: 'some-unknown-provider', key: dummyKey },
          lost: { type: 'bearer', provider: 'anthropic-compatible', token: dummyToken },
        }),
        'utf-8',
      )
    })

    it('lists every credential by name, kind and provider', async () => {
      const saved = await listSavedCredentials(authPath)
      expect(saved).toEqual([
        { name: 'claude-code', type: 'oauth', provider: 'anthropic-subscription' },
        { name: 'work', type: 'api', provider: 'openai-compatible' },
        { name: 'g', type: 'api', provider: 'gemini' },
        { name: 'a b', type: 'oauth', provider: 'anthropic-subscription' },
        { name: 'other', type: 'api', provider: 'some-unknown-provider' },
        { name: 'lost', type: 'bearer', provider: 'anthropic-compatible' },
      ])
    })

    it('never returns a key, token or tokens field or a secret value', async () => {
      const saved = await listSavedCredentials(authPath)
      for (const entry of saved) {
        expect(Object.keys(entry).sort()).toEqual(['name', 'provider', 'type'])
      }
      const text = JSON.stringify(saved)
      expect(text).not.toContain(dummyToken)
      expect(text).not.toContain(dummyKey)
    })

    it('drops an entry with no known kind or no provider', async () => {
      await writeFile(
        authPath,
        JSON.stringify({
          odd: { type: 'session', provider: 'gemini', key: dummyKey },
          bare: { type: 'api', key: dummyKey },
          text: 'not-a-credential',
          kept: { type: 'api', provider: 'gemini', key: dummyKey },
        }),
        'utf-8',
      )
      expect(await listSavedCredentials(authPath)).toEqual([
        { name: 'kept', type: 'api', provider: 'gemini' },
      ])
    })

    it('gives an empty list for a missing, unreadable or non-object store', async () => {
      expect(await listSavedCredentials(join(tempDir, 'missing.json'))).toEqual([])
      await writeFile(authPath, '{"trunc', 'utf-8')
      expect(await listSavedCredentials(authPath)).toEqual([])
      await writeFile(authPath, '[1, 2]', 'utf-8')
      expect(await listSavedCredentials(authPath)).toEqual([])
      await writeFile(authPath, 'null', 'utf-8')
      expect(await listSavedCredentials(authPath)).toEqual([])
    })
  })

  describe('auth path', () => {
    it('is under XDG_DATA_HOME when that is set', () => {
      expect(getAuthPath({ env: { XDG_DATA_HOME: '/x' }, homeDir: '/h' })).toBe(
        join('/x', 'agent-qa', 'auth.json'),
      )
    })

    it('is under the home folder when XDG_DATA_HOME is not set', () => {
      expect(getAuthPath({ env: {}, homeDir: '/h' })).toBe(join('/h', '.agent-qa', 'auth.json'))
    })
  })

  describe('symlinked auth.json', () => {
    const credA: AuthCredential = { type: 'api', provider: 'openai', key: 'sk-a' }
    const credB: AuthCredential = { type: 'api', provider: 'openai-compatible', key: 'sk-b' }
    let realDir: string
    let linkDir: string
    let realPath: string
    let linkPath: string
    const isSymlink = (path: string) =>
      lstat(path).then(
        stats => stats.isSymbolicLink(),
        () => false,
      )

    beforeEach(async () => {
      realDir = join(tempDir, 'real')
      linkDir = join(tempDir, 'link')
      realPath = join(realDir, 'auth.json')
      linkPath = join(linkDir, 'auth.json')
      await mkdir(realDir, { recursive: true })
      await mkdir(linkDir, { recursive: true })
    })

    it('AUTH-SYMLINK-KEPT: writeAuth through a link keeps the link and writes its target 0600', async () => {
      await writeAuth('a', credA, realPath)
      await symlink(realPath, linkPath)

      await writeAuth('b', credB, linkPath)

      expect(await isSymlink(linkPath)).toBe(true)
      expect(await readAuth(realPath)).toEqual({ a: credA, b: credB })
      expect((await stat(realPath)).mode & 0o777).toBe(0o600)
      const stray = [...(await readdir(realDir)), ...(await readdir(linkDir))].filter(name =>
        name.endsWith('.tmp'),
      )
      expect(stray).toEqual([])
    })

    it('AUTH-SYMLINK-REMOVE-KEEPS-LINK: removing the last credential keeps the link and clears the target', async () => {
      await writeAuth('a', credA, realPath)
      await symlink(realPath, linkPath)

      await removeAuth('a', linkPath)

      expect(await isSymlink(linkPath)).toBe(true)
      expect(await readAuth(realPath)).not.toHaveProperty('a')
    })

    it('AUTH-SYMLINK-DANGLING-CREATES-TARGET: a dangling relative link has its target created', async () => {
      await symlink(join('..', 'real', 'auth.json'), linkPath)

      await writeAuth('a', credA, linkPath)

      expect(await isSymlink(linkPath)).toBe(true)
      expect(await readAuth(realPath)).toEqual({ a: credA })
    })
  })
})
