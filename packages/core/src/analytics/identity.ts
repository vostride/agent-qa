import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { idAgent } from 'id-agent'

export type AnalyticsRuntimeContext = 'user' | 'ci' | 'agent'
export type AnalyticsAgentProduct =
  | 'claude_code'
  | 'cursor'
  | 'gemini_cli'
  | 'augment'
  | 'goose'
  | 'opencode'
  | 'codex'
  | 'cline'
  | 'amp'

export interface AnalyticsIdentity {
  distinctId: string
  runtimeContext: AnalyticsRuntimeContext
  agentProduct?: AnalyticsAgentProduct
  isInternal?: boolean
}

export interface AnalyticsIdentityStore {
  distinctId: string
  is_internal: boolean
}

interface ParsedAnalyticsIdentityStore extends AnalyticsIdentityStore {
  needsMigration: boolean
}

export interface ResolveAnalyticsIdentityOptions {
  env?: Record<string, string | undefined>
  identityPath?: string
  homeDir?: string
}

const LOCAL_ANALYTICS_ID_PATTERN = /^u_([a-z]+-){9}[a-z]+$/

export function getAnalyticsIdentityPath(
  env: Record<string, string | undefined> = process.env,
  homeDir = homedir(),
): string {
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'agent-qa', 'analytics.json')
  return join(homeDir, '.agent-qa', 'analytics.json')
}

export function generateAnalyticsUserId(): string {
  return idAgent({ prefix: 'u', words: 10 })
}

function parseAnalyticsIdentityStore(value: unknown): ParsedAnalyticsIdentityStore | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const distinctId = (value as { distinctId?: unknown }).distinctId
  if (typeof distinctId !== 'string' || !LOCAL_ANALYTICS_ID_PATTERN.test(distinctId)) return null
  const rawIsInternal = (value as { is_internal?: unknown }).is_internal
  return {
    distinctId,
    is_internal: rawIsInternal === true,
    needsMigration: typeof rawIsInternal !== 'boolean',
  }
}

async function readAnalyticsIdentityStore(path?: string): Promise<ParsedAnalyticsIdentityStore | null> {
  const identityPath = path ?? getAnalyticsIdentityPath()
  try {
    const data = await readFile(identityPath, 'utf-8')
    const parsed = JSON.parse(data) as unknown
    return parseAnalyticsIdentityStore(parsed)
  } catch {
    return null
  }
}

export async function readAnalyticsIdentity(path?: string): Promise<AnalyticsIdentityStore | null> {
  const parsed = await readAnalyticsIdentityStore(path)
  return parsed
    ? { distinctId: parsed.distinctId, is_internal: parsed.is_internal }
    : null
}

export async function writeAnalyticsIdentity(
  distinctId: string,
  path?: string,
  isInternal = false,
): Promise<void> {
  const identityPath = path ?? getAnalyticsIdentityPath()
  await mkdir(dirname(identityPath), { recursive: true })
  await writeFile(identityPath, JSON.stringify({
    distinctId,
    is_internal: isInternal,
  }, null, 2), { mode: 0o600 })
  await chmod(identityPath, 0o600)
}

export function resolveAnalyticsAgentProduct(
  env: Record<string, string | undefined> = process.env,
): AnalyticsAgentProduct | undefined {
  if (env.CLAUDECODE !== undefined || env.CLAUDE_CODE_ENTRYPOINT !== undefined) return 'claude_code'
  if (env.CURSOR_AGENT !== undefined) return 'cursor'
  if (env.GEMINI_CLI !== undefined) return 'gemini_cli'
  if (env.AUGMENT_AGENT !== undefined) return 'augment'
  if (env.GOOSE_TERMINAL !== undefined || env.AGENT === 'goose') return 'goose'
  if (env.OPENCODE_CLIENT !== undefined) return 'opencode'
  if (env.CODEX_SANDBOX !== undefined) return 'codex'
  if (env.CLINE_ACTIVE !== undefined) return 'cline'
  if (env.AGENT === 'amp') return 'amp'
  return undefined
}

function hasUnknownAgentSignal(env: Record<string, string | undefined>): boolean {
  return typeof env.AGENT === 'string' && env.AGENT.length > 0
}

export async function resolveAnalyticsIdentity(
  options: ResolveAnalyticsIdentityOptions = {},
): Promise<AnalyticsIdentity> {
  const env = options.env ?? process.env
  if (env.CI === 'true') {
    return { distinctId: 'u_CI', runtimeContext: 'ci' }
  }

  const agentProduct = resolveAnalyticsAgentProduct(env)
  if (agentProduct) {
    return {
      distinctId: `u_AGENT-${agentProduct}`,
      runtimeContext: 'agent',
      agentProduct,
    }
  }

  if (hasUnknownAgentSignal(env)) {
    return { distinctId: 'u_AGENT', runtimeContext: 'agent' }
  }

  const identityPath = options.identityPath ?? getAnalyticsIdentityPath(env, options.homeDir)
  const existing = await readAnalyticsIdentityStore(identityPath)
  if (existing) {
    if (existing.needsMigration) {
      await writeAnalyticsIdentity(existing.distinctId, identityPath, existing.is_internal)
    }
    return {
      distinctId: existing.distinctId,
      runtimeContext: 'user',
      isInternal: existing.is_internal,
    }
  }

  const distinctId = generateAnalyticsUserId()
  await writeAnalyticsIdentity(distinctId, identityPath)
  return { distinctId, runtimeContext: 'user', isInternal: false }
}
