// THE APP-ATTACHMENT CENSUS, AND THE APP-LESS NEGOTIATION PATH
// (Phase 408 plan 04 · MCPA-01 · D-05 / D-09 / D-14 · T-408-18).
//
// WHY THIS FILE EXISTS. Two standing laws D-14 requires RECORDED rather than proven once:
//
//   1. WHICH TOOLS CARRY THE APP IS DATA, and the data and the wire agree. A tool advertising
//      `_meta.ui.resourceUri` is a tool telling a host "there is a live view behind me" — which is
//      a door onto the credential channel `app-resource.ts` guards. A third one appearing quietly
//      is the failure this census exists to make loud.
//   2. AN APP-LESS HOST STILL GETS A WORKING LINK, AND STILL GETS NO APP. D-09 makes "never a
//      broken embed" structural: the link-out rides every carrier result for every host class,
//      and the App attaches only where the extension was negotiated. Both halves are asserted in
//      ONE flow here, because either alone is satisfiable by a surface that is wrong.
//
// THE 399.1 LESSON, AND WHY IT SHAPES EVERY LINE BELOW (D-05). The carrier set is DERIVED, twice,
// from shipped data — once from `AGENT_QA_TOOL_PROJECTIONS`' declared `ui` member and once from a
// driven `tools/list` document — and the two derivations are compared to each other. A cell that
// spelled the pair as two literals would agree with a mapping that had silently grown a third
// carrier, which is precisely the shape 399.1 taught: a census restated as a constant censuses the
// constant. The one thing this file DOES pin as a literal is that the derived set is not empty,
// because two empty sets are equal and that is the way a derived census lies.
//
// WHAT PLAN 02 ACTUALLY SHIPPED, AND THEREFORE WHICH BRANCH `(C3)` ASSERTS (recorded 2026-08-31,
// from 408-02-SUMMARY.md decision D-F). The plan carried a contingency: if per-request client
// capabilities turned out to be unreadable at the resource-read seam, the App-absent claim would
// have had to be asserted as an UNLISTED template plus an inert declaration — absence by
// non-enumeration. That contingency did NOT fire. The capabilities ARE readable at
// `ctx.mcpReq.envelope['io.modelcontextprotocol/clientCapabilities'].extensions`, measured over a
// real socket, so the PRIMARY branch shipped: a non-negotiated `ui://` read is REFUSED by name,
// before anything is minted. `(C3)` therefore asserts the refusal.
//
// AND MEASURING THE FALLBACK'S REACH WAS WORTH THE LINE IT COST (2026-08-31). `(C3)` also asks what
// `{ list: undefined }` alone buys, and the answer is narrower than "the address is undiscoverable":
// no CONCRETE `ui://agent-qa/live-run/<runId>` is enumerable — `resources/list` names none — but
// the TEMPLATE is advertised on `resources/templates/list`, exactly as the six entity templates
// are, and by design (a host must be able to see an App exists in order to ask for it, 408-03 D-L).
// So the contingency branch, had it fired, would NOT have made the App un-obtainable: a caller who
// read the template listing and knew any run id could have expanded it by hand. What makes the App
// un-obtainable is clause 3 of the ruling, not clause 2. That is recorded here rather than left as
// a surprise for whoever next reaches for "unlisted" as a security property.
//
// THE MODERN-ERA CONSTRAINT IS INHERITED, NOT RE-LITIGATED (408-02 D-G, WINDOWS 318). The
// negotiating control below constructs its client with `versionNegotiation: { mode: 'auto' }`
// because the capabilities envelope exists only on the 2026-07-28 wire era. Without it this file
// would measure plan 02's correct fail-closed refusal and read it as a defect.
//
// THE MUTATION LEGS, APPLIED AND THEIR REDS OBSERVED (2026-08-31) — a leg nobody ran is a leg
// nobody knows the strength of, so each was applied to its subject and the subject then restored:
//   M1  A THIRD CARRIER ROW in `mapping.ts` (`agent_qa_list_runs` given a `ui` declaration).
//       Declared with `runIdFrom: 'output'` on a read-only op -> `(C2)` red BY NAME
//       ("agent_qa_list_runs reads its runId off the wrong source"). Declared CONSISTENTLY
//       (`'input'`) it passes here — and reds `projection-fidelity.test.ts`'s pinned census
//       instead. THAT DIVISION OF LABOUR IS DELIBERATE and is why this file does not restate the
//       pair: that census owns "the carrier set may not GROW without somebody saying so"; this file
//       owns "the table and the wire may not DISAGREE", which is the failure a pin cannot see.
//   M2  `projection.ts` stops deriving `_meta` from the declaration -> `(C1)` red by name: the
//       table names two carriers and the advertised document names none.
//   M3  `app-resource.ts`'s negotiation gate short-circuited (the read serves everybody) ->
//       `(C3)` red: "the App-less client obtained the App".
//   M4  `catalog.ts`'s `liveLinkLineFor` call replaced by a bare `liveLinkLine(liveRunLinkOf(base
//       ?? '', ...))` composition -> `(C4)` red: a base-less host composes the relative fragment
//       `watch live or review: /runs/<id>/live` instead of naming the absence.

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

