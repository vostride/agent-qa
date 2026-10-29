// End to end on shipped code; the executor, recorded handoff, retention and host page are scripted.

import { createServer } from 'node:http'
import type { Server as NodeHttpServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Browser, Frame, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  LIVE_EMBED_PATH_PREFIX,
  RUNS_LIVE_URL_FUNCTION_ID,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import {
  APP_RESOURCE_MIME_TYPE,
  APP_RESOURCE_URI_TEMPLATE,
  APP_WRAPPER_APP_NAME,
  APP_WRAPPER_CONNECTING_HINT,
  APP_WRAPPER_CONNECTING_MESSAGE,
  APP_WRAPPER_LOAD_TIMEOUT_MS,
  APP_WRAPPER_PERMANENT_LINK_LABEL,
  APP_WRAPPER_RUN_ENDED_MESSAGE,
  APP_WRAPPER_UI_PROTOCOL_VERSION,
  MCP_APPS_EXTENSION_ID,
  appResourceUriFor,
  liveLinkLine,
  liveRunLinkOf,
} from '@vostride/agent-qa-mcp'
import { startRun } from '@vostride/agent-qa-runner'
import type { MemberTestRunContext, RunConfig } from '@vostride/agent-qa-runner'
import { HANDOFF_FILE, RUNS_SUBDIR, FsEventLog, slugBranch } from '@vostride/agent-qa-runner-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION, RunsLiveUrlResultSchema } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, RunSession } from '@vostride/agent-qa-schema'
import { generateTestId } from '@vostride/agent-qa-ids'
import { WebPlatformAdapter } from '@vostride/agent-qa-web'

import { DASHBOARD_FUNCTION_CALLER, composeDashboardDoor, createDashboardRunDoor } from '../commands/dashboard.js'
import { composeMcpMasking, createMcpHttpRequestListener } from '../commands/mcp.js'
import { composeLiveView } from '../composition/live-view-composition.js'
import { createRunServiceSessionRegistry } from '../composition/run-service-session-registry.js'
import { startLiveStreamFixturePage } from './fixtures/live-stream-fixture-page.js'
import type { LiveStreamFixturePage } from './fixtures/live-stream-fixture-page.js'

const BROWSER_INSTALL_INSTRUCTION =
  'a real Chromium is required for the App-host harness — this file IS the render leg, so a run '
  + 'without a browser proves nothing: run `pnpm exec playwright install chromium` and re-run. '
  + 'THIS MUST NOT BE SKIPPED WHEN THE BROWSER IS ABSENT (a skipped browser suite is a failed gate).'

const TOKEN_ENV_VAR = 'AGENT_QA_408_06_HARNESS_TOKEN'
const TOKEN_VALUE = 'harness-token-408-06-not-a-real-credential'

// A static page gets a keepalive every 2 s; above the band means a poller, below a silent producer.
const CHANGING_WINDOW_MS = 3_000
const STATIC_SETTLE_MS = 3_000
const STATIC_WINDOW_MS = 6_000
const STATIC_MIN_FRAMES = 2
const STATIC_MAX_FRAMES = 4

// ---- The Apps-host CSP, mapped from the OFFICIAL schema's own documented mapping ---------------

const requireFromHere = createRequire(fileURLToPath(import.meta.url))

interface ExtAppsSchema {
  readonly $defs: Record<string, unknown>
}

// ext-apps is a devDependency of `packages/mcp` only, so its schema resolves from there.
const EXT_APPS_SCHEMA: ExtAppsSchema = (() => {
  const mcpRequire = createRequire(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../mcp/src/app-resource.ts'),
  )
  return JSON.parse(
    readFileSync(mcpRequire.resolve('@modelcontextprotocol/ext-apps/schema.json'), 'utf8'),
  ) as ExtAppsSchema
})()

/** The `ui/initialize` params the official schema REQUIRES, read from it rather than restated. */
const UI_INITIALIZE_REQUIRED_PARAMS: readonly string[] = (
  EXT_APPS_SCHEMA.$defs.McpUiInitializeRequest as {
    readonly properties: { readonly params: { readonly required: readonly string[] } }
  }
).properties.params.required

/** The `_meta.ui.csp` block a served App can carry, in the shape this file reads it off the wire. */
interface ServedCsp {
  readonly frameDomains?: readonly string[]
  readonly connectDomains?: readonly string[]
  readonly resourceDomains?: readonly string[]
}

/**
 * Which CSP directives each `McpUiResourceCsp` field governs — READ OUT OF THE SCHEMA'S OWN PROSE,
 * on this suite's derive-don't-restate law (the same law `UI_INITIALIZE_REQUIRED_PARAMS` obeys).
 *
 * ext-apps states the mapping in each property's `description`, one line per property, in the form
 * "Maps to CSP `img-src`, `script-src`, `style-src`, `font-src`, `media-src` directives". So the
 * directive names are lifted from the backticked `*-src` tokens on that line rather than transcribed
 * here, and an upstream schema that adds a directive to a field arrives here without an edit.
 *
 * `baseUriDomains` is DELIBERATELY not on this list, and the omission is not laziness: it maps to
 * `base-uri`, whose documented default is `'self'` and not `'none'`. Folding it in under the
 * "empty or omitted -> 'none'" rule below would be restating it WRONGLY, which is worse than not
 * deriving it at all. The `*-src` filter is what draws that line, and it draws it from the token.
 */
const CSP_FIELD_DIRECTIVES: Readonly<Record<string, readonly string[]>> = (() => {
  const properties = (
    EXT_APPS_SCHEMA.$defs.McpUiResourceCsp as {
      readonly properties: Record<string, { readonly description?: string }>
    }
  ).properties
  const mapping: Record<string, readonly string[]> = {}
  for (const [field, property] of Object.entries(properties)) {
    const line = (property.description ?? '').split('\n').find((entry) => entry.includes('Maps to CSP'))
    if (line === undefined) continue
    const directives = [...line.matchAll(/`([a-z-]+-src)`/g)].map((match) => match[1] as string)
    if (directives.length > 0) mapping[field] = directives
  }
  // If ext-apps rewords `resourceDomains`, every directive goes underived; this gate fails loudly.
  const resource = mapping.resourceDomains ?? []
  for (const required of ['script-src', 'style-src']) {
    if (!resource.includes(required)) {
      throw new Error(
        `ext-apps' schema no longer documents \`resourceDomains\` as mapping to \`${required}\` — `
        + 'the host CSP derivation in app-host-harness.test.ts has gone blind and must be re-read '
        + `against the new wording (found: ${JSON.stringify(mapping)})`,
      )
    }
  }
  return mapping
})()

/**
 * Source expressions an emulated host grants BEYOND what the served metadata asked for, by directive.
 *
 * A host emulation that quietly supplies a permission the App never requested proves nothing about a
 * real host — it proves what the test file believes. So every additional grant is a named value with
 * a comment, and every call site passes one explicitly.
 */
type HostAllowances = Readonly<Record<string, readonly string[]>>

/** A host that grants nothing beyond the metadata — the schema's secure default, unembellished. */
const NO_HOST_ALLOWANCE: HostAllowances = {}

// Assumes a real Apps host runs an App's own inline script and style; ext-apps' schema is silent.
const PERMISSIVE_HOST_ALLOWANCE: HostAllowances = {
  'script-src': ["'unsafe-inline'"],
  'style-src': ["'unsafe-inline'"],
}

// Every directive the metadata governs is derived; a hardcoded one hides a host that withholds it.
function hostCspFor(
  csp: ServedCsp | undefined,
  hostAllowances: HostAllowances = NO_HOST_ALLOWANCE,
): string {
  const directive = (name: string, origins: readonly string[] | undefined): string => {
    // The schema's rule, applied identically to every field: empty or omitted contributes nothing.
    const derived = origins === undefined ? [] : origins
    const granted = hostAllowances[name] ?? []
    const sources = [...derived, ...granted]
    return sources.length === 0 ? `${name} 'none'` : `${name} ${sources.join(' ')}`
  }
  const directives: string[] = ["default-src 'none'"]
  for (const [field, names] of Object.entries(CSP_FIELD_DIRECTIVES)) {
    for (const name of names) {
      directives.push(directive(name, (csp as Record<string, readonly string[] | undefined> | undefined)?.[field]))
    }
  }
  return directives.join('; ')
}

// ---- The workspace, copied in shape from the tracer's ------------------------------------------

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-408-06-harness-'))
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
    'name: The App-host harness probe\n'
    + `test-id: ${generateTestId()}\n`
    + 'target: conformance\n'
    + 'steps:\n'
    + '  - Do nothing this run will ever reach\n',
    'utf8',
  )
  return configPath
}

