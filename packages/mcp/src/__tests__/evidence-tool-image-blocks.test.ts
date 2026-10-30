// Masking hides strings, never pixels: these cells prove which bytes travel, not image privacy.

import { createHash } from 'node:crypto'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  invokeFunction,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import type { EvidenceBlobLookup, FunctionCaller, RunId } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgentQaMcpServer } from '../catalog.js'
import { MAX_RESULT_SIZE_META_KEY, RUN_READ_MAX_RESULT_SIZE_CHARS } from '../mapping.js'
import { decorateRunEvidenceImage, maskedToolResult, RUN_EVIDENCE_IMAGE_TEXT_MARKER } from '../masked-result.js'

const TOOL = 'agent_qa_get_run_evidence'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKAC'
  + 'AAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZ'
  + 'jwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIB'
  + 'AwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNE'
  + 'RUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfI'
  + 'ycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIB'
  + 'AgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpD'
  + 'REVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG'
  + 'x8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxcc'
  + 'HBwcHBwcHCIiIiIiIicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4u'
  + 'Li4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLv/dAAQAAf/aAAwDAQACEQMRAD8A06KKK/STkP/Z'

const decode = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const PNG = decode(PNG_BASE64)
const JPEG = decode(JPEG_BASE64)
/** A WebM EBML header: a recording, which is never relayed to the model. */
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81])
/** An evidence document stored as a blob. Its text would bypass masking inside base64. */
const DOCUMENT_SECRET = 'sk-document-secret'
const DOCUMENT = new TextEncoder().encode(JSON.stringify({ kind: 'console', records: [DOCUMENT_SECRET] }))
/** The PNG magic and then noise: the op sniffs image/png, and the bytes are no image. */
const PNG_PREFIX_JUNK = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
/** A real PNG cut before its IEND trailer. */
const PNG_TRUNCATED = PNG.slice(0, 40)

const RUN = 'r_image-blocks'

type Blobs = Map<string, Map<string, Uint8Array>>

function blobsOf(entries: Record<string, readonly Uint8Array[]>): Blobs {
  return new Map(Object.entries(entries).map(([runId, list]) => [runId, new Map(list.map((bytes) => [shaOf(bytes), bytes]))]))
}

function lookup(blobs: Blobs, runId: RunId, sha: string): EvidenceBlobLookup {
  const run = blobs.get(String(runId))
  if (run === undefined) return { status: 'unknown_run' }
  const bytes = run.get(sha)
  return bytes === undefined ? { status: 'blob_absent' } : { status: 'found', bytes }
}

function registryOver(blobs: Blobs): FunctionRegistry {
  const evidenceBlobs = {
    read: (runId: RunId, sha: string) => Promise.resolve(lookup(blobs, runId, sha)),
    stat: (runId: RunId, sha: string) => {
      const found = lookup(blobs, runId, sha)
      return Promise.resolve(found.status === 'found' ? { status: 'found' as const, byteLength: found.bytes.length } : found)
    },
    readRange: (runId: RunId, sha: string, start: number, end: number) => {
      const found = lookup(blobs, runId, sha)
      return Promise.resolve(found.status === 'found' ? { status: 'found' as const, bytes: found.bytes.slice(start, end + 1) } : found)
    },
  }
  const runs = {
    list: () => Promise.resolve([]),
    readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' }),
  }
  return createFunctionRegistry({ deps: { evidenceBlobs, runs } as unknown as FunctionDeps })
}

// The registry and the MCP server read no scopes or safe mode, so the caller carries neither.
const reader: FunctionCaller = { surface: 'mcp', origin: 'agent' }
const identity = (text: string): string => text

const openClients: Client[] = []
afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

async function connect(registry: FunctionRegistry, maskText: (text: string) => string = identity): Promise<Client> {
  const handler = createMcpHandler(() => buildAgentQaMcpServer({ registry, caller: reader, maskText }))
  const client = new Client({ name: 'agent-qa-image', version: '0.0.0' })
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('http://image.local/mcp'), {
    fetch: ((url: URL | string, init?: RequestInit) => handler.fetch(new Request(url, init))) as typeof fetch,
  }))
  return client
}

type Block = { readonly type: string; readonly text?: string; readonly data?: string; readonly mimeType?: string }
type WireResult = { readonly content: readonly Block[]; readonly structuredContent?: unknown; readonly isError?: boolean }

