import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AuthStateMetadataSchema,
  AUTH_STATE_HOOK_JSON_ENV,
  AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV,
  buildAuthStateHookEnv,
  listAuthStateMetadata,
  readAuthStateMetadata,
  removeAuthStateFiles,
  removeAuthStateTarget,
  resolveAuthStateForRun,
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

  it('lists valid auth-state metadata only without exposing paths or payload details', async () => {
    const root = await createTempRoot()
    const adminPaths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    const viewerPaths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'prod-web',
      stateName: 'viewer',
      target: webTarget,
    })

    await expect(listAuthStateMetadata({ configDir: root })).resolves.toEqual([])

    await writeAuthStateFiles(adminPaths, { payload, metadata })
    await writeAuthStateFiles(viewerPaths, {
      payload,
      metadata: {
        ...metadata,
        target: 'prod-web',
        name: 'viewer',
        capturedAt: '2026-05-17T01:00:00.000Z',
      },
    })

    await mkdir(path.join(root, '.agent-qa/auth-states', 'staging-web'), { recursive: true })
    await writeFile(
      path.join(root, '.agent-qa/auth-states', 'staging-web', 'broken.meta.json'),
      '{',
      'utf-8',
    )
    await writeFile(
      path.join(root, '.agent-qa/auth-states', 'staging-web', 'mismatch.meta.json'),
      `${JSON.stringify({ ...metadata, name: 'other' }, null, 2)}\n`,
      'utf-8',
    )
    await writeFile(
      path.join(root, '.agent-qa/auth-states', 'staging-web', 'payload-copy.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf-8',
    )

    const result = await listAuthStateMetadata({ configDir: root })

    expect(result).toEqual([
      {
        ...metadata,
        target: 'prod-web',
        name: 'viewer',
        capturedAt: '2026-05-17T01:00:00.000Z',
      },
      metadata,
    ])
    expect(Object.keys(result[0] ?? {})).toEqual(['version', 'kind', 'target', 'name', 'capturedAt'])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('.agent-qa/auth-states')
    expect(serialized).not.toContain('.json')
    expect(serialized).not.toContain('payloadPath')
    expect(serialized).not.toContain('metadataPath')
    expect(serialized).not.toContain('secret-cookie')
    expect(serialized).not.toContain('secret-local-storage')
    expect(serialized).not.toContain('firebaseLocalStorageDb')
  })

  it('filters listed auth-state metadata by target name', async () => {
    const root = await createTempRoot()
    const adminPaths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    const viewerPaths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'prod-web',
      stateName: 'viewer',
      target: webTarget,
    })

    await writeAuthStateFiles(adminPaths, { payload, metadata })
    await writeAuthStateFiles(viewerPaths, {
      payload,
      metadata: {
        ...metadata,
        target: 'prod-web',
        name: 'viewer',
        capturedAt: '2026-05-17T01:00:00.000Z',
      },
    })

    await expect(listAuthStateMetadata({
      configDir: root,
      targetName: 'staging-web',
    })).resolves.toEqual([metadata])
  })

  it('removes one named auth state without touching neighboring states', async () => {
    const root = await createTempRoot()
    const adminPaths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    const viewerPaths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'viewer',
      target: webTarget,
    })

    await writeAuthStateFiles(adminPaths, { payload, metadata })
    await writeAuthStateFiles(viewerPaths, {
      payload,
      metadata: {
        ...metadata,
        name: 'viewer',
      },
    })

    await removeAuthStateFiles({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    await removeAuthStateFiles({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })

    await expect(readFile(adminPaths.payloadPath, 'utf-8')).rejects.toThrow()
    await expect(readAuthStateMetadata(adminPaths)).rejects.toThrow(/not found/)
    await expect(readAuthStateMetadata(viewerPaths)).resolves.toEqual({
      ...metadata,
      name: 'viewer',
    })
  })

  it('removes an entire target auth-state directory without touching neighboring targets', async () => {
    const root = await createTempRoot()
    const stagingPaths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    const prodPaths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'prod-web',
      stateName: 'admin',
      target: webTarget,
    })

    await writeAuthStateFiles(stagingPaths, { payload, metadata })
    await writeAuthStateFiles(prodPaths, {
      payload,
      metadata: {
        ...metadata,
        target: 'prod-web',
      },
    })
    await writeFile(path.join(stagingPaths.targetDir, 'broken.meta.json'), '{', 'utf-8')
    await writeFile(path.join(stagingPaths.targetDir, 'partial.json'), '{}', 'utf-8')

    await removeAuthStateTarget({
      configDir: root,
      targetName: 'staging-web',
      target: webTarget,
    })
    await removeAuthStateTarget({
      configDir: root,
      targetName: 'staging-web',
      target: webTarget,
    })

    await expect(readFile(stagingPaths.payloadPath, 'utf-8')).rejects.toThrow()
    await expect(readFile(path.join(stagingPaths.targetDir, 'broken.meta.json'), 'utf-8')).rejects.toThrow()
    await expect(readAuthStateMetadata(prodPaths)).resolves.toEqual({
      ...metadata,
      target: 'prod-web',
    })
  })

  it('rejects mobile targets for removal helpers', async () => {
    const root = await createTempRoot()

    await expect(removeAuthStateFiles({
      configDir: root,
      targetName: 'mobile-app',
      stateName: 'admin',
      target: androidTarget,
    })).rejects.toThrow(/auth state is only supported for web targets/)

    await expect(removeAuthStateTarget({
      configDir: root,
      targetName: 'mobile-app',
      target: iosTarget,
    })).rejects.toThrow(/auth state is only supported for web targets/)
  })
})

