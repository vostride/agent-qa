import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentHost } from '../chat/host.js'
import { DashboardDatabase } from '../db/database.js'
import { startServer } from '../server/server.js'

/**
 * THE ARTIFACT-SERVING GUARD, DRIVEN AT THE RAW WIRE (402-05 D-16 → 405-07 D-14 — T-402-17/T-405-28).
 *
 * ---- WHAT THIS FILE MEASURES NOW -------------------------------------------------------------
 *
 * the two PATH-addressed artifact routes these cells were written against are
 * deleted, with the containment resolver, the three-door serving verdict and the run-deletion
 * filesystem sweep that shared it. Refs are the only artifact addressing: a run's evidence
 * is reached as `GET /api/runs/:runId/artifacts/:sha`, and the containment rule for those bytes is
 * the evidence store's own, reached through the `runs.artifact` op rather than reassembled here.
 *
 * The escape payloads did not go away with the routes — they arrive at whatever route serves
 * artifacts — so this file keeps every one of them and re-aims it at the successor. What changed is
 * WHERE the refusal comes from: it is no longer a path check this package wrote, it is a content
 * ADDRESS contract. A sha is 64 characters drawn from `[0-9a-f]`, so every payload below fails to
 * be one, and the door refuses before it has any path to resolve.
 *
 * ---- WHY A SOCKET AND NOT `fetch` ------------------------------------------------------------
 *
 * Every HTTP client in Node builds its request target through the WHATWG URL parser, and that
 * parser REMOVES double-dot path segments before a byte leaves the process. `fetch` cannot send
 * `GET /api/runs/run-1/artifacts/../../canary.txt` — it sends `GET /canary.txt`. A cell that used
 * `fetch` for the literal form would therefore be measuring its own client, and would report a
 * refusal the server never made. These cells write the request line onto a `net.Socket` directly,
 * so the bytes on the wire are the bytes the cell chose. That is this file's whole reason to exist
 * alongside `run-service/__tests__/run-detail-routes.test.ts`, which drives the same route through
 * `fetch` over a real store.
 *
 * ---- WHERE NORMALIZATION ACTUALLY HAPPENS, MEASURED ------------------------------------------
 *
 *  - A LITERAL `../` reaches this process and is then collapsed by `tryParseRequestUrl`'s
 *    `new URL(...)` — the request lands on a different route entirely, never on the artifact arm.
 *  - A WHOLE-SEGMENT `%2e%2e` is ALSO collapsed there: the URL spec counts it as a double-dot path
 *    segment. That class cannot reach the arm from any client.
 *  - `..%2f`, `..%5c` and `%2f`-prefixed segments are NOT collapsed — the encoded separator keeps
 *    the dot-dot inside one segment, so it survives the parse intact and arrives at the route.
 *    THOSE are the payloads below, and the address contract is the only thing refusing them.
 *
 * ---- THE CANARY ------------------------------------------------------------------------------
 *
 * Every refusal cell targets a real file planted OUTSIDE any artifact root and asserts its bytes
 * never appear in any response. A 4xx alone would be satisfied by a route that refused for the
 * wrong reason. The claim is now STRONGER than it was: the arm opens no path at all, so a canary
 * appearing in a body would mean a filesystem read this layer is no longer capable of making.
 *
 * ---- THE PLANTED HOST, AND WHAT IT IS AND IS NOT PROOF OF ------------------------------------
 *
 * `serveRunArtifact` validates the address with the SHIPPED `RunsArtifactInputSchema` BEFORE it
 * dispatches, so every refusal below is the shipped contract's and not this file's. The host here
 * is a stub that THROWS if it is ever invoked with a refused address — so a route that stopped
 * validating would surface as a 500 rather than quietly pass this suite.
 *
 * The 200 control is planted bytes, deliberately: what it proves is that the door is not refusing
 * everything, and that the address it accepted is the one it echoed as the validator. The bytes of
 * a blob actually WRITTEN through `FsEvidenceArtifactStore` are 405-05's cell in
 * `run-detail-routes.test.ts`, over a real composed registry; a second registry composition here
 * would be a second thing to keep in step with the first.
 */

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
