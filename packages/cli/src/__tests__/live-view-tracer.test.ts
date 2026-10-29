// THE TRACER'S VERIFY (403-01 Task 4) — ONE REAL SCREENCAST FRAME, painted on the served embed
// page, reached only through a `liveUrl` the function layer minted.
//
// WHAT IS PRODUCTION HERE, AND WHAT IS NOT. Production: `startServer` (the embed route, the frame
// socket's upgrade arm, the mint route), `startRun` (the run shell, its bus and its live-stream
// hub), `WebPlatformAdapter` (a real headless Chromium and a real `Page.startScreencast`),
// `composeDashboardDoor` and `composeLiveView` (the signer, the mint port and the validator).
// Scripted: the member EXECUTOR — which is the runner's own designed injection seam — and the
// clock the composition already takes as a port, so the cold-expired arm can move time without
// waiting five minutes. Nothing else is faked; in particular `validateLiveUrlToken` runs by
// reference, so a cell that gets a frame got it past the real validator.
//
// This file is in `packages/cli` because only the CLI may import every package at once.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Browser } from 'playwright-core'
import { chromium } from 'playwright-core'

import { LIVE_EMBED_PATH_PREFIX, LIVE_URL_TTL_MS, RUNS_LIVE_URL_FUNCTION_ID, invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import { LIVE_EMBED_EXPIRED_MESSAGE, LIVE_EMBED_PATH_PREFIX as SERVER_EMBED_PATH_PREFIX } from '@vostride/agent-qa-dashboard'
import { startRun } from '@vostride/agent-qa-runner'
import type { MemberTestRunContext, RunConfig } from '@vostride/agent-qa-runner'
import { EditorLiveUrlResultSchema, RunsLiveUrlResultSchema } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, RunEventEnvelope, RunSession } from '@vostride/agent-qa-schema'
import { generateTestId } from '@vostride/agent-qa-ids'
import { WebPlatformAdapter } from '@vostride/agent-qa-web'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DASHBOARD_FUNCTION_CALLER, composeDashboardDoor, createDashboardRunDoor } from '../commands/dashboard.js'
import { composeLiveView } from '../composition/live-view-composition.js'
import { createRunServiceSessionRegistry } from '../composition/run-service-session-registry.js'
import { plantEditorSubject, startLiveViewHarness } from './conformance/live-view-fixture.js'
import { cleanupTempRoots } from './conformance/spawned-chat.js'
import { startLiveStreamFixturePage } from './fixtures/live-stream-fixture-page.js'
import type { LiveStreamFixturePage } from './fixtures/live-stream-fixture-page.js'

/** `packages/dashboard-server/src/server/server.ts`, resolved from this file rather than guessed. */
const SERVER_SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../dashboard-server/src/server/server.ts',
)

const BROWSER_INSTALL_INSTRUCTION =
  'a real Chromium is required for the tracer: run `pnpm exec playwright install chromium`.'

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-403-01-tracer-'))
  const configPath = join(root, 'agent-qa.config.yaml')
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
          conformance: { platform: 'web', url: 'https://conformance.invalid', environment: 'local' },
        },
      },
      services: { dashboard: {} },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(
    join(root, 'tests', 'probe.test.yaml'),
    'name: The live-view tracer probe\n'
    + `test-id: ${generateTestId()}\n`
    + 'target: conformance\n'
    + 'steps:\n'
    + '  - Do nothing this run will ever reach\n',
    'utf8',
  )
  return configPath
}

interface Fixture {
  readonly origin: string
  readonly runId: string
  readonly session: RunSession
  readonly registry: FunctionRegistry
  readonly browser: Browser
  readonly clock: { now: number }
  /** Resolve the scripted member so the run reaches its terminal sequence. */
  readonly finishRun: () => void
  readonly close: () => Promise<void>
}

let fixture: Fixture | undefined
let page: LiveStreamFixturePage | undefined

