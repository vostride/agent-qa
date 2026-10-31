// Every refusal cell has an allowed twin: a refusal and a dead server look the same from outside.

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { basename, dirname } from 'node:path'

import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { EditorLiveUrlResultSchema } from '@vostride/agent-qa-schema'

import {
  DASHBOARD_ANCHORED_BUILDS,
  buildFreshness,
  cleanupTempRoots,
  runServiceFixtureProject,
  spawnDashboard,
} from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'

/** What `spawnDashboard` returns: the door plus its own readiness statement. */
type ReadySpawnedDashboard = SpawnedDashboard & { readonly ready: boolean }

const REBUILD_INSTRUCTION =
  'these cells drive the BUILT binary: run `pnpm -r build` from the agent-qa root first.'

/** The attacker's origin. A host this process could never resolve, so nothing can answer for it. */
const HOSTILE_ORIGIN = 'http://evil.test'

const BROWSER_INSTALL_INSTRUCTION =
  'cell (2) drives a REAL Chromium from a real second origin: run '
  + '`pnpm exec playwright install chromium` and re-run. IT MUST NOT BE SKIPPED WHEN THE BROWSER '
  + 'IS ABSENT — it is the only cell that measures SC-2 on the road a person\'s browser actually '
  + 'takes, and every other cell here states the headers rather than provoking them.'

/** How long the run has to become attachable before this file gives up and says so. */
const ATTACH_BUDGET_MS = 60_000

interface Fixture {
  readonly dashboard: ReadySpawnedDashboard
  readonly runId: string
}

let fixture: Fixture | undefined

function held(): Fixture {
  if (fixture === undefined) throw new Error('the cross-site fixture never came up')
  return fixture
}

/** Quote the child's own streams in every failure — a spawned cell's message is its diagnosis. */
function childContext(dashboard: SpawnedDashboard): string {
  return `child stdout: ${JSON.stringify(dashboard.stdout().slice(-1200))}; `
    + `child stderr: ${JSON.stringify(dashboard.stderr().slice(-1200))}`
}

// ---- the raw HTTP client ---------------------------------------------------------------------
//
// THE IDIOM IS `dashboard-door-security.test.ts`'s, deliberately duplicated rather than imported:
// that file is a test module and exports nothing, and a shared helper extracted for a second
// caller would put the two doors' evidence behind one implementation. `Origin` is a FORBIDDEN
// FETCH HEADER — `fetch` silently drops it — so a header-exact cross-site cell has to be written
// onto a socket by hand. The path is not parsed and the headers are not filtered: that is the
// point, because both are what the attacker sends.

interface RawResponse {
  /** `0` means NO RESPONSE ARRIVED — the socket closed empty, or the budget expired. */
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly note?: string
}

function noResponse(note: string): RawResponse {
  return { status: 0, headers: {}, body: '', note }
}

/**
 * Undo `Transfer-Encoding: chunked` framing.
 *
 * NOT A FLOURISH — the defect it prevents was measured. The mint door writes its JSON with
 * `res.end(body)` and no `Content-Length`, so node frames it chunked, and a raw body read starts
 * `17c\r\n{"liveUrl":…`. `JSON.parse` on that throws, which made "is there a token in this answer?"
 * answer NO for an answer that plainly carried one — a false GREEN wearing the fix's clothes.
 */
function dechunk(body: string): string {
  let rest = body
  let out = ''
  for (;;) {
    const at = rest.indexOf('\r\n')
    if (at === -1) return out === '' ? body : out
    const size = Number.parseInt(rest.slice(0, at).split(';')[0] ?? '', 16)
    if (!Number.isInteger(size)) return out === '' ? body : out
    if (size === 0) return out
    out += rest.slice(at + 2, at + 2 + size)
    rest = rest.slice(at + 2 + size + 2)
  }
}

function parseRaw(raw: string): RawResponse {
  if (raw === '') return noResponse('the socket closed without a single byte')
  const split = raw.indexOf('\r\n\r\n')
  const head = split === -1 ? raw : raw.slice(0, split)
  const framed = split === -1 ? '' : raw.slice(split + 4)
  const lines = head.split('\r\n')
  const status = Number.parseInt(lines[0]?.split(' ')[1] ?? '', 10)
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at === -1) continue
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  const body = (headers['transfer-encoding'] ?? '').includes('chunked') ? dechunk(framed) : framed
  return { status: Number.isInteger(status) ? status : 0, headers, body }
}

function rawRequest(
  port: number,
  init: {
    readonly method: string
    readonly path: string
    readonly headers?: Readonly<Record<string, string | undefined>>
    readonly body?: string
    readonly budgetMs?: number
    readonly httpVersion?: '1.0' | '1.1'
  },
): Promise<RawResponse> {
  return new Promise<RawResponse>((settle) => {
    const socket = connect(port, '127.0.0.1')
    let raw = ''
    let settled = false
    const finish = (value: RawResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      settle(value)
    }
    const timer = setTimeout(
      () => finish(noResponse('no response within the cell budget')),
      init.budgetMs ?? 8_000,
    )
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { raw += chunk })
    socket.on('end', () => finish(parseRaw(raw)))
    socket.on('close', () => finish(parseRaw(raw)))
    socket.on('error', (error: Error) => finish(parseRaw(raw).status === 0 ? noResponse(error.message) : parseRaw(raw)))
    socket.on('connect', () => {
      const headers: Record<string, string> = {
        host: `127.0.0.1:${String(port)}`,
        connection: 'close',
      }
      for (const [key, value] of Object.entries(init.headers ?? {})) {
        const normalizedKey = key.toLowerCase()
        if (value === undefined) delete headers[normalizedKey]
        else headers[normalizedKey] = value
      }
      if (init.body !== undefined) {
        headers['content-length'] = String(Buffer.byteLength(init.body))
      }
      socket.write(
        `${init.method} ${init.path} HTTP/${init.httpVersion ?? '1.1'}\r\n`
        + Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')
        + '\r\n'
        + (init.body ?? ''),
      )
    })
  })
}

/** One mint request, with whatever headers the cell wants to state. */
function mintRaw(
  port: number,
  runId: string,
  headers: Readonly<Record<string, string | undefined>>,
  httpVersion: '1.0' | '1.1' = '1.1',
): Promise<RawResponse> {
  return rawRequest(port, {
    method: 'GET',
    path: `/api/runs/${encodeURIComponent(runId)}/live-url`,
    headers,
    httpVersion,
  })
}