async function fetchArtifact(
  client: Client,
  bytes: Uint8Array,
  range?: { readonly start: number; readonly end?: number },
  runId = RUN,
): Promise<WireResult> {
  const args = { action: 'runs.artifact', runId, sha: shaOf(bytes), ...(range === undefined ? {} : { range }) }
  return await client.callTool({ name: TOOL, arguments: args }) as unknown as WireResult
}

const texts = (result: WireResult): string[] => result.content.filter((block) => block.type === 'text').map((block) => block.text!)
const images = (result: WireResult): Block[] => result.content.filter((block) => block.type === 'image')

/** The first eight-character window of `plant` found in `haystack` (the credential-surface rule). */
function leakedWindow(haystack: string, plant: string, size = 8): string | undefined {
  for (let at = 0; at + size <= plant.length; at += 1) {
    const window = plant.slice(at, at + size)
    if (haystack.includes(window)) return window
  }
  return undefined
}

function expectNoBytes(result: WireResult, bytes: Uint8Array): void {
  expect(images(result)).toEqual([])
  expect(result.structuredContent).toBeUndefined()
  expect(leakedWindow(JSON.stringify(result), encode(bytes)), 'the refusal carried the artifact bytes').toBeUndefined()
}

describe('IMAGE-PNG / IMAGE-JPEG', () => {
  for (const [label, bytes, base64, mimeType] of [
    ['IMAGE-PNG', PNG, PNG_BASE64, 'image/png'],
    ['IMAGE-JPEG', JPEG, JPEG_BASE64, 'image/jpeg'],
  ] as const) {
    it(`${label}: a complete ${mimeType} answers the structured result, its text, and one image block`, async () => {
      const client = await connect(registryOver(blobsOf({ [RUN]: [PNG, JPEG] })))
      const result = await fetchArtifact(client, bytes)

      expect(result.isError ?? false, texts(result).join('\n')).toBe(false)
      expect(result.content.map((block) => block.type)).toEqual(['text', 'image'])
      expect(result.structuredContent).toEqual({
        runId: RUN, sha: shaOf(bytes), contentType: mimeType, byteLength: bytes.length, bytesBase64: base64,
      })
      const [text] = texts(result)
      expect(JSON.parse(text!)).toEqual({
        ...(result.structuredContent as Record<string, unknown>), bytesBase64: RUN_EVIDENCE_IMAGE_TEXT_MARKER,
      })
      expect(text).not.toContain(base64)
      const [image] = images(result)
      expect(image).toEqual({ type: 'image', data: base64, mimeType })
      expect(decode(image!.data!)).toEqual(bytes)
    })
  }
})