/** How long the tracer will keep asking the mint route for a handle that has not registered yet. */
const MINT_RETRY_BUDGET_MS = 60_000
// 2026-10-02 (quick 261002-tmo): every embed state here is pushed to the page over its socket (no
// poll), so each wait is a condition with a hang ceiling. 10 s was outrun at load up to 132: (vi)'s
// page had not yet shown `ended` after finishRun() (quick 261002-tmo forced gate 4).
const EMBED_STATE_WAIT_MS = 60_000
const MINT_RETRY_INTERVAL_MS = 250

/** Every mint answer this file has observed, per call — the record of the race it no longer hides. */
const mintAnswerLog: string[][] = []

async function mintOnce(handle: number): Promise<{ liveUrl: string; stream: { kind: string }; expiresAt: number }> {
  const held = fixture as Fixture
  const response = await fetch(`${held.origin}/api/runs/${encodeURIComponent(held.runId)}/live-url?handle=${String(handle)}`)
  const raw = await response.text()
  expect(response.status, raw).toBe(200)
  return RunsLiveUrlResultSchema.parse(JSON.parse(raw))
}

/**
 * The mint route, POLLED until the member's handle declares a stream.
 *
 * WHY THIS REPLACED A `beforeAll` DEFERRED. This file used to hold a `registered` promise that the
 * scripted executor resolved right after `ctx.registerLiveStream`, and `beforeAll` awaited it — so
 * no cell could ever observe the window between "the session exists" and "the member's browser has
 * registered its screencast". Its own comment named the symptom: "a flake that would look exactly
 * like the capability being absent". That window is the PRODUCT'S start-up ordering, not a harness
 * artifact, and closing it in the harness is how six plans of careful measurement coexisted with a
 * dead preview in the normal case (403-VERIFICATION gap 1). The wait is gone; the tracer now
 * exercises the real ordering and proves the mint EVENTUALLY declares a stream.
 */
