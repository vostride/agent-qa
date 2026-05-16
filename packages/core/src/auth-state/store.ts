import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AuthStateMetadataSchema, type AuthStateMetadata } from './schema.js'
import type { ResolvedAuthStatePaths } from './resolver.js'

export interface WriteAuthStateFilesInput {
  payload: unknown
  metadata: AuthStateMetadata
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

