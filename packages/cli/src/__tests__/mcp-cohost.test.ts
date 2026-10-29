// The mint and the frame proxy must share a composition, as each process signs with its own key.

import { createServer } from 'node:http'
import type { Server as NodeHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect as netConnect } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  createFunctionRegistry,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import {
  LIVE_LINK_ABSENT_LINE,
  MCP_APPS_EXTENSION_ID,
  appResourceUriFor,
  liveLinkLine,
  liveRunLinkOf,
} from '@vostride/agent-qa-mcp'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRunId,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  RunEventEnvelope,
  RunSession,
} from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { composeLiveView } from '../composition/live-view-composition.js'
import type { ComposedLiveView } from '../composition/live-view-composition.js'
import { createRunServiceSessionRegistry } from '../composition/run-service-session-registry.js'
import { mcpMountPlanFor, mountCoHostedMcp } from '../commands/dashboard.js'
import {
  composeMcpMasking,
  createMcpHttpRequestListener,
  MCP_HTTP_BIND_HOST,
  MCP_HTTP_DEFAULT_PORT,
} from '../commands/mcp.js'

// ---- The fixture composition — the dashboard's own, minus the database ------------------------

const RUN_ID = 'run-408-03-cohost'
const APP_URI = `ui://agent-qa/live-run/${RUN_ID}`
const TOKEN_ENV_VAR = 'AGENT_QA_408_03_COHOST_TOKEN'
const TOKEN_VALUE = 'cohost-token-408-03-not-a-real-credential'

function handoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(RUN_ID),
    scope: { tier: 'product', key: 'cohost' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_cohost',
        testName: 'the member this fixture announces',
        filePath: 'tests/cohost.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      },
    ],
  }
}

const RUN_STARTED: RunEventEnvelope = {
  seq: 1,
  ts: 1_800_000_000_000,
  runId: RUN_ID,
  type: 'runStarted',
  payload: {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { tier: 'product', key: 'cohost' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    memberTestCount: 1,
    handles: [0],
  },
} as unknown as RunEventEnvelope

/**
 * The one live session this fixture announces, published through the ONE bridge the registry
 * observes — the same route a real run reaches `createRunServiceSessionRegistry` by.
 */
const SESSION = {
  id: asRunId(RUN_ID),
  status: 'running',
  executionContext: 'local-headless',
  streamCapabilityOf: (handle: number) =>
    handle === 0 ? { kind: 'cdp-screencast' } : { kind: 'none' },
  // The registry arms its eviction window off this, so a session that never settles is a session
  // that stays attachable — which is what a RUNNING run is, and what this fixture announces.
  done: new Promise<never>(() => {}),
} as unknown as RunSession

interface Harness {
  readonly port: number
  readonly url: string
  readonly boundOrigin: string
  readonly liveView: ComposedLiveView
  close(): Promise<void>
}

let harness: Harness

beforeAll(async () => {
  // The dashboard's composition order, verbatim: the session registry first (hoisted above both
  // arms), then the live view over it with the ORIGIN AS A BOX — the port does not exist yet.
  let boundOrigin: string | undefined
  const sessions = createRunServiceSessionRegistry({
    observeSessions: (observer) => {
      observer(SESSION)
      return () => {}
    },
  })
  const liveView = composeLiveView({
    sessions,
    origin: () => boundOrigin,
  })

  // `runs.liveurl` is bound here, unlike the standalone endpoint, so the App registers at all.
  const registry: FunctionRegistry = createFunctionRegistry({
    deps: {
      runs: {
        list: () => Promise.resolve([handoff()]),
        get: (runId: string) => Promise.resolve(String(runId) === RUN_ID ? handoff() : undefined),
        readEvents: (runId: string, fromSeq: number) =>
          Promise.resolve(String(runId) === RUN_ID && fromSeq <= 1 ? [RUN_STARTED] : []),
        readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
      },
      liveView: liveView.liveView,
    } as unknown as FunctionDeps,
  })

  // The masker is the declared loader over a project config, as the dashboard composes it.
  const projectRoot = mkdtempSync(join(tmpdir(), 'agent-qa-441-07-cohost-'))
  const configPath = join(projectRoot, 'agent-qa.config.yaml')
  writeFileSync(configPath, JSON.stringify({
    workspace: {
      testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local',
    },
  }))
  writeFileSync(join(projectRoot, '.env.secrets.local'), '')
  const masking = composeMcpMasking({ configPath })

  const server: NodeHttpServer = createServer(
    createMcpHttpRequestListener({
      registry,
      maskText: (text: string) => masking.mask(text),
      // The dashboard's own supplier: no configured base in this fixture, so the bound origin is
      // what fills the absence — read PER RESULT, because the box below is assigned after listen.
      liveLink: { dashboardBaseUrl: () => boundOrigin },
    }),
  )
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()))
  const port = (server.address() as AddressInfo).port
  boundOrigin = `http://localhost:${String(port)}`

  harness = {
    port,
    url: `http://127.0.0.1:${String(port)}/mcp`,
    boundOrigin,
    liveView,
    close: async () => {
      await new Promise<void>((closed) => server.close(() => closed()))
      sessions.dispose()
      rmSync(projectRoot, { recursive: true, force: true })
    },
  }
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

/** One recorded HTTP exchange — the status line and every header, exactly as they crossed. */
interface Frame {
  readonly status: number
  readonly headerNames: readonly string[]
}

const frames: Frame[] = []

// Records every response's header names, so the CORS cell is about the wire, not a source grep.
async function connectAs(
  token: string | undefined,
  options: { readonly apps?: boolean } = {},
): Promise<Client> {
  const recordingFetch = (async (input: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
    const res = await fetch(input as string, { ...init, headers })
    frames.push({ status: res.status, headerNames: [...res.headers.keys()] })
    return res
  }) as typeof fetch

  const client = new Client(
    { name: 'agent-qa-408-03-cohost', version: '0.0.0' },
    {
      // Plan 02 D-G: the per-request capabilities envelope exists only on the modern era.
      versionNegotiation: { mode: 'auto' as const },
      ...(options.apps === false
        ? {}
        : { capabilities: { extensions: { [MCP_APPS_EXTENSION_ID]: {} } } }),
    },
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(harness.url), {
    fetch: recordingFetch,
  }))
  return client
}