// A digest refuses an unrecorded run, so the fixture records a handoff for a run still live.
function recordedHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId,
    scope: { tier: 'suite', key: 'live-view' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_harness',
        testName: 'the harness member',
        filePath: 'tests/probe.test.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      },
    ],
  } as unknown as CompletedRunHandoff
}

interface Fixture {
  /** The dashboard origin — the embed route and the frame socket. */
  readonly origin: string
  /** The co-hosted MCP endpoint's URL. */
  readonly mcpUrl: string
  readonly runId: string
  readonly session: RunSession
  readonly registry: FunctionRegistry
  readonly browser: Browser
  /** Point the run's REAL browser at a url — the changing/static switch leg 2 needs. */
  navigateTarget(url: string): Promise<void>
  /** The fixture page's base url; append `?animate=1` for the moving arm. */
  readonly targetUrl: string
  /** Resolve the scripted member so the run reaches its terminal sequence. */
  readonly finishRun: () => void
  readonly close: () => Promise<void>
}

let fixture: Fixture | undefined
let targetPage: LiveStreamFixturePage | undefined
const openServers: NodeHttpServer[] = []

beforeAll(async () => {
  process.env[TOKEN_ENV_VAR] = TOKEN_VALUE

  const configPath = fixtureWorkspace()
  const configDir = dirname(resolve(configPath))
  const agentQaRoot = join(configDir, '.agent-qa')
  targetPage = await startLiveStreamFixturePage()
  const page = targetPage

  const { DashboardDatabase, startServer } = await import('@vostride/agent-qa-dashboard')
  const db = new DashboardDatabase({ dbPath: join(configDir, 'dashboard.db') })
  const runDoor = await createDashboardRunDoor({ db })
  let boundOrigin: string | undefined

  const runId = `r_408_06_harness_${String(Date.now())}`

  // The RECORDED document, on disk, so the SHIPPED `createRunsReader` really reads it rather than a
  // port this file injected. Written before the run starts, which is the ordinary order: a dashboard
  // knows about a run before somebody asks it for the run's digest.
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(recordedHandoff(runId))}\n`, 'utf8')

  // THE SCRIPTED EXECUTOR — the runner's designed injection seam, and the only scripted thing on the
  // run path. It drives a REAL WebPlatformAdapter at a REAL headless Chromium, registers the
  // adapter's real screencast capability through the real `ctx.registerLiveStream`, and then waits on
  // a deferred so the run stays live while the cells watch it.
  let finishRun: () => void = () => {}
  const finished = new Promise<void>((settle) => { finishRun = settle })
  const adapter = new WebPlatformAdapter()
  let adapterUp = false

  const runConfig: RunConfig = {
    runId: runId as RunConfig['runId'],
    scope: { tier: 'suite', key: 'live-view' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [{ testId: 'harness', name: 'the harness member', filePath: 'harness.test.ts' }],
    executor: async (_member, ctx: MemberTestRunContext) => {
      await adapter.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
      adapterUp = true
      await adapter.execute({ type: 'navigate', to: 'url', url: `${page.url}?animate=1` })
      ctx.registerLiveStream?.(adapter.liveStream)
      await finished
      await adapter.cleanup()
      adapterUp = false
      return { name: 'the harness member', filePath: 'harness.test.ts', status: 'passed', steps: [], duration: 1 }
    },
    ports: {
      handoffStore: { save: async (_handoff: CompletedRunHandoff) => {} },
      // THE REAL STORE, not a no-op. The App's roster read goes through `runs.events` ->
      // `createRunsReader.readEvents` -> `FsEventLog`, so wiring the run's own log to that store is
      // what makes the roster the App renders the roster this run really announced.
      eventLog: new FsEventLog({ root: agentQaRoot, runId }),
    },
  }

  const session = startRun(runConfig)

  const sessions = createRunServiceSessionRegistry({
    observeSessions: (observer) => { observer(session); return () => undefined },
    // SCRIPTED, and it is the registry's OWN declared knob (see the header). The default window is
    // five minutes; leg 3's subject is the answer a person gets for a run this host no longer holds
    // a live session for, and waiting five real minutes for it would make the gate unrunnable.
    retentionMs: 1,
  })
  const liveView = composeLiveView({
    sessions,
    origin: () => boundOrigin,
  })

  const { agentHost, host } = composeDashboardDoor({
    agentQaRoot,
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
      validate: (token, expectation) => liveView.validate(token, expectation),
      mintLiveUrl: async (id, handle) => RunsLiveUrlResultSchema.parse(
        await invokeFunction(host.registry as FunctionRegistry, RUNS_LIVE_URL_FUNCTION_ID, { runId: id, handle }, DASHBOARD_FUNCTION_CALLER),
      ),
    },
  })
  const address = started.server.address()
  if (address === null || typeof address === 'string') throw new TypeError('the server bound no port')
  boundOrigin = `http://127.0.0.1:${String(address.port)}`

  // Over `host.registry`, so a `ui://` mint is signed by the signer the frame proxy checks against.
  const masking = composeMcpMasking({ configPath })
  const mcpServer = createServer(
    createMcpHttpRequestListener({
      registry: host.registry as FunctionRegistry,
      maskText: (text: string) => masking.mask(text),
      liveLink: { dashboardBaseUrl: () => boundOrigin },
    }),
  )
  await new Promise<void>((listening) => mcpServer.listen(0, '127.0.0.1', () => listening()))
  const mcpPort = (mcpServer.address() as AddressInfo).port

  let browser: Browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    started.close()
    await new Promise<void>((closed) => mcpServer.close(() => closed()))
    throw new Error(`${BROWSER_INSTALL_INSTRUCTION} underlying error: ${error instanceof Error ? error.message : String(error)}`)
  }

  // WAIT FOR THE MEMBER'S BROWSER TO DECLARE ITS SCREENCAST, and say why the wait is here.
  //
  // There is a real window between "the session exists" and "the member's Chromium has registered
  // its screencast" — the PRODUCT'S own start-up ordering, which `live-view-tracer.test.ts` owns and
  // deliberately exercises by polling the mint route inside its cells. It is not this file's
  // subject: reading the App during that window mints a `liveUrl` for a handle that still declares
  // `none`, the frozen embed page correctly says `no-stream`, and a harness that treated that as its
  // answer would report a NOT-YET as a broken render leg (measured — it is the first thing this file
  // did). So the wait is here, once, on the session's own capability rather than on a sleep, and it
  // reads the capability rather than minting one: a poll that minted would register a token with the
  // masker on every iteration for no reason.
  const streamDeadline = Date.now() + 120_000
  const declared: string[] = []
  for (;;) {
    const capability = session.streamCapabilityOf(0)
    declared.push(capability.kind)
    if (capability.kind === 'cdp-screencast') break
    if (Date.now() > streamDeadline) {
      throw new Error(
        `the harness member never declared a screencast within 120s; answers=${JSON.stringify(declared)}`,
      )
    }
    await new Promise((tick) => setTimeout(tick, 250))
  }

  fixture = {
    origin: boundOrigin,
    mcpUrl: `http://127.0.0.1:${String(mcpPort)}/mcp`,
    runId,
    session,
    registry: host.registry as FunctionRegistry,
    browser,
    targetUrl: page.url,
    navigateTarget: async (url) => { await adapter.execute({ type: 'navigate', to: 'url', url }) },
    finishRun,
    close: async () => {
      finishRun()
      await session.done.catch(() => undefined)
      if (adapterUp) await adapter.cleanup().catch(() => undefined)
      await browser.close()
      await new Promise<void>((closed) => mcpServer.close(() => closed()))
      started.close()
      sessions.dispose()
      await host.close()
      db.close()
      rmSync(configDir, { recursive: true, force: true })
      delete process.env[TOKEN_ENV_VAR]
    },
  }
}, 240_000)