/** The one fact every cell here turns on: did this answer hand out a token? */
function liveUrlIn(response: RawResponse): string | undefined {
  try {
    const parsed = JSON.parse(response.body) as { liveUrl?: unknown }
    return typeof parsed.liveUrl === 'string' ? parsed.liveUrl : undefined
  } catch {
    return undefined
  }
}

// ---- the raw WebSocket client ----------------------------------------------------------------
//
// WHY BY HAND. The upgrade's `Origin` is the whole subject of cell (5), and neither the platform
// `WebSocket` nor `playwright`'s page can be made to state one: the platform client decides that
// header for you and a browser page can only ever send its own. So the handshake is written onto a
// socket, the `hello` is framed by hand, and the server's answer is decoded by hand. Nothing here
// is a protocol implementation — it speaks exactly the four things this door's cells need.

/** A client text frame: FIN, opcode 1, MASK set (a client frame that is not masked is a protocol error). */
function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  const header: number[] = [0x81]
  if (length < 126) header.push(0x80 | length)
  else if (length < 65_536) header.push(0x80 | 126, (length >> 8) & 0xff, length & 0xff)
  else throw new Error('this cell never sends a frame that large')
  const mask = randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }
  return Buffer.concat([Buffer.from(header), mask, masked])
}

/** Decode every COMPLETE frame at the head of `buffer`; hand back what is still partial. */
function drainFrames(buffer: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const opcode = (buffer[offset] ?? 0) & 0x0f
    const second = buffer[offset + 1] ?? 0
    const isMasked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let maskKey: Buffer | undefined
    if (isMasked) {
      if (buffer.length - cursor < 4) break
      maskKey = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (buffer.length - cursor < length) break
    let payload = buffer.subarray(cursor, cursor + length)
    if (maskKey !== undefined) {
      const copy = Buffer.from(payload)
      for (let index = 0; index < copy.length; index += 1) {
        copy[index] = (copy[index] ?? 0) ^ (maskKey[index % 4] ?? 0)
      }
      payload = copy
    }
    offset = cursor + length
    if (opcode === 0x1) texts.push(payload.toString('utf8'))
  }
  return { texts, rest: buffer.subarray(offset) }
}

interface SocketReading {
  /** The upgrade's HTTP status. `101` is an accepted upgrade; `0` means the door hung up. */
  readonly upgradeStatus: number
  readonly messages: { type?: string; reason?: string; stream?: { kind?: string } }[]
  readonly note?: string
}

/**
 * One frame-socket exchange with EXACTLY the headers the cell states.
 *
 * `origin: undefined` sends no `Origin` header at all — the non-browser client — which is a
 * different fact from sending an empty one, and the two must not be spelled the same way.
 */
function speakToFrameSocketRaw(input: {
  readonly port: number
  readonly runId: string
  readonly token: string
  readonly host?: string
  readonly origin?: string
  readonly until: readonly string[]
  readonly budgetMs?: number
}): Promise<SocketReading> {
  return new Promise<SocketReading>((settle) => {
    const socket = connect(input.port, '127.0.0.1')
    const messages: { type?: string; reason?: string; stream?: { kind?: string } }[] = []
    let head = ''
    let upgraded = false
    let upgradeStatus = 0
    let pending = Buffer.alloc(0)
    let settled = false
    const finish = (note?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(budget)
      socket.destroy()
      settle({ upgradeStatus, messages, ...(note === undefined ? {} : { note }) })
    }
    const budget = setTimeout(() => finish('no answer within the cell budget'), input.budgetMs ?? 20_000)
    socket.on('error', (error: Error) => finish(error.message))
    socket.on('close', () => finish('the door hung up'))
    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        head += chunk.toString('latin1')
        const split = head.indexOf('\r\n\r\n')
        if (split === -1) return
        upgradeStatus = Number.parseInt(head.split('\r\n')[0]?.split(' ')[1] ?? '', 10)
        if (!Number.isInteger(upgradeStatus)) upgradeStatus = 0
        if (upgradeStatus !== 101) { finish(`the upgrade was answered ${String(upgradeStatus)}`); return }
        upgraded = true
        pending = Buffer.from(head.slice(split + 4), 'latin1')
        socket.write(maskedTextFrame(JSON.stringify({ type: 'hello', token: input.token })))
      } else {
        pending = Buffer.concat([pending, chunk])
      }
      const drained = drainFrames(pending)
      // `Buffer.from`, not the subarray itself: a subarray keeps its parent's `ArrayBufferLike`
      // backing type, which is not the `ArrayBuffer` the accumulator was allocated with.
      pending = Buffer.from(drained.rest)
      for (const text of drained.texts) {
        try {
          const parsed = JSON.parse(text) as { type?: string }
          messages.push(parsed)
          if (typeof parsed.type === 'string' && input.until.includes(parsed.type)) finish()
        } catch { /* a non-JSON text frame is not a message this protocol defines */ }
      }
    })
    socket.on('connect', () => {
      const headers: Record<string, string> = {
        host: input.host ?? `127.0.0.1:${String(input.port)}`,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
      }
      if (input.origin !== undefined) headers.origin = input.origin
      socket.write(
        `GET /api/live-view/ws?runId=${encodeURIComponent(input.runId)} HTTP/1.1\r\n`
        + Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')
        + '\r\n',
      )
    })
  })
}

// ---- the second origin -------------------------------------------------------------------------

/** A throwaway server on a SECOND loopback port. A different port is a different ORIGIN. */
async function serveAttackerPage(html: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', () => { ready() }) })
  return { server, port: (server.address() as AddressInfo).port }
}

let browser: Browser | undefined
let attackerServer: Server | undefined

