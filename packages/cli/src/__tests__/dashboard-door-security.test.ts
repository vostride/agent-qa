// The fourth door's security posture, DRIVEN (Phase 400 plan 14, verification gaps 6 and 7).
//
// WHY EVERY CELL BELOW OPENS A SOCKET. The phase's shipped CORS corpus asserted that a response
// carried no `Access-Control-Allow-Origin`. That is an assertion about what an attacker gets to
// READ, and the threat is what an attacker gets to DO: a CORS simple request needs no preflight,
// so a 204-no-grant OPTIONS arm never runs, the browser sends the POST anyway, and the action
// executes. Withholding the reply header hides the answer and not the side effect. So no cell here
// asserts a header alone: every REJECTS cell measures the SIDE-EFFECT SURFACE — whether the request
// reached the composed host at all — around a request written byte-by-byte onto a real socket.
//
// RAW SOCKETS RATHER THAN `fetch`, for two reasons that are both load-bearing. `fetch` normalises
// a path, and gap 7's probe is a request target (`//`) that no URL builder will hand to a server.
// And `Origin` is a forbidden header name in a browser, so a corpus that could only set the headers
// `fetch` permits could not state the attacker's request at all.
//
// ACCEPTS CONTROLS ARE NOT OPTIONAL HERE. A REJECTS-only corpus is green against a door that
// refuses everything, which is a door nobody can use. The two axes the policy allows — a
// same-origin browser drive and an Origin-less local drive — are pinned SEPARATELY, so a fix that
// closed either one reds a cell.
//
// 430 (2026-09-28): the cross-site corpus was driven on the run-confirm pair.
//
// 432-14 (2026-10-01, D-13/D-14): the run-confirm pair is deleted, and with it the router whose
// method-level guards this corpus measured. The same-site refusal survives on every mutating route
// that had one, so the corpus moves to them and is driven through the SHIPPED server
// (`startServer` over the composed host): the mark door, which is the dashboard's own mark
// control, and the credential and editor doors, which refuse before they touch anything. Each
// cell below says which of its claims moved and which retired with the router.
//
// 430 D-02 (2026-09-28): 7a (the session-id route) and 7b-i (the turn's fold guard) are deleted
// with the routes they drove. The generic 404 those paths now answer is carried by
// C430-DELETED-CHAT-ROUTES-SHARED-404 and process survival's s5.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { RUNS_MARK_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { DashboardDatabase, startServer, type AgentHost } from '@vostride/agent-qa-dashboard'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { composeDashboardDoor } from '../commands/dashboard.js'

/** The cross-origin an attacker's page is served from — the verifier's own probe value. */
const HOSTILE_ORIGIN = 'https://evil.example'

/** The run the mark door is driven against. Not recorded, so the op answers `run-not-found`. */
const MARKED_RUN = 'run-432-14-door-security'
const MARK_PATH = `/api/runs/${MARKED_RUN}/mark`
const MARK_BODY = JSON.stringify({ kind: 'false-fail', note: 'door security' })

/** A run row the dashboard's own run read serves, so gap 7's synchronous read arm has a subject. */
const READ_RUN = 'run-432-14-read'

// ---- the fixture project -------------------------------------------------------------------

