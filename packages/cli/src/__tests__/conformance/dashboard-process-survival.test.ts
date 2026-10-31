// Each cell spawns `agent-qa dashboard` and checks it serves a request after the hostile one.

import { connect } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DASHBOARD_ANCHORED_BUILDS,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardFixtureProject,
  spawnDashboard,
} from './spawned-chat.js'

afterEach(() => {
  cleanupTempRoots()
})

// ---- the raw HTTP client -----------------------------------------------------------------------

interface RawResponse {
  /** `0` means NO RESPONSE ARRIVED — the socket closed empty, the connect failed, or time ran out. */
  readonly status: number
  readonly head: string
  readonly body: string
  /** Why nothing arrived, when nothing arrived. `ECONNREFUSED` here means the process is gone. */
  readonly note: string
}

function unchunk(body: string): string {
  let decoded = ''
  let rest = body
  for (;;) {
    const lineEnd = rest.indexOf('\r\n')
    if (lineEnd === -1) return decoded
    const size = Number.parseInt(rest.slice(0, lineEnd), 16)
    if (!Number.isInteger(size) || size === 0) return decoded
    decoded += rest.slice(lineEnd + 2, lineEnd + 2 + size)
    rest = rest.slice(lineEnd + 2 + size + 2)
  }
}

function parseRaw(raw: string): RawResponse {
  if (raw === '') return { status: 0, head: '', body: '', note: 'the socket closed without a single byte' }
  const split = raw.indexOf('\r\n\r\n')
  const head = split === -1 ? raw : raw.slice(0, split)
  const payload = split === -1 ? '' : raw.slice(split + 4)
  const body = /^transfer-encoding: chunked\r?$/imu.test(head) ? unchunk(payload) : payload
  const status = Number.parseInt(head.split('\r\n')[0]?.split(' ')[1] ?? '', 10)
  return {
    status: Number.isInteger(status) ? status : 0,
    head,
    body,
    note: Number.isInteger(status) ? '' : 'the bytes that arrived were not a status line',
  }
}

/**
 * One request, written onto a socket exactly as given.
 *
 * THE REQUEST LINE IS A STRING AND IS NOT PARSED. `//%` and `http://[` are both things a URL
 * builder refuses to produce and both are what the attacker sends; a client that normalised them
 * would be measuring its own normalisation.
 */
function rawRequest(
  port: number,
  requestLine: string,
  options: { readonly headers?: Readonly<Record<string, string>>; readonly budgetMs?: number } = {},
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
      () => finish({ status: 0, head: '', body: '', note: 'no response within the cell budget' }),
      options.budgetMs ?? 8_000,
    )
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { raw += chunk })
    socket.on('end', () => finish(parseRaw(raw)))
    socket.on('close', () => finish(parseRaw(raw)))
    socket.on('error', (error: Error) => {
      finish(raw === '' ? { status: 0, head: '', body: '', note: error.message } : parseRaw(raw))
    })
    socket.on('connect', () => {
      const headers: Record<string, string> = {
        host: `127.0.0.1:${String(port)}`,
        connection: 'close',
      }
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        headers[key.toLowerCase()] = value
      }
      socket.write(
        `${requestLine} HTTP/1.1\r\n`
        + Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')
        + '\r\n',
      )
    })
  })
}

// ---- the survival instrument -------------------------------------------------------------------

// `/api/stats` is a plain database read the hermetic dashboard answers 200 with no state.
const HEALTHY_LINE = 'GET /api/stats'

interface Survival {
  /** The healthy drive BEFORE the hostile request — proof the subject was serving. */
  readonly before: RawResponse
  /** What the hostile request itself got back. */
  readonly hostile: RawResponse
  /** The healthy drive AFTER it, on the SAME process — the truth's own question. */
  readonly after: RawResponse
  /** Whether the child had exited by the time the last drive finished. */
  readonly exited: boolean
  readonly stderr: string
}