afterAll(async () => {
  const held = fixture
  fixture = undefined
  if (held !== undefined) await held.close().catch(() => undefined)
  await targetPage?.close().catch(() => undefined)
  targetPage = undefined
  for (const server of openServers.splice(0)) {
    await new Promise<void>((closed) => server.close(() => closed()))
  }
})

const held = (): Fixture => {
  if (fixture === undefined) throw new Error('the harness fixture never came up')
  return fixture
}

// ---- The MCP client leg ------------------------------------------------------------------------

/**
 * Connect the SHIPPED client with a bearer, on the modern era, declaring (or withholding) the
 * Apps extension.
 */
async function connectClient(options: { readonly apps: boolean }): Promise<Client> {
  const bearerFetch = (async (input: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${TOKEN_VALUE}`)
    return await fetch(input as string, { ...init, headers })
  }) as typeof fetch

  const client = new Client(
    { name: 'agent-qa-408-06-app-host-harness', version: '0.0.0' },
    {
      // Plan 02 D-G: the per-request capabilities envelope exists ONLY on the modern era.
      versionNegotiation: { mode: 'auto' as const },
      ...(options.apps ? { capabilities: { extensions: { [MCP_APPS_EXTENSION_ID]: {} } } } : {}),
    },
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(held().mcpUrl), { fetch: bearerFetch }))
  return client
}

interface ServedApp {
  readonly html: string
  readonly mimeType: string
  readonly csp?: ServedCsp
}

/** Read the concrete App resource for this run, over the wire, as an Apps-negotiating host would. */
async function readServedApp(): Promise<ServedApp> {
  const client = await connectClient({ apps: true })
  try {
    const result = await client.readResource({ uri: appResourceUriFor(held().runId) })
    const contents = result.contents as readonly {
      readonly text?: string
      readonly mimeType?: string
      readonly _meta?: { readonly ui?: { readonly csp?: ServedApp['csp'] } }
    }[]
    expect(contents, 'the App read answered exactly one content item').toHaveLength(1)
    const first = contents[0] as NonNullable<(typeof contents)[number]>
    return {
      html: first.text ?? '',
      mimeType: first.mimeType ?? '',
      ...(first._meta?.ui?.csp === undefined ? {} : { csp: first._meta.ui.csp }),
    }
  } finally {
    await client.close().catch(() => {})
  }
}

// ---- The Apps HOST page ------------------------------------------------------------------------

// Served over http, not `srcdoc`, because a CSP response header is how a policy is enforced.
async function appsHost(served: ServedApp, hostAllowances: HostAllowances): Promise<string> {
  const csp = hostCspFor(served.csp, hostAllowances)
  const hostPage = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>apps host</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
</head><body>
<iframe data-apps-host-frame sandbox="allow-scripts" src="/app"></iframe>
<script>
  // The host side of the postMessage bridge, recorded rather than answered: this harness asserts
  // WHAT the App says on ui/initialize, and a wrapper that renders no run state of its own needs
  // nothing back from a host to reach its states.
  window.__uiMessages = [];
  window.addEventListener('message', function (event) { window.__uiMessages.push(event.data); });
</script>
</body></html>
`
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/app')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': csp,
      })
      res.end(served.html)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(hostPage)
  })
  openServers.push(server)
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/host`
}

/**
 * The wrapper's own frame inside the host page.
 *
 * POLLED, because a sub-frame's url is `''` until it has actually navigated and `goto` resolves on
 * the HOST document. The first attempt at this file read the frame list once and found a nameless
 * empty frame — the harness racing the browser, not a defect in the App.
 */
async function wrapperFrame(page: Page, budgetMs = 30_000): Promise<Frame> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const found = page.frames().find((frame) => frame.url().endsWith('/app'))
    if (found !== undefined) return found
    if (Date.now() > deadline) {
      throw new Error(
        `no wrapper frame within ${String(budgetMs)}ms; `
        + `frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
      )
    }
    await page.waitForTimeout(50)
  }
}

