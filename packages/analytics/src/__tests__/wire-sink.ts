// A REAL listening HTTP server, used as the wire surface for this package's network cells
//
// WHY A REAL SERVER AND NOT A STUB. Two of this package's claims are claims about BYTES:
// "opted out dials nothing" and "a seeded secret does not appear on the wire". Both are only
// meaningful when read off what a network peer receives — after the payload has been serialized,
// gzipped and pushed through a socket — rather than off the object the transport was handed. This
// repo has a filed precedent for the difference: a corpus that asserted on `error.message` while
// the live channel was the error's serialization.
//
// It binds `127.0.0.1:0` and nothing else. A wall test that needs the internet to prove itself is a
// wall test that fails in CI for reasons that have nothing to do with the wall.
//
// This module lives under `__tests__` on purpose: `tsup` bundles from `src/index.ts`,
// `packages/arch`'s specifier scanner skips `__tests__`, and vitest only collects `*.test.ts`.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'

export interface WireRequest {
  readonly method: string
  readonly path: string
  readonly contentEncoding?: string
  /** Exactly the bytes that arrived — still gzipped when the sender compressed them. */
  readonly raw: Buffer
  /** Those same bytes, decompressed. What a network peer reads. */
  readonly text: string
}

export interface WireSink {
  readonly origin: string
  readonly requests: WireRequest[]
  close(): Promise<void>
}

export async function startWireSink(): Promise<WireSink> {
  const requests: WireRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const contentEncoding = req.headers['content-encoding'] as string | undefined
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        ...(contentEncoding === undefined ? {} : { contentEncoding }),
        raw,
        text: decodeWireBody(raw, contentEncoding),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 1 }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Gzip is posthog-node's default, so the wire bytes are compressed unless compression failed. */
export function decodeWireBody(raw: Buffer, contentEncoding?: string): string {
  if (contentEncoding === 'gzip' || isGzip(raw)) return gunzipSync(raw).toString('utf8')
  return raw.toString('utf8')
}

/**
 * The bytes as posthog-node hands them to `fetch`: a gzip `Blob` by default, a JSON string when
 * `CompressionStream` is unavailable. Read as bytes and decompressed — never read off the event
 * object, because the point of a wire assertion is that it is made on what leaves.
 */
export async function readOutgoingBody(body: unknown): Promise<string> {
  if (typeof body === 'string') return body
  if (body instanceof Blob) return decodeWireBody(Buffer.from(await body.arrayBuffer()))
  if (body instanceof Uint8Array) return decodeWireBody(Buffer.from(body))
  return String(body ?? '')
}

function isGzip(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}
