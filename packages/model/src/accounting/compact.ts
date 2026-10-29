// Deterministic and pure: no clock, no randomness, sorted keys, so no run-to-run variance leaks.

export type LogEntry = { source: string; level?: string; message: string }

const DEFAULT_LEVEL = 'log'
const MAX_SAMPLES = 5
const SAMPLE_PREFIX = '  · '
const TRUNCATION_MARKER = '…[truncated to fit context budget]'

// A single structured value is one thing, not a burst, so it gets a far larger bound.
const BLOB_CEILING = 8000

// Variable-token normalization, applied in this fixed precedence so a broader
// pattern never chews a narrower one (UUID/timestamp/IP before bare hex/number).
// `<*>` carries no digits, so a replaced token is never re-matched by a later rule.
const PLACEHOLDER = '<*>'
const NORMALIZERS: readonly RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // UUID
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, // ISO timestamp
  /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}\b/gi, // IPv6-ish
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, // IPv4
  /\b0x[0-9a-f]+\b/gi, // hex literal
  /\b[0-9a-f]{7,}\b/gi, // long bare hex id
  /\b\d+(?:\.\d+)?\b/g, // bare number (last)
]

function normalize(message: string): string {
  let out = message
  for (const pattern of NORMALIZERS) out = out.replace(pattern, PLACEHOLDER)
  return out
}

type LogClass = { source: string; level: string; normalized: string; count: number; samples: string[] }

// Samples are the first five seen, so a growing burst never changes which are shown.
export function compactLogs(entries: LogEntry[]): string {
  const classes = new Map<string, LogClass>()

  for (const entry of entries) {
    const level = entry.level ?? DEFAULT_LEVEL
    const normalized = normalize(entry.message)
    const key = `${entry.source}::${level}::${normalized}`
    const existing = classes.get(key)
    if (existing) {
      existing.count++
      if (existing.samples.length < MAX_SAMPLES) existing.samples.push(entry.message)
    } else {
      classes.set(key, { source: entry.source, level, normalized, count: 1, samples: [entry.message] })
    }
  }

  const sortedKeys = [...classes.keys()].sort()
  const blocks: string[] = []
  for (const key of sortedKeys) {
    const klass = classes.get(key)
    if (klass === undefined) continue
    const header = `[${klass.source}] ${klass.level} ×${klass.count}: ${klass.normalized}`
    const lines = klass.samples.map(sample => `${SAMPLE_PREFIX}${sample}`)
    blocks.push([header, ...lines].join('\n'))
  }
  return blocks.join('\n')
}

// Variable tokens stay verbatim; never throws on cyclic input.
export function guardBlob(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const str = safeStringify(value)
  if (str.length <= BLOB_CEILING) return str
  return str.slice(0, BLOB_CEILING) + TRUNCATION_MARKER
}

type ConsoleShaped = { text?: unknown; message?: unknown; level?: unknown; source?: unknown }
type NetworkShaped = { url?: unknown; method?: unknown; status?: unknown }

function asLogEntry(value: unknown): LogEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const c = value as ConsoleShaped
  const text = typeof c.text === 'string' ? c.text : typeof c.message === 'string' ? c.message : undefined
  if (text !== undefined) {
    return {
      source: typeof c.source === 'string' ? c.source : 'console',
      level: typeof c.level === 'string' ? c.level : undefined,
      message: text,
    }
  }
  const n = value as NetworkShaped
  if (typeof n.url === 'string' && typeof n.method === 'string') {
    return {
      source: 'network',
      level: n.status === undefined ? undefined : String(n.status),
      message: `${n.method} ${n.url}`,
    }
  }
  return undefined
}

// Compacted output is still bounded by the blob ceiling, so distinct classes cannot flood it.
export function guardToolOutput(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length > 0) {
    const entries = value.map(asLogEntry)
    if (entries.every((e): e is LogEntry => e !== undefined)) {
      const compacted = compactLogs(entries)
      if (compacted.length <= BLOB_CEILING) return compacted
      return compacted.slice(0, BLOB_CEILING) + TRUNCATION_MARKER
    }
  }
  return guardBlob(value)
}

// Cycle-safe stringify preserving key order; never throws.
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(value, (_key, node) => {
        if (typeof node === 'object' && node !== null) {
          if (seen.has(node)) return '[Circular]'
          seen.add(node)
        }
        return node
      }) ?? 'undefined'
    )
  } catch {
    return '[unserializable]'
  }
}