/** The NESTED embed frame — the frozen 403 page — found by its own served path. */
async function embedFrame(page: Page, budgetMs = 40_000): Promise<Frame> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const found = page.frames().find((frame) => frame.url().includes(LIVE_EMBED_PATH_PREFIX))
    if (found !== undefined) return found
    if (Date.now() > deadline) {
      throw new Error(
        `no embed frame appeared within ${String(budgetMs)}ms; `
        + `frames: ${JSON.stringify(page.frames().map((f) => f.url().split('#')[0]))}`,
      )
    }
    await page.waitForTimeout(100)
  }
}

/** The embed page's own painted-frame counter, read through the frame hierarchy. */
async function paintedFrames(frame: Frame): Promise<number> {
  return await frame.evaluate(
    () => Number(document.querySelector('[data-embed-state]')?.getAttribute('data-embed-frames') ?? '0'),
  )
}

/**
 * Open the host page, wait for the wrapper to SETTLE, and answer the state it settled in.
 *
 * IT WAITS FOR ANY SETTLED STATE, NOT FOR `live`, and that is deliberate. A `waitFor('[live]')` that
 * times out reports sixty seconds of silence — it cannot say that the document reached
 * `unreachable-origin` in 300 ms and sat there, which is the single most informative thing about a
 * CSP-blocked probe. Every browser console line is captured with it, because a CSP refusal announces
 * itself there and nowhere else.
 */
