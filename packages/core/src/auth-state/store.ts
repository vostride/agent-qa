import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AuthStateMetadataSchema, TargetNameSchema, type AuthStateMetadata } from './schema.js'
import { resolveAuthStatePaths, resolveAuthStateRoot, type ResolvedAuthStatePaths } from './resolver.js'

export interface WriteAuthStateFilesInput {
  payload: unknown
  metadata: AuthStateMetadata
}

export interface ListAuthStateMetadataInput {
  configDir: string
  authStateDir?: string
  targetName?: string
}

export interface RemoveAuthStateFilesInput {
  configDir: string
  authStateDir?: string
  targetName: string
  stateName: string
  target?: Parameters<typeof resolveAuthStatePaths>[0]['target']
  platform?: Parameters<typeof resolveAuthStatePaths>[0]['platform']
}

export interface RemoveAuthStateTargetInput {
  configDir: string
  authStateDir?: string
  targetName: string
  target?: Parameters<typeof resolveAuthStatePaths>[0]['target']
  platform?: Parameters<typeof resolveAuthStatePaths>[0]['platform']
}

function assertMetadataMatches(paths: ResolvedAuthStatePaths, metadata: AuthStateMetadata): void {
  if (metadata.target !== paths.targetName) {
    throw new Error(`Auth-state metadata target "${metadata.target}" does not match resolved target "${paths.targetName}"`)
  }
  if (metadata.name !== paths.stateName) {
    throw new Error(`Auth-state metadata name "${metadata.name}" does not match resolved state "${paths.stateName}"`)
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  const directory = path.dirname(filePath)
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)

  await mkdir(directory, { recursive: true })
  try {
    await writeFile(tempPath, serialized, { mode: 0o600 })
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readAuthStateMetadata(paths: ResolvedAuthStatePaths): Promise<AuthStateMetadata> {
  let raw: string
  try {
    raw = await readFile(paths.metadataPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Auth-state metadata not found: ${paths.metadataPath}`)
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid auth-state metadata JSON: ${paths.metadataPath}`)
  }

  const result = AuthStateMetadataSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Invalid auth-state metadata: ${result.error.issues.map(issue => issue.message).join('; ')}`)
  }

  assertMetadataMatches(paths, result.data)
  return result.data
}

export async function writeAuthStateFiles(
  paths: ResolvedAuthStatePaths,
  input: WriteAuthStateFilesInput,
): Promise<void> {
  const metadata = AuthStateMetadataSchema.parse(input.metadata)
  assertMetadataMatches(paths, metadata)

  await writeJsonAtomic(paths.payloadPath, input.payload)
  await writeJsonAtomic(paths.metadataPath, metadata)
}

export async function listAuthStateMetadata(
  input: ListAuthStateMetadataInput,
): Promise<AuthStateMetadata[]> {
  const rootDir = resolveAuthStateRoot({
    configDir: input.configDir,
    authStateDir: input.authStateDir,
  })
  const targetFilter = input.targetName ? TargetNameSchema.parse(input.targetName) : undefined

  let targetEntries: Dirent<string>[]
  try {
    targetEntries = await readdir(rootDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const metadata: AuthStateMetadata[] = []
  for (const targetEntry of targetEntries) {
    if (!targetEntry.isDirectory()) continue
    const targetNameResult = TargetNameSchema.safeParse(targetEntry.name)
    if (!targetNameResult.success) continue
    const targetName = targetNameResult.data
    if (targetFilter && targetName !== targetFilter) continue

    let stateEntries: Dirent<string>[]
    const targetDir = path.join(rootDir, targetName)
    try {
      stateEntries = await readdir(targetDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const stateEntry of stateEntries) {
      if (!stateEntry.isFile() || !stateEntry.name.endsWith('.meta.json')) continue
      const stateName = stateEntry.name.slice(0, -'.meta.json'.length)
      const paths = (() => {
        try {
          return resolveAuthStatePaths({
            configDir: input.configDir,
            authStateDir: input.authStateDir,
            targetName,
            stateName,
            platform: 'web',
          })
        } catch {
          return null
        }
      })()
      if (!paths) continue

      try {
        const entry = await readAuthStateMetadata(paths)
        metadata.push(entry)
      } catch {
        continue
      }
    }
  }

  return metadata.sort((a, b) => {
    const targetOrder = a.target.localeCompare(b.target)
    return targetOrder === 0 ? a.name.localeCompare(b.name) : targetOrder
  })
}

export async function removeAuthStateFiles(input: RemoveAuthStateFilesInput): Promise<void> {
  const paths = resolveAuthStatePaths(input)
  await rm(paths.payloadPath, { force: true })
  await rm(paths.metadataPath, { force: true })
}

export async function removeAuthStateTarget(input: RemoveAuthStateTargetInput): Promise<void> {
  const paths = resolveAuthStatePaths({
    ...input,
    stateName: 'placeholder',
  })
  await rm(paths.targetDir, { recursive: true, force: true })
}
