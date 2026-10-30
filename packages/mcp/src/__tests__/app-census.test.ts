// Carriers are derived from the table and `tools/list`; an App-less host gets the link, no App.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server as NodeHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  type FunctionDeclaration,
  type FunctionDeps,
  type FunctionRegistry,
  type LiveViewPort,
} from '@vostride/agent-qa-agent'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRunId,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  LiveUrlSigner,
  RunEventEnvelope,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  APP_RESOURCE_URI_TEMPLATE,
  MCP_APPS_EXTENSION_ID,
  appResourceUriFor,
} from '../app-resource.js'
import { buildAgentQaMcpServer } from '../catalog.js'
import { createAgentQaMcpNodeHandler } from '../http.js'
import { LIVE_LINK_ABSENT_LINE, liveLinkLine, liveRunLinkOf } from '../live-link.js'
import { AGENT_QA_TOOL_PROJECTIONS } from '../mapping.js'
import type { ToolProjection } from '../mapping.js'

// ---- Shared fixture vocabulary -----------------------------------------------------------------

const FIXTURE_RUN_ID = 'run-408-04-census'
const FIXTURE_ORIGIN = 'http://127.0.0.1:7793'
const SIGNING_KEY = 'zz-408-04-app-census-signing-key'
const DASHBOARD_BASE = 'http://localhost:4108'
const HANDLES: readonly number[] = [0]

// The retired scope names are spelled by hand and cast past the type; nothing reads them.
const EVERY_SCOPE: readonly string[] = [
  'read', 'run', 'config-write', 'knowledge-write', 'approval-write', 'test-write',
]

const callerWith = (grantedScopes: readonly string[]): FunctionCaller => ({
  surface: 'mcp',
  grantedScopes,
  safeMode: false,
  origin: 'agent',
}) as FunctionCaller

const identity = (text: string): string => text

/** Empty deps: a listing reads deps only for each op's binding status, not for which ops exist. */
function builtInRegistry(): FunctionRegistry {
  return createFunctionRegistry({ deps: {} as unknown as FunctionDeps })
}

const openServers: NodeHttpServer[] = []
const openClients: Client[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// ---- 1 & 2. The census, derived from BOTH sides -------------------------------------------------

interface AdvertisedTool {
  readonly name: string
  readonly _meta?: { readonly ui?: { readonly resourceUri?: unknown } }
}

/**
 * Read `tools/list` off a real build through the SDK's own in-process driver.
 *
 * The socket is the only thing replaced — the same idiom `projection-fidelity.test.ts` uses, and
 * for its reason: a cell asserting against a hand-assembled listing measures this file's idea of
 * the protocol rather than the protocol. The wire era is irrelevant HERE (a tool's `_meta` rides
 * every era); it is load-bearing only for the negotiation cells below, which use a real socket.
 */
async function advertisedTools(): Promise<readonly AdvertisedTool[]> {
  const handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry: builtInRegistry(),
      caller: callerWith(EVERY_SCOPE),
      maskText: identity,
    }),
  )
  const client = new Client({ name: 'agent-qa-408-04-census', version: '0.0.0' })
  openClients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://census.local/mcp'), {
      fetch: ((url: URL | string, init?: RequestInit) =>
        handler.fetch(new Request(url, init))) as typeof fetch,
    }),
  )
  return (await client.listTools()).tools as unknown as readonly AdvertisedTool[]
}

/** The carriers as the TABLE declares them. */
const declaredCarriers = (): readonly ToolProjection[] =>
  AGENT_QA_TOOL_PROJECTIONS.filter((projection) => projection.ui !== undefined)

