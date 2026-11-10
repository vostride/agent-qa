// Every string of an envelope passes the mask before the transport sees it. An envelope that cannot
// be masked is dropped, never sent as it is.

export type TextMask = (text: string) => string

export interface EnvelopeTransport<TEnvelope, TResult> {
  send(envelope: TEnvelope): PromiseLike<TResult>
  flush(timeout?: number): PromiseLike<boolean>
}

export function maskEnvelope<T>(envelope: T, mask: TextMask): T {
  return maskValue(envelope, mask) as T
}

function maskValue(value: unknown, mask: TextMask): unknown {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) return value.map((item) => maskValue(item, mask))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskValue(item, mask)]),
    )
  }
  return value
}

export function createMaskingTransport<TOptions, TEnvelope, TResult extends object>(
  inner: (options: TOptions) => EnvelopeTransport<TEnvelope, TResult>,
  resolveMask: () => TextMask,
): (options: TOptions) => EnvelopeTransport<TEnvelope, Partial<TResult>> {
  return (options) => {
    const transport = inner(options)
    return {
      send: (envelope) => {
        let masked: TEnvelope
        try {
          masked = maskEnvelope(envelope, resolveMask())
        } catch {
          return Promise.resolve({})
        }
        return transport.send(masked)
      },
      flush: (timeout) => transport.flush(timeout),
    }
  }
}