/**
 * A raw request over a socket, because `fetch` refuses to let a caller set `Host`.
 *
 * The DNS-rebinding guard is a claim ABOUT the `Host` header and undici silently overwrites it, so
 * a cell built on `fetch` would assert the guard while never once presenting a bad host. Copied in
 * shape from `mcp-visibility-differential.test.ts`, which measured that the hard way.
 */
async function rawRequest(headers: Record<string, string>): Promise<{
  readonly status: number
  readonly text: string
}> {
  return await new Promise((done, failed) => {
    const socket = netConnect(harness.port, '127.0.0.1', () => {
      const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
      socket.write(
        [
          'POST /mcp HTTP/1.1',
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      )
    })
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
    })
    socket.on('error', failed)
    socket.on('end', () => {
      done({ status: Number.parseInt(buffer.split(' ')[1] ?? '0', 10), text: buffer })
    })
  })
}

// A cross-package import resolves to `dist`, so a stale mcp build makes App cells test old code.

const MCP_PACKAGE_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../mcp')
const MCP_ARTIFACT = resolvePath(MCP_PACKAGE_DIR, 'dist/index.js')
const MCP_REBUILD_INSTRUCTION = 'run `pnpm --filter @vostride/agent-qa-mcp run build`'

describe('this file measures a FRESH artifact', () => {
  it('reads a build no older than the sources it measures', () => {
    const artifact = statSync(MCP_ARTIFACT).mtimeMs
    for (const source of ['src/app-resource.ts', 'src/catalog.ts', 'src/live-link.ts']) {
      const path = resolvePath(MCP_PACKAGE_DIR, source)
      expect(
        statSync(path).mtimeMs <= artifact,
        `${source} is newer than the built mcp package — ${MCP_REBUILD_INSTRUCTION}`,
      ).toBe(true)
    }
  })
})

// The guard order, reused verbatim from the standalone listener.

