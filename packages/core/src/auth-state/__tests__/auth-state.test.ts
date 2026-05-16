import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AuthStateMetadataSchema,
  readAuthStateMetadata,
  resolveAuthStatePaths,
  writeAuthStateFiles,
} from '../index.js'

const tempRoots: string[] = []

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-qa-auth-state-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const webTarget = { platform: 'web' as const, url: 'https://staging.example.com' }
const androidTarget = { platform: 'android' as const, appPackage: 'com.example.app' }
const iosTarget = { platform: 'ios' as const, bundleId: 'com.example.app' }

const metadata = {
  version: 1,
  kind: 'web',
  target: 'staging-web',
  name: 'admin',
  capturedAt: '2026-05-17T00:00:00.000Z',
} as const

const payload = {
  cookies: [
    {
      name: 'session',
      value: 'secret-cookie',
      domain: 'staging.example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [
    {
      origin: 'https://staging.example.com',
      localStorage: [
        { name: 'token', value: 'secret-local-storage' },
      ],
      indexedDB: [
        {
          name: 'firebaseLocalStorageDb',
          version: 1,
          stores: [
            {
              name: 'firebaseLocalStorage',
              records: [{ key: 'user', value: { uid: '123' } }],
            },
          ],
        },
      ],
    },
  ],
}

describe('auth-state resolver', () => {
  it('resolves default target-scoped sidecar paths', async () => {
    const root = await createTempRoot()

    const paths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })

    expect(paths.rootDir).toBe(path.join(root, '.agent-qa/auth-states'))
    expect(paths.targetDir).toBe(path.join(root, '.agent-qa/auth-states', 'staging-web'))
    expect(paths.payloadPath).toBe(path.join(root, '.agent-qa/auth-states', 'staging-web', 'admin.json'))
    expect(paths.metadataPath).toBe(path.join(root, '.agent-qa/auth-states', 'staging-web', 'admin.meta.json'))
  })

  it('resolves a configured auth-state directory relative to the config dir', async () => {
    const root = await createTempRoot()

    const paths = resolveAuthStatePaths({
      configDir: root,
      authStateDir: '.agent-qa/custom-auth-states',
      targetName: 'staging-web',
      stateName: 'admin',
      platform: 'web',
    })

    expect(paths.payloadPath).toBe(path.join(root, '.agent-qa/custom-auth-states', 'staging-web', 'admin.json'))
    expect(paths.metadataPath).toBe(path.join(root, '.agent-qa/custom-auth-states', 'staging-web', 'admin.meta.json'))
  })

  it('rejects invalid target and auth-state slugs before path construction', async () => {
    const root = await createTempRoot()

    for (const targetName of ['Staging', 'staging_web', 'bad/path', '.', '..', '../staging', '', 'staging-']) {
      expect(() => resolveAuthStatePaths({
        configDir: root,
        targetName,
        stateName: 'admin',
        target: webTarget,
      }), JSON.stringify(targetName)).toThrow(/Target name/)
    }

    for (const stateName of ['Admin', 'admin/user', '../admin', '.admin', 'admin-', '', 'admin_state']) {
      expect(() => resolveAuthStatePaths({
        configDir: root,
        targetName: 'staging-web',
        stateName,
        target: webTarget,
      }), JSON.stringify(stateName)).toThrow(/Auth state name/)
    }
  })

  it('rejects Android and iOS targets with mobile app-state guidance', async () => {
    const root = await createTempRoot()

    for (const target of [androidTarget, iosTarget]) {
      expect(() => resolveAuthStatePaths({
        configDir: root,
        targetName: 'staging-web',
        stateName: 'admin',
        target,
      })).toThrow(/auth state is only supported for web targets/)
      expect(() => resolveAuthStatePaths({
        configDir: root,
        targetName: 'staging-web',
        stateName: 'admin',
        target,
      })).toThrow(/use\.mobile\.appState: preserve/)
      expect(() => resolveAuthStatePaths({
        configDir: root,
        targetName: 'staging-web',
        stateName: 'admin',
        target,
      })).toThrow(/secure-storage\/keychain/)
    }
  })
})

describe('auth-state metadata and store', () => {
  it('accepts only the minimal V1 metadata contract', () => {
    const result = AuthStateMetadataSchema.safeParse(metadata)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.keys(result.data)).toEqual(['version', 'kind', 'target', 'name', 'capturedAt'])
    }

    for (const key of ['createdAt', 'updatedAt', 'capturedFrom', 'ttlSeconds', 'expiresAt']) {
      expect(AuthStateMetadataSchema.safeParse({
        ...metadata,
        [key]: key === 'ttlSeconds' ? 3600 : '2026-05-17T00:00:00.000Z',
      }).success, key).toBe(false)
    }
  })

  it('writes raw Playwright storage-state payload and metadata sidecar files', async () => {
    const root = await createTempRoot()
    const paths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })

    await writeAuthStateFiles(paths, { payload, metadata })

    expect(JSON.parse(await readFile(paths.payloadPath, 'utf-8'))).toEqual(payload)
    expect(JSON.parse(await readFile(paths.metadataPath, 'utf-8'))).toEqual(metadata)
    expect(await readAuthStateMetadata(paths)).toEqual(metadata)
  })

  it('leaves previous sidecar files intact when serialization fails before rename', async () => {
    const root = await createTempRoot()
    const paths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    await writeAuthStateFiles(paths, { payload, metadata })

    const circularPayload: Record<string, unknown> = { cookies: [] }
    circularPayload.self = circularPayload

    await expect(writeAuthStateFiles(paths, { payload: circularPayload, metadata })).rejects.toThrow()

    expect(JSON.parse(await readFile(paths.payloadPath, 'utf-8'))).toEqual(payload)
    expect(JSON.parse(await readFile(paths.metadataPath, 'utf-8'))).toEqual(metadata)
  })

  it('rejects missing, corrupt, and mismatched metadata with actionable errors', async () => {
    const root = await createTempRoot()
    const paths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })

    await expect(readAuthStateMetadata(paths)).rejects.toThrow(/Auth-state metadata not found/)

    await mkdir(path.dirname(paths.metadataPath), { recursive: true })
    await writeFile(paths.metadataPath, '{')
    await expect(readAuthStateMetadata(paths)).rejects.toThrow(/Invalid auth-state metadata JSON/)

    await writeFile(paths.metadataPath, `${JSON.stringify({ ...metadata, target: 'other-web' }, null, 2)}\n`)
    await expect(readAuthStateMetadata(paths)).rejects.toThrow(/does not match resolved target/)

    await writeFile(paths.metadataPath, `${JSON.stringify({ ...metadata, name: 'viewer' }, null, 2)}\n`)
    await expect(readAuthStateMetadata(paths)).rejects.toThrow(/does not match resolved state/)
  })
})
