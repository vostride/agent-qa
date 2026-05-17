import { redactSecretValue, type SecretRedactor } from '../agent/secrets.js'
import type { RuntimeAuthStateConfig } from '../types/platform.js'
import {
  AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH,
  AUTH_STATE_HOOK_JSON_ENV,
  AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV,
  buildAuthStateHookEnv,
} from './hook-env.js'

export const AUTH_STATE_REDACTION_MARKER = '[auth state redacted]'

export interface AuthStateRedactionContext {
  secretRedactor?: SecretRedactor
  authState?: RuntimeAuthStateConfig
  storageStatePath?: string
  hookStorageStatePath?: string
  hookJsonEnv?: string
  redactAuthLikeKeys?: boolean
}

const AUTH_STATE_JSON_KEY = normalizeKey(AUTH_STATE_HOOK_JSON_ENV)
const AUTH_STATE_PATH_KEY = normalizeKey(AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV)
const STRUCTURED_AUTH_STATE_KEYS = new Set(['authstate', 'auth_state'])
const STRUCTURED_PATH_KEYS = new Set(['storagestatepath', AUTH_STATE_JSON_KEY, AUTH_STATE_PATH_KEY])
const AUTH_LIKE_KEY_RE = /(^|[_-])(token|cookie|authorization|csrf|session|bearer)([_-]|$)|^(token|cookie|authorization|csrf|session|bearer)$/i

function normalizeKey(key: string): string {
  return key.replace(/[\s-]/g, '').toLowerCase()
}

function isBufferLike(value: unknown): value is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isBufferLike(value)
}

function isStorageStateShape(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.cookies) && Array.isArray(value.origins)
}

function isRuntimeAuthStateShape(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.storageStatePath === 'string'
    && typeof value.stateName === 'string'
    && typeof value.targetName === 'string'
}

function isAuthStateManagementMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false
  if ('storageStatePath' in value || 'payloadPath' in value || 'metadataPath' in value) return false
  return value.kind === 'web'
    && typeof value.target === 'string'
    && typeof value.name === 'string'
    && typeof value.capturedAt === 'string'
}

function isAuthStateManagementConfig(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((key) => key === 'dir')
}

function isAuthLikeCredentialKey(key: string): boolean {
  return AUTH_LIKE_KEY_RE.test(key)
}

function knownSensitiveStrings(context: AuthStateRedactionContext): string[] {
  const values = new Set<string>()
  const hookStorageStatePath = context.hookStorageStatePath ?? AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH

  for (const value of [
    AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH,
    hookStorageStatePath,
    context.storageStatePath,
    context.authState?.storageStatePath,
    context.hookJsonEnv,
  ]) {
    if (typeof value === 'string' && value.length > 0) values.add(value)
  }

  if (context.authState) {
    const env = buildAuthStateHookEnv(context.authState, hookStorageStatePath)
    const hookJson = env[AUTH_STATE_HOOK_JSON_ENV]
    if (hookJson) values.add(hookJson)
  }

  return [...values].sort((left, right) => right.length - left.length)
}

function tryParseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function looksLikeStorageStateJson(value: string): boolean {
  if (!value.includes('"cookies"') || !value.includes('"origins"')) return false
  return isStorageStateShape(tryParseJsonObject(value))
}

function looksLikeAuthStateHookJson(value: string): boolean {
  if (!value.includes('"storageStatePath"')) return false
  const parsed = tryParseJsonObject(value)
  return isRecord(parsed)
    && typeof parsed.storageStatePath === 'string'
    && (
      typeof parsed.name === 'string'
      || typeof parsed.target === 'string'
      || parsed.kind === 'web'
    )
}

function redactStructuredAuthStateText(value: string): string {
  return value
    .replace(
      /(\bauthState\s*:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+name\s*:\s*)[^\n#]+/gi,
      (_match, prefix: string) => `${prefix}${AUTH_STATE_REDACTION_MARKER}`,
    )
    .replace(
      /(["']?(?:authState|auth_state|storageStatePath|AGENT_QA_AUTH_STATE_JSON|AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH)["']?\s*[:=]\s*)(["'])[^"']*\2/gi,
      (_match, prefix: string, quote: string) => `${prefix}${quote}${AUTH_STATE_REDACTION_MARKER}${quote}`,
    )
    .replace(
      /((?:authState|auth_state|storageStatePath|AGENT_QA_AUTH_STATE_JSON|AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH)\s*[:=]\s*)[^\s,}\]]+/gi,
      (_match, prefix: string) => `${prefix}${AUTH_STATE_REDACTION_MARKER}`,
    )
}

function redactStorageStateJsonLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      return looksLikeStorageStateJson(trimmed) || looksLikeAuthStateHookJson(trimmed)
        ? AUTH_STATE_REDACTION_MARKER
        : line
    })
    .join('\n')
}

export function redactAuthStateString(
  value: string,
  context: AuthStateRedactionContext = {},
): string {
  if (
    value.includes(AUTH_STATE_HOOK_JSON_ENV)
    || value.includes(AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV)
    || looksLikeStorageStateJson(value.trim())
    || looksLikeAuthStateHookJson(value.trim())
  ) {
    return AUTH_STATE_REDACTION_MARKER
  }

  if (value.includes('authState') || value.includes('auth_state')) {
    const parsed = tryParseJsonObject(value.trim())
    if (parsed !== undefined) {
      return JSON.stringify(redactAuthStateOnly(parsed, context))
    }
  }

  let redacted = redactStorageStateJsonLines(value)
  for (const sensitive of knownSensitiveStrings(context)) {
    redacted = redacted.split(sensitive).join(AUTH_STATE_REDACTION_MARKER)
  }
  return redactStructuredAuthStateText(redacted)
}

function shouldRedactKeyValue(key: string, value: unknown, context: AuthStateRedactionContext): boolean {
  const normalized = normalizeKey(key)
  if (STRUCTURED_PATH_KEYS.has(normalized)) return true
  if (STRUCTURED_AUTH_STATE_KEYS.has(normalized)) {
    if (typeof value === 'string') return true
    if (isAuthStateManagementConfig(value) || isAuthStateManagementMetadata(value)) return false
    return true
  }
  if (typeof value === 'string' && value.startsWith('[secret')) return false
  return context.redactAuthLikeKeys !== false && isAuthLikeCredentialKey(key)
}

function redactAuthStateOnly<T>(value: T, context: AuthStateRedactionContext): T {
  if (typeof value === 'string') {
    return redactAuthStateString(value, context) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAuthStateOnly(item, context)) as T
  }
  if (isBufferLike(value)) {
    return value
  }
  if (value instanceof Error) {
    const redacted = new Error(redactAuthStateString(value.message, context))
    redacted.name = value.name
    redacted.stack = value.stack ? redactAuthStateString(value.stack, context) : undefined
    return redacted as T
  }
  if (!isRecord(value)) {
    return value
  }
  if (isStorageStateShape(value) || isRuntimeAuthStateShape(value)) {
    return AUTH_STATE_REDACTION_MARKER as T
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (shouldRedactKeyValue(key, item, context)) {
      result[key] = AUTH_STATE_REDACTION_MARKER
    } else {
      result[key] = redactAuthStateOnly(item, context)
    }
  }
  return result as T
}

export function redactAuthStateValue<T>(
  value: T,
  context: AuthStateRedactionContext = {},
): T {
  return redactAuthStateOnly(redactSecretValue(value, context.secretRedactor), context)
}