/**
 * Spawn the shipped dashboard, drive one hostile request at it, and report whether it lived.
 *
 * IT RETURNS DATA AND NEVER ASSERTS, on `spawned-chat.ts`'s law — a helper that threw would report
 * every caller's failure in one voice, and the four cells below are asking four different
 * questions about the same shape.
 *
 * THE FRESHNESS GUARD RUNS BEFORE ANYTHING IS SPAWNED and it is the load-bearing precondition of
 * this whole file: these cells execute `dashboard-server`'s `dist`, so a stale build would certify
 * the PREVIOUS `server.ts` while reading as proof of this one — the exact trap that would let a
 * process-kill fix "pass" without ever being loaded.
 */
async function survive(
  label: string,
  hostileLine: string,
  hostileHeaders: Readonly<Record<string, string>> = {},
): Promise<Survival> {
  expect(buildFreshness(DASHBOARD_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
    .toEqual({ missing: [], stale: [] })

  const project = dashboardFixtureProject(label)
  const dashboard = await spawnDashboard(project.root, project.configPath)
  expect(
    dashboard.ready,
    `the built \`agent-qa dashboard\` command never reported that it was listening for the ${label} `
    + `survival cell. its stdout: ${JSON.stringify(dashboard.stdout().slice(-1200))}; its stderr: `
    + `${JSON.stringify(dashboard.stderr().slice(-1200))}`,
  ).toBe(true)

  try {
    const before = await rawRequest(dashboard.port, HEALTHY_LINE)
    const hostile = await rawRequest(dashboard.port, hostileLine, { headers: hostileHeaders })
    // A process that is going to die from an unhandled rejection dies on a later tick than the one
    // that closed the socket, so the healthy drive is given a beat to find a dead port rather than
    // a live one that is about to stop being live.
    await new Promise<void>((tick) => setTimeout(tick, 500))
    const after = await rawRequest(dashboard.port, HEALTHY_LINE, { budgetMs: 5_000 })
    return {
      before,
      hostile,
      after,
      exited: dashboard.stderr().includes('Node.js v') || dashboard.stderr().includes('throw er;'),
      stderr: dashboard.stderr(),
    }
  } finally {
    await dashboard.stop()
  }
}

// Survival is asserted first, so a dead process is not reported as a wrong status.
function expectSurvived(label: string, result: Survival): void {
  expect(
    result.before.status,
    `${label}: the subject was not serving BEFORE the hostile request, so this cell measured `
    + `nothing. note=${JSON.stringify(result.before.note)}`,
  ).toBe(200)

  expect(
    result.after.status,
    `${label}: THE PROCESS DID NOT SURVIVE. the next healthy request got `
    + `${JSON.stringify(result.after.note)} instead of a 200 — an \`ECONNREFUSED\` here is a dead `
    + `process, which is what one unauthenticated request used to buy. the child's stderr: `
    + `${JSON.stringify(result.stderr.slice(-900))}`,
  ).toBe(200)

  expect(
    result.exited,
    `${label}: the child printed a fatal-error trailer, so something reached the process handlers `
    + `even though the port stayed open. its stderr: ${JSON.stringify(result.stderr.slice(-900))}`,
  ).toBe(false)
}

// ---- the cells -----------------------------------------------------------------------------

describe('the shipped dashboard process survives a malformed request path', () => {
  it(
    's1 — `GET //%` is answered 400 by the listener and the process serves the next request',
    { timeout: 120_000 },
    async () => {
      const result = await survive('s1-slash-slash-percent', 'GET //%')
      expectSurvived('s1', result)
      expect(
        result.hostile.status,
        `s1: the malformed request line was not answered 400 at the outermost frame. `
        + `note=${JSON.stringify(result.hostile.note)} body=${JSON.stringify(result.hostile.body)}. `
        + `a 500 here means the process-level backstop caught what the guarded parse should have `
        + `refused precisely.`,
      ).toBe(400)
    },
  )

  it(
    's2 — `GET http://[` (absolute-form target) is answered 400 and the process serves the next request',
    { timeout: 120_000 },
    async () => {
      const result = await survive('s2-absolute-form', 'GET http://[')
      expectSurvived('s2', result)
      expect(
        result.hostile.status,
        `s2: the unparseable absolute-form request target was not answered 400. `
        + `note=${JSON.stringify(result.hostile.note)} body=${JSON.stringify(result.hostile.body)}`,
      ).toBe(400)
    },
  )

  it(
    's3 — `GET //%` on the WEBSOCKET-UPGRADE frame closes the socket and the process serves the next request',
    { timeout: 120_000 },
    async () => {
      // THE FRAME NO LISTENER `try` CAN REACH. `server.on('upgrade')` is a synchronous event
      // handler, so its throw is an uncaught EXCEPTION rather than a rejected promise: the
      // process-level backstop around the request listener cannot see it and neither can
      // `clientError`. Only the guarded parse at the upgrade site keeps this process alive, which
      // is why this cell — and not the two above — is the one that reds when that guard is removed.
      const result = await survive('s3-upgrade-frame', 'GET //%', {
        connection: 'Upgrade',
        upgrade: 'websocket',
      })
      expectSurvived('s3', result)
      expect(
        result.hostile.status,
        `s3: the upgrade handler answered a status where it should have destroyed the socket — `
        + `its existing failure idiom for a request it will not serve. `
        + `body=${JSON.stringify(result.hostile.body)}`,
      ).toBe(0)
    },
  )

  it(
    's4 — `GET /api/suites/%` (the decodeURIComponent sibling) is answered 500 by the backstop and the process serves the next request',
    { timeout: 120_000 },
    async () => {
      // THE THROW THE PARSE GUARD DOES NOT COVER, and that is the point of this cell. `%` inside a
      // PATH is lenient — `new URL('/api/suites/%', 'http://localhost')` parses fine — so both
      // guarded parses succeed and the request reaches a route whose `decodeURIComponent` throws a
      // `URIError` SYNCHRONOUSLY inside the router. At HEAD that throw travels out of the async
      // listener as an unhandled rejection and ends the process. Only the process-level backstop
      // answers it, so this cell is the backstop's own pin.
      //
      // WHICH SIBLING ROUTE, MEASURED RATHER THAN ASSUMED. All three candidates the plan named
      // (`/api/suites/%`, `/api/tests/%`, `/api/analytics/tests/%`) were driven at HEAD against the
      // spawned binary and all three killed it. This one is used because it is the shortest path
      // whose manager the fixture project really configures — a route that answered 501 for a
      // missing manager would never reach its own decode, and would pin nothing.
      const result = await survive('s4-decode-sibling', 'GET /api/suites/%')
      expectSurvived('s4', result)
      expect(
        result.hostile.status,
        `s4: the synchronous \`URIError\` out of the router was not answered 500 by the `
        + `process-level backstop. note=${JSON.stringify(result.hostile.note)} — a 0 here means it `
        + `was never answered at all, which is the HEAD behaviour this cell exists to forbid.`,
      ).toBe(500)
    },
  )

  it(
    's5 — ACCEPTS CONTROL: a deleted chat path answers the shared 404, and a healthy request 200',
    { timeout: 120_000 },
    async () => {
      // A refuse-everything fix passes the four cells above and fails this one: the malformed path
      // has to travel past the guarded parse and the backstop to the router's generic 404.
      const result = await survive('s5-accepts-control', 'GET /api/chat/sessions/%/events')
      expectSurvived('s5', result)
      expect(
        result.hostile.status,
        `s5: a deleted path was not answered by the router's generic 404 — the frames above it `
        + `answered first. body=${JSON.stringify(result.hostile.body)}`,
      ).toBe(404)
      expect(JSON.parse(result.hostile.body)).toEqual({ error: 'Not found' })
      expect(
        result.hostile.head,
        's5: the 404 carried a cross-origin grant',
      ).not.toMatch(/^access-control-allow-origin:/imu)
    },
  )
})