/** The `surface-dispatch.ts` fixture project, verbatim in shape (see the door cell's own note). */
function fixtureWorkspace(secrets = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-400-14-'))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(join(root, '.env.secrets.local'), secrets, 'utf8')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      registry: {
        targets: {
          conformance: { platform: 'web', url: 'https://conformance.invalid' },
        },
      },
    })}\n`,
    'utf8',
  )
  return configPath
}

interface DoorFixture {
  readonly origin: string
  readonly port: number
  readonly configRoot: string
  readonly configPath: string
  readonly host: LocalAgentHost
  /** Every op id the composed host was asked to dispatch, in order — the side-effect surface. */
  readonly invocations: string[]
  close(): Promise<void>
}

const openDoors: DoorFixture[] = []

/**
 * The door as `agent-qa dashboard` composes it, served by the shipped `startServer`.
 *
 * `wrapHost` exists for gap 7's backstop cells and nothing else: it composes the SHIPPED host and
 * then replaces exactly one of its members with a throwing one, which is how a fault is injected
 * at a seam the product really has rather than by standing up a lookalike door.
 */
async function openDoor(options: {
  readonly wrapHost?: (host: AgentHost) => AgentHost
  readonly secrets?: string
} = {}): Promise<DoorFixture> {
  const configPath = fixtureWorkspace(options.secrets)
  const configRoot = dirname(resolve(configPath))
  let boundOrigin: string | undefined
  const { host, agentHost, declaredSecretMask } = composeDashboardDoor({
    agentQaRoot: join(configRoot, '.agent-qa'),
    configPath,
    boundOrigin: () => boundOrigin,
  })
  const invocations: string[] = []
  const counted: AgentHost = {
    ...agentHost,
    invokeFunction: (registry, functionId, input, caller) => {
      invocations.push(functionId)
      return agentHost.invokeFunction(registry, functionId, input, caller)
    },
  }
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  db.insertRun({
    id: READ_RUN, name: 'read', filePath: 'tests/read.test.yaml', status: 'failed', duration: 1,
    startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:00:01.000Z',
  })
  const signals = ['SIGINT', 'SIGTERM'] as const
  const before = signals.map((signal) => new Set(process.listeners(signal)))
  const started = await startServer({
    declaredSecretMask,
    db,
    port: 0,
    // 2026-10-03 (quick-261003-tsr, WR-07): the fixture's own config, so the config and undo arms
    // write a temporary file rather than one resolved from the test's working directory.
    configPath,
    agentHost: options.wrapHost === undefined ? counted : options.wrapHost(counted),
  })
  const owned = signals.map((signal, index) =>
    process.listeners(signal).filter((listener) => !before[index]!.has(listener)))
  const address = started.server.address()
  if (address === null || typeof address === 'string') throw new TypeError('the door bound no port')
  boundOrigin = `http://127.0.0.1:${String(address.port)}`
  const fixture: DoorFixture = {
    origin: boundOrigin,
    port: address.port,
    configRoot,
    configPath,
    host,
    invocations,
    close: async () => {
      started.close()
      signals.forEach((signal, index) => {
        for (const listener of owned[index]!) process.removeListener(signal, listener)
      })
      await host.close()
      rmSync(configRoot, { recursive: true, force: true })
    },
  }
  openDoors.push(fixture)
  return fixture
}

afterEach(async () => {
  while (openDoors.length > 0) await openDoors.pop()!.close()
})

// ---- the raw HTTP client -------------------------------------------------------------------

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

function parseRaw(raw: string): RawResponse {
  if (raw === '') return noResponse('the socket closed without a single byte')
  const split = raw.indexOf('\r\n\r\n')
  const head = split === -1 ? raw : raw.slice(0, split)
  const body = split === -1 ? '' : raw.slice(split + 4)
  const lines = head.split('\r\n')
  const status = Number.parseInt(lines[0]?.split(' ')[1] ?? '', 10)
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at === -1) continue
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return {
    status: Number.isInteger(status) ? status : 0,
    headers,
    body: headers['transfer-encoding'] === 'chunked' ? dechunk(body) : body,
  }
}

/** A writer that sets no Content-Length answers chunked; the chunk framing is not the body. */
function dechunk(framed: string): string {
  let out = ''
  let rest = framed
  for (;;) {
    const lineEnd = rest.indexOf('\r\n')
    if (lineEnd === -1) return out
    const size = Number.parseInt(rest.slice(0, lineEnd), 16)
    if (!Number.isFinite(size) || size === 0) return out
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size)
    rest = rest.slice(lineEnd + 2 + size + 2)
  }
}

/**
 * One request, written onto a socket exactly as given.
 *
 * The PATH IS NOT PARSED and the HEADERS ARE NOT FILTERED. That is the whole point: `//` and
 * `Origin: https://evil.example` are both things a URL builder or a browser-shaped client would
 * refuse to produce, and both are what the attacker sends.
 */
