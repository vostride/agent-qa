// Every string of an envelope passes the mask before the transport sees it. An envelope that cannot
// be masked is dropped, never sent as it is.

export type TextMask = (text: string) => string

export interface EnvelopeTransport<TEnvelope, TResult> {
  send(envelope: TEnvelope): PromiseLike<TResult>
  flush(timeout?: number): PromiseLike<boolean>
}

// Ids and protocol fields: a short secret must never rewrite the value under one of these keys.
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'event_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'segment_id',
  'debug_id',
  'public_key',
  'dsn',
  'sent_at',
  'type',
  'platform',
  'level',
  'sdk',
])

// Longest first, so a spelling that holds a shorter one is replaced whole.
export function homeSpellings(homeDir: string, realHomeDir: string): string[] {
  const spellings = new Set<string>()
  for (const given of [homeDir, realHomeDir]) {
    const path = given.replace(/[\\/]+$/, '')
    if (/^(?:[A-Za-z]:)?$/.test(path)) continue
    const forward = path.replaceAll('\\', '/')
    for (const form of [path, forward, path.replaceAll('/', '\\')]) {
      spellings.add(form)
      spellings.add(JSON.stringify(form).slice(1, -1))
    }
    const url = `file://${forward.startsWith('/') ? '' : '/'}${forward}`
    spellings.add(url)
    const encoded = encodedUrl(url)
    if (encoded !== undefined) spellings.add(encoded)
  }
  return [...spellings].sort((a, b) => b.length - a.length)
}

function encodedUrl(url: string): string | undefined {
  try {
    return encodeURI(url)
  } catch {
    // A lone surrogate has no encoded form.
    return undefined
  }
}

export function rewriteHome(text: string, spellings: readonly string[]): string {
  return spellings.reduce((rewritten, spelling) => rewritten.replaceAll(spelling, '~'), text)
}

export function maskEnvelope<T>(envelope: T, mask: TextMask): T {
  return maskValue(envelope, mask) as T
}

function maskValue(value: unknown, mask: TextMask): unknown {
  if (typeof value === 'string') return mask(value)
  if (ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) return value.map((item) => maskValue(item, mask))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        STRUCTURAL_KEYS.has(key) ? item : maskValue(item, mask),
      ]),
    )
  }
  return value
}

export type RepeatFilter = <T>(envelope: T) => T | undefined

interface ReportedFrame {
  readonly filename?: unknown
  readonly function?: unknown
  readonly lineno?: unknown
  readonly colno?: unknown
}

interface ReportedException {
  readonly type?: unknown
  readonly value?: unknown
  readonly stacktrace?: { readonly frames?: unknown } | null
}

// Every exception value counts, not the first alone: the SDK puts a linked cause before the error
// that wraps it, so two errors around one cause would otherwise read as one.
export function reportKey(event: unknown): string | undefined {
  const values = (event as { exception?: { values?: unknown } | null } | null)?.exception?.values
  if (!Array.isArray(values) || values.length === 0) return undefined
  return JSON.stringify(
    values.map((value: ReportedException | null) => {
      const frames: unknown = value?.stacktrace?.frames
      return [
        value?.type,
        value?.value,
        (Array.isArray(frames) ? frames : []).map((frame: ReportedFrame | null) => [
          frame?.filename,
          frame?.function,
          frame?.lineno,
          frame?.colno,
        ]),
      ]
    }),
  )
}

// The set lives as long as the process: an error event already sent leaves every later envelope,
// with no cap. Span containers and every other item are kept.
export function createRepeatFilter(): RepeatFilter {
  const sent = new Set<string>()
  return <T>(envelope: T): T | undefined => {
    if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return envelope
    const items: unknown[] = envelope[1]
    const kept = items.filter((item) => {
      const key = errorEventKey(item)
      if (key === undefined) return true
      if (sent.has(key)) return false
      sent.add(key)
      return true
    })
    if (kept.length === 0) return undefined
    return kept.length === items.length ? envelope : ([envelope[0], kept] as T)
  }
}

function errorEventKey(item: unknown): string | undefined {
  if (!Array.isArray(item)) return undefined
  const [header, payload]: unknown[] = item
  return (header as { type?: unknown } | null)?.type === 'event' ? reportKey(payload) : undefined
}

export interface MaskingTransportOptions {
  readonly homeSpellings?: readonly string[]
  readonly dropRepeats?: RepeatFilter
}

// Each string passes the secret mask resolved for its envelope first and the home rewrite after, so
// a secret that holds the home path is still found whole. Repeats are dropped from the masked
// envelope, which is sent only while an item is left.
export function createMaskingTransport<TOptions, TEnvelope, TResult extends object>(
  inner: (options: TOptions) => EnvelopeTransport<TEnvelope, TResult>,
  resolveMask: (envelope: TEnvelope) => TextMask,
  options: MaskingTransportOptions = {},
): (options: TOptions) => EnvelopeTransport<TEnvelope, Partial<TResult>> {
  const spellings = options.homeSpellings ?? []
  const { dropRepeats } = options
  return (transportOptions) => {
    const transport = inner(transportOptions)
    return {
      send: (envelope) => {
        let outgoing: TEnvelope | undefined
        try {
          const mask = resolveMask(envelope)
          const masked = maskEnvelope(envelope, (text) => rewriteHome(mask(text), spellings))
          outgoing = dropRepeats === undefined ? masked : dropRepeats(masked)
        } catch {
          return Promise.resolve({})
        }
        return outgoing === undefined ? Promise.resolve({}) : transport.send(outgoing)
      },
      flush: (timeout) => transport.flush(timeout),
    }
  }
}