describe('auth-state runtime preflight', () => {
  it('resolves a selected auth state to an internal storage-state path', async () => {
    const root = await createTempRoot()
    const paths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    await writeAuthStateFiles(paths, { payload, metadata })

    await expect(resolveAuthStateForRun({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })).resolves.toEqual({
      version: 1,
      kind: 'web',
      targetName: 'staging-web',
      stateName: 'admin',
      capturedAt: '2026-05-17T00:00:00.000Z',
      storageStatePath: paths.payloadPath,
    })
  })

  it('builds runtime-neutral auth-state hook env from selected metadata', async () => {
    const root = await createTempRoot()
    const paths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    await writeAuthStateFiles(paths, { payload, metadata })
    const resolved = await resolveAuthStateForRun({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })

    const hookEnv = buildAuthStateHookEnv(resolved, '/workspace/.agent-qa-auth-state/storage-state.json')

    expect(hookEnv[AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV]).toBe('/workspace/.agent-qa-auth-state/storage-state.json')
    expect(JSON.parse(hookEnv[AUTH_STATE_HOOK_JSON_ENV])).toEqual({
      version: 1,
      kind: 'web',
      target: 'staging-web',
      name: 'admin',
      capturedAt: '2026-05-17T00:00:00.000Z',
      storageStatePath: '/workspace/.agent-qa-auth-state/storage-state.json',
    })
    expect(JSON.stringify(hookEnv)).not.toContain(paths.payloadPath)
  })

  it('uses logical target/name and recapture guidance when metadata is missing', async () => {
    const root = await createTempRoot()
    const paths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })

    await expect(resolveAuthStateForRun({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })).rejects.toThrow(/Auth state "admin" for target "staging-web"/)

    try {
      await resolveAuthStateForRun({
        configDir: root,
        targetName: 'staging-web',
        stateName: 'admin',
        target: webTarget,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('agent-qa auth-state capture --target staging-web --name admin')
      expect(message).not.toContain(paths.payloadPath)
      expect(message).not.toContain(paths.metadataPath)
      expect(message).not.toContain('.agent-qa/auth-states')
    }
  })

  it('uses logical target/name and recapture guidance when payload is missing', async () => {
    const root = await createTempRoot()
    const paths = resolveAuthStatePaths({
      configDir: root,
      targetName: 'staging-web',
      stateName: 'admin',
      target: webTarget,
    })
    await writeAuthStateFiles(paths, { payload, metadata })
    await unlink(paths.payloadPath)

    try {
      await resolveAuthStateForRun({
        configDir: root,
        targetName: 'staging-web',
        stateName: 'admin',
        target: webTarget,
      })
      throw new Error('expected auth-state preflight to fail')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('Auth state "admin" for target "staging-web"')
      expect(message).toContain('agent-qa auth-state capture --target staging-web --name admin')
      expect(message).not.toContain(paths.payloadPath)
      expect(message).not.toContain(paths.metadataPath)
      expect(message).not.toContain('.agent-qa/auth-states')
    }
  })

  it('rejects Android and iOS targets through the existing mobile guidance', async () => {
    const root = await createTempRoot()

    for (const target of [androidTarget, iosTarget]) {
      await expect(resolveAuthStateForRun({
        configDir: root,
        targetName: 'staging-web',
        stateName: 'admin',
        target,
      })).rejects.toThrow(/auth state is only supported for web targets/)
      await expect(resolveAuthStateForRun({
        configDir: root,
        targetName: 'staging-web',
        stateName: 'admin',
        target,
      })).rejects.toThrow(/use\.mobile\.appState: preserve/)
    }
  })
})
