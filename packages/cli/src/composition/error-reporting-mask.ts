// Every string of an envelope passes the mask before the transport sees it. An envelope that cannot
// be masked is dropped, never sent as it is.

import { createHash } from 'node:crypto'

export type TextMask = (text: string) => string

export interface EnvelopeTransport<TEnvelope, TResult> {
  send(envelope: TEnvelope): PromiseLike<TResult>
  flush(timeout?: number): PromiseLike<boolean>
}

// Where an envelope's ids and protocol fields sit, so a short secret never rewrites one. A field
// marked KEEP is left whole; `*` stands for any key; a one-element array gives every element's
// shape. Anything with no shape, such as breadcrumb data, contexts, extra and tags, is free text.
const KEEP = Symbol('kept as it is')

type Shape = typeof KEEP | readonly [Shape] | ShapeFields

interface ShapeFields {
  readonly [key: string]: Shape
}

const IDS = { trace_id: KEEP, span_id: KEEP, parent_span_id: KEEP, segment_id: KEEP } as const

const ENVELOPE_HEADER: Shape = {
  event_id: KEEP,
  sent_at: KEEP,
  dsn: KEEP,
  sdk: KEEP,
  trace: { trace_id: KEEP, public_key: KEEP },
}

const ITEM_HEADER: Shape = { type: KEEP, content_type: KEEP }

const EVENT: Shape = {
  event_id: KEEP,
  type: KEEP,
  platform: KEEP,
  level: KEEP,
  sdk: KEEP,
  contexts: { trace: IDS },
  breadcrumbs: [{ type: KEEP, level: KEEP }],
  exception: { values: [{ mechanism: { type: KEEP } }] },
  debug_meta: { images: [{ type: KEEP, debug_id: KEEP }] },
  spans: [IDS],
}

const SPAN_CONTAINER: Shape = {
  items: [{ ...IDS, status: KEEP, attributes: { '*': { type: KEEP } } }],
}

const PAYLOADS: Readonly<Record<string, Shape>> = {
  event: EVENT,
  transaction: EVENT,
  span: SPAN_CONTAINER,
}

function field(shape: Shape | undefined, key: string): Shape | undefined {
  if (shape === undefined || shape === KEEP || Array.isArray(shape)) return undefined
  const fields = shape as ShapeFields
  if (Object.hasOwn(fields, key)) return fields[key]
  return Object.hasOwn(fields, '*') ? fields['*'] : undefined
}

function element(shape: Shape | undefined): Shape | undefined {
  return Array.isArray(shape) ? (shape as readonly [Shape])[0] : undefined
}

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

// An envelope is a header and a list of items, each an item header and a payload whose shape its
// type names.
export function maskEnvelope<T>(envelope: T, mask: TextMask): T {
  if (!Array.isArray(envelope)) return maskValue(envelope, mask, undefined) as T
  const [header, items, ...rest] = envelope as unknown[]
  return [
    maskValue(header, mask, ENVELOPE_HEADER),
    Array.isArray(items)
      ? items.map((item) => maskItem(item, mask))
      : maskValue(items, mask, undefined),
    ...rest.map((value) => maskValue(value, mask, undefined)),
  ] as T
}

function maskItem(item: unknown, mask: TextMask): unknown {
  if (!Array.isArray(item)) return maskValue(item, mask, undefined)
  const [header, payload, ...rest] = item as unknown[]
  const type: unknown = (header as { type?: unknown } | null)?.type
  const shape =
    typeof type === 'string' && Object.hasOwn(PAYLOADS, type) ? PAYLOADS[type] : undefined
  return [
    maskValue(header, mask, ITEM_HEADER),
    maskValue(payload, mask, shape),
    ...rest.map((value) => maskValue(value, mask, undefined)),
  ]
}

function maskValue(value: unknown, mask: TextMask, shape: Shape | undefined): unknown {
  if (shape === KEEP) return value
  if (typeof value === 'string') return mask(value)
  if (ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) return value.map((item) => maskValue(item, mask, element(shape)))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskValue(item, mask, field(shape, key))]),
    )
  }
  return value
}

export interface RepeatFilter {
  <T>(envelope: T): T | undefined
  // Forgets the error events of an envelope whose send failed or was dropped, so the next
  // occurrence of each is sent.
  forget(envelope: unknown): void
}

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
// that wraps it, so two errors around one cause would otherwise read as one. The key is a digest,
// so each error the process remembers costs the same few bytes.
export function reportKey(event: unknown): string | undefined {
  const values = (event as { exception?: { values?: unknown } | null } | null)?.exception?.values
  if (!Array.isArray(values) || values.length === 0) return undefined
  const described = JSON.stringify(
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
  return createHash('sha256').update(described).digest('base64')
}

// The set lives as long as the process: an error event already sent leaves every later envelope,
// with no cap. Span containers and every other item are kept.
export function createRepeatFilter(): RepeatFilter {
  const sent = new Set<string>()
  const filter = <T>(envelope: T): T | undefined => {
    const items = itemsOf(envelope)
    if (items === undefined) return envelope
    const kept = items.filter((item) => {
      const key = errorEventKey(item)
      if (key === undefined) return true
      if (sent.has(key)) return false
      sent.add(key)
      return true
    })
    if (kept.length === 0) return undefined
    return kept.length === items.length ? envelope : ([(envelope as unknown[])[0], kept] as T)
  }
  return Object.assign(filter, {
    forget: (envelope: unknown) => {
      for (const item of itemsOf(envelope) ?? []) {
        const key = errorEventKey(item)
        if (key !== undefined) sent.delete(key)
      }
    },
  })
}

function itemsOf(envelope: unknown): unknown[] | undefined {
  return Array.isArray(envelope) && Array.isArray(envelope[1]) ? envelope[1] : undefined
}

function errorEventKey(item: unknown): string | undefined {
  if (!Array.isArray(item)) return undefined
  const [header, payload]: unknown[] = item
  return (header as { type?: unknown } | null)?.type === 'event' ? reportKey(payload) : undefined
}

// Only a 2xx answer means the ingest took the envelope; a dropped one is answered with no status.
function delivered(result: unknown): boolean {
  const status: unknown = (result as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && status >= 200 && status < 300
}

export interface MaskingTransportOptions {
  readonly homeSpellings?: readonly string[]
  readonly dropRepeats?: RepeatFilter
}

// Each string passes the secret mask resolved for its envelope first and the home rewrite after, so
// a secret that holds the home path is still found whole. Repeats are dropped from the masked
// envelope, which is sent only while an item is left, and a send that fails is forgotten.
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
        if (outgoing === undefined) return Promise.resolve({})
        if (dropRepeats === undefined) return transport.send(outgoing)
        const sending = outgoing
        return Promise.resolve(transport.send(sending)).then(
          (result) => {
            if (!delivered(result)) dropRepeats.forget(sending)
            return result
          },
          (error: unknown) => {
            dropRepeats.forget(sending)
            throw error
          },
        )
      },
      flush: (timeout) => transport.flush(timeout),
    }
  }
}
