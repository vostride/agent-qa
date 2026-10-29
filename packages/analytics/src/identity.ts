// The record is `{distinctId, is_internal}` and nothing else; `compose.ts` decides whether to send.

import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { idAgent } from 'id-agent'
import { ANALYTICS_AGENT_PRODUCTS, ANALYTICS_RUNTIME_CONTEXTS } from './events.js'

// Read off the union's own vocabularies, so a resolved value is always one the union accepts.
export type AnalyticsRuntimeContext = (typeof ANALYTICS_RUNTIME_CONTEXTS)[number]
export type AnalyticsAgentProduct = (typeof ANALYTICS_AGENT_PRODUCTS)[number]

/** The id scheme, named so a cell can assert it rather than a reader having to trust a comment. */
export const ANALYTICS_USER_ID_PREFIX = 'u'
export const ANALYTICS_USER_ID_WORDS = 10

/** What a resolved identity is, before anything decides whether to send on its behalf. */
export interface ResolvedAnalyticsIdentity {
  distinctId: string
  runtimeContext: AnalyticsRuntimeContext
  agentProduct?: AnalyticsAgentProduct
  isInternal?: boolean
}

/** The on-disk record. Two keys, carried verbatim, and the exact set a cell pins. */
export interface AnalyticsIdentityStore {
  distinctId: string
  is_internal: boolean
}

type StoreRead =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; record: AnalyticsIdentityStore }

export interface ResolveAnalyticsIdentityOptions {
  env?: Record<string, string | undefined>
  ci?: boolean
  identityPath?: string
  homeDir?: string
}

// A stored id is adopted only in this shape; anything else is replaced.
const LOCAL_ANALYTICS_ID_PATTERN = /^u_([a-z]+-){9}[a-z]+$/

export function getAnalyticsIdentityPath(
  env: Record<string, string | undefined> = process.env,
  homeDir = homedir(),
): string {
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'agent-qa', 'analytics.json')
  return join(homeDir, '.agent-qa', 'analytics.json')
}

export function generateAnalyticsUserId(): string {
  return idAgent({ prefix: ANALYTICS_USER_ID_PREFIX, words: ANALYTICS_USER_ID_WORDS })
}

function parseAnalyticsIdentityStore(value: unknown): AnalyticsIdentityStore | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const distinctId = (value as { distinctId?: unknown }).distinctId
  if (typeof distinctId !== 'string' || !LOCAL_ANALYTICS_ID_PATTERN.test(distinctId)) return null
  return { distinctId, is_internal: (value as { is_internal?: unknown }).is_internal === true }
}

async function readStore(identityPath: string): Promise<StoreRead> {
  let data: string
  try {
    data = await readFile(identityPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  try {
    const record = parseAnalyticsIdentityStore(JSON.parse(data))
    return record === null ? { kind: 'invalid' } : { kind: 'valid', record }
  } catch {
    return { kind: 'invalid' }
  }
}

// Publish a whole record in one step: link refuses an existing file (the loser of a first-use race
// reads back the winner's id); rename atomically replaces an invalid one.
async function placeNewRecord(identityPath: string, replace: boolean): Promise<void> {
  await mkdir(dirname(identityPath), { recursive: true })
  const temp = `${identityPath}.${randomUUID()}.tmp`
  const record: AnalyticsIdentityStore = {
    distinctId: generateAnalyticsUserId(),
    is_internal: false,
  }
  try {
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' })
    await chmod(temp, 0o600)
    if (replace) {
      await rename(temp, identityPath)
    } else {
      await link(temp, identityPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
  } finally {
    await rm(temp, { force: true })
  }
}

export async function readAnalyticsIdentity(path?: string): Promise<AnalyticsIdentityStore | null> {
  try {
    const found = await readStore(path ?? getAnalyticsIdentityPath())
    return found.kind === 'valid' ? found.record : null
  } catch {
    return null
  }
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
  if (typeof env.AGENT === 'string' && env.AGENT.length > 0) return 'unknown'
  return undefined
}

// The host decides `ci`; a CI resolution is a fresh in-memory id and touches no file.
export async function resolveAnalyticsIdentity(
  options: ResolveAnalyticsIdentityOptions = {},
): Promise<ResolvedAnalyticsIdentity> {
  const env = options.env ?? process.env
  const agentProduct = resolveAnalyticsAgentProduct(env)
  const attribution = agentProduct === undefined ? {} : { agentProduct }
  if (options.ci === true) {
    return { distinctId: 'ci_' + randomUUID(), runtimeContext: 'ci', ...attribution }
  }

  const identityPath = options.identityPath ?? getAnalyticsIdentityPath(env, options.homeDir)
  const found = await readStore(identityPath)
  if (found.kind !== 'valid') await placeNewRecord(identityPath, found.kind === 'invalid')
  const stored = found.kind === 'valid' ? found : await readStore(identityPath)
  if (stored.kind !== 'valid') {
    throw new Error('the analytics identity store did not hold a valid record')
  }
  return {
    distinctId: stored.record.distinctId,
    runtimeContext: 'user',
    isInternal: stored.record.is_internal,
    ...attribution,
  }
}