function rawRequest(
  port: number,
  init: {
    readonly method: string
    readonly path: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly budgetMs?: number
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
        headers[key.toLowerCase()] = value
      }
      if (init.body !== undefined) {
        headers['content-length'] = String(Buffer.byteLength(init.body))
      }
      socket.write(
        `${init.method} ${init.path} HTTP/1.1\r\n`
        + Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')
        + '\r\n'
        + (init.body ?? ''),
      )
    })
  })
}

/** A mark, driven with whatever headers the cell wants to state. */
function driveMark(
  port: number,
  headers: Readonly<Record<string, string>>,
  body: string = MARK_BODY,
): Promise<RawResponse> {
  return rawRequest(port, { method: 'POST', path: MARK_PATH, headers, body })
}

const sameOrigin = (door: DoorFixture): string => `http://127.0.0.1:${String(door.port)}`

// ---- the side-effect surface ---------------------------------------------------------------

/** One arm's own side-effect surface, read before and after a refused drive. */
interface SeamReading {
  readonly seam: string
  readonly before: string
  readonly after: string
}

/**
 * The whole REJECTS assertion, in one place so no cell can quietly assert less than its siblings.
 *
 * STATUS IS THE WEAKEST OF THESE and it is deliberately not alone: a door that answered 403 and
 * acted anyway would pass a status-only cell. The side effect a mark has is its dispatch, so the
 * surface measured is whether the composed host was asked to do anything at all. An arm that
 * writes past the host (a file, a credential, a provider request) passes its own seam reading too
 * (2026-10-03, quick-261003-tsr WR-07).
 */
function expectNoSideEffect(
  label: string,
  door: DoorFixture,
  response: RawResponse,
  expectedStatus: number,
  reading?: { readonly invocationsBefore: number; readonly seam: SeamReading },
): void {
  expect(response.status, `${label}: the door answered ${String(response.status)} ${response.note ?? ''}`)
    .toBe(expectedStatus)
  expect(response.body, `${label}: a refusal carries no receipt`).not.toContain('receipt')
  expect(response.body, `${label}: a refusal carries the op's answer`).not.toContain('run-not-found')
  expect(door.invocations.slice(reading?.invocationsBefore ?? 0), `${label}: the refused drive reached the composed host`)
    .toEqual([])
  if (reading !== undefined) {
    expect(reading.seam.after, `${label}: the refused drive changed ${reading.seam.seam}`)
      .toBe(reading.seam.before)
  }
}

/** The ACCEPTS half: the mark was dispatched exactly once and the op's own answer came back. */
function expectDispatchedOnce(label: string, door: DoorFixture, response: RawResponse): void {
  expect(response.status, `${label}: the admitted mark was refused ${response.note ?? ''}`).toBe(200)
  expect(JSON.parse(response.body)).toEqual({ kind: 'run-not-found', runId: MARKED_RUN })
  expect(door.invocations).toEqual([RUNS_MARK_FUNCTION_ID])
}

// ---- the retained same-site arms, each with its own side-effect seam -----------------------
//
// 2026-10-03 (quick-261003-tsr, WR-07): 6g used to measure only `door.invocations`, which six of
// these seven arms never cross, and drove them with a mark body none of them could act on. Each arm
// now names the seam it writes through, is driven with a body it WOULD act on, and has a same-origin
// control showing that body acts. The live-editor arm is the one that cannot be driven to its write
// here (an admitted create starts a browser), so its control stops at the create's next refusal past
// the cross-site check, before any session, and its seam is the session list.

/** The machine-wide credential name the credential, move and delete arms act on. */
const PROBE_CREDENTIAL = 'door-probe'
const MOVED_CREDENTIAL = 'door-probe-moved'

/** Everything the arm probes need beyond the door: a private auth store and a provider sink. */
interface ArmScene {
  readonly door: DoorFixture
  readonly authFile: string
  readonly providerHits: () => number
  readonly providerBaseUrl: string
}

interface SameSiteArm {
  readonly method: 'POST' | 'DELETE'
  readonly path: string
  readonly seam: string
  /** Puts the state the arm acts on in place; returns the body to drive with. */
  readonly arrange: (scene: ArmScene) => Promise<string | undefined>
  readonly read: (scene: ArmScene) => Promise<string>
  /** The same-origin control: the identical request acts, and the seam shows it. */
  readonly admitted: (scene: ArmScene, response: RawResponse, before: string) => Promise<void>
}