describe('which tools carry the App is census-pinned DATA', () => {
  it('the carrier set derived from the table equals the set the WIRE advertises', async () => {
    const fromTable = declaredCarriers()
      .map((projection) => projection.name)
      .sort()

    const fromWire = (await advertisedTools())
      .filter((tool) => typeof tool._meta?.ui?.resourceUri === 'string')
      .map((tool) => tool.name)
      .sort()

    // The one literal in this cell, and it is the anti-vacuity pin rather than the census: two
    // empty sets are equal, which is how a derived census reports a surface that vanished.
    expect(fromTable.length, 'no tool declares the App at all — the census is over an empty set')
      .toBeGreaterThan(0)

    // Derived twice, compared once. A row without a `_meta` derivation, or a `_meta` without a
    // row, is a difference between these two lists and nothing else has to be updated to see it.
    expect(fromWire, 'the table and the advertised document disagree about the App carriers')
      .toEqual(fromTable)

    // And every advertised reference is the ONE published template, not a second spelling.
    for (const tool of await advertisedTools()) {
      if (tool._meta?.ui === undefined) continue
      expect(tool._meta.ui.resourceUri, tool.name).toBe(APP_RESOURCE_URI_TEMPLATE)
    }
  })

  it('every carrier\'s runIdFrom agrees with what its own OPS can answer', () => {
    const declared: ReadonlyMap<string, FunctionDeclaration> = new Map(
      builtInRegistry()
        .list(callerWith(EVERY_SCOPE))
        .map((declaration) => [declaration.id, declaration]),
    )

    const carriers = declaredCarriers()
    expect(carriers.length, 'nothing to check — see the carrier-set cell').toBeGreaterThan(0)

    for (const projection of carriers) {
      // A carrier is a 1:1 tool over one op today. Asserted rather than assumed, because the rule
      // below reads THE op's declaration and a fold would make "the op" ambiguous.
      expect(projection.ops, `${projection.name} carries the App over more than one op`)
        .toHaveLength(1)
      const declaration = declared.get(projection.ops[0]!)
      expect(declaration, `${projection.name} names an op the registry does not declare`)
        .toBeDefined()

      // An op that makes the run finds its id in its output; a read is told it, so in its input.
      const makesTheRun = declaration!.risk.readOnly !== true
      expect(projection.ui?.runIdFrom, `${projection.name} reads its runId off the wrong source`)
        .toBe(makesTheRun ? 'output' : 'input')

      // One template, named by the declaration rather than by a per-carrier string.
      expect(projection.ui?.resource, projection.name).toBe('live-run')
    }

    // The rule DISCRIMINATES: both arms are exercised by the shipped table, so a cell that
    // answered the same source for everything could not pass here.
    const sources = new Set(carriers.map((projection) => projection.ui?.runIdFrom))
    expect(sources, 'every carrier reads the same source — the rule is untested on one arm')
      .toEqual(new Set(['input', 'output']))
  })
})

// ---- 3 & 4. The App-less path, on the wire -------------------------------------------------------

function fixtureSigner(): LiveUrlSigner {
  return {
    sign: (data) => createHmac('sha256', SIGNING_KEY).update(data).digest('base64url'),
    equals: (a, b) => {
      const left = Buffer.from(a)
      const right = Buffer.from(b)
      return left.length === right.length && timingSafeEqual(left, right)
    },
  }
}

const runStartedEnvelope = (): RunEventEnvelope => ({
  seq: 1,
  ts: 1_800_000_000_000,
  runId: FIXTURE_RUN_ID,
  type: 'runStarted',
  payload: {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { tier: 'test', key: 'TST-408-04' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    memberTestCount: HANDLES.length,
    handles: [...HANDLES],
  },
})

function handoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(FIXTURE_RUN_ID),
    scope: { tier: 'product', key: 'app-census' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_app_census',
        testName: 'a member this fixture recorded',
        filePath: 'tests/app-census.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      },
    ],
  }
}