describe('the mounted endpoint keeps the standalone face\'s guard order', () => {
  it('refuses a non-localhost Host with 403 forbidden_host, before anything else', async () => {
    const answer = await rawRequest({
      Host: 'attacker.example.com',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      // A legacy bearer, deliberately: the Host wall answers first, so no header a caller adds can
      // rescue a rebound name. That ordering IS the DNS-rebinding claim.
      Authorization: `Bearer ${TOKEN_VALUE}`,
    })
    expect(answer.status).toBe(403)
    expect(answer.text).toContain('forbidden_host')
  })

  it('refuses a non-localhost Origin with 403 forbidden_origin', async () => {
    const answer = await rawRequest({
      Host: `127.0.0.1:${String(harness.port)}`,
      Origin: 'https://evil.example.com',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN_VALUE}`,
    })
    expect(answer.status).toBe(403)
    expect(answer.text).toContain('forbidden_origin')
  })

  it('admits an unmatched legacy bearer past the guards like no bearer, echoing nothing', async () => {
    const answer = await rawRequest({
      Host: `127.0.0.1:${String(harness.port)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer not-the-declared-credential',
    })
    expect(answer.status).not.toBe(401)
    expect(answer.status).not.toBe(403)
    expect(answer.text).not.toContain('invalid_token')
    expect(answer.text).not.toContain('not-the-declared-credential')
  })
})

// The served token validates in this composition.