async function mint(handle = 0): Promise<{ liveUrl: string; stream: { kind: string }; expiresAt: number }> {
  const deadline = Date.now() + MINT_RETRY_BUDGET_MS
  const answers: string[] = []
  for (;;) {
    const result = await mintOnce(handle)
    answers.push(result.stream.kind)
    if (result.stream.kind === 'cdp-screencast') {
      mintAnswerLog.push(answers)
      return result
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the mint never declared a stream within ${String(MINT_RETRY_BUDGET_MS)}ms; `
        + `answers=${JSON.stringify(answers)}`,
      )
    }
    await new Promise((tick) => setTimeout(tick, MINT_RETRY_INTERVAL_MS))
  }
}

beforeAll(async () => {
  const configPath = fixtureWorkspace()
  const configDir = dirname(resolve(configPath))
  page = await startLiveStreamFixturePage()
  const fixturePage = page

  const { DashboardDatabase, startServer } = await import('@vostride/agent-qa-dashboard')
  const db = new DashboardDatabase({ dbPath: join(configDir, 'dashboard.db') })
  const runDoor = await createDashboardRunDoor({ db })
  let boundOrigin: string | undefined

  // THE SCRIPTED EXECUTOR — the runner's designed injection seam, and the only scripted thing on
  // this path. It drives a REAL WebPlatformAdapter at a REAL headless Chromium, registers the
  // adapter's real screencast capability through the real `ctx.registerLiveStream`, and then waits
  // on a deferred so the run stays live while the cells watch it.
  let finishRun: () => void = () => {}
  const finished = new Promise<void>((resolve_) => { finishRun = resolve_ })
  // NOTHING WAITS FOR THE CAPABILITY ANY MORE (403-07 Task 2). The deferred that used to live here
  // was resolved right after `ctx.registerLiveStream` and awaited in `beforeAll`, which engineered
  // the product's own start-up race out of the harness. `mint()` above polls instead, so the cells
  // read the ordering production actually has.
  const adapter = new WebPlatformAdapter()
  let adapterUp = false

  const runId = `r_403_tracer_${String(Date.now())}`
  const runConfig: RunConfig = {
    runId: runId as RunConfig['runId'],
    scope: { tier: 'suite', key: 'live-view' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [{ testId: 'tracer', name: 'the tracer member', filePath: 'tracer.test.ts' }],
    executor: async (_member, ctx: MemberTestRunContext) => {
      await adapter.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
      adapterUp = true
      await adapter.execute({ type: 'navigate', to: 'url', url: `${fixturePage.url}?animate=1` })
      ctx.registerLiveStream?.(adapter.liveStream)
      await finished
      await adapter.cleanup()
      adapterUp = false
      return { name: 'the tracer member', filePath: 'tracer.test.ts', status: 'passed', steps: [], duration: 1 }
    },
    ports: {
      handoffStore: { save: async (_handoff: CompletedRunHandoff) => {} },
      eventLog: { append: (_envelope: RunEventEnvelope) => {}, read: () => [] },
    },
  }

  const session = startRun(runConfig)

  // The registry the shipped command hoists — handed the ONE session this cell started.
  const sessions = createRunServiceSessionRegistry({
    observeSessions: (observer) => { observer(session); return () => undefined },
  })
  // A SHIFTABLE CLOCK ON THE COMPOSITION'S OWN `now` PORT (the cold-expired arm, D-02). Not a fake
  // validator: `composeLiveView` takes `now` because a host owns its clock, and the cell uses that
  // seam rather than replacing anything.
  const clock = { now: Date.now() }
  const liveView = composeLiveView({
    sessions,
    origin: () => boundOrigin,
    now: () => clock.now,
  })

  const { agentHost, host } = composeDashboardDoor({
    agentQaRoot: join(configDir, '.agent-qa'),
    configPath,
    boundOrigin: () => boundOrigin,
    liveView: liveView.liveView,
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(host)

  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath,
    agentHost,
    executionBackend: runDoor.backend,
    runServiceAttach: sessions.attach,
    liveView: {
      validate: (token, expectation) => liveView.validate(token, { ...expectation, now: clock.now }),
      mintLiveUrl: async (id, handle) => RunsLiveUrlResultSchema.parse(
        await invokeFunction(host.registry as FunctionRegistry, RUNS_LIVE_URL_FUNCTION_ID, { runId: id, handle }, DASHBOARD_FUNCTION_CALLER),
      ),
    },
  })
  const address = (started.server as Server).address()
  if (address === null || typeof address === 'string') throw new TypeError('the server bound no port')
  boundOrigin = `http://127.0.0.1:${String(address.port)}`

  let browser: Browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    started.close()
    throw new Error(`${BROWSER_INSTALL_INSTRUCTION} underlying error: ${error instanceof Error ? error.message : String(error)}`)
  }

  fixture = {
    origin: boundOrigin,
    runId,
    session,
    registry: host.registry as FunctionRegistry,
    browser,
    clock,
    finishRun,
    close: async () => {
      finishRun()
      await session.done.catch(() => undefined)
      if (adapterUp) await adapter.cleanup().catch(() => undefined)
      await browser.close()
      started.close()
      sessions.dispose()
      await host.close()
      db.close()
      rmSync(configDir, { recursive: true, force: true })
    },
  }
}, 180_000)

afterAll(async () => {
  const held = fixture
  fixture = undefined
  if (held !== undefined) await held.close().catch(() => undefined)
  await page?.close().catch(() => undefined)
  page = undefined
})