// A bound live view with a real signer, so an App-less cell measures negotiation, not the floor.
function liveRegistry(): FunctionRegistry {
  // Real clock: the read renders with `Date.now()`, so a fixed epoch expires the render later.
  let clock = Date.now()
  const liveView: LiveViewPort = {
    signer: fixtureSigner(),
    origin: () => FIXTURE_ORIGIN,
    now: () => (clock += 1),
    capabilityOf: (runId, handle) =>
      runId === FIXTURE_RUN_ID && HANDLES.includes(handle) ? { kind: 'cdp-screencast' } : undefined,
  }

  const deps = {
    runs: {
      list: () => Promise.resolve([handoff()]),
      get: (runId: string) =>
        Promise.resolve(String(runId) === FIXTURE_RUN_ID ? handoff() : undefined),
      readEvents: (runId: string, fromSeq: number) =>
        Promise.resolve(runId === FIXTURE_RUN_ID && fromSeq <= 1 ? [runStartedEnvelope()] : []),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    runInvocation: { start: () => Promise.resolve({ runId: asRunId(FIXTURE_RUN_ID) }) },
    liveView,
  } as unknown as FunctionDeps

  return createFunctionRegistry({ deps })
}

// A real socket: the capabilities envelope arrives only over a wire, so the legs differ there.
async function serveLiveHost(options: { readonly base?: string } = {}): Promise<string> {
  const registry = liveRegistry()
  const handler = createAgentQaMcpNodeHandler(() => ({
    registry,
    caller: callerWith(['read', 'run']),
    maskText: identity,
    // `base: undefined` drops the supplier, as on a standalone host with no dashboard.
    ...(options.base === undefined ? {} : { liveLink: { dashboardBaseUrl: () => options.base } }),
  }))
  const server = createServer((req, res) => void handler(req as never, res as never))
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
}

/** The shipped client, declaring the Apps extension or deliberately declaring nothing. */
async function connect(url: string, options: { readonly apps: boolean }): Promise<Client> {
  const client = new Client(
    { name: 'agent-qa-408-04-app-less', version: '0.0.0' },
    {
      capabilities: options.apps ? { extensions: { [MCP_APPS_EXTENSION_ID]: {} } } : {},
      versionNegotiation: { mode: 'auto' as const },
    },
  )
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

interface ToolCallResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly isError?: boolean
  readonly _meta?: Record<string, unknown>
}

const textsOf = (result: ToolCallResult): readonly string[] =>
  (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '')

const resourceUriOf = (result: ToolCallResult): unknown =>
  (result._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri

async function callBothCarriers(client: Client): Promise<readonly ToolCallResult[]> {
  const started = (await client.callTool({
    name: 'agent_qa_start_run',
    arguments: { runId: FIXTURE_RUN_ID },
  })) as unknown as ToolCallResult
  const digest = (await client.callTool({
    name: 'agent_qa_get_run_digest',
    arguments: { runId: FIXTURE_RUN_ID },
  })) as unknown as ToolCallResult
  return [started, digest]
}

describe('an App-LESS host gets the link and NOT the App, in one flow', () => {
  it('link-out present AND App un-obtainable, on a host where the App really exists',
    async () => {
      const url = await serveLiveHost({ base: DASHBOARD_BASE })
      const stranger = await connect(url, { apps: false })

      // The link rides every carrier result, even for a host that negotiated nothing.
      const results = await callBothCarriers(stranger)
      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(result.isError ?? false, JSON.stringify(textsOf(result))).toBe(false)
        expect(textsOf(result), 'a carrier result reached an App-less host with no link line')
          .toContain(liveLinkLine(liveRunLinkOf(DASHBOARD_BASE, FIXTURE_RUN_ID)))
        // The advertisement is inert metadata and rides along; only the read is gated.
        expect(resourceUriOf(result)).toBe(appResourceUriFor(FIXTURE_RUN_ID))
      }

      // Half two: the App is not obtainable, refused by name before anything is minted.
      const refusal = await stranger
        .readResource({ uri: appResourceUriFor(FIXTURE_RUN_ID) })
        .then(() => undefined, (error: unknown) => error)
      expect(refusal, 'the App-less client obtained the App').toBeDefined()
      expect(String((refusal as Error).message)).toContain(MCP_APPS_EXTENSION_ID)

      // No concrete run address is enumerable, though the template itself is listed.
      const listed = JSON.stringify(await stranger.listResources())
      expect(listed, 'a concrete live-run address is enumerable').not.toContain(
        'ui://agent-qa/live-run/',
      )
      const templates = JSON.stringify(await stranger.listResourceTemplates())
      expect(templates, 'the App template stopped being discoverable — a host cannot ask for it')
        .toContain(APP_RESOURCE_URI_TEMPLATE)

      // Positive control: a negotiating client obtains the App, so the absence above is the gate's.
      const host = await connect(url, { apps: true })
      const served = (await host.readResource({
        uri: appResourceUriFor(FIXTURE_RUN_ID),
      })) as { contents: readonly { text?: string }[] }
      expect(served.contents[0]?.text ?? '', 'the App is not obtainable by ANYBODY here')
        .toContain(FIXTURE_ORIGIN)
    })

  it('with no base anywhere the line is LIVE_LINK_ABSENT_LINE verbatim — never a link to '
    + 'nothing (RESEARCH Open Question 3)', async () => {
    const url = await serveLiveHost()
    const stranger = await connect(url, { apps: false })

    for (const result of await callBothCarriers(stranger)) {
      expect(result.isError ?? false, JSON.stringify(textsOf(result))).toBe(false)
      // IMPORTED, never restated: the cell asserts the SAME string the surface prints, so a
      // reworded absence cannot pass a cell carrying yesterday's transcription.
      expect(textsOf(result)).toContain(LIVE_LINK_ABSENT_LINE)
      // And nothing that reads as an address reached the caller.
      expect(textsOf(result).some((text) => text.includes('/runs/'))).toBe(false)
      expect(textsOf(result).some((text) => text.includes('http'))).toBe(false)
    }

    // Only the link is absent; the concrete App reference still rides the result.
    const [, digest] = await callBothCarriers(stranger)
    expect(resourceUriOf(digest!)).toBe(appResourceUriFor(FIXTURE_RUN_ID))
  })
})