describe('IMAGE-JSON-PARITY', () => {
  it('structuredContent carries exactly the masked op result, and the text carries it with the bytes replaced by the marker', async () => {
    const registry = registryOver(blobsOf({ [RUN]: [PNG] }))
    const mask = (text: string) => text.split(RUN).join('<SECRET_RUN>')
    const client = await connect(registry, mask)
    const result = await fetchArtifact(client, PNG)

    const output = await invokeFunction(registry, 'runs.artifact', { runId: RUN, sha: shaOf(PNG) }, reader)
    const expected = maskedToolResult(output, mask)
    expect(expected.isError ?? false).toBe(false)
    expect(result.structuredContent).toEqual(expected.structuredContent)
    expect(result.content.filter((block) => block.type !== 'image')).toEqual([{
      type: 'text',
      text: JSON.stringify({
        ...(expected.structuredContent as Record<string, unknown>), bytesBase64: RUN_EVIDENCE_IMAGE_TEXT_MARKER,
      }),
    }])
    expect(texts(result)[0]).not.toContain(RUN)
    expect(images(result)).toEqual([{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }])
  })

  it('IMAGE-TEXT-SIZE: a real-size screenshot\'s text stays far under the size hint while structuredContent keeps the op result', async () => {
    const size = 200_000
    const big = new Uint8Array(size)
    big.set(PNG.subarray(0, 8), 0)
    for (let at = 8; at < size - 12; at += 1) big[at] = (at * 131 + 17) & 0xff
    big.set(PNG.subarray(PNG.length - 12), size - 12)
    const bigBase64 = Buffer.from(big).toString('base64')
    const registry = registryOver(blobsOf({ [RUN]: [big] }))
    const client = await connect(registry)

    const { tools } = await client.listTools()
    const hint = tools.find((tool) => tool.name === TOOL)?._meta?.[MAX_RESULT_SIZE_META_KEY]
    expect(hint).toBe(RUN_READ_MAX_RESULT_SIZE_CHARS)

    const result = await fetchArtifact(client, big)
    expect(result.isError ?? false, texts(result).join('\n').slice(0, 200)).toBe(false)
    const [text] = texts(result)
    expect(text!.length).toBeLessThan(1000)
    expect(text!.length).toBeLessThan(hint as number)
    expect(text).not.toContain(bigBase64.slice(0, 64))
    const output = await invokeFunction(registry, 'runs.artifact', { runId: RUN, sha: shaOf(big) }, reader)
    expect(result.structuredContent).toEqual(output)
    expect(images(result)).toEqual([{ type: 'image', data: bigBase64, mimeType: 'image/png' }])
  })

  it('a range covering the whole image is a complete image, with range and total length unchanged', async () => {
    const client = await connect(registryOver(blobsOf({ [RUN]: [PNG] })))
    const result = await fetchArtifact(client, PNG, { start: 0 })

    expect(result.isError ?? false).toBe(false)
    expect(result.structuredContent).toMatchObject({
      bytesBase64: PNG_BASE64, byteLength: PNG.length, totalLength: PNG.length, range: { start: 0, end: PNG.length - 1 },
    })
    expect(images(result)).toEqual([{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }])
  })

  it('the step-document arm is never decorated', async () => {
    const client = await connect(registryOver(blobsOf({ [RUN]: [PNG] })))
    const result = await client.callTool({ name: TOOL, arguments: {
      action: 'runs.evidence', runId: RUN, testIndex: 0, stepIndex: 0, kind: 'console',
    } }) as unknown as WireResult
    expect(images(result)).toEqual([])
  })

  it('merges the existing result metadata rather than replacing it', () => {
    const output = { runId: RUN, sha: shaOf(PNG), contentType: 'image/png', byteLength: PNG.length, bytesBase64: PNG_BASE64 }
    const masked = maskedToolResult(output, identity)
    const withMeta: CallToolResult = { ...masked, _meta: { 'agent-qa/probe': { kept: true } } }
    const decorated = decorateRunEvidenceImage({ result: withMeta, output, maskText: identity })

    expect(decorated._meta).toEqual({ 'agent-qa/probe': { kept: true } })
    expect(decorated.structuredContent).toBe(masked.structuredContent)
    expect(decorated.content[0]).toEqual({
      type: 'text', text: JSON.stringify({ ...output, bytesBase64: RUN_EVIDENCE_IMAGE_TEXT_MARKER }),
    })
    expect(decorated.content[1]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' })
  })
})

describe('IMAGE-RANGE-REFUSAL', () => {
  for (const [label, range] of [
    ['a head fragment carrying the PNG signature', { start: 0, end: 15 }],
    ['a tail fragment', { start: 8 }],
  ] as const) {
    it(`${label} is a named refusal and never an image`, async () => {
      const registry = registryOver(blobsOf({ [RUN]: [PNG] }))
      const fragment = await invokeFunction(registry, 'runs.artifact', { runId: RUN, sha: shaOf(PNG), range }, reader)
      // The adversarial precondition: the op still types the fragment by the whole blob's head.
      expect(fragment).toMatchObject({ contentType: 'image/png', totalLength: PNG.length })

      const result = await fetchArtifact(await connect(registry), PNG, range)
      expect(result.isError).toBe(true)
      expect(texts(result).join('\n')).toMatch(/^artifact-range-fragment: /)
      expectNoBytes(result, PNG.slice(range.start, 'end' in range ? range.end + 1 : undefined))
    })
  }

  it('a recording is a named not-an-image refusal and its bytes are not relayed', async () => {
    const result = await fetchArtifact(await connect(registryOver(blobsOf({ [RUN]: [WEBM] }))), WEBM)
    expect(result.isError).toBe(true)
    expect(texts(result).join('\n')).toMatch(/^artifact-not-image: /)
    expect(texts(result).join('\n')).toContain('video/webm')
    expectNoBytes(result, WEBM)
  })

  it('an evidence document stored as a blob cannot travel as encoded bytes past masking', async () => {
    const result = await fetchArtifact(await connect(registryOver(blobsOf({ [RUN]: [DOCUMENT] }))), DOCUMENT)
    expect(result.isError).toBe(true)
    expect(texts(result).join('\n')).toMatch(/^artifact-not-image: /)
    expect(texts(result).join('\n')).toContain('runs.evidence')
    expectNoBytes(result, DOCUMENT)
    expect(JSON.stringify(result)).not.toContain(DOCUMENT_SECRET)
  })

  it('the function op keeps its generic range support', async () => {
    const registry = registryOver(blobsOf({ [RUN]: [PNG, WEBM] }))
    const fragment = await invokeFunction(registry, 'runs.artifact', { runId: RUN, sha: shaOf(PNG), range: { start: 8, end: 11 } }, reader)
    expect(fragment).toEqual({
      runId: RUN, sha: shaOf(PNG), contentType: 'image/png', byteLength: 4, bytesBase64: encode(PNG.slice(8, 12)),
      totalLength: PNG.length, range: { start: 8, end: 11 },
    })
    const recording = await invokeFunction(registry, 'runs.artifact', { runId: RUN, sha: shaOf(WEBM) }, reader)
    expect(recording).toMatchObject({ contentType: 'video/webm', bytesBase64: encode(WEBM) })
  })
})

// No mcp dependency exports `SecretRedactor`, so this stand-in replaces one value exactly.
function standInMask(name: string, value: string): (text: string) => string {
  return (text) => text.split(value).join(`[secret:${name}]`)
}

describe('IMAGE-MASK-WITHHOLD', () => {
  it('(a) a masking refusal withholds the image and every byte', async () => {
    // The PNG is 70 bytes, so a masker that hides the spelling `70` cannot mask `byteLength` in
    // place and the whole result is withheld.
    const hideLength = (text: string) => text.split(String(PNG.length)).join('<SECRET_0>')
    const result = await fetchArtifact(await connect(registryOver(blobsOf({ [RUN]: [PNG] })), hideLength), PNG)

    expect(result.isError).toBe(true)
    expect(texts(result).join('\n')).toContain('withheld')
    expectNoBytes(result, PNG)
  })

  it('(b) masking that altered the encoded bytes withholds the image and the altered result', async () => {
    const planted = PNG_BASE64.slice(20, 36)
    const result = await fetchArtifact(
      await connect(registryOver(blobsOf({ [RUN]: [PNG] })), standInMask('IMAGE_KEY', planted)),
      PNG,
    )

    expect(result.isError).toBe(true)
    expect(texts(result).join('\n')).toMatch(/^artifact-image-withheld: /)
    expectNoBytes(result, PNG)
    expect(JSON.stringify(result)).not.toContain(planted)
  })

  for (const [label, bytes] of [
    ['bytes carrying only the PNG magic', PNG_PREFIX_JUNK],
    ['a PNG cut before its trailer', PNG_TRUNCATED],
  ] as const) {
    it(`(c) ${label} are refused as an invalid image`, async () => {
      const registry = registryOver(blobsOf({ [RUN]: [bytes] }))
      expect(await invokeFunction(registry, 'runs.artifact', { runId: RUN, sha: shaOf(bytes) }, reader))
        .toMatchObject({ contentType: 'image/png' })

      const result = await fetchArtifact(await connect(registry), bytes)
      expect(result.isError).toBe(true)
      expect(texts(result).join('\n')).toMatch(/^artifact-image-invalid: /)
      expectNoBytes(result, bytes)
    })
  }
})

// ---- Evidence isolation: one registry, two callers, a server and masker per request ----

const ALPHA_SECRET = 'alphasecret90217'
const BETA_SECRET = 'betasecret90217'
const ALPHA = `r_${ALPHA_SECRET}`
const BETA = `r_${BETA_SECRET}`

function maskerFor(secret: string): { readonly mask: (text: string) => string; readonly dispose: () => void } {
  return { mask: standInMask('RUN_KEY', secret), dispose: () => undefined }
}

describe('EVIDENCE-ISOLATION', () => {
  it('interleaved callers keep their own run, bytes and masking', async () => {
    const registry = registryOver(blobsOf({ [ALPHA]: [PNG], [BETA]: [JPEG] }))
    const alphaMask = maskerFor(ALPHA_SECRET)
    const betaMask = maskerFor(BETA_SECRET)
    try {
      const alpha = await connect(registry, alphaMask.mask)
      const beta = await connect(registry, betaMask.mask)
      const calls = Array.from({ length: 16 }, (_, index) => index % 2 === 0
        ? fetchArtifact(alpha, PNG, undefined, ALPHA).then((result) => ['alpha', result] as const)
        : fetchArtifact(beta, JPEG, undefined, BETA).then((result) => ['beta', result] as const))

      for (const [who, result] of await Promise.all(calls)) {
        const [own, other, ownSecret, otherSecret, mimeType] = who === 'alpha'
          ? [PNG, JPEG, ALPHA_SECRET, BETA_SECRET, 'image/png']
          : [JPEG, PNG, BETA_SECRET, ALPHA_SECRET, 'image/jpeg']
        const wire = JSON.stringify(result)
        expect(result.isError ?? false, texts(result).join('\n')).toBe(false)
        expect(images(result)).toEqual([{ type: 'image', data: encode(own), mimeType }])
        expect(result.structuredContent).toMatchObject({ sha: shaOf(own), bytesBase64: encode(own) })
        expect(wire, `${who} carried its own run id unmasked`).not.toContain(ownSecret)
        expect(wire, `${who} carried the other run's id`).not.toContain(otherSecret)
        expect(wire).not.toContain(shaOf(other))
        expect(leakedWindow(wire, encode(other)), `${who} carried the other run's bytes`).toBeUndefined()
      }
    } finally {
      alphaMask.dispose()
      betaMask.dispose()
    }
  })

  it('another run\'s sha, an unknown run and a deleted blob are named misses, never other bytes', async () => {
    const blobs = blobsOf({ [ALPHA]: [PNG], [BETA]: [JPEG] })
    const client = await connect(registryOver(blobs))

    const crossRun = await fetchArtifact(client, JPEG, undefined, ALPHA)
    expect(crossRun.isError).toBe(true)
    expect(texts(crossRun).join('\n')).toContain('No evidence blob is recorded for run')
    expectNoBytes(crossRun, JPEG)

    const unknown = await fetchArtifact(client, PNG, undefined, 'r_never-recorded')
    expect(unknown.isError).toBe(true)
    expect(texts(unknown).join('\n')).toMatch(/r_never-recorded/)
    expectNoBytes(unknown, PNG)

    const before = await fetchArtifact(client, PNG, undefined, ALPHA)
    expect(images(before)).toHaveLength(1)
    blobs.get(ALPHA)!.delete(shaOf(PNG))
    const after = await fetchArtifact(client, PNG, undefined, ALPHA)
    expect(after.isError).toBe(true)
    expect(texts(after).join('\n')).toContain('No evidence blob is recorded for run')
    expectNoBytes(after, PNG)
    expectNoBytes(after, JPEG)
  })

  it('a blob deleted while another caller\'s read is in flight answers the named miss', async () => {
    const blobs = blobsOf({ [ALPHA]: [PNG], [BETA]: [JPEG] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gated: Blobs = new Map([[ALPHA, blobs.get(ALPHA)!], [BETA, blobs.get(BETA)!]])
    const registry = createFunctionRegistry({
      deps: {
        evidenceBlobs: {
          read: async (runId: RunId, sha: string) => {
            if (String(runId) === ALPHA) await gate
            return lookup(gated, runId, sha)
          },
        },
      } as unknown as FunctionDeps,
    })
    const alpha = await connect(registry)
    const beta = await connect(registry)

    const pending = fetchArtifact(alpha, PNG, undefined, ALPHA)
    const betaResult = await fetchArtifact(beta, JPEG, undefined, BETA)
    gated.get(ALPHA)!.delete(shaOf(PNG))
    release()
    const alphaResult = await pending

    expect(images(betaResult)).toEqual([{ type: 'image', data: JPEG_BASE64, mimeType: 'image/jpeg' }])
    expect(alphaResult.isError).toBe(true)
    expect(texts(alphaResult).join('\n')).toContain('No evidence blob is recorded for run')
    expectNoBytes(alphaResult, PNG)
    expectNoBytes(alphaResult, JPEG)
  })

  it('a refusal keeps the existing result metadata', () => {
    const output = {
      runId: RUN, sha: shaOf(PNG), contentType: 'image/png', byteLength: 16, bytesBase64: encode(PNG.slice(0, 16)),
      totalLength: PNG.length, range: { start: 0, end: 15 },
    }
    const withMeta: CallToolResult = { ...maskedToolResult(output, identity), _meta: { 'agent-qa/probe': 1 } }
    const refused = decorateRunEvidenceImage({ result: withMeta, output, maskText: identity })

    expect(refused.isError).toBe(true)
    expect(refused._meta).toEqual({ 'agent-qa/probe': 1 })
    expect(refused.structuredContent).toBeUndefined()
    expect(refused.content).toHaveLength(1)
  })
})