async function openWrapper(page: Page, url: string): Promise<{
  readonly frame: Frame
  readonly state: string
  readonly console: readonly string[]
}> {
  const consoleLines: string[] = []
  page.on('console', (message) => { consoleLines.push(`${message.type()}: ${message.text()}`) })
  page.on('pageerror', (error) => { consoleLines.push(`pageerror: ${error.message}`) })

  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const frame = await wrapperFrame(page)
  await frame.waitForFunction(
    () => {
      const state = document.querySelector('[data-app-state]')?.getAttribute('data-app-state')
      return state !== null && state !== undefined && state !== 'connecting'
    },
    undefined,
    { timeout: 60_000 },
  )
  const state = await frame.locator('[data-app-state]').getAttribute('data-app-state')
  return { frame, state: state ?? '(none)', console: consoleLines }
}

// A cross-package import resolves to `dist`, so a stale mcp build makes these claims test old code.

const MCP_PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../mcp')
const MCP_ARTIFACT = resolve(MCP_PACKAGE_DIR, 'dist/index.js')
const REBUILD_INSTRUCTION = 'run `pnpm build` from the workspace root (a per-package rebuild is NOT '
  + 'enough for a cross-package harness — 408-03 measured that)'

describe('this file measures a FRESH artifact', () => {
  it('(0) reads a build no older than the sources it measures', () => {
    const artifact = statSync(MCP_ARTIFACT).mtimeMs
    for (const source of ['src/app-resource.ts', 'src/app-wrapper.ts', 'src/catalog.ts', 'src/live-link.ts', 'src/projection.ts']) {
      const path = resolve(MCP_PACKAGE_DIR, source)
      expect(
        statSync(path).mtimeMs <= artifact,
        `${source} is newer than the built mcp package — ${REBUILD_INSTRUCTION}`,
      ).toBe(true)
    }
  })
})

// ---- LEG 1: negotiate, list, call, read --------------------------------------------------------