beforeAll(async () => {
  // FIRST, AND BEFORE ANYTHING IS SPAWNED: a stale build measures the previous commit.
  expect(buildFreshness(DASHBOARD_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
    .toEqual({ missing: [], stale: [] })

  const project = runServiceFixtureProject('live-view-cross-site')
  const dashboard = await spawnDashboard(project.root, project.configPath)
  expect(
    dashboard.ready,
    `the built \`agent-qa dashboard\` never reported that it was listening. ${childContext(dashboard)}`,
  ).toBe(true)

  const trigger = await fetch(`${dashboard.origin}/api/runs/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'tests/probe.test.yaml' }),
  })
  const triggerBody = await trigger.text()
  expect(trigger.status, `the trigger route refused: ${triggerBody}. ${childContext(dashboard)}`)
    .toBe(202)
  const runId = (JSON.parse(triggerBody) as { runId?: string }).runId
  expect(typeof runId, `the trigger ack named no run: ${triggerBody}`).toBe('string')

  // The queue starts the run asynchronously. Poll the mint — bounded — rather than sleeping a
  // number somebody guessed. This poll is a plain node `fetch`: no `Origin`, which is the
  // non-browser caller the guard must keep admitting, so a fixture that comes up at all is
  // already the first reading of cell (4)'s contract.
  const deadline = Date.now() + ATTACH_BUDGET_MS
  let attachable = false
  while (Date.now() < deadline) {
    const probe = await fetch(`${dashboard.origin}/api/runs/${encodeURIComponent(runId as string)}/live-url`)
    if (probe.status === 200) { attachable = true; await probe.text(); break }
    await probe.text().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  expect(
    attachable,
    `the spawned dashboard never made run ${String(runId)} attachable. ${childContext(dashboard)}`,
  ).toBe(true)

  fixture = { dashboard, runId: runId as string }
}, 180_000)

afterAll(async () => {
  const open = fixture
  fixture = undefined
  if (browser !== undefined) { await browser.close().catch(() => undefined); browser = undefined }
  if (attackerServer !== undefined) {
    const listening = attackerServer
    attackerServer = undefined
    await new Promise<void>((closed) => listening.close(() => closed()))
  }
  if (open !== undefined) await open.dashboard.stop()
  cleanupTempRoots()
})

describe('the live-url mint door refuses a cross-site browser request', () => {
  it('(1) THE CHOKE POINT: a cross-site GET is refused by name and carries no wildcard CORS', async () => {
    const f = held()

    // THE ATTACKER'S REQUEST, byte for byte as a page on another origin would drive it.
    const hostile = await mintRaw(f.dashboard.port, f.runId, {
      origin: HOSTILE_ORIGIN,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    })

    // THE ALLOWED TWIN, IN THE SAME BREATH. Identical shape, no hostile origin. If this does not
    // answer 200 with a token then the door is unreachable at this instant and the refusal above
    // proves nothing at all — a broken server and a working guard are the same reading otherwise.
    const twin = await mintRaw(f.dashboard.port, f.runId, {
      origin: f.dashboard.origin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    })

    const reading = {
      hostileStatus: hostile.status,
      hostileAcao: hostile.headers['access-control-allow-origin'] ?? null,
      hostileLiveUrl: liveUrlIn(hostile) === undefined ? null : 'PRESENT',
      hostileBody: hostile.body.slice(0, 200),
      hostileNote: hostile.note ?? null,
      twinStatus: twin.status,
      twinLiveUrl: liveUrlIn(twin) === undefined ? null : 'PRESENT',
      twinNote: twin.note ?? null,
    }
    const context = `${JSON.stringify(reading)}. ${childContext(f.dashboard)}`

    expect(
      reading.twinStatus,
      `${context} — THE ALLOWED TWIN. The same request without the hostile Origin must still be `
      + 'answered; without this reading the refusal below cannot be told from an unreachable route.',
    ).toBe(200)
    expect(reading.twinLiveUrl, `${context} — the twin must actually receive a token`).toBe('PRESENT')

    expect(
      reading.hostileStatus,
      `${context} — SC-2: a page on another origin must be refused BY NAME. At HEAD this read 200.`,
    ).toBe(403)
    expect(
      hostile.body,
      `${context} — the refusal is a typed word, not a bare status`,
    ).toContain('cross_site_refused')
    expect(
      reading.hostileAcao,
      `${context} — the answer must carry NO Access-Control-Allow-Origin at all, so that even a `
      + 'refusal body is unreadable cross-origin. At HEAD this read `*` on a 200 carrying the token.',
    ).toBeNull()
    expect(
      reading.hostileLiveUrl,
      `${context} — no token may leave through this door for a cross-site caller`,
    ).toBeNull()
  }, 60_000)

  it('(3) REGRESSION PIN: the dashboard\'s own same-origin page still mints', async () => {
    const f = held()
    const answer = await mintRaw(f.dashboard.port, f.runId, {
      origin: f.dashboard.origin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    })
    const context = `status=${String(answer.status)} body=${answer.body.slice(0, 200)} `
      + `note=${answer.note ?? 'none'}. ${childContext(f.dashboard)}`
    expect(answer.status, `${context} — the dashboard's own UI is the caller this door exists for`).toBe(200)
    expect(liveUrlIn(answer), `${context} — and it receives a real token`).toMatch(/^http.*#v2\./u)
  }, 60_000)

  it('(4) REGRESSION PIN: the non-browser client, which sends NO Origin at all, still mints', async () => {
    const f = held()

    // A PLAIN NODE `fetch`: no `Origin`, no `Sec-Fetch-Site`. This is the CLI, `curl`, and the
    // conformance harness itself — including `live-view-dom.test.ts`'s `mintStreamKind`, whose
    // non-vacuity control for cells (8)/(8b) queries this exact route from Node. An absent Origin
    // is EVIDENCE OF A NON-BROWSER CALLER, and refusing it would brick every local drive to defend
    // against nothing.
    const response = await fetch(
      `${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}/live-url`,
    )
    const raw = await response.text()
    const context = `status=${String(response.status)} body=${raw.slice(0, 200)}. ${childContext(f.dashboard)}`
    expect(response.status, `${context} — the Origin-absent caller is ALLOWED, by policy`).toBe(200)
    expect(
      (JSON.parse(raw) as { liveUrl?: string }).liveUrl,
      `${context} — and it receives a real token`,
    ).toMatch(/^http.*#v2\./u)

    // The SECOND spelling of the same fact, because a header a client library did not send and a
    // header the server did not write fail differently: the answer carries no wildcard CORS grant
    // even on the allowed path, so the token body is unreadable from a foreign document.
    expect(
      response.headers.get('access-control-allow-origin'),
      `${context} — a capability answer stamps no cross-origin read grant, allowed or not`,
    ).toBeNull()
  }, 60_000)

  it('(2) REAL BROWSER CORS LAYER: a capability answer exposes no Access-Control-Allow-Origin grant', async () => {
    const f = held()

    if (browser === undefined) {
      try {
        browser = await chromium.launch({ headless: true })
      } catch (error) {
        throw new Error(
          `${BROWSER_INSTALL_INSTRUCTION} underlying error: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const dash = `http://127.0.0.1:${String(f.dashboard.port)}`
    // The control proves the page, the browser and the door are live. No /api read is readable from
    // another origin, so it is a `no-cors` fetch: an opaque answer means the request reached the
    // door, and the listener sees the door refuse it with 403.
    const controlUrl = `${dash}/api/stats`
    const liveUrl = `${dash}/api/runs/${encodeURIComponent(f.runId)}/live-url`

    // THIS CELL MEASURES THE SECOND, INDEPENDENT LAYER: a capability answer carries no
    // `Access-Control-Allow-Origin` grant. Guard discrimination rests on cells (1) and (6), both
    // mutation-proven; this cell pins the browser behavior that keeps those layers distinct.
    const html = `<!doctype html><meta charset="utf-8"><title>second origin</title><body><script>
      window.__reading = { phase: 'pending' };
      (async () => {
        const reading = { phase: 'done', control: null, controlError: null, target: null, targetError: null };
        try {
          const response = await fetch(${JSON.stringify(controlUrl)}, { mode: 'no-cors' });
          reading.control = { type: response.type };
        } catch (error) { reading.controlError = String(error); }
        try {
          const response = await fetch(${JSON.stringify(liveUrl)});
          reading.target = { status: response.status, bodyHead: (await response.text()).slice(0, 300) };
        } catch (error) { reading.targetError = String(error); }
        window.__reading = reading;
      })();
    </script></body>`

    const attacker = await serveAttackerPage(html)
    attackerServer = attacker.server
    const attackerPort = attacker.port

    interface PageScriptReading {
      control: { type: string } | null
      controlError: string | null
      target: { status: number; bodyHead: string } | null
      targetError: string | null
    }

    interface PageReading extends PageScriptReading {
      responses: { url: string; status: number }[]
      failures: { url: string; errorText: string | null }[]
    }

    // Five arms: one browser arm cannot tell a guard from a race.
    const arms: (PageReading & { arm: number })[] = []
    for (let k = 0; k < 5; k += 1) {
      const page = await browser.newPage()
      const responses: PageReading['responses'] = []
      const failures: PageReading['failures'] = []
      page.on('response', (response) => {
        responses.push({ url: response.url(), status: response.status() })
      })
      page.on('requestfailed', (request) => {
        failures.push({ url: request.url(), errorText: request.failure()?.errorText ?? null })
      })
      try {
        await page.goto(`http://127.0.0.1:${String(attackerPort)}/`, { waitUntil: 'load', timeout: 30_000 })
        await page.waitForFunction(
          () => (window as unknown as { __reading: { phase: string } }).__reading.phase === 'done',
          undefined,
          { timeout: 30_000 },
        )
        const reading = await page.evaluate(
          () => (window as unknown as { __reading: unknown }).__reading,
        ) as PageScriptReading
        arms.push({ arm: k + 1, ...reading, responses, failures })
      } finally {
        await page.close().catch(() => undefined)
      }
    }

    for (const reading of arms) {
      const context = `arm ${String(reading.arm)} of 5, attacker origin `
        + `http://127.0.0.1:${String(attackerPort)} → dashboard ${dash}: ${JSON.stringify(reading)}. `
        + childContext(f.dashboard)
      const controlResponses = reading.responses.filter((response) => response.url === controlUrl)
      const liveUrlFailures = reading.failures.filter((failure) => failure.url === liveUrl)
      const liveUrlResponses = reading.responses.filter((response) => response.url === liveUrl)

      // THE LISTENER'S OWN NON-VACUITY, ASSERTED FIRST.
      expect(
        controlResponses.map((response) => response.status),
        `${context} — the response listener must observe the door refuse the cross-site control read`,
      ).toContain(403)

      expect(
        reading.control?.type,
        `${context} — THE CONTROL: this page must be able to reach the dashboard cross-origin at `
        + 'all. A blocked target below means nothing if the browser could not reach the door.',
      ).toBe('opaque')
      expect(
        reading.controlError,
        `${context} — the control got an answer, so the page, the browser and the door are all live`,
      ).toBeNull()

      expect(
        liveUrlFailures.map((failure) => failure.errorText),
        `${context} — Chromium must report the blocked live-url request as net::ERR_FAILED`,
      ).toContain('net::ERR_FAILED')
      expect(
        liveUrlResponses,
        `${context} — Chromium must not surface a response event for the blocked live-url request`,
      ).toEqual([])

      // THE VERDICT. Either the browser refused to hand the body over (no
      // `Access-Control-Allow-Origin` on the answer) or the page read a refusal — never a token.
      const targetBody = reading.target?.bodyHead ?? ''
      expect(
        targetBody.includes('liveUrl'),
        `${context} — SC-2: a page on another origin must not be able to obtain a liveUrl. At HEAD `
        + 'this page read the token out of a 200 and could have opened the frame socket with it.',
      ).toBe(false)
      expect(
        reading.targetError !== null || reading.target?.status === 403,
        `${context} — the mint must be either unreadable to this document (a CORS failure, because `
        + 'the answer carries no Access-Control-Allow-Origin) or refused by name with 403',
      ).toBe(true)
    }
  }, 300_000)

  it('(5) the frame socket\'s DEFENSE-IN-DEPTH Origin rung — refusal, and the two shapes it must not break', async () => {
    const f = held()

    // The token comes from the non-browser caller the guard admits.
    const raw = await (await fetch(`${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}/live-url`)).text()
    const token = (JSON.parse(raw) as { liveUrl?: string }).liveUrl?.split('#')[1]
    expect(typeof token, `the mint answered ${raw.slice(0, 200)}`).toBe('string')

    const arms = {
      // A NON-BROWSER CLIENT: no `Origin` header at all.
      absent: await speakToFrameSocketRaw({
        port: f.dashboard.port, runId: f.runId, token: token as string, until: ['ready', 'ended', 'refused'],
      }),
      // THE SANDBOXED EMBED'S SHAPE. `live-preview.tsx` sandboxes the embed iframe WITHOUT
      // `allow-same-origin`, so the real embed's upgrade carries the literal `null`.
      opaque: await speakToFrameSocketRaw({
        port: f.dashboard.port, runId: f.runId, token: token as string, origin: 'null',
        until: ['ready', 'ended', 'refused'],
      }),
      // THE DASHBOARD'S OWN PAGE.
      sameHost: await speakToFrameSocketRaw({
        port: f.dashboard.port, runId: f.runId, token: token as string,
        origin: `http://127.0.0.1:${String(f.dashboard.port)}`,
        until: ['ready', 'ended', 'refused'],
      }),
      // A NON-SANDBOXED PAGE ON ANOTHER ORIGIN — the one shape this rung can honestly refuse.
      hostile: await speakToFrameSocketRaw({
        port: f.dashboard.port, runId: f.runId, token: token as string, origin: HOSTILE_ORIGIN,
        until: ['ready', 'ended', 'refused'], budgetMs: 10_000,
      }),
    }

    const summary = Object.fromEntries(Object.entries(arms).map(([name, reading]) => [name, {
      upgradeStatus: reading.upgradeStatus,
      types: reading.messages.map((message) => message.type),
      note: reading.note ?? null,
    }]))
    const context = `${JSON.stringify(summary)}. ${childContext(f.dashboard)}`

    // THE THREE ALLOWED SHAPES FIRST — they are what makes the refusal below a reading about the
    // rung rather than a reading about a socket that stopped working.
    for (const name of ['absent', 'opaque', 'sameHost'] as const) {
      expect(arms[name].upgradeStatus, `${context} — the ${name} arm's upgrade must be accepted`).toBe(101)
      expect(
        arms[name].messages.some((message) => message.type === 'ready'),
        `${context} — the ${name} arm must reach \`ready\`. The \`opaque\` arm is the LEGITIMATE `
        + 'sandboxed embed: if it breaks, the live preview a person watches breaks with it.',
      ).toBe(true)
    }

    expect(
      arms.hostile.upgradeStatus,
      `${context} — a present, non-\`null\`, cross-host Origin is refused before \`handleUpgrade\`. `
      + 'At HEAD this upgrade was ACCEPTED (101) and answered `ready`.',
    ).not.toBe(101)
    expect(
      arms.hostile.messages.map((message) => message.type),
      `${context} — a refused upgrade has never seen a credential, so it says nothing at all`,
    ).toEqual([])

    // HONEST STANDING, WRITTEN INTO THE CELL SO IT IS NOT MISREAD LATER: the `opaque` arm above is
    // the same shape a SANDBOXED ATTACKER iframe sends, so this rung is not a credential and is not
    // claimed to be one. The credential is the token the `hello` message carries, minted by a door
    // that cells (1)-(4) prove now refuses a cross-site caller.
  }, 120_000)

  it('(6) THE REBIND ARM: a claimed Host this server never agreed to answer to is refused, and the token it would have handed out never leaves', async () => {
    const f = held()
    const port = f.dashboard.port
    const hostileHost = `evil.example:${String(port)}`
    const hostileOrigin = `http://${hostileHost}`
    const allowedHost = `127.0.0.1:${String(port)}`
    const allowedOrigin = `http://${allowedHost}`

    const rebind = await mintRaw(port, f.runId, {
      host: hostileHost,
      origin: hostileOrigin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    })
    const rebindNoSfs = await mintRaw(port, f.runId, {
      host: hostileHost,
      origin: hostileOrigin,
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    })

    // Obtain a real credential through the admitted non-browser path. The hostile socket arm is
    // stronger than the mint arms: even a caller already holding a valid token must not upgrade
    // through a name this loopback-only server never agreed to answer to.
    const admittedRaw = await (await fetch(
      `${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}/live-url`,
    )).text()
    const validToken = (JSON.parse(admittedRaw) as { liveUrl?: string }).liveUrl?.split('#')[1]
    expect(typeof validToken, `the admitted mint answered ${admittedRaw.slice(0, 200)}`).toBe('string')

    const rebindSocket = await speakToFrameSocketRaw({
      port,
      runId: f.runId,
      token: validToken as string,
      host: hostileHost,
      origin: hostileOrigin,
      until: ['ready', 'ended', 'refused'],
      budgetMs: 10_000,
    })

    // ALLOWED TWINS, measured in the same breath. These make every refusal below attributable to
    // the claimed Host rung rather than to an unregistered route or a dead frame socket.
    const allowed = await mintRaw(port, f.runId, {
      host: allowedHost,
      origin: allowedOrigin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    })
    const allowedNoSfs = await mintRaw(port, f.runId, {
      host: allowedHost,
      origin: allowedOrigin,
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    })
    const allowedSocket = await speakToFrameSocketRaw({
      port,
      runId: f.runId,
      token: validToken as string,
      host: allowedHost,
      origin: allowedOrigin,
      until: ['ready', 'ended', 'refused'],
    })

    const reading = {
      rebindStatus: rebind.status,
      rebindAcao: rebind.headers['access-control-allow-origin'] ?? null,
      rebindLiveUrl: liveUrlIn(rebind) === undefined ? null : 'PRESENT',
      rebindBody: rebind.body.slice(0, 200),
      rebindNoSfsStatus: rebindNoSfs.status,
      rebindNoSfsAcao: rebindNoSfs.headers['access-control-allow-origin'] ?? null,
      rebindNoSfsLiveUrl: liveUrlIn(rebindNoSfs) === undefined ? null : 'PRESENT',
      rebindNoSfsBody: rebindNoSfs.body.slice(0, 200),
      rebindUpgradeStatus: rebindSocket.upgradeStatus,
      rebindTypes: rebindSocket.messages.map((message) => message.type),
      allowedStatus: allowed.status,
      allowedLiveUrl: liveUrlIn(allowed) === undefined ? null : 'PRESENT',
      allowedNoSfsStatus: allowedNoSfs.status,
      allowedNoSfsLiveUrl: liveUrlIn(allowedNoSfs) === undefined ? null : 'PRESENT',
      allowedUpgradeStatus: allowedSocket.upgradeStatus,
      allowedTypes: allowedSocket.messages.map((message) => message.type),
    }
    const context = `${JSON.stringify(reading)}. ${childContext(f.dashboard)}`

    expect(reading.allowedStatus, `${context} — the same-origin loopback mint stays admitted`).toBe(200)
    expect(reading.allowedLiveUrl, `${context} — the admitted twin receives a token`).toBe('PRESENT')
    expect(reading.allowedNoSfsStatus, `${context} — the loopback twin without Sec-Fetch-Site stays admitted`)
      .toBe(200)
    expect(reading.allowedNoSfsLiveUrl, `${context} — its token must be present`).toBe('PRESENT')
    expect(reading.allowedUpgradeStatus, `${context} — the loopback frame-socket twin upgrades`).toBe(101)
    expect(reading.allowedTypes, `${context} — the loopback frame-socket twin reaches ready`).toContain('ready')

    expect(
      reading.rebindStatus,
      `${context} — SC-2: a claimed Host this server never agreed to answer to is refused. At HEAD this read 200.`,
    ).toBe(403)
    expect(rebind.body, `${context} — the refusal is typed`).toContain('cross_site_refused')
    expect(reading.rebindAcao, `${context} — the refusal carries no cross-origin read grant`).toBeNull()
    expect(reading.rebindLiveUrl, `${context} — no token leaves through the claimed hostile Host`).toBeNull()

    expect(reading.rebindNoSfsStatus, `${context} — omitting Sec-Fetch-Site must not bypass the Host rung`)
      .toBe(403)
    expect(rebindNoSfs.body, `${context} — the no-Sec-Fetch-Site refusal is typed`)
      .toContain('cross_site_refused')
    expect(reading.rebindNoSfsAcao, `${context} — the no-Sec-Fetch-Site refusal carries no read grant`)
      .toBeNull()
    expect(reading.rebindNoSfsLiveUrl, `${context} — the no-Sec-Fetch-Site arm leaks no token`).toBeNull()

    expect(reading.rebindUpgradeStatus, `${context} — a valid token does not excuse a hostile claimed Host`)
      .not.toBe(101)
    expect(reading.rebindTypes, `${context} — a refused upgrade says nothing at all`).toEqual([])
  }, 120_000)

  it('(7) THE ADMIT SIDE: every name this server DID agree to answer to still mints, and the shape it did not still does not', async () => {
    const f = held()
    const port = f.dashboard.port

    const localhost = await mintRaw(port, f.runId, {
      host: `localhost:${String(port)}`,
      origin: `http://localhost:${String(port)}`,
    })
    const ipv4 = await mintRaw(port, f.runId, {
      host: `127.0.0.1:${String(port)}`,
      origin: `http://127.0.0.1:${String(port)}`,
    })
    const ipv6 = await mintRaw(port, f.runId, {
      host: `[::1]:${String(port)}`,
      origin: `http://[::1]:${String(port)}`,
    })
    const originAbsent = await mintRaw(port, f.runId, {
      host: `localhost:${String(port)}`,
    })
    // Node's HTTP parser rejects an HTTP/1.1 request without Host before the route runs. HTTP/1.0
    // is the one protocol shape where omission is valid, so it measures the application rung.
    const hostAbsent = await mintRaw(port, f.runId, { host: undefined }, '1.0')

    const reading = {
      localhostStatus: localhost.status,
      localhostLiveUrl: liveUrlIn(localhost) === undefined ? null : 'PRESENT',
      ipv4Status: ipv4.status,
      ipv4LiveUrl: liveUrlIn(ipv4) === undefined ? null : 'PRESENT',
      ipv6Status: ipv6.status,
      ipv6LiveUrl: liveUrlIn(ipv6) === undefined ? null : 'PRESENT',
      originAbsentStatus: originAbsent.status,
      originAbsentLiveUrl: liveUrlIn(originAbsent) === undefined ? null : 'PRESENT',
      hostAbsentStatus: hostAbsent.status,
      hostAbsentLiveUrl: liveUrlIn(hostAbsent) === undefined ? null : 'PRESENT',
      hostAbsentBody: hostAbsent.body.slice(0, 200),
    }
    const context = `${JSON.stringify(reading)}. ${childContext(f.dashboard)}`

    for (const [name, status, liveUrl] of [
      ['localhost', reading.localhostStatus, reading.localhostLiveUrl],
      ['127.0.0.1', reading.ipv4Status, reading.ipv4LiveUrl],
      ['[::1]', reading.ipv6Status, reading.ipv6LiveUrl],
      ['the Origin-absent local client', reading.originAbsentStatus, reading.originAbsentLiveUrl],
    ] as const) {
      expect(status, `${context} — ${name} remains an admitted claimed Host`).toBe(200)
      expect(liveUrl, `${context} — ${name} receives a real token`).toBe('PRESENT')
    }

    expect(reading.hostAbsentStatus, `${context} — an unstated Host cannot be validated`).toBe(403)
    expect(hostAbsent.body, `${context} — the absent-Host refusal is typed`)
      .toContain('cross_site_refused')
    expect(reading.hostAbsentLiveUrl, `${context} — the absent Host leaks no token`).toBeNull()
  }, 120_000)
})

// Its own dashboard: an editor session builds its planner at creation, so a model is declared.

const EDITOR_MODEL_NAME = 'cross-site-stub'
/** Nothing listens here; the stub model is constructed and never called. */
const EDITOR_MODEL_BASE_URL = 'http://127.0.0.1:9/v1'
/** An id no session holds. */
const UNHELD_SESSION_ID = 'no-such-session'

/**
 * The browsers root the child is handed, so its hermetic `HOME` does not hide the installed
 * Chromium (the populated-run fixture's reasoning). Playwright's own resolver answers; an explicit
 * `PLAYWRIGHT_BROWSERS_PATH` in this process wins.
 */
function playwrightBrowsersRoot(): string | undefined {
  const declared = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (declared !== undefined && declared.trim() !== '') return declared
  let current: string
  try {
    current = dirname(chromium.executablePath())
  } catch {
    return undefined
  }
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return undefined
    if (basename(current).startsWith('chromium')) return parent
    current = parent
  }
}

interface EditorFixture {
  readonly dashboard: ReadySpawnedDashboard
  readonly sessionId: string
}

let editorFixture: EditorFixture | undefined

function editorHeld(): EditorFixture {
  if (editorFixture === undefined) throw new Error('the live-editor cross-site fixture never came up')
  return editorFixture
}

interface ControlSocketReading {
  /** `101` is an accepted upgrade; `0` means the door hung up before any status line. */
  readonly upgradeStatus: number
  /** The close code the server sent after accepting, if it sent one. */
  readonly closeCode: number | undefined
  readonly note?: string
}

/** One control-socket upgrade with EXACTLY the Origin the cell states (`undefined`: none at all). */
function upgradeControlSocketRaw(input: {
  readonly port: number
  readonly sessionId: string
  readonly origin?: string
  readonly budgetMs?: number
}): Promise<ControlSocketReading> {
  return new Promise<ControlSocketReading>((settle) => {
    const socket = connect(input.port, '127.0.0.1')
    let head = ''
    let upgradeStatus = 0
    let upgraded = false
    let closeCode: number | undefined
    let pending = Buffer.alloc(0)
    let settled = false
    const finish = (note?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(budget)
      socket.destroy()
      settle({ upgradeStatus, closeCode, ...(note === undefined ? {} : { note }) })
    }
    const budget = setTimeout(() => finish('no answer within the cell budget'), input.budgetMs ?? 10_000)
    socket.on('error', (error: Error) => finish(error.message))
    socket.on('close', () => finish('the door hung up'))
    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        head += chunk.toString('latin1')
        const split = head.indexOf('\r\n\r\n')
        if (split === -1) return
        upgradeStatus = Number.parseInt(head.split('\r\n')[0]?.split(' ')[1] ?? '', 10)
        if (!Number.isInteger(upgradeStatus)) upgradeStatus = 0
        if (upgradeStatus !== 101) { finish(`the upgrade was answered ${String(upgradeStatus)}`); return }
        upgraded = true
        pending = Buffer.from(head.slice(split + 4), 'latin1')
      } else {
        pending = Buffer.concat([pending, chunk])
      }
      // A server close frame: FIN + opcode 8, unmasked, a two-byte code first.
      if (pending.length >= 4 && ((pending[0] ?? 0) & 0x0f) === 0x8) {
        closeCode = pending.readUInt16BE(2)
        finish()
      }
    })
    socket.on('connect', () => {
      const headers: Record<string, string> = {
        host: `127.0.0.1:${String(input.port)}`,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
      }
      if (input.origin !== undefined) headers.origin = input.origin
      socket.write(
        `GET /api/live-editor/ws?sessionId=${encodeURIComponent(input.sessionId)} HTTP/1.1\r\n`
        + Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')
        + '\r\n',
      )
    })
  })
}

function editorMintPath(sessionId: string): string {
  return `/api/live-editor/sessions/${encodeURIComponent(sessionId)}/live-url`
}

describe('the live-editor surface refuses a cross-site caller', () => {
  beforeAll(async () => {
    const project = runServiceFixtureProject('live-editor-cross-site')
    const config = JSON.parse(readFileSync(project.configPath, 'utf8')) as Record<string, unknown>
    const registry = (config.registry ?? {}) as Record<string, unknown>
    config.registry = {
      ...registry,
      llms: [{
        name: EDITOR_MODEL_NAME,
        provider: 'openai-compatible',
        model: 'stub-model',
        baseURL: EDITOR_MODEL_BASE_URL,
      }],
    }
    config.use = { ...((config.use ?? {}) as Record<string, unknown>), llm: EDITOR_MODEL_NAME }
    writeFileSync(project.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    const browsersRoot = playwrightBrowsersRoot()
    const dashboard = await spawnDashboard(
      project.root,
      project.configPath,
      60_000,
      browsersRoot === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: browsersRoot },
    )
    // Held before any assertion, so afterAll stops the child even if session creation fails.
    editorFixture = { dashboard, sessionId: '' }
    expect(
      dashboard.ready,
      `the built \`agent-qa dashboard\` never reported that it was listening. ${childContext(dashboard)}`,
    ).toBe(true)

    // A plain node `fetch`: no Origin, the non-browser caller the guard admits.
    const created = await fetch(`${dashboard.origin}/api/live-editor/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'web', headless: true }),
    })
    const createdBody = await created.text()
    expect(created.status, `the session door refused: ${createdBody}. ${childContext(dashboard)}`).toBe(201)
    const sessionId = (JSON.parse(createdBody) as { sessionId?: string }).sessionId
    expect(typeof sessionId, `the create answer named no session: ${createdBody}`).toBe('string')
    editorFixture = { dashboard, sessionId: sessionId as string }
  }, 180_000)

  afterAll(async () => {
    const open = editorFixture
    editorFixture = undefined
    if (open === undefined) return
    if (open.sessionId !== '') {
      await fetch(`${open.dashboard.origin}/api/live-editor/sessions/${encodeURIComponent(open.sessionId)}`, {
        method: 'DELETE',
      }).then(async (response) => response.text()).catch(() => undefined)
    }
    await open.dashboard.stop()
  }, 60_000)

  it('(8) the control socket\'s upgrade (live-editor surface): absent and same-host Origins admitted, null and foreign destroyed', async () => {
    const f = editorHeld()
    const port = f.dashboard.port
    const arms = {
      // THE ALLOWED SHAPES FIRST, as in cell (5): a non-browser client with no Origin at all …
      absent: await upgradeControlSocketRaw({ port, sessionId: UNHELD_SESSION_ID }),
      // … and the dashboard's own page.
      sameHost: await upgradeControlSocketRaw({
        port, sessionId: UNHELD_SESSION_ID, origin: `http://127.0.0.1:${String(port)}`,
      }),
      // UNLIKE THE FRAME SOCKET, the literal `null` is refused: this socket has no sandboxed embed.
      opaque: await upgradeControlSocketRaw({ port, sessionId: UNHELD_SESSION_ID, origin: 'null' }),
      hostile: await upgradeControlSocketRaw({ port, sessionId: UNHELD_SESSION_ID, origin: HOSTILE_ORIGIN }),
    }
    const context = `${JSON.stringify(arms)}. ${childContext(f.dashboard)}`

    for (const name of ['absent', 'sameHost'] as const) {
      expect(arms[name].upgradeStatus, `${context} — the ${name} arm's upgrade is accepted`).toBe(101)
      expect(
        arms[name].closeCode,
        `${context} — the ${name} arm is closed by name for an id no session holds`,
      ).toBe(4404)
    }
    for (const name of ['opaque', 'hostile'] as const) {
      expect(
        arms[name].upgradeStatus,
        `${context} — the ${name} arm is destroyed before any status line`,
      ).toBe(0)
      expect(arms[name].closeCode, `${context} — a destroyed upgrade sends no close frame`).toBeUndefined()
    }
  }, 60_000)

  it('(9) every live-editor door and the editor mint (live-editor surface): a foreign Origin is refused 403 with no Access-Control-Allow-Origin', async () => {
    const f = editorHeld()
    const port = f.dashboard.port
    const hostileHeaders = {
      origin: HOSTILE_ORIGIN,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    }
    const doors = [
      { name: 'POST /api/live-editor/sessions', method: 'POST', path: '/api/live-editor/sessions', body: '{}' },
      { name: 'GET /api/live-editor/sessions', method: 'GET', path: '/api/live-editor/sessions' },
      {
        name: 'DELETE /api/live-editor/sessions/:id',
        method: 'DELETE',
        path: `/api/live-editor/sessions/${UNHELD_SESSION_ID}`,
      },
      {
        name: 'POST /api/live-editor/sessions/:id/auth-state',
        method: 'POST',
        path: `/api/live-editor/sessions/${UNHELD_SESSION_ID}/auth-state`,
        body: '{"name":"probe"}',
      },
      { name: 'GET /api/live-editor/sessions/:id/live-url', method: 'GET', path: editorMintPath(f.sessionId) },
    ] as const

    const readings: Record<string, unknown>[] = []
    for (const door of doors) {
      const hostile = await rawRequest(port, {
        method: door.method,
        path: door.path,
        headers: { ...hostileHeaders, ...('body' in door ? { 'content-type': 'application/json' } : {}) },
        ...('body' in door ? { body: door.body } : {}),
      })
      // THE ALLOWED TWIN, in the same breath: the same door with no Origin reaches past the guard.
      // Its POST twins carry a body the route refuses on its own terms (malformed JSON), so no
      // session is created or changed by a twin.
      const twin = await rawRequest(port, {
        method: door.method,
        path: door.path,
        ...('body' in door ? { headers: { 'content-type': 'application/json' }, body: 'not json' } : {}),
      })
      readings.push({
        door: door.name,
        hostileStatus: hostile.status,
        hostileAcao: hostile.headers['access-control-allow-origin'] ?? null,
        hostileBody: hostile.body.slice(0, 120),
        twinStatus: twin.status,
        twinAcao: twin.headers['access-control-allow-origin'] ?? null,
        // A twin that minted carries a credential: the reading says so and never prints it.
        twinBody: liveUrlIn(twin) === undefined ? twin.body.slice(0, 120) : '<a liveUrl, withheld>',
      })
    }
    const context = `${JSON.stringify(readings)}. ${childContext(f.dashboard)}`

    for (const reading of readings) {
      expect(reading.twinStatus, `${context} — ${String(reading.door)}: the twin is answered`).not.toBe(0)
      expect(
        reading.twinStatus,
        `${context} — ${String(reading.door)}: the twin reaches past the guard`,
      ).not.toBe(403)
      expect(reading.twinAcao, `${context} — ${String(reading.door)}: no wildcard grant on the twin`).toBeNull()

      expect(reading.hostileStatus, `${context} — ${String(reading.door)}: refused by name`).toBe(403)
      expect(String(reading.hostileBody), `${context} — ${String(reading.door)}: the typed refusal`)
        .toContain('cross_site_refused')
      expect(reading.hostileAcao, `${context} — ${String(reading.door)}: no read grant on the refusal`)
        .toBeNull()
      expect(String(reading.hostileBody), `${context} — ${String(reading.door)}: no token leaves`)
        .not.toContain('v2.')
    }
  }, 60_000)

  it('(10) the same-origin editor mint (live-editor surface) answers 200 with no Access-Control-Allow-Origin, and a page on another origin cannot read it', async () => {
    const f = editorHeld()
    const port = f.dashboard.port
    const sameOrigin = await rawRequest(port, {
      method: 'GET',
      path: editorMintPath(f.sessionId),
      headers: {
        origin: f.dashboard.origin,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    })
    const sameOriginContext = `status=${String(sameOrigin.status)} body=${sameOrigin.body.slice(0, 200)} `
      + `note=${sameOrigin.note ?? 'none'}. ${childContext(f.dashboard)}`
    expect(sameOrigin.status, `${sameOriginContext} — the dashboard's own page mints`).toBe(200)
    const result = EditorLiveUrlResultSchema.parse(JSON.parse(sameOrigin.body))
    expect(result.liveUrl, `${sameOriginContext} — a real token, in the fragment`).toMatch(/^http.*#v2\./u)
    expect(
      sameOrigin.headers['access-control-allow-origin'] ?? null,
      `${sameOriginContext} — the admitted answer stamps no cross-origin read grant`,
    ).toBeNull()

    if (browser === undefined) {
      try {
        browser = await chromium.launch({ headless: true })
      } catch (error) {
        throw new Error(
          `${BROWSER_INSTALL_INSTRUCTION} underlying error: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const dash = `http://127.0.0.1:${String(port)}`
    // The control is the `no-cors` liveness read of cell (2).
    const controlUrl = `${dash}/api/stats`
    const mintUrl = `${dash}${editorMintPath(f.sessionId)}`
    const html = `<!doctype html><meta charset="utf-8"><title>second origin</title><body><script>
      window.__reading = { phase: 'pending' };
      (async () => {
        const reading = { phase: 'done', control: null, controlError: null, target: null, targetError: null };
        try {
          const response = await fetch(${JSON.stringify(controlUrl)}, { mode: 'no-cors' });
          reading.control = { type: response.type };
        } catch (error) { reading.controlError = String(error); }
        try {
          const response = await fetch(${JSON.stringify(mintUrl)});
          reading.target = { status: response.status, bodyHead: (await response.text()).slice(0, 300) };
        } catch (error) { reading.targetError = String(error); }
        window.__reading = reading;
      })();
    </script></body>`
    const { server: attacker, port: attackerPort } = await serveAttackerPage(html)

    interface PageReading {
      control: { type: string } | null
      controlError: string | null
      target: { status: number; bodyHead: string } | null
      targetError: string | null
    }

    const arms: (PageReading & { arm: number })[] = []
    try {
      // k=5, the house rule for a real-Chromium cell (cell (2)).
      for (let k = 0; k < 5; k += 1) {
        const page = await browser.newPage()
        try {
          await page.goto(`http://127.0.0.1:${String(attackerPort)}/`, { waitUntil: 'load', timeout: 30_000 })
          await page.waitForFunction(
            () => (window as unknown as { __reading: { phase: string } }).__reading.phase === 'done',
            undefined,
            { timeout: 30_000 },
          )
          const reading = await page.evaluate(
            () => (window as unknown as { __reading: unknown }).__reading,
          ) as PageReading
          arms.push({ arm: k + 1, ...reading })
        } finally {
          await page.close().catch(() => undefined)
        }
      }
    } finally {
      await new Promise<void>((closed) => attacker.close(() => closed()))
    }

    for (const reading of arms) {
      const context = `arm ${String(reading.arm)} of 5: ${JSON.stringify(reading)}. ${childContext(f.dashboard)}`
      expect(reading.control?.type, `${context} — THE CONTROL: the page reaches the dashboard at all`)
        .toBe('opaque')
      expect(reading.controlError, `${context} — the control got an answer`).toBeNull()
      expect(
        (reading.target?.bodyHead ?? '').includes('liveUrl'),
        `${context} — a page on another origin must not obtain an editor liveUrl`,
      ).toBe(false)
      expect(
        reading.targetError !== null || reading.target?.status === 403,
        `${context} — the mint is unreadable to this document, or refused by name with 403`,
      ).toBe(true)
    }
  }, 300_000)
})