describe('a served App token validates against THIS composition\'s validator', () => {
  it('serves wrapper HTML whose liveUrl passes the composition\'s own validate', async () => {
    const client = await connectAs(TOKEN_VALUE)
    try {
      const result = await client.readResource({ uri: APP_URI })
      const contents = result.contents as readonly { uri: string; text?: string }[]
      expect(contents).toHaveLength(1)
      const html = contents[0]?.text ?? ''

      // Read the token back OUT OF THE BYTES the host would render, never out of the input the
      // renderer was handed — the claim is about what crossed the wire.
      const matches = [
        ...html.matchAll(new RegExp(`/live/${RUN_ID}#([\\w.-]+)`, 'gu')),
      ].map((match) => match[1] as string)
      expect(matches.length, 'one pane per announced handle').toBe(1)

      // A token minted in another process fails this validator, which the frame proxy shares.
      const verdict = harness.liveView.validate(matches[0] as string, {
        subject: { kind: 'run', id: RUN_ID },
        now: Date.now(),
      })
      expect(verdict.kind).toBe('ok')
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('renders the permanent-link slot, pointing at the tokenless page', async () => {
    const client = await connectAs(TOKEN_VALUE)
    try {
      const result = await client.readResource({ uri: APP_URI })
      const html = (result.contents as readonly { text?: string }[])[0]?.text ?? ''

      // The permanent link's address is in the served markup, so a host running no script has it.
      expect(html).toContain('data-app-permanent-link')
      expect(html).toContain(liveRunLinkOf(harness.boundOrigin, RUN_ID))
      // The SAME page the carrier line names — one address for one run, never two.
      expect(html).toContain(`/runs/${RUN_ID}/live`)
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('names the minted origin in the App\'s frameDomains, and nothing wider', async () => {
    const client = await connectAs(TOKEN_VALUE)
    try {
      const result = await client.readResource({ uri: APP_URI })
      const contents = result.contents as readonly {
        _meta?: { ui?: { csp?: { frameDomains?: readonly string[] } } }
      }[]
      expect(contents[0]?._meta?.ui?.csp?.frameDomains).toEqual([harness.boundOrigin])
    } finally {
      await client.close().catch(() => {})
    }
  })
})

// The carrier link, composed from the bound origin.

describe('a carrier result on this endpoint carries the link composed from the bound origin', () => {
  it('carries the link line and the concrete App address', async () => {
    const client = await connectAs(TOKEN_VALUE)
    try {
      const result = (await client.callTool({
        name: 'agent_qa_get_run_digest',
        arguments: { runId: RUN_ID },
      })) as unknown as {
        content?: readonly { type: string; text?: string }[]
        isError?: boolean
        _meta?: { ui?: { resourceUri?: unknown } }
      }

      const texts = (result.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')

      expect(result.isError ?? false, JSON.stringify(texts)).toBe(false)
      expect(texts).toContain(liveLinkLine(liveRunLinkOf(harness.boundOrigin, RUN_ID)))
      expect(texts).not.toContain(LIVE_LINK_ABSENT_LINE)
      expect(result._meta?.ui?.resourceUri).toBe(appResourceUriFor(RUN_ID))
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('carries a TOKENLESS link — the permanent page, never a minted credential', async () => {
    const client = await connectAs(TOKEN_VALUE)
    try {
      const result = (await client.callTool({
        name: 'agent_qa_get_run_digest',
        arguments: { runId: RUN_ID },
      })) as unknown as { content?: readonly { type: string; text?: string }[] }
      const line = (result.content ?? [])
        .map((part) => part.text ?? '')
        .find((text) => text.startsWith('watch live'))
      expect(line).toBeDefined()
      const url = new URL((line as string).slice((line as string).indexOf('http')))
      expect(url.pathname).toBe(`/runs/${RUN_ID}/live`)
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
    } finally {
      await client.close().catch(() => {})
    }
  })
})

// No CORS header on any answered request.

describe('the co-hosted endpoint emits no CORS header, ever (the counted-zero law)', () => {
  it('answered no request with an access-control-* header', () => {
    expect(frames.length, 'the cells above really crossed this socket').toBeGreaterThan(0)
    const offending = frames.flatMap((frame) =>
      frame.headerNames.filter((name) => name.toLowerCase().startsWith('access-control')),
    )
    expect(offending).toEqual([])
  })

  // The refusal driven here is the Origin wall's.
  it('answered no REFUSAL with one either', async () => {
    const answer = await rawRequest({
      Host: `127.0.0.1:${String(harness.port)}`,
      Origin: 'https://evil.example.com',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    })
    expect(answer.status).toBe(403)
    expect(answer.text.toLowerCase()).not.toContain('access-control')
  })
})

// The remaining source assertions each name the construct they read and their behavioural partner.

const DASHBOARD_SOURCE = readFileSync(
  resolvePath(dirname(fileURLToPath(import.meta.url)), '../commands/dashboard.ts'),
  'utf8',
)

// A legacy credential declaration, left unparsed: a leftover key cannot change the decision.
const DECLARED_TOKEN = { name: 'cohost', tokenEnvVar: TOKEN_ENV_VAR, scopes: ['read'] } as const

interface MountRow {
  readonly claim: string
  readonly config: unknown
  readonly mount: boolean
  readonly port?: number
}

// Each row is a config record in and a decision out, so an ignored `enabled: false` is caught.
const MOUNT_ROWS: readonly MountRow[] = [
  {
    claim: 'mounts when services.mcp declares a token and says nothing about enabled — an ABSENT'
      + ' enabled means ENABLED',
    config: { services: { mcp: { tokens: [DECLARED_TOKEN] } } },
    mount: true,
    port: MCP_HTTP_DEFAULT_PORT,
  },
  {
    claim: 'mounts when services.mcp is declared with no token at all (the block is the'
      + ' request; loopback and the Host/Origin guards bound the endpoint)',
    config: { services: { mcp: {} } },
    mount: true,
    port: MCP_HTTP_DEFAULT_PORT,
  },
  {
    claim: 'does NOT mount when services.mcp.enabled is the literal false, even with a token'
      + ' declared',
    config: { services: { mcp: { enabled: false, tokens: [DECLARED_TOKEN] } } },
    mount: false,
  },
  {
    claim: 'mounts when enabled is true and no token is declared — there is no bearer to match',
    config: { services: { mcp: { enabled: true, tokens: [] } } },
    mount: true,
  },
  {
    claim: 'does NOT mount for a token declared under services.dashboard.mcp, a path the mount'
      + ' never reads',
    config: { services: { dashboard: { mcp: { tokens: [DECLARED_TOKEN] } } } },
    mount: false,
  },
  {
    claim: 'does NOT mount for a config with no services block, and does not throw',
    config: {},
    mount: false,
  },
  {
    claim: 'does NOT mount for an absent config, and does not throw',
    config: undefined,
    mount: false,
  },
  {
    claim: 'binds the standalone face\'s default port when no port is declared',
    config: { services: { mcp: { tokens: [DECLARED_TOKEN] } } },
    mount: true,
    port: MCP_HTTP_DEFAULT_PORT,
  },
  {
    claim: 'falls back to the default port when the declared port is outside the schema\'s range',
    config: { services: { mcp: { tokens: [DECLARED_TOKEN], port: 70_000 } } },
    mount: true,
    port: MCP_HTTP_DEFAULT_PORT,
  },
  {
    claim: 'binds the declared port when it is an integer inside the schema\'s range',
    config: { services: { mcp: { tokens: [DECLARED_TOKEN], port: 9123 } } },
    mount: true,
    port: 9123,
  },
]

describe('the co-host mount decision is a FUNCTION of the parsed config', () => {
  for (const row of MOUNT_ROWS) {
    it(row.claim, () => {
      const plan = mcpMountPlanFor(row.config)
      expect(plan.mount).toBe(row.mount)
      if (row.port !== undefined) expect(plan.port).toBe(row.port)
    })
  }

  it('counts no token entries — one, two or an unset declaration decide the same plan, and the plan'
    + ' carries no count', () => {
    const two = mcpMountPlanFor({
      services: { mcp: { tokens: [DECLARED_TOKEN, { ...DECLARED_TOKEN, name: 'second' }] } },
    })
    const unset = mcpMountPlanFor({
      services: { mcp: { tokens: [{ name: 'ghost', tokenEnvVar: 'AGENT_QA_408_09_UNSET', scopes: ['read'] }] } },
    })
    expect(two).toEqual({ mount: true, port: MCP_HTTP_DEFAULT_PORT })
    expect(unset).toEqual(two)
    expect('tokenCount' in two).toBe(false)
  })
})

// Driven over `mountCoHostedMcp` with a real occupied ephemeral socket, not the default port.

describe('a failed bind on the optional MCP endpoint leaves the primary surface serving', () => {
  it('answers no server handle and a warning naming the MCP endpoint and the occupied port', async () => {
    const squatter = createServer(() => {})
    await new Promise<void>((bound) => squatter.listen(0, MCP_HTTP_BIND_HOST, () => bound()))
    const occupied = (squatter.address() as AddressInfo).port
    const warnings: string[] = []
    try {
      const outcome = await mountCoHostedMcp({
        server: createServer(() => {}),
        port: occupied,
        warn: (line) => warnings.push(line),
      })
      // The handle the command keeps: a failed bind leaves the dashboard serving.
      expect(outcome.server).toBeUndefined()
      expect(outcome.boundPort).toBeUndefined()
      expect(outcome.warning ?? '', 'the warning names the endpoint').toContain('MCP endpoint')
      expect(outcome.warning ?? '', 'the warning names the port').toContain(String(occupied))
      expect(warnings.join('\n'), 'and it really reached the operator').toContain('EADDRINUSE')
    } finally {
      await new Promise<void>((closed) => squatter.close(() => closed()))
    }
  })

  it('logs a socket error raised AFTER a successful listen, with exactly one handler left attached', async () => {
    const warnings: string[] = []
    const server = createServer(() => {})
    try {
      const outcome = await mountCoHostedMcp({ server, port: 0, warn: (line) => warnings.push(line) })
      expect(outcome.server).toBe(server)
      expect(outcome.boundPort ?? 0).toBeGreaterThan(0)
      // EXACTLY ONE. The listen-time handler is removed inside the `listen` callback before the
      // promise settles, and the durable one is attached in its place — so this count is the
      // behavioural form of "the rejection handler was detached on success". Two would mean the
      // old `once('error')` is still armed over a settled promise; zero would mean the emit below
      // throws, because a Node EventEmitter with no 'error' listener rethrows.
      expect(server.listenerCount('error')).toBe(1)
      server.emit('error', new Error('after-listen-boom'))
      expect(warnings.join('\n')).toContain('after-listen-boom')
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()))
    }
  })
})

// ---- 7. The two wiring facts, stated as source assertions and labelled as such -------------------

describe('the shipped dashboard composition wires and closes the endpoint', () => {
  it('SOURCE ASSERTION: the mount passes the LIVE-VIEW-BOUND registry — the wiring half,'
    + ' whose behavioural half is the served-token cell above', () => {
    // The construct read is a PROPERTY ASSIGNMENT in the `createMcpHttpRequestListener({ … })`
    // argument: `registry: runHost.registry as FunctionRegistry`. It is code, not prose.
    //
    // THE OTHER HALF IS BEHAVIOURAL AND IT IS IN THIS FILE: the cell "serves wrapper HTML whose
    // liveUrl passes the composition's own validate" reads a token back out of the bytes the host
    // would render and validates it against the composition's own validator. That cell proves the
    // CONSEQUENCE of this wiring over an equivalent composition; this line proves the SHIPPED
    // command really composes it that way. Neither alone is the whole claim.
    expect(DASHBOARD_SOURCE).toContain('registry: runHost.registry as FunctionRegistry')
  })

  it('SOURCE ASSERTION: the shutdown path closes the second server and disposes its masking —'
    + ' two method calls, in the shutdown closure and nowhere else', () => {
    // The constructs read are two METHOD CALLS inside `const shutdown = async () => { … }`.
    // Driving a real shutdown would open a database, a browser-capable execution backend and the
    // whole dashboard-server to observe them, which is why this stays a wiring assertion — said
    // out loud rather than implied. Its behavioural sibling is the bind-collision cell above,
    // which proves the same two handles are safe to leave unset.
    const shutdown = DASHBOARD_SOURCE.slice(DASHBOARD_SOURCE.indexOf('const shutdown = async ()'))
    expect(shutdown).toContain('mcpServer?.close()')
    // The co-host composes the declared mask from the project config; it holds nothing to dispose.
    expect(shutdown).not.toContain('mcpMasking')
    expect(DASHBOARD_SOURCE).toContain('composeMcpMasking({ configPath: configFilePath })')
  })
})

// A legacy declaration whose variable is set nowhere.
const UNSET_ENTRY = {
  name: 'ghost',
  tokenEnvVar: 'AGENT_QA_408_17_UNSET_TOKEN',
  scopes: ['read'],
} as const

/** The config an operator with one legacy MCP declaration and no `enabled` key has written. */
const UNSET_ENTRY_CONFIG = { services: { mcp: { tokens: [UNSET_ENTRY] } } }

describe('the co-host resolves no credentials', () => {
  it('a declared-but-unset tokenEnvVar costs nothing — the plan reads no token and no environment', () => {
    // It costs NOTHING now: the decision reads no token entry and no environment, so there is no
    // refusal to warn about and nothing to escape. The source half: no dashboard code dereferences
    // an MCP token any more.
    expect(() => mcpMountPlanFor(UNSET_ENTRY_CONFIG)).not.toThrow()
    expect(mcpMountPlanFor(UNSET_ENTRY_CONFIG)).toEqual({ mount: true, port: MCP_HTTP_DEFAULT_PORT })
    expect(DASHBOARD_SOURCE).not.toContain('resolveMcpTokens(')
    expect(DASHBOARD_SOURCE).not.toContain('coHostedMcpCredentialsFor(')
  })

  it('the co-hosted endpoint is served without a credential, and the Host/Origin guards refuse'
    + ' another origin', async () => {
    // Served without a credential; the loopback bind and the Host and Origin guards bound it.
    const client = await connectAs(undefined)
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await client.close()
    const refused = await rawRequest({
      Host: `127.0.0.1:${String(harness.port)}`,
      Origin: 'https://evil.example.com',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    })
    expect(refused.status).toBe(403)
  })

  it('services.mcp.enabled: false never reads the environment at all', () => {
    // The plan takes no environment at all, so the off switch is the WHOLE decision on this path.
    expect(mcpMountPlanFor.length).toBe(1)
    expect(mcpMountPlanFor({ services: { mcp: { enabled: false, tokens: [UNSET_ENTRY] } } }).mount).toBe(false)
    expect(mcpMountPlanFor(UNSET_ENTRY_CONFIG).mount, 'an ABSENT enabled means ENABLED').toBe(true)
  })
})

/** The standalone MCP face's own source, read the way `DASHBOARD_SOURCE` above is read. */
const MCP_COMMAND_SOURCE = readFileSync(
  resolvePath(dirname(fileURLToPath(import.meta.url)), '../commands/mcp.ts'),
  'utf8',
)

describe('neither MCP face resolves a token', () => {
  it('the standalone agent-qa mcp face reads no token declaration and resolves none', () => {
    expect(MCP_COMMAND_SOURCE).not.toContain('resolveMcpTokens(')
    expect(MCP_COMMAND_SOURCE).not.toContain('services?.mcp?.tokens')
    expect(MCP_COMMAND_SOURCE, 'and is not routed through a co-host wrapper')
      .not.toContain('coHostedMcpCredentialsFor')
  })
})
