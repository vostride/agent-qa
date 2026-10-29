import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentHost } from '../chat/host.js'
import { DashboardDatabase } from '../db/database.js'
import { startServer } from '../server/server.js'

// Raw socket writes, because `fetch` collapses `../` before sending; no body may hold the canary.

const CANARY = 'agent-qa-traversal-canary-8f3a1c'

/** A well-formed content address: 64 lowercase hex characters. */
const GOOD_SHA = 'a'.repeat(64)
const PLANTED_BYTES = 'planted-artifact-bytes'
const RUN_ID = 'r_traversal-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'

let tempDir: string
let outsideCanaryPath: string
let port: number
let close: (() => void) | undefined
let db: DashboardDatabase | undefined
/** Every address the planted op was asked for. A refused address must never appear here. */
const dispatchedShas: string[] = []

/**
 * A host that answers ONLY for the one well-formed address, and throws for anything else.
 *
 * The throw is the instrument: `serveRunArtifact` refuses a malformed address before it dispatches,
 * so a payload below reaching this function at all means the validation was skipped — and the 500
 * that follows is louder than the 400 the cell expected.
 */
function plantedHost(): AgentHost {
  return {
    registry: {} as never,
    caller: { surface: 'test', actor: 'traversal' },
    runsArtifactFunctionId: 'test:planted-artifact-op',
    analysisGetFunctionId: 'test:planted-analysis-get-op',
    invokeFunction: (_registry: unknown, _id: string, input: unknown) => {
      const { sha } = input as { sha: string }
      dispatchedShas.push(sha)
      if (sha !== GOOD_SHA) throw new Error(`planted op reached with an address it must never see: ${sha}`)
      return Promise.resolve({
        runId: RUN_ID,
        sha: GOOD_SHA,
        contentType: 'image/png',
        byteLength: PLANTED_BYTES.length,
        bytesBase64: Buffer.from(PLANTED_BYTES, 'utf8').toString('base64'),
      })
    },
  } as unknown as AgentHost
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-qa-traversal-'))
  // Canary 1: inside the workspace, one level out of anywhere an artifact could live.
  mkdirSync(join(tempDir, 'artifacts'), { recursive: true })
  writeFileSync(join(tempDir, 'artifacts', 'canary.txt'), CANARY)
  // Canary 2: a SIBLING DIRECTORY whose name has an artifact root's name as a string prefix. This
  // is the file a `resolved.startsWith(root)` containment check served and a path-relative one
  // refused — the class that motivated the unified resolver the ref address now replaces.
  mkdirSync(join(tempDir, 'artifacts', 'screenshots-evil'), { recursive: true })
  writeFileSync(join(tempDir, 'artifacts', 'screenshots-evil', 'canary.txt'), CANARY)
  // Canary 3: reached only by smuggling an ABSOLUTE path in as the address.
  outsideCanaryPath = join(tempDir, 'absolute-canary.txt')
  writeFileSync(outsideCanaryPath, CANARY)

  const configPath = join(tempDir, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'testDir: tests\n')
  db = new DashboardDatabase({ dbPath: ':memory:' })
  const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, configPath, agentHost: plantedHost() })
  close = started.close
  port = (started.server.address() as AddressInfo).port
})

afterAll(() => {
  close?.()
  db?.close()
  rmSync(tempDir, { recursive: true, force: true })
})

interface RawResponse {
  readonly status: number
  readonly raw: string
}

/**
 * Write ONE request line onto a socket and read the whole response back.
 *
 * The target is used VERBATIM — no URL construction anywhere in this helper, which is the entire
 * point of it. `latin1` is used to stringify the response so a binary body is searchable for the
 * canary marker without a decoder rewriting bytes.
 */