function authStoreText(scene: ArmScene): Promise<string> {
  return Promise.resolve(existsSync(scene.authFile) ? readFileSync(scene.authFile, 'utf8') : '<absent>')
}

function authNames(scene: ArmScene): string[] {
  return existsSync(scene.authFile)
    ? Object.keys(JSON.parse(readFileSync(scene.authFile, 'utf8')) as Record<string, unknown>).sort()
    : []
}

const sameSiteJson = (door: DoorFixture): Record<string, string> => ({
  'content-type': 'application/json',
  origin: sameOrigin(door),
})

const RETAINED_SAME_SITE_ARMS: readonly SameSiteArm[] = [
  {
    method: 'POST',
    path: MARK_PATH,
    seam: 'the composed host\'s dispatch log',
    arrange: () => Promise.resolve(MARK_BODY),
    read: ({ door }) => Promise.resolve(JSON.stringify(door.invocations)),
    admitted: async ({ door }, response) => { expectDispatchedOnce('6g', door, response) },
  },
  {
    method: 'POST',
    path: '/api/config/undo',
    seam: 'the config file',
    arrange: async ({ door }) => {
      const changed = await rawRequest(door.port, {
        method: 'PATCH',
        path: '/api/config',
        headers: sameSiteJson(door),
        body: JSON.stringify({
          undoable: true,
          changes: [{ op: 'set', path: ['use', 'mobile', 'appState'], value: 'preserve' }],
        }),
      })
      expect(changed.status, `6g arrange: the undoable config write failed: ${changed.body}`).toBe(200)
      const { undo } = JSON.parse(changed.body) as { undo: { token: string } }
      return JSON.stringify({ token: undo.token })
    },
    read: ({ door }) => Promise.resolve(readFileSync(door.configPath, 'utf8')),
    admitted: async ({ door }, response) => {
      expect(response.status, `6g /api/config/undo: the same-origin Undo was refused: ${response.body}`).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ restored: true })
      const restored = parseYaml(readFileSync(door.configPath, 'utf8')) as { use: { mobile: { appState: string } } }
      expect(restored.use.mobile.appState, 'the token the refused drives carried was spent').toBe('reset')
    },
  },
  {
    method: 'POST',
    path: '/api/live-editor/sessions',
    seam: 'the live-editor session list',
    arrange: () => Promise.resolve(JSON.stringify({ platform: 'web', targetName: 'conformance' })),
    read: async ({ door }) => {
      const listed = await rawRequest(door.port, {
        method: 'GET', path: '/api/live-editor/sessions', headers: { origin: sameOrigin(door) },
      })
      expect(listed.status, `the session list did not answer: ${listed.body}`).toBe(200)
      return listed.body
    },
    admitted: async (scene, response, before) => {
      // Past the cross-site check, the create answers its next refusal: the fixture declares no model.
      expect(response.status, `6g /api/live-editor/sessions: ${response.body}`).toBe(400)
      const { error } = JSON.parse(response.body) as { error: string }
      expect(error).not.toBe('cross_site_refused')
      expect(error).toContain('LLM not configured')
      expect(await RETAINED_SAME_SITE_ARMS[2]!.read(scene)).toBe(before)
    },
  },
  {
    method: 'POST',
    path: '/api/auth/credential',
    seam: 'auth.json',
    arrange: () => Promise.resolve(JSON.stringify({
      configName: PROBE_CREDENTIAL, provider: 'openai-compatible', type: 'api-key', secret: 'sk-door-probe',
    })),
    read: authStoreText,
    admitted: async (scene, response) => {
      expect(response.status, `6g /api/auth/credential: ${response.body}`).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ saved: true, created: true })
      expect(authNames(scene)).toEqual([PROBE_CREDENTIAL])
    },
  },
  {
    method: 'POST',
    path: '/api/auth/credential/move',
    seam: 'auth.json',
    arrange: () => Promise.resolve(JSON.stringify({
      from: PROBE_CREDENTIAL, to: MOVED_CREDENTIAL, provider: 'openai-compatible',
    })),
    read: authStoreText,
    admitted: async (scene, response) => {
      expect(response.status, `6g /api/auth/credential/move: ${response.body}`).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ moved: true })
      expect(authNames(scene)).toEqual([MOVED_CREDENTIAL])
    },
  },
  {
    method: 'POST',
    path: '/api/llm/test',
    seam: 'the provider endpoint',
    arrange: (scene) => Promise.resolve(JSON.stringify({
      configName: 'door-llm-probe', provider: 'openai-compatible', model: 'door-probe', baseURL: scene.providerBaseUrl,
    })),
    read: (scene) => Promise.resolve(`${String(scene.providerHits())} provider request(s)`),
    admitted: async (scene, response) => {
      expect(response.status, `6g /api/llm/test: ${response.body}`).toBe(200)
      expect(scene.providerHits(), 'the admitted connection test never reached the provider').toBeGreaterThan(0)
    },
  },
  {
    method: 'DELETE',
    path: `/api/auth/${MOVED_CREDENTIAL}`,
    seam: 'auth.json',
    arrange: () => Promise.resolve(undefined),
    read: authStoreText,
    admitted: async (scene, response) => {
      expect(response.status, `6g DELETE /api/auth: ${response.body}`).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ deleted: true })
      expect(authNames(scene)).toEqual([])
    },
  },
]

