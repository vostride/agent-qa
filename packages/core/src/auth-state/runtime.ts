import { readFile } from 'node:fs/promises'
import { readAuthStateMetadata } from './store.js'
import {
  resolveAuthStatePaths,
  type AuthStateTargetPlatform,
  type ResolvedAuthStatePaths,
} from './resolver.js'

export interface ResolveAuthStateForRunInput {
  configDir: string
  authStateDir?: string
  targetName: string
  stateName: string
  target?: {
    platform: AuthStateTargetPlatform
  }
  platform?: AuthStateTargetPlatform
}

export interface ResolvedAuthStateForRun {
  version: number
  kind: 'web'
  targetName: string
  stateName: string
  capturedAt: string
  storageStatePath: string
}

function createAuthStateReadError(targetName: string, stateName: string): Error {
  return new Error(
    `Auth state "${stateName}" for target "${targetName}" was not found or could not be read. ` +
    `Run agent-qa auth-state capture --target ${targetName} --name ${stateName}.`,
  )
}

async function assertPayloadReadable(paths: ResolvedAuthStatePaths): Promise<void> {
  const raw = await readFile(paths.payloadPath, 'utf-8')
  JSON.parse(raw)
}

export async function resolveAuthStateForRun(
  input: ResolveAuthStateForRunInput,
): Promise<ResolvedAuthStateForRun> {
  const paths = resolveAuthStatePaths(input)

  try {
    const metadata = await readAuthStateMetadata(paths)
    await assertPayloadReadable(paths)
    return {
      version: metadata.version,
      kind: metadata.kind,
      targetName: metadata.target,
      stateName: metadata.name,
      capturedAt: metadata.capturedAt,
      storageStatePath: paths.payloadPath,
    }
  } catch {
    throw createAuthStateReadError(paths.targetName, paths.stateName)
  }
}
