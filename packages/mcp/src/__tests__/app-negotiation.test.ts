// A real client over a socket: where the SDK puts declared capabilities is measured here.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server as NodeHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import type { ResourceMetadata, ResourceTemplate } from '@modelcontextprotocol/server'
import {
  RUNS_LIVE_URL_FUNCTION_ID,
  createFunctionRegistry,
  validateLiveUrlToken,
  type FunctionDeps,
  type FunctionRegistry,
  type LiveViewPort,
} from '@vostride/agent-qa-agent'
import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  FunctionCaller,
  LiveUrlSigner,
  RunEventEnvelope,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY,
  APP_RESOURCE_MIME_TYPE,
  AppResourceNegotiationError,
  MCP_APPS_EXTENSION_ID,
  createAppResourceReadHandler,
  negotiatedAppsExtension,
  registerAppResources,
  type AppReadContext,
  type AppResourceRegistrar,
} from '../app-resource.js'
import { createAgentQaMcpNodeHandler } from '../http.js'

// ---- The fixture composition -------------------------------------------------------------------

const FIXTURE_RUN_ID = 'run-negotiation'
const FIXTURE_ORIGIN = 'http://127.0.0.1:7788'
const SIGNING_KEY = 'zz-app-negotiation-signing-key'
const APP_URI = `ui://agent-qa/live-run/${FIXTURE_RUN_ID}`

/**
 * Every token this signer has ever produced, in order.
 *
 * The mint counter AND the leak corpus in one object, which is the honest shape: the two questions
 * the refusal arm has to answer are "did anything get minted?" and "did any minted byte reach the
 * caller?", and both are questions about what the SIGNER did rather than about what the handler
 * says it did.
 */
function recordingSigner(): { readonly signer: LiveUrlSigner; readonly minted: string[] } {
  const minted: string[] = []
  const signer: LiveUrlSigner = {
    sign: (data) => {
      const signature = createHmac('sha256', SIGNING_KEY).update(data).digest('base64url')
      minted.push(signature)
      return signature
    },
    equals: (a, b) => {
      const left = Buffer.from(a)
      const right = Buffer.from(b)
      return left.length === right.length && timingSafeEqual(left, right)
    },
  }
  return { signer, minted }
}