/** A loopback provider that counts what reaches it and answers every request 401. */
async function openProviderSink(): Promise<{ readonly baseUrl: string; hits(): number; close(): Promise<void> }> {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'door probe', type: 'invalid_request_error' } }))
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    hits: () => hits,
    close: () => new Promise<void>((closed) => {
      server.closeAllConnections()
      server.close(() => closed())
    }),
  }
}

// ---- gap 6: the cross-origin drive ---------------------------------------------------------

describe('the fourth door refuses a cross-origin drive before anything happens (gap 6)', () => {
  it('6a — refuses the CORS simple request, before the mark reaches the host', async () => {
    const door = await openDoor()
    // THE VERIFIER'S EXACT PROBE, on the mark door. `text/plain;charset=UTF-8` with a JSON body
    // is a CORS SIMPLE request: no preflight is sent, and an unguarded route would record a mark
    // on the person's machine.
    const answered = await driveMark(door.port, {
      'content-type': 'text/plain;charset=UTF-8',
      origin: HOSTILE_ORIGIN,
    })
    expectNoSideEffect('6a', door, answered, 403)
  })

  it('6b — refuses a cross-origin drive that declares application/json (the Origin leg alone)', async () => {
    const door = await openDoor()
    const answered = await driveMark(door.port, {
      'content-type': 'application/json',
      origin: HOSTILE_ORIGIN,
    })
    expectNoSideEffect('6b', door, answered, 403)
  })

  // RE-SPELLED 2026-10-01 (432-14): was 'refuses a text/plain drive bearing no Origin at all (the
  // Content-Type leg alone)'. The media-type leg belonged to the run-confirm router and was deleted
  // with it; no surviving door has one. A browser always sends `Origin` on a cross-origin POST, so
  // a request with none is a local client, and the mark door admits it exactly once.
  it('6c — admits a text/plain drive bearing no Origin at all as a local client, exactly once', async () => {
    const door = await openDoor()
    const answered = await driveMark(door.port, { 'content-type': 'text/plain;charset=UTF-8' })
    expectDispatchedOnce('6c', door, answered)
  })

  it('6d — ACCEPTS the same-origin browser drive, which dispatches the mark once', async () => {
    const door = await openDoor()
    // The dashboard's own page, marking on its own door: `Origin` equals the request's `Host`
    // origin, which is what a browser sends on a same-origin POST.
    const answered = await driveMark(door.port, {
      'content-type': 'application/json',
      origin: sameOrigin(door),
    })
    expectDispatchedOnce('6d', door, answered)
  })

  it('6e — ACCEPTS the Origin-less local drive (curl and local tooling, the recorded policy)', async () => {
    const door = await openDoor()
    // A SEPARATE AXIS from 6d and not a repetition of it: 6d varies the Origin's VALUE, this one
    // varies its PRESENCE. A guard that required an Origin would pass 6d and fail here, and it
    // would have bricked every scripted drive against a localhost door.
    const answered = await driveMark(door.port, { 'content-type': 'application/json' })
    expectDispatchedOnce('6e', door, answered)
  })

  // RE-SPELLED 2026-10-01 (432-14): was 'refuses a cross-origin answer to somebody else's
  // outstanding run confirm'. There is no outstanding question to spend. The claim that survives is
  // that the refusal is about the ORIGIN and never about the body: the byte-identical request is
  // refused from another origin and accepted from the door's own.
  it('6f — refuses a cross-origin mark, and the identical request from the page itself dispatches', async () => {
    const door = await openDoor()
    const refused = await driveMark(door.port, {
      'content-type': 'application/json',
      origin: HOSTILE_ORIGIN,
    })
    expectNoSideEffect('6f', door, refused, 403)

    const accepted = await driveMark(door.port, {
      'content-type': 'application/json',
      origin: sameOrigin(door),
    })
    expectDispatchedOnce('6f', door, accepted)
  })

  // RE-SPELLED 2026-10-01 (432-14): was 'refuses EVERY mutating route the router's own table
  // declares'. The table was the run-confirm router's and is deleted. The shipped router has no
  // table of its mutating arms, so the retained same-site arms are listed here by path; a new
  // same-site arm must be added to this list to be ranged.
  // RE-SPELLED 2026-10-03 (quick-261003-tsr, WR-07): was '6g — refuses EVERY retained same-site
  // mutating arm, and reaches the mark arm same-origin'. Each arm is now driven with a body it
  // would act on, its own seam is read around the refusal, and every arm has its accepts control.
  it('6g — refuses EVERY retained same-site mutating arm before its own side effect, and each arm acts for its own page', async () => {
    const door = await openDoor()
    const savedDataHome = process.env.XDG_DATA_HOME
    const dataHome = mkdtempSync(join(tmpdir(), 'agent-qa-432-14-auth-'))
    process.env.XDG_DATA_HOME = dataHome
    const sink = await openProviderSink()
    const scene: ArmScene = {
      door,
      authFile: join(dataHome, 'agent-qa', 'auth.json'),
      providerHits: () => sink.hits(),
      providerBaseUrl: sink.baseUrl,
    }
    try {
      for (const arm of RETAINED_SAME_SITE_ARMS) {
        const body = await arm.arrange(scene)
        const before = await arm.read(scene)
        for (const contentType of ['application/json', 'text/plain;charset=UTF-8']) {
          const invocationsBefore = door.invocations.length
          const crossOrigin = await rawRequest(door.port, {
            method: arm.method,
            path: arm.path,
            headers: { 'content-type': contentType, origin: HOSTILE_ORIGIN },
            ...(body === undefined ? {} : { body }),
          })
          const label = `6g ${contentType} ${arm.method} ${arm.path}`
          expectNoSideEffect(label, door, crossOrigin, 403, {
            invocationsBefore,
            seam: { seam: arm.seam, before, after: await arm.read(scene) },
          })
          expect(JSON.parse(crossOrigin.body)).toEqual({ error: 'cross_site_refused' })
        }

        // THE ACCEPTS CONTROL, per arm: a door that refused everything, or an arm whose body could
        // not act, would pass the refusals above and fail here.
        const admitted = await rawRequest(door.port, {
          method: arm.method,
          path: arm.path,
          headers: sameSiteJson(door),
          ...(body === undefined ? {} : { body }),
        })
        await arm.admitted(scene, admitted, before)
      }
    } finally {
      await sink.close()
      if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = savedDataHome
      rmSync(dataHome, { recursive: true, force: true })
    }
  }, 60_000)

  it('6i — refuses the literal `null` Origin, which is not the same fact as no Origin at all', async () => {
    const door = await openDoor()
    // A SEPARATE RUNG FROM 6e AND THE ONE MOST EASILY LOST. `Origin: null` is what a sandboxed
    // iframe, a `data:` document and a cross-origin redirect send — an origin that declined to
    // name itself, which is the opposite of a local client that has no origin to name.
    const answered = await driveMark(door.port, {
      'content-type': 'application/json',
      origin: 'null',
    })
    expectNoSideEffect('6i', door, answered, 403)
  })

  it('6h — refuses a same-origin-looking drive whose Sec-Fetch-Site says cross-site', async () => {
    const door = await openDoor()
    // The third axis, varied alone: the Origin here is exactly the one 6d ACCEPTS, so nothing but
    // the fetch-metadata header can decide this request.
    const answered = await driveMark(door.port, {
      'content-type': 'application/json',
      origin: sameOrigin(door),
      'sec-fetch-site': 'cross-site',
    })
    expectNoSideEffect('6h', door, answered, 403)
  })
})