describe('leg 1 — a negotiating host reaches the App over the wire', () => {
  it('(1) the client really negotiated the MODERN era, which is what makes the App obtainable', async () => {
    const client = await connectClient({ apps: true })
    try {
      // NOT DECORATION. `@modelcontextprotocol/client@2.0.0` DEFAULTS to the legacy 2025 handshake,
      // and on that era it sends no per-request client capabilities at all — so the App's
      // negotiation gate correctly refuses, and a harness that never checked would report the
      // phase's central feature as broken. Asserting the era here is what stops that.
      expect(client.getProtocolEra()).toBe('modern')
      expect(client.getNegotiatedProtocolVersion()).toBeDefined()
    } finally {
      await client.close().catch(() => {})
    }
  }, 60_000)

  it('(2) tools/list advertises the App TEMPLATE on the declared carriers, and on nothing else', async () => {
    const client = await connectClient({ apps: true })
    try {
      const listed = await client.listTools()
      const carriers = listed.tools
        .filter((tool) => (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri !== undefined)
        .map((tool) => tool.name)
        .sort()

      // ENUMERATED FROM THE WIRE, then checked for shape rather than for a hardcoded pair — the
      // pair itself is pinned by the mcp package's own carrier census, and restating it here would
      // be a second copy free to disagree with it.
      expect(carriers.length, 'at least one tool carries the App reference').toBeGreaterThan(0)
      for (const name of carriers) {
        const tool = listed.tools.find((candidate) => candidate.name === name)
        const uri = (tool?._meta as { ui: { resourceUri: string } }).ui.resourceUri
        expect(uri, 'the LISTING advertises the template, not a run-specific address')
          .toBe(APP_RESOURCE_URI_TEMPLATE)
      }
      expect(carriers.length, 'and not every tool carries it').toBeLessThan(listed.tools.length)
    } finally {
      await client.close().catch(() => {})
    }
  }, 60_000)

  it('(3) a carrier CALL for the REAL running run carries the link-out line and the concrete address', async () => {
    const client = await connectClient({ apps: true })
    try {
      const result = await client.callTool({
        name: 'agent_qa_get_run_digest',
        arguments: { runId: held().runId },
      })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)

      // Tool-result text, which SEP-1730 obliges hosts to render, carries the permanent link.
      const text = (result.content as readonly { type: string; text?: string }[])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
      const expectedLink = liveRunLinkOf(held().origin, held().runId)
      expect(text).toContain(liveLinkLine(expectedLink))
      expect(expectedLink).not.toContain('#')
      expect(expectedLink).not.toContain('?')

      const meta = result._meta as { ui?: { resourceUri?: string } } | undefined
      expect(meta?.ui?.resourceUri).toBe(appResourceUriFor(held().runId))
      expect(meta?.ui?.resourceUri).not.toBe(APP_RESOURCE_URI_TEMPLATE)
    } finally {
      await client.close().catch(() => {})
    }
  }, 90_000)

  it('(4) resources/read of that address serves the App, typed and scoped to the served origin', async () => {
    const served = await readServedApp()

    // The mime type the Apps extension defines, pinned in `ext-apps-constants.test.ts` against the
    // official package — here it is asserted on the WIRE.
    expect(served.mimeType).toBe(APP_RESOURCE_MIME_TYPE)

    // The only allowed frame origin is the minted link's own, which is this server's bound origin.
    expect(served.csp?.frameDomains).toEqual([held().origin])

    // The origin probe is a `fetch`, so with no `connectDomains` the App gets `connect-src 'none'`.
    expect(served.csp?.connectDomains).toEqual([held().origin])
    expect(served.csp?.connectDomains).toEqual(served.csp?.frameDomains)

    expect(served.html).toContain(`${LIVE_EMBED_PATH_PREFIX}${held().runId}#`)
  }, 90_000)

  it('(5-neg) a host that did NOT negotiate the extension cannot obtain the App at all (clause 3)', async () => {
    const client = await connectClient({ apps: false })
    try {
      // The template is advertised; what blocks the App is the read refusing before it mints.
      const templates = await client.listResourceTemplates()
      expect(
        templates.resourceTemplates.map((entry) => entry.uriTemplate),
        'the template is advertised — a host must see an App exists in order to ask for it',
      ).toContain(APP_RESOURCE_URI_TEMPLATE)

      await expect(client.readResource({ uri: appResourceUriFor(held().runId) })).rejects.toThrow()
    } finally {
      await client.close().catch(() => {})
    }
  }, 60_000)
})