const runStartedEnvelope = (handles: readonly number[]): RunEventEnvelope => ({
  seq: 1,
  ts: 1_800_000_000_000,
  runId: FIXTURE_RUN_ID,
  type: 'runStarted',
  payload: {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { tier: 'test', key: 'TST-1' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    memberTestCount: handles.length,
    handles: [...handles],
  },
})

function fixtureRegistry(handles: readonly number[] = [0, 1]): {
  readonly registry: FunctionRegistry
  readonly minted: string[]
} {
  const { signer, minted } = recordingSigner()
  // Real clock: the renderer falls back to `Date.now()`, so a fixed epoch would expire the render.
  let clock = Date.now()

  const liveView: LiveViewPort = {
    signer,
    origin: () => FIXTURE_ORIGIN,
    now: () => (clock += 1),
    capabilityOf: (runId, handle) =>
      runId === FIXTURE_RUN_ID && handles.includes(handle) ? { kind: 'cdp-screencast' } : undefined,
  }

  const runs = {
    readEvents: async (runId: string, fromSeq: number) =>
      runId === FIXTURE_RUN_ID && fromSeq <= 1 ? [runStartedEnvelope(handles)] : [],
  }

  return {
    registry: createFunctionRegistry({
      deps: { runs, liveView } as unknown as FunctionDeps,
    }),
    minted,
  }
}

// Cells pass scope sets as strings cast past the type, to show the server reads none.
const caller = (grantedScopes?: readonly string[]): FunctionCaller =>
  grantedScopes === undefined
    ? { surface: 'mcp', origin: 'agent' }
    : ({ surface: 'mcp', origin: 'agent', grantedScopes } as FunctionCaller)

const identity = (text: string): string => text

// ---- The socket, and the two ways a client can arrive at it ------------------------------------

const openServers: NodeHttpServer[] = []
const openClients: Client[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/**
 * Serve a request listener on loopback and answer its URL.
 *
 * A REAL socket rather than the SDK's in-process `handler.fetch` driver, and the difference is the
 * measurement itself: the envelope this file is here to read is lifted by the transport, so a cell
 * that skipped the wire would be reading a shape nothing on the wire produced.
 */
async function serve(listener: (req: never, res: never) => void): Promise<string> {
  const server = createServer(listener as never)
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
}

// `mode: 'auto'` reaches the modern era, the only one that carries per-request capabilities.
async function connect(
  url: string,
  options: { readonly apps: boolean; readonly era?: 'modern' | 'legacy' } = { apps: true },
): Promise<Client> {
  const client = new Client(
    { name: 'agent-qa-negotiation', version: '0.0.0' },
    {
      capabilities: options.apps ? { extensions: { [MCP_APPS_EXTENSION_ID]: {} } } : {},
      ...(options.era === 'legacy' ? {} : { versionNegotiation: { mode: 'auto' as const } }),
    },
  )
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

// ---- 1. The measurement ----

/**
 * A registrar that WRAPS the production read to capture the context the SDK hands it.
 *
 * Deliberately a wrapper and not a replacement: the read that runs is the one
 * `registerAppResources` built, so the capture cannot drift from what the server actually serves.
 * This is also why the measurement needs no test-only hook inside `app-resource.ts` — the
 * registrar slice that module already takes IS the seam.
 */
function capturingRegistrar(
  server: McpServer,
  sink: (ctx: AppReadContext) => void,
): AppResourceRegistrar {
  return {
    registerResource(
      name: string,
      template: ResourceTemplate,
      config: ResourceMetadata,
      read: (uri: URL, variables: never, ctx: never) => unknown,
    ) {
      return server.registerResource(name, template, config, ((
        uri: URL,
        variables: never,
        ctx: AppReadContext,
      ) => {
        sink(ctx)
        return read(uri, variables, ctx as never)
      }) as never)
    },
  }
}

async function measureReadContext(options: {
  readonly apps: boolean
  readonly era?: 'modern' | 'legacy'
}): Promise<AppReadContext | undefined> {
  const { registry } = fixtureRegistry()
  let captured: AppReadContext | undefined

  const handler = toNodeHandler(
    createMcpHandler(() => {
      const server = new McpServer(
        { name: 'agent-qa', version: '2.0.0' },
        {
          capabilities: {
            resources: {},
            extensions: { [MCP_APPS_EXTENSION_ID]: {} },
          },
        },
      )
      registerAppResources(
        capturingRegistrar(server, (ctx) => {
          captured = ctx
        }),
        { registry, caller: caller(), maskText: identity },
      )
      return server
    }),
  )

  const url = await serve((req, res) => void handler(req as never, res as never))
  const client = await connect(url, options)
  await client.readResource({ uri: APP_URI }).catch(() => undefined)
  return captured
}

describe('the negotiation envelope, measured against the shipped SDK', () => {
  it('carries the client capabilities at the pinned envelope member on the modern era', async () => {
    const ctx = await measureReadContext({ apps: true })

    // The whole point of the cell: the PATH, spelled out, asserted against the wire. If the SDK
    // moves this member, `negotiatedAppsExtension` starts refusing everybody and this line is the
    // one that says why.
    const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined
    expect(envelope, 'the modern era lifts a per-request _meta envelope').toBeDefined()
    expect(
      Object.keys(envelope ?? {}),
      'the envelope names the client-capabilities member the gate reads',
    ).toContain(APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY)

    const capabilities = envelope?.[APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY] as
      | { extensions?: Record<string, unknown> }
      | undefined
    expect(capabilities?.extensions).toHaveProperty(MCP_APPS_EXTENSION_ID)

    // And the predicate agrees with the bytes — the gate reads the member this cell just measured
    // rather than a second, parallel reading of the same request.
    expect(negotiatedAppsExtension(ctx)).toBe(true)
  })

  it('carries NO capabilities for a client that declared no extension, and none at all on the legacy era', async () => {
    const declaredNothing = await measureReadContext({ apps: false })
    expect(negotiatedAppsExtension(declaredNothing)).toBe(false)

    // The default legacy era carries no per-request capabilities, so a declaring caller is refused.
    const legacy = await measureReadContext({ apps: true, era: 'legacy' })
    expect(legacy?.mcpReq?.envelope).toBeUndefined()
    expect(negotiatedAppsExtension(legacy)).toBe(false)
  })

  it('answers false for absent evidence of every shape', () => {
    expect(negotiatedAppsExtension(undefined)).toBe(false)
    expect(negotiatedAppsExtension({})).toBe(false)
    expect(negotiatedAppsExtension({ mcpReq: {} })).toBe(false)
    expect(negotiatedAppsExtension({ mcpReq: { envelope: {} } })).toBe(false)
    expect(
      negotiatedAppsExtension({
        mcpReq: { envelope: { [APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY]: {} } as never },
      }),
    ).toBe(false)
    expect(
      negotiatedAppsExtension({
        mcpReq: {
          envelope: {
            [APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY]: { extensions: { 'other/ext': {} } },
          } as never,
        },
      }),
    ).toBe(false)
  })
})

// ---- 2 & 3. The gate, over the wire, on the shipped node handler --------------------------------

async function serveAgentQa(
  handles?: readonly number[],
  grantedScopes?: readonly string[],
): Promise<{
  readonly url: string
  readonly minted: string[]
}> {
  const { registry, minted } = fixtureRegistry(handles)
  const handler = createAgentQaMcpNodeHandler(() => ({
    registry,
    caller: caller(grantedScopes),
    maskText: identity,
  }))
  const url = await serve((req, res) => void handler(req as never, res as never))
  return { url, minted }
}

describe('the ui:// read over the shipped node handler', () => {
  it('serves the App to a NEGOTIATING client, with tokens the shipped validator accepts', async () => {
    const { url, minted } = await serveAgentQa([0, 1])
    const client = await connect(url, { apps: true })

    const result = await client.readResource({ uri: APP_URI })
    const contents = result.contents as readonly {
      uri: string
      mimeType?: string
      text?: string
    }[]

    expect(contents).toHaveLength(1)
    expect(contents[0]?.mimeType).toBe(APP_RESOURCE_MIME_TYPE)
    const html = contents[0]?.text ?? ''

    // Two handles announced, so two panes were minted for THIS read.
    expect(minted).toHaveLength(2)

    // The tokens are IN the bytes the host renders — read back out of the document rather than out
    // of the input the renderer was handed — and each one goes past the SHIPPED validator.
    const liveUrls = [
      ...html.matchAll(
        new RegExp(`${FIXTURE_ORIGIN.replace(/\./g, '\\.')}/live/${FIXTURE_RUN_ID}#([\\w.-]+)`, 'g'),
      ),
    ].map((match) => match[1] as string)
    expect(liveUrls).toHaveLength(2)

    const { signer } = recordingSigner()
    for (const [index, token] of liveUrls.entries()) {
      const verdict = validateLiveUrlToken(signer, token, {
        // The fixture's own clock: a past literal would report a fresh token as `expired`.
        subject: { kind: 'run', id: FIXTURE_RUN_ID },
        now: Date.now(),
      })
      expect(
        verdict.kind,
        `pane ${index} validates against the composition's own signer`,
      ).toBe('ok')
    }
  })

  it('REFUSES a non-negotiating client by name, and mints nothing on that path', async () => {
    const { url, minted } = await serveAgentQa([0, 1])
    const client = await connect(url, { apps: false })

    await expect(client.readResource({ uri: APP_URI })).rejects.toThrow(MCP_APPS_EXTENSION_ID)

    // Refuse-before-mint means the signer is never asked, so no token exists to leak.
    expect(minted, 'a refused read mints nothing at all').toHaveLength(0)
  })

  it('leaks no minted byte on the refusal path, proven against a live mint of the same run', async () => {
    const { url, minted } = await serveAgentQa([0, 1])

    // First a NEGOTIATED read, so real tokens for this exact run exist in this process. Without it
    // the next assertion would be vacuous — you cannot fail to find bytes that were never minted.
    const negotiated = await connect(url, { apps: true })
    await negotiated.readResource({ uri: APP_URI })
    expect(minted.length).toBeGreaterThan(0)

    const refused = await connect(url, { apps: false })
    const error = await refused.readResource({ uri: APP_URI }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error, 'the non-negotiated read refuses').toBeDefined()

    const refusal = JSON.stringify(error, Object.getOwnPropertyNames(error))
    for (const token of minted) {
      expect(refusal.includes(token), 'no minted byte appears on the refusal channel').toBe(false)
    }
  })
})

// ---- 3b. The refusal happens BEFORE the mint, counted at the invocation wall --------------------

describe('the refusal arm runs before anything is invoked (acceptance: zero mint invocations)', () => {
  it('invokes NO op at all — not the roster read, and not the mint', async () => {
    const invoked: string[] = []
    const read = createAppResourceReadHandler({
      invoke: async (opId) => {
        invoked.push(opId)
        return undefined
      },
      maskText: identity,
    })

    // A context carrying no negotiation evidence: the shape a model-driven read produces.
    await expect(read(new URL(APP_URI), {}, { mcpReq: { envelope: {} } })).rejects.toBeInstanceOf(
      AppResourceNegotiationError,
    )

    expect(invoked, 'the wall is never crossed on a refused read').toEqual([])
    expect(invoked.includes(RUNS_LIVE_URL_FUNCTION_ID)).toBe(false)
  })

  it('DOES cross the wall once negotiation is evident — the counter is load-bearing', async () => {
    const invoked: string[] = []
    const read = createAppResourceReadHandler({
      invoke: async (opId) => {
        invoked.push(opId)
        // An unannounced roster (`undefined`) is the single-handle default every non-suite run is,
        // so one mint is reached — the smallest composition that proves the counter can move.
        return opId === RUNS_LIVE_URL_FUNCTION_ID
          ? {
              handle: 0,
              liveUrl: `${FIXTURE_ORIGIN}/live/${FIXTURE_RUN_ID}#v2.body.sig`,
              expiresAt: 1_800_000_300_000,
              stream: { kind: 'cdp-screencast' },
            }
          : undefined
      },
      maskText: identity,
    })

    await read(new URL(APP_URI), {}, {
      mcpReq: {
        envelope: {
          [APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY]: {
            extensions: { [MCP_APPS_EXTENSION_ID]: {} },
          },
        } as never,
      },
    })

    expect(invoked).toContain(RUNS_LIVE_URL_FUNCTION_ID)
  })
})

// ---- 4. Who may obtain a live-view credential ----

describe('who may obtain a live-view credential', () => {
  it('a caller that merely DECLARES the Apps extension DOES obtain a freshly minted credential — the RECORDED posture, because the declaration is a host-capability signal and never an authorization control', async () => {
    // THE FORGING CALLER, and it takes no forging at all: `connect(url, { apps: true })` is a stock
    // `@modelcontextprotocol/client@2.0.0` with ONE added capability member. It renders nothing,
    // paints nothing, implements no App bridge, and is exactly the shape a model-driven caller can
    // compose for itself — which is the whole finding gaps[2] recorded.
    const { url, minted } = await serveAgentQa([0])
    expect(minted, 'nothing has been minted before this read — the assertion below is not vacuous')
      .toHaveLength(0)

    const declarer = await connect(url, { apps: true })
    const result = await declarer.readResource({ uri: APP_URI })
    const contents = result.contents as readonly { text?: string }[]
    const html = contents[0]?.text ?? ''

    // A declaring caller's read succeeds, and the minted token's bytes reach its document.
    expect(
      minted,
      'road `demote`: any caller reaching the mint is the recorded posture (no caller holds a '
      + 'scope) '
      + '— if this is now zero, the declaration has been silently re-read as an authorization '
      + 'control and the ruling in app-resource.ts has been reversed without being argued',
    ).toHaveLength(1)
    const signature = minted[0] as string
    expect(
      html.includes(signature),
      'the credential minted during THIS read is in the document the declaring caller received',
    ).toBe(true)
  })

  // Scopes bind nothing; the bound-mint floor and the local network controls bound the credential.
  it('a DECLARING caller whose granted scopes omit `read` obtains the same App as any caller — a template, a readable address, one mint', async () => {
    const offered: string[] = []
    const { registry, minted } = fixtureRegistry([0, 1])
    const templates = registerAppResources(
      {
        registerResource: (name: string) => {
          offered.push(name)
          return undefined
        },
      },
      { registry, caller: caller(['run']), maskText: identity },
    )
    expect(templates, 'the template exists for every caller of a bound composition').toHaveLength(1)
    expect(offered).toHaveLength(1)
    expect(minted, 'registration mints nothing either way').toHaveLength(0)

    const { url, minted: wireMinted } = await serveAgentQa([0], ['run'])
    const declarer = await connect(url, { apps: true })
    const result = await declarer.readResource({ uri: APP_URI })
    expect((result.contents as readonly { text?: string }[])[0]?.text ?? '').toContain('<')
    expect(wireMinted, 'one credential per handle, as for any other caller').toHaveLength(1)
  })
})

// ---- 5. The fixture clock and the renderer clock are one clock ----

// Past `2027-01-15`, where a fixed `1_800_000_000_000` clock would expire every render.
const PAST_THE_2027_TIME_BOMB = 2_000_000_000_000

describe('the fixture clock cannot expire its own fixtures', () => {
  it('serves a document carrying a liveUrl under a system clock past `2027-01-15`', async () => {
    // The stub goes in BEFORE the fixture is built, because the fixture reads `Date.now()` once at
    // construction — a stub installed afterwards would measure nothing. A spy rather than fake
    // timers, deliberately: the read below is a real async round trip over a real socket, and fake
    // timers would be a second, much larger change to the thing under measurement.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(PAST_THE_2027_TIME_BOMB)
    try {
      const { url, minted } = await serveAgentQa([0, 1])
      const client = await connect(url, { apps: true })
      const result = await client.readResource({ uri: APP_URI })
      const contents = result.contents as readonly { text?: string }[]
      const html = contents[0]?.text ?? ''

      expect(minted, 'the read minted nothing under a future clock').toHaveLength(2)
      const liveUrls = [
        ...html.matchAll(
          new RegExp(`${FIXTURE_ORIGIN.replace(/\./g, '\\.')}/live/${FIXTURE_RUN_ID}#([\\w.-]+)`, 'g'),
        ),
      ]
      expect(
        liveUrls.length,
        'the served document carries no liveUrl under a future clock — the fixture clock and the '
        + "renderer's clock have drifted apart again",
      ).toBe(2)
    } finally {
      clock.mockRestore()
    }
  })
})