describe('C432-RETAINED-CROSS-SITE', () => {
  it('C432-RETAINED-CROSS-SITE: the dashboard mark control refuses another origin before dispatch and dispatches for its own page', async () => {
    const door = await openDoor()
    for (const headers of [
      { 'content-type': 'text/plain;charset=UTF-8', origin: HOSTILE_ORIGIN },
      { 'content-type': 'application/json', origin: HOSTILE_ORIGIN },
    ]) {
      const refused = await driveMark(door.port, headers)
      expectNoSideEffect(`C432-RETAINED-CROSS-SITE ${headers['content-type']}`, door, refused, 403)
      expect(JSON.parse(refused.body)).toEqual({ error: 'cross_site_refused' })
      expect(refused.headers['access-control-allow-origin']).toBeUndefined()
    }
    const accepted = await driveMark(door.port, {
      'content-type': 'application/json',
      origin: sameOrigin(door),
    })
    expectDispatchedOnce('C432-RETAINED-CROSS-SITE', door, accepted)
  })
})

describe('C441-CONFIG', () => {
  it('the dashboard command binds the declared mask', async () => {
    const door = await openDoor({ secrets: 'PW_441=Hunter-42-zz\n' })
    const config = JSON.parse(readFileSync(door.configPath, 'utf8')) as { use: Record<string, unknown> }
    config.use.buildTag = 'Hunter-42-zz'
    config.use.releaseNote = 'plain-441-value'
    writeFileSync(door.configPath, `${JSON.stringify(config)}\n`, 'utf8')

    const read = await rawRequest(door.port, { method: 'GET', path: '/api/config' })

    expect(read.status, read.body).toBe(200)
    expect(read.body).not.toContain('Hunter-42-zz')
    const body = JSON.parse(read.body) as { config: { use: Record<string, unknown> }; file: { lines: { text: string }[] } }
    expect(body.config.use.buildTag).toBe('[secret:PW_441]')
    expect(body.config.use.releaseNote).toBe('plain-441-value')
    expect(body.file.lines.some((line) => line.text.includes('[secret:PW_441]'))).toBe(true)
  })
})

