// No model-readable channel of the flow holds a minted token; only the wrapper HTML carries one.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server as NodeHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  createFunctionRegistry,
  type FunctionDeps,
  type FunctionRegistry,
  type LiveViewPort,
} from '@vostride/agent-qa-agent'
import {
  asRunId,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  LiveUrlSigner,
  RunEventEnvelope,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_APPS_EXTENSION_ID, appResourceUriFor } from '../app-resource.js'
import { createAgentQaMcpNodeHandler } from '../http.js'

// ---- The scanner: one pure helper, driven by BOTH passes ---------------------------------------

/** One model-readable byte stream, named by the channel it was read off. */
interface CorpusChannel {
  readonly channel: string
  readonly text: string
}

/** One occurrence of minted bytes where none may appear. */
interface Leak {
  readonly channel: string
  readonly needle: string
  readonly excerpt: string
}

/**
 * The strings whose appearance anywhere in the corpus is a disclosure of `token`.
 *
 * NOT JUST THE WHOLE TOKEN. A minted `liveUrl` token is `v2.<body>.<signature>`, and a channel
 * carrying only the signature has disclosed the part an attacker cannot compute — so a cell that
 * asked only for the whole string would be satisfied by a leak that dropped the version prefix.
 * Each dot-separated segment of eight characters or more is therefore its own needle, on the
 * windowing rule `masked-serialization.test.ts` established for the same reason: absence has to be
 * asserted at a width narrower than the value, or the assertion sets a disclosure budget nobody
 * agreed to. The `v2` prefix is below the width and is deliberately not a needle — it is a public
 * format marker that occurs in this file's own prose.
 */
function needlesOf(token: string): readonly string[] {
  const segments = token.split('.').filter((segment) => segment.length >= 8)
  return [token, ...segments]
}

/**
 * Every occurrence of every token's needles across the corpus.
 *
 * TOTAL AND UNDECORATED: it answers what it found and never throws, so the SAME function can be
 * asked to find nothing (the standing law) and to find something (the mutation control). A scanner
 * that asserted internally could only ever be used one way round, and a control that drove a
 * second implementation would be measuring the control.
 */
function scanCorpus(
  corpus: readonly CorpusChannel[],
  tokens: readonly string[],
): readonly Leak[] {
  const leaks: Leak[] = []
  for (const token of tokens) {
    for (const needle of needlesOf(token)) {
      for (const entry of corpus) {
        const at = entry.text.indexOf(needle)
        if (at === -1) continue
        leaks.push({
          channel: entry.channel,
          needle,
          excerpt: entry.text.slice(Math.max(0, at - 40), at + needle.length + 40),
        })
      }
    }
  }
  return leaks
}

// ---- The fixture composition -------------------------------------------------------------------

const FIXTURE_RUN_ID = 'run-408-04-token-absence'
const FIXTURE_ORIGIN = 'http://127.0.0.1:7791'
const SIGNING_KEY = 'zz-408-04-token-absence-signing-key'
const DASHBOARD_BASE = 'http://localhost:4104'
const ENTITY_URI = 'agentqa://memory/MEM-001'
const HANDLES: readonly number[] = [0, 1]

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

const runStartedEnvelope = (handles: readonly number[]): RunEventEnvelope => ({
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
    memberTestCount: handles.length,
    handles: [...handles],
  },
})

function handoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'token-absence' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_token_absence',
        testName: 'a member this fixture recorded',
        filePath: 'tests/token-absence.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      },
    ],
  }
}

/**
 * The smallest registry in which the WHOLE flow answers: both carriers, the entity read, and a
 * `ui://` read that really mints.
 *
 * `liveView` is a real port with a real HMAC signer, and `onMinted` is the capture — the ground
 * truth every needle below is derived from.
 */