// 2026-10-02 (432-39, D-10/D-12): the scope union is deleted, so the retired names are spelled by
// hand here and handed to the caller as a smuggle, cast past the deleted field; nothing reads them.
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
  it('(C1) the carrier set derived from the table equals the set the WIRE advertises', async () => {
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

  it('(C2) every carrier\'s runIdFrom agrees with what its own OPS can answer', () => {
    const declared: ReadonlyMap<string, FunctionDeclaration> = new Map(
      builtInRegistry()
        .list(callerWith(EVERY_SCOPE))
        .map((declaration) => [declaration.id, declaration]),
    )

    const carriers = declaredCarriers()
    expect(carriers.length, 'nothing to check — see (C1)').toBeGreaterThan(0)

    for (const projection of carriers) {
      // A carrier is a 1:1 tool over one op today. Asserted rather than assumed, because the rule
      // below reads THE op's declaration and a fold would make "the op" ambiguous.
      expect(projection.ops, `${projection.name} carries the App over more than one op`)
        .toHaveLength(1)
      const declaration = declared.get(projection.ops[0]!)
      expect(declaration, `${projection.name} names an op the registry does not declare`)
        .toBeDefined()

      // THE RULE, DERIVED RATHER THAN TABULATED. An op that MAKES a run cannot have been told the run
      // id — the run did not exist when the caller called, so the only honest source is the op's own
      // OUTPUT. An op that merely READS about a run was told which one, so its source is the
      // validated INPUT. Plan 03's decoration trusts exactly this datum to find the concrete runId,
      // so a swapped source decorates a result with a reference to a run nobody asked about.
      // 432-20 (D-12): "makes the run" was read off the `run` scope; declarations carry no scopes,
      // so it is read off the risk descriptor — a carrier that is not a declared read made the run.
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

/**
 * A composition that CAN honestly serve the App — a bound `liveView` with a real signer.
 *
 * This is what makes `(C3)` a statement about NEGOTIATION rather than about the D-03 registration
 * floor: on a host with no live view the App is absent for every caller, so an App-less cell over
 * such a host would pass while proving nothing. The negotiating control in `(C3)` is what pins
 * that the App really is obtainable here.
 */
function liveRegistry(): FunctionRegistry {
  // WR-07, THIS FILE'S HALF (408-13; the shape 408-12 established). ANCHORED TO THE REAL CLOCK
  // rather than pinned to the literal `1_800_000_000_000`, which IS 2027-01-15T08:00:00Z: the
  // `ui://` read renders without an explicit `now`, so `renderAppWrapperPage` falls back to
  // `Date.now()`, and a fixture clock pinned to a fixed epoch silently becomes an EXPIRED render
  // once real time passes it. `(C3)`'s positive control would then assert `FIXTURE_ORIGIN` is in a
  // document that carries nothing at all — and every App-less cell above it would stop being a
  // statement about NEGOTIATION and become a statement about an empty render, which is the vacuity
  // this control exists to prevent. THE GATE ON THIS RELATIONSHIP IS `(A10)` IN
  // `token-absence.test.ts` (408-12), which renders under a stubbed system clock past 2027-01-15;
  // if you change this clock, that is where the alarm lives.
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

/**
 * Serve the shipped node handler on loopback.
 *
 * A REAL socket, for plan 02's measured reason: the per-request client-capabilities envelope the
 * negotiation gate reads is lifted by the transport, so the App-less and App-capable legs differ in
 * one observable fact only when they travel a wire.
 */
async function serveLiveHost(options: { readonly base?: string } = {}): Promise<string> {
  const registry = liveRegistry()
  const handler = createAgentQaMcpNodeHandler(() => ({
    registry,
    caller: callerWith(['read', 'run']),
    maskText: identity,
    // `base: undefined` drops the supplier ENTIRELY — the shape a standalone host with no
    // dashboard anywhere is in, which is `(C4)`'s subject.
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
  it('(C3) link-out present AND App un-obtainable, on a host where the App really exists',
    async () => {
      const url = await serveLiveHost({ base: DASHBOARD_BASE })
      const stranger = await connect(url, { apps: false })

      // HALF ONE — the link rides EVERY carrier result, for a host that negotiated nothing. This
      // is what makes "never a broken embed" structural rather than detected (D-09).
      const results = await callBothCarriers(stranger)
      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(result.isError ?? false, JSON.stringify(textsOf(result))).toBe(false)
        expect(textsOf(result), 'a carrier result reached an App-less host with no link line')
          .toContain(liveLinkLine(liveRunLinkOf(DASHBOARD_BASE, FIXTURE_RUN_ID)))
        // The advertisement is inert metadata and rides along regardless (408-03 D-L) — what is
        // gated is the READ, below.
        expect(resourceUriOf(result)).toBe(appResourceUriFor(FIXTURE_RUN_ID))
      }

      // HALF TWO — and the App is NOT obtainable. The PRIMARY branch plan 02 shipped: refused by
      // name, before anything is minted.
      const refusal = await stranger
        .readResource({ uri: appResourceUriFor(FIXTURE_RUN_ID) })
        .then(() => undefined, (error: unknown) => error)
      expect(refusal, 'the App-less client obtained the App').toBeDefined()
      expect(String((refusal as Error).message)).toContain(MCP_APPS_EXTENSION_ID)

      // WHAT `{ list: undefined }` ACTUALLY BUYS, MEASURED (2026-08-31) — and it is less than the
      // contingency branch would have needed. No CONCRETE `ui://agent-qa/live-run/<runId>` address
      // is enumerable: `resources/list` names none, so nothing can walk a listing to a readable
      // address for a particular run. The TEMPLATE, however, IS advertised on
      // `resources/templates/list`, exactly as the six entity templates are — and that is by
      // design rather than by oversight, because a host must be able to SEE that an App exists in
      // order to ask for it (408-03 D-L, the same argument that leaves `_meta` inert-but-present).
      //
      // So discovery alone would NOT have made the App un-obtainable, which is worth recording
      // here: had plan 02's contingency fired, "unlisted template + inert declaration" would have
      // left a caller who read `resources/templates/list` and knew any run id able to expand the
      // template by hand. What makes the App genuinely un-obtainable is the refusal asserted
      // immediately above — clause 3 of the ruling, not clause 2.
      const listed = JSON.stringify(await stranger.listResources())
      expect(listed, 'a concrete live-run address is enumerable').not.toContain(
        'ui://agent-qa/live-run/',
      )
      const templates = JSON.stringify(await stranger.listResourceTemplates())
      expect(templates, 'the App template stopped being discoverable — a host cannot ask for it')
        .toContain(APP_RESOURCE_URI_TEMPLATE)

      // THE POSITIVE CONTROL, and without it this whole cell is vacuous: on THIS host, a client
      // that DID negotiate obtains the App. So the absence above is the negotiation gate's doing
      // and not the D-03 registration floor's.
      const host = await connect(url, { apps: true })
      const served = (await host.readResource({
        uri: appResourceUriFor(FIXTURE_RUN_ID),
      })) as { contents: readonly { text?: string }[] }
      expect(served.contents[0]?.text ?? '', 'the App is not obtainable by ANYBODY here')
        .toContain(FIXTURE_ORIGIN)
    })

  it('(C4) with no base anywhere the line is LIVE_LINK_ABSENT_LINE verbatim — never a link to '
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

    // The absence is the LINK, not the App: the concrete reference still rides the result, because
    // a host that cannot be given a browser page can still be told an App exists (408-03 D-L).
    const [, digest] = await callBothCarriers(stranger)
    expect(resourceUriOf(digest!)).toBe(appResourceUriFor(FIXTURE_RUN_ID))
  })
})