async function rawRequest(target: string): Promise<RawResponse> {
  return new Promise<RawResponse>((ok, fail) => {
    const chunks: Buffer[] = []
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`,
      )
    })
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    socket.on('error', fail)
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('latin1')
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? '0')
      ok({ status, raw })
    })
  })
}

/** The refusal word the artifact door published, or undefined when it was not the responder. */
function refusal(response: RawResponse): string | undefined {
  return /"error":"([a-z_]+)"/.exec(response.raw)?.[1]
}

function expectNoCanary(response: RawResponse): void {
  expect(response.raw).not.toContain(CANARY)
}

describe('the ref-addressed artifact route refuses encoded traversal at the raw wire', () => {
  it('documents where normalization happens: a LITERAL ../ never reaches the artifact door', async () => {
    // Sent as raw bytes — no client could produce this. The server's own `tryParseRequestUrl`
    // collapses it, so the request lands somewhere that is not the artifact route at all. This cell
    // exists so the encoded payloads below are read as the ones that DO reach the door.
    const response = await rawRequest(`/api/runs/${RUN_ID}/artifacts/../../canary.txt`)
    expect(refusal(response)).toBeUndefined()
    expectNoCanary(response)
  })

  it('refuses an encoded-separator dot-dot escape presented as the content address', async () => {
    const response = await rawRequest(`/api/runs/${RUN_ID}/artifacts/..%2f..%2fcanary.txt`)
    expect(response.status).toBe(400)
    expect(refusal(response)).toBe('malformed_sha')
    expectNoCanary(response)
  })

  it('refuses a BACKSLASH-separated escape (a separator on win32, a forbidden byte everywhere)', async () => {
    const response = await rawRequest(`/api/runs/${RUN_ID}/artifacts/..%5c..%5ccanary.txt`)
    expect(response.status).toBe(400)
    expect(refusal(response)).toBe('malformed_sha')
    expectNoCanary(response)
  })

  it('refuses an ABSOLUTE path smuggled in as the content address', async () => {
    const response = await rawRequest(
      `/api/runs/${RUN_ID}/artifacts/${encodeURIComponent(outsideCanaryPath)}`,
    )
    expect(response.status).toBe(400)
    expect(refusal(response)).toBe('malformed_sha')
    expectNoCanary(response)
  })

  it('refuses a SIBLING DIRECTORY whose name is a string prefix of an artifact root', async () => {
    // The class a prefix-compare containment check served: `<artifacts>/screenshots-evil/...`
    // starts with `<artifacts>/screenshots` as a STRING and is outside it as a PATH. There is no
    // prefix compare left to fool — the address is not a path.
    const response = await rawRequest(
      `/api/runs/${RUN_ID}/artifacts/..%2f..%2fscreenshots-evil%2fcanary.txt`,
    )
    expect(response.status).toBe(400)
    expect(refusal(response)).toBe('malformed_sha')
    expectNoCanary(response)
  })

  it('refuses a malformed percent escape rather than decoding the address at all', async () => {
    // THE SHA IS NEVER DECODED, and that is the contract rather than an oversight: a content
    // address contains nothing percent-encoding could represent differently, so a segment that
    // needed decoding is already not one. The raw bytes go straight to the address regex.
    const response = await rawRequest(`/api/runs/${RUN_ID}/artifacts/%zz.png`)
    expect(response.status).toBe(400)
    expect(refusal(response)).toBe('malformed_sha')
  })

  it('refuses an escape in the RUN ID segment, and blames the run id rather than the address', async () => {
    const response = await rawRequest(`/api/runs/..%2f..%2fcanary.txt/artifacts/${GOOD_SHA}`)
    expect(response.status).toBe(400)
    expect(refusal(response)).toBe('invalid_run_id')
    expectNoCanary(response)
  })

  it('refuses UPPERCASE hex — a content address has exactly one spelling', async () => {
    const response = await rawRequest(`/api/runs/${RUN_ID}/artifacts/${GOOD_SHA.toUpperCase()}`)
    expect(response.status).toBe(400)
    expect(refusal(response)).toBe('malformed_sha')
  })

  it('does not reassemble a path split across REAL separators into an address', async () => {
    // The arm's regex is anchored with `[^/]+` on both captures, so a target carrying an extra
    // separator matches nothing here rather than being rejoined into something that does. It falls
    // through to the four-segment run catch-all, which refuses it as a run id.
    const response = await rawRequest(`/api/runs/${RUN_ID}/artifacts/${GOOD_SHA}/extra`)
    expect(response.status).toBe(404)
    expect(refusal(response)).toBeUndefined()
  })

  it('NON-VACUITY: every refusal above stopped before the op was ever asked', () => {
    // The planted host throws for any address but the good one. If a refusal had dispatched, the
    // cell above it would have seen a 500 — and this asserts the same fact directly, so a future
    // change that moved validation after dispatch cannot pass by accident.
    expect(dispatchedShas.filter((sha) => sha !== GOOD_SHA)).toEqual([])
  })

  it('CONTROL: a well-formed content address reaches the op and its bytes are served', async () => {
    const response = await rawRequest(`/api/runs/${RUN_ID}/artifacts/${GOOD_SHA}`)
    expect(response.status).toBe(200)
    expect(response.raw).toContain(PLANTED_BYTES)
    // The address IS the validator, and the door promises it will never go stale.
    expect(response.raw).toContain(`ETag: "${GOOD_SHA}"`)
    expect(response.raw).toContain('X-Content-Type-Options: nosniff')
    expect(dispatchedShas).toContain(GOOD_SHA)
    expectNoCanary(response)
  })
})