// ---- gap 7: the malformed request path -----------------------------------------------------

/** Everything that escaped the server while a cell ran — the second half of every survival claim. */
function watchForEscapes(): { readonly escaped: unknown[]; readonly stop: () => void } {
  const escaped: unknown[] = []
  const onRejection = (reason: unknown): void => { escaped.push(reason) }
  const onUncaught = (error: unknown): void => { escaped.push(error) }
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onUncaught)
  return {
    escaped,
    stop: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onUncaught)
    },
  }
}

/** The door is still answering: a same-origin mark reaches the op and gets its own answer. */
async function expectDoorAnswers(door: DoorFixture, message: string): Promise<void> {
  const before = door.invocations.length
  const healthy = await driveMark(door.port, {
    'content-type': 'application/json',
    origin: sameOrigin(door),
  })
  expect(healthy.status, `${message} ${healthy.note ?? ''}`).toBe(200)
  expect(JSON.parse(healthy.body)).toEqual({ kind: 'run-not-found', runId: MARKED_RUN })
  expect(door.invocations.length).toBe(before + 1)
}

/** Let a rejection reach the process before a cell claims none did. */
async function settleEscapes(): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, 100))
}

/** Replace the host's dispatch with one that throws SYNCHRONOUSLY on its first call and only then. */
function throwingInvokeOnce(message: string): (host: AgentHost) => AgentHost {
  return (host) => {
    let calls = 0
    return {
      ...host,
      invokeFunction: (registry, functionId, input, caller) => {
        calls += 1
        if (calls === 1) throw new Error(message)
        return host.invokeFunction(registry, functionId, input, caller)
      },
    }
  }
}