function fixtureRegistry(): { readonly registry: FunctionRegistry; readonly minted: string[] } {
  const minted: string[] = []
  // Real clock: the renderer falls back to `Date.now()`, so a fixed epoch would expire the render.
  let clock = Date.now()

  const liveView: LiveViewPort = {
    signer: fixtureSigner(),
    origin: () => FIXTURE_ORIGIN,
    now: () => (clock += 1),
    capabilityOf: (runId, handle) =>
      runId === FIXTURE_RUN_ID && HANDLES.includes(handle) ? { kind: 'cdp-screencast' } : undefined,
    onMinted: (token) => {
      minted.push(token)
    },
  }

  const deps = {
    runs: {
      list: () => Promise.resolve([handoff(FIXTURE_RUN_ID)]),
      get: (runId: string) =>
        Promise.resolve(String(runId) === FIXTURE_RUN_ID ? handoff(FIXTURE_RUN_ID) : undefined),
      readEvents: (runId: string, fromSeq: number) =>
        Promise.resolve(
          runId === FIXTURE_RUN_ID && fromSeq <= 1 ? [runStartedEnvelope(HANDLES)] : [],
        ),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    runInvocation: { start: () => Promise.resolve({ runId: asRunId(FIXTURE_RUN_ID) }) },
    entities: {
      get: (ref: string) =>
        Promise.resolve(
          ref === ENTITY_URI || ref === 'MEM-001'
            ? {
                kind: 'MEM' as const,
                shortId: 'MEM-001',
                uri: ENTITY_URI,
                machineId: 'mem-001-token-absence',
                title: 'a memory this fixture recorded',
                statusSource: 'active',
              }
            : undefined,
        ),
    },
    // `{ entries: [] }` and not `{}`: `readEntityCardContext` reads the masked config through
    // `masked.entries.find(...)`, so an empty object makes the entity read refuse rather than
    // answer — and a corpus whose entity channel is a stack trace is not the entity channel.
    config: { getMasked: () => Promise.resolve({ entries: [] }) },
    liveView,
  } as unknown as FunctionDeps

  return { registry: createFunctionRegistry({ deps }), minted }
}

// The tokenless MCP caller every request is served as.
const caller: FunctionCaller = {
  surface: 'mcp',
  origin: 'agent',
}

const identity = (text: string): string => text

// ---- The wire ----------------------------------------------------------------------------------

const openServers: NodeHttpServer[] = []
const openClients: Client[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
  for (const server of openServers.splice(0)) {
    // Pooled keep-alive sockets stay open (see `serve`), so teardown closes them rather than
    // waiting on a peer.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// A real socket, because the in-process driver never reaches the era that carries capabilities.
async function serve(listener: (req: never, res: never) => void): Promise<string> {
  const server = createServer(listener as never)
  // The reap can beat a request already written on a pooled socket, giving `ECONNRESET`.
  server.keepAliveTimeout = 0
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
}

/** The shipped client, negotiating the Apps extension or deliberately not. */
async function connect(url: string, options: { readonly apps: boolean }): Promise<Client> {
  const client = new Client(
    { name: 'agent-qa-408-04-token-absence', version: '0.0.0' },
    {
      capabilities: options.apps ? { extensions: { [MCP_APPS_EXTENSION_ID]: {} } } : {},
      versionNegotiation: { mode: 'auto' as const },
    },
  )
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

// ---- Capturing the channels --------------------------------------------------------------------

interface ToolCallResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
  readonly _meta?: unknown
}

/** The three members of a tool result a MODEL reads, each as its own named channel. */
function toolChannels(label: string, result: ToolCallResult): readonly CorpusChannel[] {
  return [
    {
      channel: `${label}:content[].text`,
      text: (result.content ?? []).map((part) => part.text ?? '').join('\n'),
    },
    {
      channel: `${label}:structuredContent`,
      text: JSON.stringify(result.structuredContent ?? null),
    },
    { channel: `${label}:_meta`, text: JSON.stringify(result._meta ?? null) },
  ]
}

/** A refusal serialized as message, name and stack. */
function refusalChannel(label: string, error: unknown): CorpusChannel {
  return {
    channel: label,
    text:
      error === undefined
        ? ''
        : JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
  }
}

// A log line reaches a transcript in hosts that pipe stderr, so console output joins the corpus.
function captureConsole(): { readonly lines: string[]; readonly restore: () => void } {
  const lines: string[] = []
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
  const originals = new Map<string, unknown>()
  for (const method of methods) {
    originals.set(method, console[method])
    console[method] = ((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    }) as typeof console.log
  }
  return {
    lines,
    restore: () => {
      for (const method of methods) {
        console[method] = originals.get(method) as typeof console.log
      }
    },
  }
}

interface FlowResult {
  /** Every model-readable byte stream this flow produced. */
  readonly corpus: readonly CorpusChannel[]
  /** Every token the flow REALLY minted, captured at `onMinted`. */
  readonly tokens: readonly string[]
  /** The ONE excluded channel: the host-rendered wrapper document. */
  readonly wrapperHtml: string
}

// `leak` makes the base supplier carry a real token, so the shipped decoration composes it in.
async function driveFullFlow(options: { readonly leak?: boolean } = {}): Promise<FlowResult> {
  const { registry, minted } = fixtureRegistry()
  const handler = createAgentQaMcpNodeHandler(() => ({
    registry,
    caller,
    maskText: identity,
    liveLink: {
      dashboardBaseUrl: () =>
        options.leak === true && minted[0] !== undefined
          ? `https://leak.invalid/${minted[0]}`
          : DASHBOARD_BASE,
    },
  }))
  const url = await serve((req, res) => void handler(req as never, res as never))

  const corpus: CorpusChannel[] = []
  const console_ = captureConsole()
  let wrapperHtml = ''
  try {
    const client = await connect(url, { apps: true })

    // 1. the advertised catalogue
    corpus.push({ channel: 'tools/list', text: JSON.stringify(await client.listTools()) })

    // 2. THE MINT, FIRST. Everything captured after this line is captured in a world where live
    //    tokens for this run exist — which is what stops every absence below being vacuous.
    const app = (await client.readResource({ uri: appResourceUriFor(FIXTURE_RUN_ID) })) as {
      contents: readonly Record<string, unknown>[]
    }
    const appContent = app.contents[0] ?? {}
    wrapperHtml = String(appContent.text ?? '')
    // The envelope is scanned; only the `text` above is excluded.
    corpus.push({
      channel: 'ui://read:envelope (text excluded BY RULING — see header)',
      text: JSON.stringify({ ...appContent, text: undefined }),
    })

    // 3. both carriers
    const started = (await client.callTool({
      name: 'agent_qa_start_run',
      arguments: { runId: FIXTURE_RUN_ID },
    })) as unknown as ToolCallResult
    corpus.push(...toolChannels('tools/call:agent_qa_start_run', started))

    const digest = (await client.callTool({
      name: 'agent_qa_get_run_digest',
      arguments: { runId: FIXTURE_RUN_ID },
    })) as unknown as ToolCallResult
    corpus.push(...toolChannels('tools/call:agent_qa_get_run_digest', digest))

    // 4. a NON-carrier, on the same three members
    const listed = (await client.callTool({
      name: 'agent_qa_list_runs',
      arguments: {},
    })) as unknown as ToolCallResult
    corpus.push(...toolChannels('tools/call:agent_qa_list_runs', listed))

    // 5. both listings
    corpus.push({
      channel: 'resources/list',
      text: JSON.stringify(await client.listResources()),
    })
    corpus.push({
      channel: 'resources/templates/list',
      text: JSON.stringify(await client.listResourceTemplates()),
    })

    // 6. an entity resource read
    const entity = await client.readResource({ uri: ENTITY_URI }).then(
      (result) => JSON.stringify(result),
      (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
    )
    corpus.push({ channel: `resources/read:${ENTITY_URI}`, text: entity })

    // 7a. a malformed `ui://` address — the refusal that ECHOES caller text
    const malformed = await client
      .readResource({ uri: 'ui://agent-qa/live-run/..%2Fetc%2Fpasswd' })
      .then(() => undefined, (error: unknown) => error)
    corpus.push(refusalChannel('refusal:malformed-ui-uri', malformed))

    // 7b. A non-negotiated read on a second client, refused before any mint.
    const stranger = await connect(url, { apps: false })
    const refused = await stranger
      .readResource({ uri: appResourceUriFor(FIXTURE_RUN_ID) })
      .then(() => undefined, (error: unknown) => error)
    corpus.push(refusalChannel('refusal:non-negotiated-ui-read', refused))
    // The carrier line reaches an App-less host too, so its channels are scanned as well.
    const strangerCarrier = (await stranger.callTool({
      name: 'agent_qa_get_run_digest',
      arguments: { runId: FIXTURE_RUN_ID },
    })) as unknown as ToolCallResult
    corpus.push(...toolChannels('tools/call:app-less:agent_qa_get_run_digest', strangerCarrier))
  } finally {
    console_.restore()
  }

  // 8. everything the flow printed
  corpus.push({ channel: 'console.*', text: console_.lines.join('\n') })

  return { corpus, tokens: [...minted], wrapperHtml }
}

// ---- The channel census: each channel is classified exactly once, `scanned` or `carrying` ----

// The wrapper HTML is the token's destination: the one place this server writes it.
const CARRYING_CHANNELS: readonly string[] = ['ui://read:text (the wrapper HTML document)']

/** Every channel a model reads, and so every channel the zero-occurrence cell scans. */
const SCANNED_CHANNELS: readonly string[] = [
  'tools/list',
  'ui://read:envelope (text excluded BY RULING — see header)',
  'tools/call:agent_qa_start_run:content[].text',
  'tools/call:agent_qa_start_run:structuredContent',
  'tools/call:agent_qa_start_run:_meta',
  'tools/call:agent_qa_get_run_digest:content[].text',
  'tools/call:agent_qa_get_run_digest:structuredContent',
  'tools/call:agent_qa_get_run_digest:_meta',
  'tools/call:agent_qa_list_runs:content[].text',
  'tools/call:agent_qa_list_runs:structuredContent',
  'tools/call:agent_qa_list_runs:_meta',
  'resources/list',
  'resources/templates/list',
  `resources/read:${ENTITY_URI}`,
  'refusal:malformed-ui-uri',
  'refusal:non-negotiated-ui-read',
  'tools/call:app-less:agent_qa_get_run_digest:content[].text',
  'tools/call:app-less:agent_qa_get_run_digest:structuredContent',
  'tools/call:app-less:agent_qa_get_run_digest:_meta',
  'console.*',
]

// Written out, not composed from the two lists, so an unclassified channel is caught.
const FLOW_CHANNELS: readonly string[] = [
  'tools/list',
  'ui://read:text (the wrapper HTML document)',
  'ui://read:envelope (text excluded BY RULING — see header)',
  'tools/call:agent_qa_start_run:content[].text',
  'tools/call:agent_qa_start_run:structuredContent',
  'tools/call:agent_qa_start_run:_meta',
  'tools/call:agent_qa_get_run_digest:content[].text',
  'tools/call:agent_qa_get_run_digest:structuredContent',
  'tools/call:agent_qa_get_run_digest:_meta',
  'tools/call:agent_qa_list_runs:content[].text',
  'tools/call:agent_qa_list_runs:structuredContent',
  'tools/call:agent_qa_list_runs:_meta',
  'resources/list',
  'resources/templates/list',
  `resources/read:${ENTITY_URI}`,
  'refusal:malformed-ui-uri',
  'refusal:non-negotiated-ui-read',
  'tools/call:app-less:agent_qa_get_run_digest:content[].text',
  'tools/call:app-less:agent_qa_get_run_digest:structuredContent',
  'tools/call:app-less:agent_qa_get_run_digest:_meta',
  'console.*',
]

// Past `2027-01-15`, where a fixed `1_800_000_000_000` clock would expire every render.
const PAST_THE_2027_TIME_BOMB = 2_000_000_000_000

// ---- The law ------------------------------------------------------------------------------------

describe('the minted liveUrl token reaches NO model-readable channel', () => {
  it('(A0) CONTROL: the flow really minted, and the ONE legal channel really carries the tokens',
    async () => {
      const flow = await driveFullFlow()

      // Non-vacuity, half one: a scan of a flow that minted nothing is green for the wrong reason.
      expect(flow.tokens.length, 'the flow minted no token at all — every absence below is vacuous')
        .toBeGreaterThan(0)
      expect(flow.tokens.length, 'one mint per announced handle (D-06)').toBe(HANDLES.length)

      // Non-vacuity, half two: the excluded channel is excluded because it is the DESTINATION.
      // If the wrapper stopped carrying tokens, the exclusion would be protecting nothing and the
      // corpus below would be asserting the absence of a credential nobody serves.
      for (const token of flow.tokens) {
        expect(
          flow.wrapperHtml.includes(token),
          'the host-rendered wrapper does not carry the token it exists to deliver',
        ).toBe(true)
      }

      // And the scanner can see them: pointed AT the excluded channel it finds every one.
      const found = scanCorpus([{ channel: 'wrapper-html', text: flow.wrapperHtml }], flow.tokens)
      expect(found.length, 'the scanner is dead — it cannot find tokens that are demonstrably there')
        .toBeGreaterThanOrEqual(flow.tokens.length)
    })

  it('(A1) ZERO occurrences across the WHOLE corpus', async () => {
    const flow = await driveFullFlow()
    const leaks = scanCorpus(flow.corpus, flow.tokens)

    expect(
      leaks,
      `minted bytes reached ${leaks.length} model-readable channel(s): ${JSON.stringify(leaks, null, 2)}`,
    ).toEqual([])
  })

  it('(A2) the corpus really covers the channels this law is about', async () => {
    const flow = await driveFullFlow()
    const channels = flow.corpus.map((entry) => entry.channel)

    // The partition first: a channel classified nowhere is an exclusion nobody can see.
    const unclassified = FLOW_CHANNELS.filter(
      (channel) =>
        !SCANNED_CHANNELS.includes(channel) && !CARRYING_CHANNELS.includes(channel),
    )
    expect(
      unclassified,
      'a channel of this flow is neither scanned for minted bytes nor named as one that legitimately '
      + 'carries them — classify it, with its ruling, or this census has an unstated remainder',
    ).toEqual([])

    // Disjoint: a channel both scanned and carrying would deny a credential it holds.
    const bothWays = SCANNED_CHANNELS.filter((channel) => CARRYING_CHANNELS.includes(channel))
    expect(bothWays, 'a channel is classified BOTH carrying and scanned').toEqual([])

    // Named individually, so a channel that stops being collected fails here, not silently.
    for (const required of SCANNED_CHANNELS) {
      expect(channels, `the corpus lost the ${required} channel`).toContain(required)
    }

    // The reverse: a channel the flow produced but nobody classified fails here.
    const uncensused = channels.filter((channel) => !SCANNED_CHANNELS.includes(channel))
    expect(
      uncensused,
      'the flow produced a channel this census does not name — add it to FLOW_CHANNELS and classify it',
    ).toEqual([])

    // The carrying channel is outside the scanned corpus and really answered.
    for (const carrying of CARRYING_CHANNELS) {
      expect(channels, `${carrying} must be EXCLUDED from the scanned corpus, by ruling`)
        .not.toContain(carrying)
    }
    expect(
      flow.wrapperHtml.length,
      'the carrying channel came back empty — the exclusion is protecting nothing',
    ).toBeGreaterThan(0)

    // Every channel answered with bytes except the console, which this flow leaves empty.
    const empty = flow.corpus
      .filter((entry) => entry.text === '' && entry.channel !== 'console.*')
      .map((entry) => entry.channel)
    expect(empty, 'a channel came back as the empty string — it was never really read').toEqual([])
    expect(
      flow.corpus.find((entry) => entry.channel === 'console.*')?.text,
      'the flow printed something — read it, then decide whether it may say that',
    ).toBe('')
  })

  it('(A3) every collected channel really ANSWERED — no absence over a dead channel', async () => {
    const flow = await driveFullFlow()
    const at = (channel: string): string =>
      flow.corpus.find((entry) => entry.channel === channel)?.text ?? ''

    // The two refusals refused for their OWN reasons, not for a fixture accident.
    expect(at('refusal:malformed-ui-uri')).toContain('not a canonical ui://agent-qa/live-run')
    expect(at('refusal:non-negotiated-ui-read')).toContain(MCP_APPS_EXTENSION_ID)

    // The entity read served a CARD rather than a stack trace — the difference between scanning
    // the entity channel and scanning the error channel twice.
    expect(at(`resources/read:${ENTITY_URI}`)).toContain('MEM-001')
    expect(at(`resources/read:${ENTITY_URI}`)).toContain('application/json')

    // Both carriers answered with the link line, so the text channel had something to say.
    for (const carrier of ['agent_qa_start_run', 'agent_qa_get_run_digest']) {
      expect(
        at(`tools/call:${carrier}:content[].text`),
        `${carrier} produced no link line — its text channel is dead`,
      ).toContain(`${DASHBOARD_BASE}/runs/${FIXTURE_RUN_ID}/live`)
    }
    // Including on the App-less client.
    expect(at('tools/call:app-less:agent_qa_get_run_digest:content[].text')).toContain(
      `${DASHBOARD_BASE}/runs/${FIXTURE_RUN_ID}/live`,
    )
  })

  it('(A9) MUTATION CONTROL: a real minted token threaded into a carrier result REDS the scan',
    async () => {
      const flow = await driveFullFlow({ leak: true })

      expect(flow.tokens.length, 'the leaking pass minted nothing to leak').toBeGreaterThan(0)

      const leaks = scanCorpus(flow.corpus, flow.tokens)

      // Passes when the scan fails; empty would mean the scanner cannot see.
      expect(leaks.length, 'the scan did not see a token planted on a real carrier channel')
        .toBeGreaterThan(0)

      // The finding lands on a carrier's model-readable text channel, where the leak is.
      expect(
        leaks.map((leak) => leak.channel),
        JSON.stringify(leaks.map((leak) => leak.channel)),
      ).toContain('tools/call:agent_qa_get_run_digest:content[].text')
    })

  it('(A10) the fixture clock and the renderer clock are ONE clock — a system time past 2027-01-15 still renders a document carrying a liveUrl',
    async () => {
      // THE STUB GOES IN FIRST, because the fixture reads `Date.now()` once when it is built — a
      // stub installed afterwards would measure nothing. A spy rather than fake timers,
      // deliberately: the flow below is a real async round trip over a real loopback socket, and
      // fake timers would be a far larger change to the very thing being measured.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(PAST_THE_2027_TIME_BOMB)
      try {
        const flow = await driveFullFlow()

        // Half one: the flow really minted under the future clock.
        expect(
          flow.tokens.length,
          'the flow minted nothing under a system clock past 2027-01-15 — the fixture clock has '
          + 'drifted away from the renderer clock again (WR-07)',
        ).toBeGreaterThan(0)

        // The credential is in the document; an expired render would strip it and pass vacuously.
        const carried = flow.tokens.filter((token) => flow.wrapperHtml.includes(token))
        expect(
          carried.length,
          'the served document carries no minted liveUrl under a future clock — (A1) would now be '
          + 'green over an EMPTY render, which is the vacuity (A0) exists to prevent',
        ).toBeGreaterThan(0)
        expect(
          flow.wrapperHtml.includes(`${FIXTURE_ORIGIN}/live/${FIXTURE_RUN_ID}#`),
          'the document holds no liveUrl at all',
        ).toBe(true)
      } finally {
        clock.mockRestore()
      }
    })
})