describe('leg 2 — the App renders and the frames are CHANGE-DRIVEN', () => {
  it('(5) the wrapper reaches `live` in a real sandboxed iframe under its own CSP', async () => {
    const served = await readServedApp()
    // THE PERMISSIVE HOST — see `PERMISSIVE_HOST_ALLOWANCE`: this cell needs the App's own inline
    // script to run, and that grant is an ASSUMPTION about real hosts, not something the served
    // metadata asked for. Named here so the cell states its own preconditions.
    const url = await appsHost(served, PERMISSIVE_HOST_ALLOWANCE)
    const page = await held().browser.newPage()
    try {
      const opened = await openWrapper(page, url)
      const wrapper = opened.frame

      expect(
        opened.state,
        `the wrapper settled in \`${opened.state}\` under the CSP its own metadata asked for `
        + `(${hostCspFor(served.csp, PERMISSIVE_HOST_ALLOWANCE)}). `
        + `Browser console: ${JSON.stringify(opened.console)}`,
      ).toBe('live')
      expect(await wrapper.locator('[data-app-state]').getAttribute('data-app-run-id')).toBe(held().runId)

      // The handshake the page really posted, validated against the OFFICIAL required-param list.
      // A5's whole risk is that these spellings drift silently; this is where a drift is loud.
      const messages = await page.evaluate(() => (window as unknown as { __uiMessages: unknown[] }).__uiMessages)
      const init = (messages as { method?: string; params?: Record<string, unknown> }[])
        .find((message) => message?.method === 'ui/initialize')
      expect(init, 'the App announced itself to its host').toBeDefined()
      for (const param of UI_INITIALIZE_REQUIRED_PARAMS) {
        expect(
          Object.hasOwn(init?.params ?? {}, param),
          `the official ext-apps schema requires ui/initialize.params.${param}`,
        ).toBe(true)
      }
      expect((init?.params as { protocolVersion?: string }).protocolVersion)
        .toBe(APP_WRAPPER_UI_PROTOCOL_VERSION)
      expect((init?.params as { appInfo?: { name?: string } }).appInfo?.name)
        .toBe(APP_WRAPPER_APP_NAME)
    } finally {
      await page.close()
    }
  }, 180_000)

  it('(6) frames PAINT through the nested embed while the page changes, and slow to the 2 s keepalive while it is static', async () => {
    const served = await readServedApp()
    // THE PERMISSIVE HOST, for the same reason cell (5) names: the frame counter this arm reads is
    // maintained by the App's own inline script, so this cell cannot exist on a host that runs none.
    const url = await appsHost(served, PERMISSIVE_HOST_ALLOWANCE)
    const page = await held().browser.newPage()
    try {
      const opened = await openWrapper(page, url)
      expect(
        opened.state,
        `the wrapper settled in "${opened.state}"; console: ${JSON.stringify(opened.console)}`,
      ).toBe('live')

      // The embed page's state and counter are read through the nested frame hierarchy.
      const embed = await embedFrame(page)
      // SETTLED-STATE FIRST, then the assertion — same reason as cell (5)'s: `refused`, `no-stream`
      // and `expired` are all things the frozen embed page says out loud, and a bare
      // `waitFor('[live]')` would report sixty seconds of silence instead of the word it printed.
      await embed.waitForFunction(
        () => {
          const state = document.querySelector('[data-embed-state]')?.getAttribute('data-embed-state')
          return state !== null && state !== undefined && state !== 'connecting'
        },
        undefined,
        { timeout: 60_000 },
      ).catch(() => undefined)
      const embedState = await embed.locator('[data-embed-state]').getAttribute('data-embed-state')
      expect(
        embedState,
        `the nested embed settled in "${String(embedState)}"; console: ${JSON.stringify(opened.console)}`,
      ).toBe('live')
      await embed.waitForFunction(
        () => Number(document.querySelector('[data-embed-state]')?.getAttribute('data-embed-frames') ?? '0') >= 1,
        undefined,
        { timeout: 60_000 },
      )

      // THE POSITIVE ARM. The run's real browser is on `?animate=1`, so the compositor is producing.
      const beforeChanging = await paintedFrames(embed)
      await page.waitForTimeout(CHANGING_WINDOW_MS)
      const afterChanging = await paintedFrames(embed)
      const changingDelta = afterChanging - beforeChanging
      expect(
        changingDelta,
        `the watched page was animating for ${String(CHANGING_WINDOW_MS)}ms and the embed painted `
        + `${String(changingDelta)} frame(s) — a live view that paints nothing while its target moves `
        + 'is the blank pane this whole phase exists to remove',
      ).toBeGreaterThan(0)

      // The static page should get only the 2 s keepalive; a 1 s screenshot poller breaks the band.
      await held().navigateTarget(held().targetUrl)
      await page.waitForTimeout(STATIC_SETTLE_MS)
      const beforeStatic = await paintedFrames(embed)
      await page.waitForTimeout(STATIC_WINDOW_MS)
      const afterStatic = await paintedFrames(embed)
      const staticDelta = afterStatic - beforeStatic
      expect(
        staticDelta,
        `the watched page was static for ${String(STATIC_WINDOW_MS)}ms and the embed painted `
        + `${String(staticDelta)} frame(s) — below ${String(STATIC_MIN_FRAMES)} the keepalive went `
        + 'silent on a healthy page (428 D-15)',
      ).toBeGreaterThanOrEqual(STATIC_MIN_FRAMES)
      expect(
        staticDelta,
        `the watched page was static for ${String(STATIC_WINDOW_MS)}ms and the embed painted `
        + `${String(staticDelta)} frame(s) — above ${String(STATIC_MAX_FRAMES)} the producer is `
        + 'emitting faster than the 2 s keepalive, i.e. polling (403-02 D-7, 428 D-15)',
      ).toBeLessThanOrEqual(STATIC_MAX_FRAMES)
    } finally {
      await page.close()
    }
  }, 300_000)
})

// No `resourceDomains` is emitted, so a literal host serves `script-src 'none'`: markup only.