/** Replace the host's dispatch with one whose first answer cannot be serialized, and only then. */
function unserializableAnswerOnce(message: string): (host: AgentHost) => AgentHost {
  return (host) => {
    let calls = 0
    return {
      ...host,
      invokeFunction: (registry, functionId, input, caller) => {
        calls += 1
        if (calls === 1) return Promise.resolve({ toJSON: (): never => { throw new Error(message) } })
        return host.invokeFunction(registry, functionId, input, caller)
      },
    }
  }
}

describe('the fourth door outlives every malformed request a socket can carry (gap 7)', () => {
  it('7c — answers an unparseable request line and serves the next request', async () => {
    const door = await openDoor()
    const watch = watchForEscapes()
    try {
      // `//` is a request target `node:http` hands straight to the handler and the WHATWG URL
      // parser refuses (a protocol-relative reference with an empty host). Unguarded, that
      // `TypeError` would leave the listener as an uncaught exception.
      const answered = await rawRequest(door.port, { method: 'GET', path: '//' })
      expect(answered.status, `the unparseable request line was never answered ${answered.note ?? ''}`)
        .toBe(400)
      expect(answered.body).toBe('Bad Request')

      await expectDoorAnswers(door, 'the door stopped serving after the unparseable request line')

      await settleEscapes()
      expect(watch.escaped, 'an exception escaped the dashboard server').toEqual([])
    } finally {
      watch.stop()
    }
  })

  // RE-SPELLED 2026-10-01 (432-14): the synchronous arm was the run-confirm router's media-type
  // refusal, deleted with it. RE-AIMED 2026-10-14 (441-15, D-07): the display unmask that carried
  // the claim next is deleted, so the evidence read's dispatch carries it — the arm calls the host
  // inside the router's own call stack, so only the server's one `try` can answer a throw there.
  it('7d — a throwing SYNCHRONOUS arm is caught by the dispatch boundary', async () => {
    const door = await openDoor({ wrapHost: throwingInvokeOnce('432-14 dispatch fault') })
    const watch = watchForEscapes()
    try {
      const answered = await rawRequest(door.port, {
        method: 'GET',
        path: `/api/runs/${READ_RUN}/evidence?kind=console&testIndex=0&stepIndex=0`,
        headers: { origin: sameOrigin(door) },
      })
      expect(answered.status, `the throwing read never answered ${answered.note ?? ''}`).toBe(500)
      expect(answered.body).toBe('Internal Server Error')

      await expectDoorAnswers(door, 'the door stopped serving after the throwing read')

      await settleEscapes()
      expect(watch.escaped, 'the exception escaped the dashboard server').toEqual([])
    } finally {
      watch.stop()
    }
  })

  // RE-SPELLED 2026-10-01 (432-14): was the run-confirm answer handler's rejection. RE-AIMED
  // 2026-10-14 (441-15, D-07): the display unmask is deleted, so the fault is an answer the mark
  // door's responder cannot serialize. It throws AFTER the body read, so it is a rejection of that
  // handler's promise, and only the arm's own `.catch` can answer it.
  it('7b-ii — a throwing responder is caught by the handler\'s own backstop', async () => {
    const door = await openDoor({ wrapHost: unserializableAnswerOnce('400-14 responder fault') })
    const watch = watchForEscapes()
    try {
      const answered = await driveMark(door.port, { 'content-type': 'application/json' })
      expect(answered.status, `the throwing responder never answered ${answered.note ?? ''}`).toBe(500)
      expect(JSON.parse(answered.body)).toEqual({ error: 'read_failed' })

      await expectDoorAnswers(door, 'the door stopped serving after the throwing responder')

      await settleEscapes()
      expect(watch.escaped, 'the rejection escaped the dashboard server').toEqual([])
    } finally {
      watch.stop()
    }
  })
})