describe('the tracer: one real CDP frame behind a function-layer-minted liveUrl', () => {
  it('(i) the mint route answers a parseable result declaring a cdp-screencast liveUrl', async () => {
    const held = fixture as Fixture
    const result = await mint(0)
    expect(result.stream.kind, 'a live Chromium member declares the screencast capability')
      .toBe('cdp-screencast')
    expect(result.liveUrl.startsWith(`${held.origin}${LIVE_EMBED_PATH_PREFIX}${held.runId}#v2.`)).toBe(true)
    // The two packages spell the embed prefix separately (dashboard-server may not import agent).
    // Pin them EQUAL rather than assume it.
    expect(SERVER_EMBED_PATH_PREFIX).toBe(LIVE_EMBED_PATH_PREFIX)
  }, 60_000)

  it('(ii) a REAL screencast frame is painted on the served embed page within 10 s', async () => {
    const held = fixture as Fixture
    const result = await mint(0)
    const embed = await held.browser.newPage()
    try {
      await embed.goto(result.liveUrl)
      await embed.locator('[data-embed-state="live"]').waitFor({ state: 'attached', timeout: EMBED_STATE_WAIT_MS })
      const frames = Number(await embed.locator('[data-embed-state]').getAttribute('data-embed-frames'))
      expect(frames, 'the page counts the frames it PAINTED, not the ones it received')
        .toBeGreaterThanOrEqual(1)
      const width = await embed.locator('[data-embed-canvas]').evaluate((node) => (node as HTMLCanvasElement).width)
      expect(width, 'a painted canvas has the frame\'s own geometry').toBeGreaterThan(0)
    } finally {
      await embed.close()
    }
  }, 120_000)

  it('(iii) a tampered fragment is refused and never reaches live', async () => {
    const held = fixture as Fixture
    const result = await mint(0)
    const tampered = `${result.liveUrl.slice(0, -4)}${result.liveUrl.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`
    const embed = await held.browser.newPage()
    try {
      await embed.goto(tampered)
      await embed.locator('[data-embed-state="refused"]').waitFor({ state: 'attached', timeout: EMBED_STATE_WAIT_MS })
      expect(await embed.locator('[data-embed-state]').getAttribute('data-embed-state')).toBe('refused')
    } finally {
      await embed.close()
    }
  }, 120_000)

  it('(iii-b) a COLD EXPIRED link says exactly "link expired" — never blank, never live', async () => {
    const held = fixture as Fixture
    const result = await mint(0)
    const restore = held.clock.now
    held.clock.now = restore + LIVE_URL_TTL_MS + 1
    const embed = await held.browser.newPage()
    try {
      await embed.goto(result.liveUrl)
      await embed.locator('[data-embed-state="expired"]').waitFor({ state: 'attached', timeout: EMBED_STATE_WAIT_MS })
      expect(await embed.locator('[data-embed-message]').textContent()).toBe(LIVE_EMBED_EXPIRED_MESSAGE)
      expect(await embed.locator('[data-embed-state]').getAttribute('data-embed-state')).not.toBe('live')
    } finally {
      await embed.close()
      held.clock.now = restore
    }
  }, 120_000)

  it('(iv) the embed document carries a nonce CSP and no-referrer, and no token', async () => {
    const held = fixture as Fixture
    const response = await fetch(`${held.origin}${LIVE_EMBED_PATH_PREFIX}${encodeURIComponent(held.runId)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain('nonce-')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-frame-options'), 'a page whose purpose is to be embedded')
      .toBeNull()
    const body = await response.text()
    // The token lives in a fragment the server never receives — so a document it served cannot
    // contain one, and this is the cheapest place to notice if that ever stopped being true.
    expect(body).not.toContain('v2.')
  }, 60_000)

  it('(iv-b) PITFALL 10: the /live/ arm is registered ABOVE the static/SPA arm, in source', () => {
    // A BEHAVIOURAL CELL CANNOT SEE THIS ONE. The tracer's fixture composes `startServer` with no
    // `uiDir`, so the SPA fallback is skipped and a mis-ordered route would answer 404 rather than
    // an HTML dashboard — the cells above would stay green while every SHIPPED dashboard (which
    // always has a `uiDir`) rendered the React app inside every embedding iframe.
    //
    // So the ORDER is asserted where it exists: in the source, by line number, with both anchors
    // required present so the cell cannot pass by matching nothing.
    const source = readFileSync(SERVER_SOURCE, 'utf8')
    const embedArm = source.indexOf('path.startsWith(LIVE_EMBED_PATH_PREFIX)')
    const staticArm = source.indexOf('if (uiDir) {')
    expect(embedArm, 'the embed route must exist in server.ts').toBeGreaterThan(-1)
    expect(staticArm, 'the static/SPA arm must exist in server.ts').toBeGreaterThan(-1)
    expect(
      embedArm,
      'the /live/ arm must precede the static/SPA arm — the SPA fallback answers index.html for '
      + 'ANY unknown path, so a later /live/ arm is a contract nobody can reach (Pitfall 10)',
    ).toBeLessThan(staticArm)
  })

  it('(v) frames flowed and the run bus published no bytes for them', async () => {
    const held = fixture as Fixture
    const result = await mint(0)
    const seen: RunEventEnvelope[] = []
    const unsubscribe = held.session.subscribe(1, (envelope) => { seen.push(envelope) })
    const embed = await held.browser.newPage()
    try {
      await embed.goto(result.liveUrl)
      await embed.locator('[data-embed-state="live"]').waitFor({ state: 'attached', timeout: EMBED_STATE_WAIT_MS })
    } finally {
      await embed.close()
      unsubscribe()
    }
    expect(seen.length, 'the positive control — the bus was actually observed').toBeGreaterThan(0)
    const serialized = JSON.stringify(seen)
    expect(serialized, 'a frame on the bus would carry its bytes').not.toContain('"bytes"')
    expect(serialized, 'and a base64 JPEG would start with the JFIF marker').not.toContain('/9j/')
  }, 120_000)

  it('(vi) when the run ends the page says so and the session resolves', async () => {
    const held = fixture as Fixture
    const result = await mint(0)
    const embed = await held.browser.newPage()
    try {
      await embed.goto(result.liveUrl)
      await embed.locator('[data-embed-state="live"]').waitFor({ state: 'attached', timeout: EMBED_STATE_WAIT_MS })
      held.finishRun()
      await embed.locator('[data-embed-state="ended"]').waitFor({ state: 'attached', timeout: EMBED_STATE_WAIT_MS })
      await expect(held.session.done).resolves.toBeDefined()
    } finally {
      await embed.close()
    }
  }, 120_000)
})

// ---- The editor token's absence; the version prefix is one of its needles ---------------------
//
// The same credential rules as a run token, measured on the shipped composition the live-view
// harness composes: the editor mint door, the dispatcher under the dashboard caller, and the frame
// socket. The server runs in THIS process, so its log is this process's console and standard
// streams, captured for the whole exchange.

/** Every line written to the console or the standard streams while `run` is in flight. */
async function captureProcessLog<T>(run: () => Promise<T>): Promise<{ result: T; log: string }> {
  const lines: string[] = []
  const record = (...parts: unknown[]): void => {
    lines.push(parts.map((part) => (typeof part === 'string' ? part : String(part))).join(' '))
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'debug').mockImplementation(record),
  ]
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  const streamSpies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      record(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
      return (stdoutWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write),
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      record(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
      return (stderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write),
  ]
  try {
    const result = await run()
    return { result, log: lines.join('\n') }
  } finally {
    for (const spy of [...spies, ...streamSpies]) spy.mockRestore()
  }
}

/** Open the frame socket as a page would, say hello, and read until `ended` or the budget. */
async function watchEditor(origin: string, sessionId: string, token: string, until: () => Promise<void>): Promise<string[]> {
  const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/api/live-view/ws?runId=${encodeURIComponent(sessionId)}`)
  const texts: string[] = []
  let frames = 0
  await new Promise<void>((settle, fail) => {
    const budget = setTimeout(() => { fail(new Error(`no ended within budget; messages=${JSON.stringify(texts)}`)) }, EMBED_STATE_WAIT_MS)
    socket.addEventListener('open', () => { socket.send(JSON.stringify({ type: 'hello', token })) })
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') { frames += 1; if (frames === 1) void until(); return }
      texts.push(event.data)
    })
    socket.addEventListener('close', () => { clearTimeout(budget); settle() })
    socket.addEventListener('error', () => { clearTimeout(budget); settle() })
  })
  return texts
}

describe('an editor token obeys every credential rule a run token does', () => {
  it('EDITOR-TOKEN-ABSENT-FROM-LOGS: no editor token in the server log, any non-mint body, or any URL but a fragment', async () => {
    const harness = await startLiveViewHarness({ label: '428-12-tracer' })
    const editor = plantEditorSubject(harness, { sessionId: 'ed-log', kind: 'cdp-screencast' })
    try {
      const { result, log } = await captureProcessLog(async () => {
        // THE CAPTURE'S OWN POSITIVE CONTROL: both channels are hooked, so an absence below is a
        // reading and not a deaf scanner.
        console.log('428-12 capture control: console')
        process.stderr.write('428-12 capture control: stderr\n')

        const mintResponse = await fetch(`${harness.origin}/api/live-editor/sessions/ed-log/live-url`)
        const mintBody = await mintResponse.text()
        const minted = EditorLiveUrlResultSchema.parse(JSON.parse(mintBody))
        const token = minted.liveUrl.split('#')[1] as string

        const bodies: [string, string][] = []
        const collect = async (name: string, url: string): Promise<void> => {
          const response = await fetch(url)
          bodies.push([`${name} (${String(response.status)})`, await response.text()])
        }
        await collect('the editor embed document', `${harness.origin}/live/ed-log`)
        await collect('the live-editor session list', `${harness.origin}/api/live-editor/sessions`)
        await collect('the run mint door, asked for the editor id', `${harness.origin}/api/runs/ed-log/live-url`)
        await collect('an unheld editor session\'s mint', `${harness.origin}/api/live-editor/sessions/nope/live-url`)

        const socketTexts = await watchEditor(harness.origin, 'ed-log', token, async () => { await editor.end() })
        bodies.push(['the frame socket\'s text messages', socketTexts.join('\n')])
        return { mintStatus: mintResponse.status, mintBody, liveUrl: minted.liveUrl, token, bodies, socketTexts }
      })

      expect(result.mintStatus, 'the no-Origin caller mints').toBe(200)
      expect(log, 'the capture saw the console').toContain('428-12 capture control: console')
      expect(log, 'the capture saw stderr').toContain('428-12 capture control: stderr')
      // THE NEEDLES' POSITIVE CONTROL: the mint's own body carries the token and its needle.
      expect(result.mintBody, 'the mint body is the one place the token is handed out').toContain(result.token)
      expect(result.mintBody).toContain('v2.')
      expect(result.socketTexts.map((text) => (JSON.parse(text) as { type?: string }).type), 'the socket was watched to its end')
        .toEqual(expect.arrayContaining(['ready', 'frame', 'ended']))

      const [, claimsPart, signaturePart] = result.token.split('.')
      expect((claimsPart ?? '').length, 'a substantial needle').toBeGreaterThan(20)
      const needles: [string, string][] = [
        ['v2.', 'the token version prefix'],
        [result.token, 'the whole editor token'],
        [claimsPart as string, 'the token\'s claims body'],
        [signaturePart as string, 'the token\'s signature'],
      ]
      for (const [needle, what] of needles) {
        expect(log, `the server log carries ${what}`).not.toContain(needle)
        for (const [name, body] of result.bodies) {
          expect(body, `${name} carries ${what}`).not.toContain(needle)
        }
      }
      // A URL carries the token only after its '#': the path the server sees has none of it.
      const [beforeFragment] = result.liveUrl.split('#')
      expect(beforeFragment, 'the served path and query carry no token').not.toContain('v2.')
      expect(beforeFragment).not.toContain(claimsPart as string)
    } finally {
      await editor.close()
      await harness.close()
      cleanupTempRoots()
    }
  }, 2 * EMBED_STATE_WAIT_MS)
})
