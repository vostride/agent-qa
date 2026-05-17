import path from 'node:path'
import { DEFAULT_AGENT_QA_AUTH_STATES_DIR } from '../runtime-paths.js'
import { AuthStateNameSchema, TargetNameSchema } from './schema.js'

export type AuthStateTargetPlatform = 'web' | 'android' | 'ios'

export interface ResolveAuthStatePathsInput {
  configDir: string
  authStateDir?: string
  targetName: string
  stateName: string
  target?: {
    platform: AuthStateTargetPlatform
  }
  platform?: AuthStateTargetPlatform
}

export interface ResolvedAuthStatePaths {
  targetName: string
  stateName: string
  rootDir: string
  targetDir: string
  payloadPath: string
  metadataPath: string
}

export interface ResolveAuthStateRootInput {
  configDir: string
  authStateDir?: string
}

const MOBILE_AUTH_STATE_ERROR = [
  'auth state is only supported for web targets.',
  'For native mobile, use use.mobile.appState: preserve when keeping app data between sessions.',
  'App-state preservation is broader than auth and does not export generic secure-storage/keychain tokens.',
].join(' ')

function assertInsideRoot(rootDir: string, filePath: string): void {
  const relativePath = path.relative(rootDir, filePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Resolved auth-state path escapes auth-state directory: ${filePath}`)
  }
}

export function resolveAuthStateRoot(input: ResolveAuthStateRootInput): string {
  const { configDir, authStateDir } = input
  const configuredDir = authStateDir ?? DEFAULT_AGENT_QA_AUTH_STATES_DIR
  if (configuredDir.trim().length === 0) {
    throw new Error('authState.dir must be a non-empty path')
  }
  return path.isAbsolute(configuredDir)
    ? path.resolve(configuredDir)
    : path.resolve(configDir, configuredDir)
}

export function resolveAuthStatePaths(input: ResolveAuthStatePathsInput): ResolvedAuthStatePaths {
  const targetName = TargetNameSchema.parse(input.targetName)
  const stateName = AuthStateNameSchema.parse(input.stateName)
  const platform = input.target?.platform ?? input.platform

  if (platform !== 'web') {
    throw new Error(MOBILE_AUTH_STATE_ERROR)
  }

  const rootDir = resolveAuthStateRoot({
    configDir: input.configDir,
    authStateDir: input.authStateDir,
  })
  const targetDir = path.join(rootDir, targetName)
  const payloadPath = path.join(targetDir, `${stateName}.json`)
  const metadataPath = path.join(targetDir, `${stateName}.meta.json`)

  assertInsideRoot(rootDir, payloadPath)
  assertInsideRoot(rootDir, metadataPath)

  return {
    targetName,
    stateName,
    rootDir,
    targetDir,
    payloadPath,
    metadataPath,
  }
}