describe("leg 2b — a host running none of the App's script still hands the person the way out", () => {
  it('(6-noscript) under `script-src \'none\'` the permanent link and a named sentence are still there', async () => {
    const served = await readServedApp()

    // THE POINT OF THE CELL, asserted before the render: this server names no `resourceDomains`, so
    // the schema's own rule is what produces `script-src 'none'` — the harness is not inventing a
    // hostile host, it is applying the documented secure default to the metadata really served.
    expect(served.csp?.resourceDomains, 'this App is wholly inline and names no resource domains')
      .toBeUndefined()
    const policy = hostCspFor(served.csp, NO_HOST_ALLOWANCE)
    expect(policy, `derived policy: ${policy}`).toContain("script-src 'none'")
    expect(policy, `derived policy: ${policy}`).toContain("style-src 'none'")

    const url = await appsHost(served, NO_HOST_ALLOWANCE)
    const page = await held().browser.newPage()
    const consoleLines: string[] = []
    page.on('console', (message) => { consoleLines.push(`${message.type()}: ${message.text()}`) })
    page.on('pageerror', (error) => { consoleLines.push(`pageerror: ${error.message}`) })
    try {
      // NOT `openWrapper`: that helper waits for a SETTLED (non-`connecting`) state, and settling is
      // exactly the thing this document cannot do here. Waiting for it would report a timeout where
      // the honest reading is "it stayed where the server rendered it".
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      const wrapper = await wrapperFrame(page)
      await wrapper.locator('[data-app-state]').waitFor({ state: 'attached', timeout: 30_000 })

      // (a) THE WAY OUT — one anchor, complete, from markup alone. `liveRunLinkOf` is the composer
      // the tool-result line uses too, so this is the same tokenless address a person is given in
      // chat, not a second spelling of it.
      const links = wrapper.locator('[data-app-permanent-link]')
      expect(await links.count(), 'exactly one permanent-link anchor, composed by the renderer')
        .toBe(1)
      expect(
        await links.getAttribute('href'),
        'the href is in the MARKUP (408-11 task 1) — a host that runs no script still has it',
      ).toBe(liveRunLinkOf(held().origin, held().runId))
      expect(await links.textContent()).toBe(APP_WRAPPER_PERMANENT_LINK_LABEL)

      // (b) THE SENTENCE — against the exported constants, never a transcription. The hint is what
      // stops `connecting` from being an indefinite promise made by a script that will never run.
      expect(await wrapper.locator('[data-app-message]').textContent())
        .toBe(APP_WRAPPER_CONNECTING_MESSAGE)
      expect(await wrapper.locator('[data-app-hint]').textContent())
        .toBe(APP_WRAPPER_CONNECTING_HINT)

      // Waits out the document's own load bound: a running script would have settled inside it.
      await page.waitForTimeout(APP_WRAPPER_LOAD_TIMEOUT_MS + 2_000)
      expect(
        await wrapper.locator('[data-app-state]').getAttribute('data-app-state'),
        `the wrapper under \`${policy}\` should still be in its server-rendered state — `
        + `console: ${JSON.stringify(consoleLines)}`,
      ).toBe('connecting')
      expect(await wrapper.locator('[data-app-state="live"]').count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 180_000)
})

// Last, because finishing the run breaks every cell above that needs it live.

describe('leg 3 — a late attach to a finished run gets the honest terminal answer', () => {
  it('(7) once the run has settled, the SAME address serves `run-ended` with the permanent link', async () => {
    held().finishRun()
    await held().session.done.catch(() => undefined)
    // The retention window (1 ms, see the fixture) has to actually elapse before the registry drops
    // the handle, so the wait is on the observable answer rather than on a sleep somebody tuned.
    await new Promise((tick) => setTimeout(tick, 250))

    const served = await readServedApp()

    // No mint means not live, and a document with no pane holds no credential; both are asserted.
    expect(served.html).not.toContain(`${LIVE_EMBED_PATH_PREFIX}${held().runId}#`)
    expect(served.csp?.frameDomains, 'no inner frame, so no frame allowance is emitted').toBeUndefined()

    // THE PERMISSIVE HOST, unchanged in meaning from before `hostAllowances` existed — this cell's
    // subject is the terminal ANSWER, not the host's script policy, so it keeps the host it had.
    const url = await appsHost(served, PERMISSIVE_HOST_ALLOWANCE)
    const page = await held().browser.newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      const wrapper = await wrapperFrame(page)
      await wrapper.locator('[data-app-state="run-ended"]').waitFor({ state: 'attached', timeout: 30_000 })

      // The sentence a person reads, against the constant the page renders — never a transcription.
      expect(await wrapper.locator('[data-app-message]').textContent())
        .toBe(APP_WRAPPER_RUN_ENDED_MESSAGE)

      // The permanent link is tokenless, so it outlives the credential and the minting process.
      const link = wrapper.locator('[data-app-permanent-link]')
      expect(await link.getAttribute('href')).toBe(liveRunLinkOf(held().origin, held().runId))
    } finally {
      await page.close()
    }
  }, 180_000)
})
