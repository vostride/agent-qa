// The `[secret:*]` marker regex and template resolution guard against cache poisoning.

import type { SecretRedactorPort, SecretResolver } from './ports.js'

export interface SecretTemplate {
  pattern: string
  name: string
}

export interface SecretFileMetadata {
  count: number
}

export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretConfigError'
  }
}

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`Secret not found: ${name}`)
    this.name = 'MissingSecretError'
  }
}

const SECRET_NAME_RE = /^\w+$/
const SECRET_TEMPLATE_RE = /\{\{secret:(\w+)\}\}/g
const REDACTED_SECRET_MARKER_RE = /\[secret:\w+\]/

function assertSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) {
    throw new SecretConfigError(`Invalid secret name: ${name}`)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// An ordered list, because an object would put integer-like names first.
function parseSecretEnvFile(content: string): Array<[string, string]> {
  const result = new Map<string, string>()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    let value = line.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result.set(key, value)
  }
  return [...result]
}

export class SecretStore implements SecretResolver {
  private storage = new Map<string, string>()

  constructor(secrets: Record<string, string> | ReadonlyArray<readonly [string, string]> = {}) {
    for (const [name, value] of Array.isArray(secrets) ? secrets : Object.entries(secrets)) {
      this.set(name, value)
    }
  }

  static empty(): SecretStore {
    return new SecretStore()
  }

  static fromEnvContent(content: string): SecretStore {
    return new SecretStore(parseSecretEnvFile(content))
  }

  private set(name: string, value: string): void {
    assertSecretName(name)
    this.storage.set(name, value)
  }

  get(name: string): string | undefined {
    return this.storage.get(name)
  }

  require(name: string): string {
    const value = this.get(name)
    if (value === undefined) throw new MissingSecretError(name)
    return value
  }

  has(name: string): boolean {
    return this.storage.has(name)
  }

  count(): number {
    return this.storage.size
  }

  metadata(): SecretFileMetadata {
    return { count: this.count() }
  }

  forEachSecret(callback: (name: string, value: string) => void): void {
    for (const [name, value] of this.storage) {
      callback(name, value)
    }
  }
}

export function findSecretTemplates(text: string): SecretTemplate[] {
  const templates: SecretTemplate[] = []
  SECRET_TEMPLATE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SECRET_TEMPLATE_RE.exec(text)) !== null) {
    templates.push({ pattern: match[0], name: match[1] })
  }
  return templates
}

export function interpolateSecretTemplates(template: string, store: SecretStore): string {
  return template.replace(SECRET_TEMPLATE_RE, (match, name: string) => {
    const value = store.get(name)
    return value === undefined ? match : value
  })
}

export function resolveSecretTemplatesInValue<T>(value: T, store?: SecretResolver): T {
  if (!store) return value
  if (typeof value === 'string') {
    return value.replace(SECRET_TEMPLATE_RE, (_match, name: string) => store.require(name)) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveSecretTemplatesInValue(item, store)) as T
  }
  if (isBufferLike(value)) {
    return value
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveSecretTemplatesInValue(item, store)
    }
    return result as T
  }
  return value
}

export function redactSecretValue<T>(value: T, redactor?: SecretRedactorPort): T {
  if (!redactor) return value
  if (typeof value === 'string') {
    return redactor.redactString(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretValue(item, redactor)) as T
  }
  if (isBufferLike(value)) {
    return value
  }
  if (value instanceof Error) {
    const redacted = new Error(redactor.redactString(value.message))
    redacted.name = value.name
    redacted.stack = value.stack ? redactor.redactString(value.stack) : undefined
    return redacted as T
  }
  if (typeof value === 'object' && value !== null) {
    // fromEntries defines own properties, so a `__proto__` key survives instead of setting the prototype.
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => [key, redactSecretValue(item, redactor)],
    )) as T
  }
  return value
}

/**
 * The cached-plan invalidation predicate (loop cache-poisoning guard): returns true
 * when a value contains a redacted `[secret:*]` marker. Moved from core loop.ts.
 */
export function containsRedactedSecretMarker(value: unknown): boolean {
  if (typeof value === 'string') return REDACTED_SECRET_MARKER_RE.test(value)
  if (Array.isArray(value)) return value.some((item) => containsRedactedSecretMarker(item))
  if (isBufferLike(value)) return false
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).some((item) => containsRedactedSecretMarker(item))
  }
  return false
}

const LITERAL_SECRET_MARKER_RE = /\[secret:(\w+)\]/

export function literalSecretMarkerRefusal(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const name = LITERAL_SECRET_MARKER_RE.exec(value)?.[1]
    return name === undefined
      ? undefined
      : `This action contains the masked placeholder [secret:${name}]; it would type the ` +
          `placeholder text. Use {{secret:${name}}} to type the secret.`
  }
  if (isBufferLike(value)) return undefined
  const items = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null
      ? Object.values(value as Record<string, unknown>)
      : []
  for (const item of items) {
    const refusal = literalSecretMarkerRefusal(item)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

function isBufferLike(value: unknown): value is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(value)
}

export class SecretRedactor implements SecretRedactorPort {
  private readonly pattern: RegExp
  private readonly valuePattern: RegExp | undefined
  private readonly nameByValue = new Map<string, string>()

  constructor(private readonly store: SecretStore) {
    const entries: Array<[string, string]> = []
    store.forEachSecret((name, value) => {
      if (value.length > 0) entries.push([name, value])
    })
    entries.sort((a, b) => b[1].length - a[1].length)
    for (const [name, value] of entries) {
      if (!this.nameByValue.has(value)) this.nameByValue.set(value, name)
    }
    const values = [...this.nameByValue.keys()].map(escapeRegExp)
    const alternatives = [
      String.raw`\{\{secret:(\w+)\}\}`,
      String.raw`(\[secret:(\w+)\])`,
      ...values,
    ]
    this.pattern = new RegExp(alternatives.join('|'), 'g')
    this.valuePattern = values.length > 0 ? new RegExp(values.join('|'), 'g') : undefined
  }

  redactString(value: string): string {
    return value.replace(
      this.pattern,
      (
        match: string,
        templateName: string | undefined,
        marker: string | undefined,
        markerName: string | undefined,
      ) => {
        const name = templateName ?? markerName
        if (name !== undefined && !this.store.has(name)) {
          const maskedName = this.maskValues(name)
          if (maskedName !== name) return `[secret:${maskedName}]`
        }
        if (templateName !== undefined) return `[secret:${templateName}]`
        if (marker !== undefined) return marker
        return `[secret:${this.nameByValue.get(match)}]`
      },
    )
  }

  private maskValues(text: string): string {
    if (this.valuePattern === undefined) return text
    return text.replace(this.valuePattern, (match) => `[secret:${this.nameByValue.get(match)}]`)
  }

  redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.redactString(value)
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item))
    }
    if (isBufferLike(value)) {
      return value
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactString(value.message),
        stack: value.stack ? this.redactString(value.stack) : undefined,
      }
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.redactValue(item)
      }
      return result
    }
    return value
  }
}
