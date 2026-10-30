// The signer is a real HMAC, so a token that validates went past the shipped validator.

import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  createFunctionRegistry,
  RUNS_EVENTS_FUNCTION_ID,
  RUNS_LIVE_URL_FUNCTION_ID,
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
import { describe, expect, it } from 'vitest'

import {
  APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY,
  APP_RESOURCE_MIME_TYPE,
  APP_RESOURCE_URI_TEMPLATE,
  AppResourceOriginSpanError,
  AppResourceUriError,
  createAppResourceReadHandler,
  MCP_APPS_EXTENSION_ID,
  parseAppUri,
  registerAppResources,
} from '../app-resource.js'
import type { AppResourceInvoke } from '../app-resource.js'
import { APP_WRAPPER_STATES } from '../app-wrapper.js'

// ---- The fixture composition -------------------------------------------------------------------

const FIXTURE_RUN_ID = 'run-tracer'
const FIXTURE_ORIGIN = 'http://127.0.0.1:7777'
const SIGNING_KEY = 'zz-app-resource-signing-key'

/** The `cli/src/composition/live-url-signer.ts` shape, keyed here so no key is ever shared. */
const signer: LiveUrlSigner = {
  sign: (data) => createHmac('sha256', SIGNING_KEY).update(data).digest('base64url'),
  equals: (a, b) => {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  },
}

// Advances one ms per read, because two mints in one millisecond are byte-identical.
function advancingClock(start = Date.now()): { now: () => number; at: () => number } {
  let current = start
  return { now: () => (current += 1), at: () => current }
}

const runStartedEnvelope = (handles?: readonly number[]): RunEventEnvelope => ({
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
    memberTestCount: handles === undefined ? 1 : handles.length,
    ...(handles === undefined ? {} : { handles: [...handles] }),
  },
})

interface FixtureOptions {
  /** The roster the run announces on its own `runStarted`. */
  readonly handles?: readonly number[]
  // No `handles` field at all, distinct from `handles: []`; both must render one document.
  readonly unannounced?: boolean
  // Defaults to the announced roster; separable so an empty-roster run can still hold a session.
  readonly liveHandles?: readonly number[]
  // Which run ids this host holds a live session for; empty means not live.
  readonly liveRunIds?: readonly string[]
}

function fixtureRegistry(options: FixtureOptions = {}): {
  readonly registry: FunctionRegistry
  readonly clock: { now: () => number; at: () => number }
} {
  const announced = options.handles ?? [0, 1]
  const handles = options.liveHandles ?? announced
  const liveRunIds = options.liveRunIds ?? [FIXTURE_RUN_ID]
  const clock = advancingClock()

  const liveView: LiveViewPort = {
    signer,
    origin: () => FIXTURE_ORIGIN,
    now: clock.now,
    capabilityOf: (runId, handle) =>
      liveRunIds.includes(runId) && handles.includes(handle)
        ? { kind: 'cdp-screencast' }
        : undefined,
  }

  const runs = {
    readEvents: async (runId: string, fromSeq: number) =>
      runId === FIXTURE_RUN_ID && fromSeq <= 1
        ? [runStartedEnvelope(options.unannounced === true ? undefined : announced)]
        : [],
  }

  return {
    registry: createFunctionRegistry({
      deps: { runs, liveView } as unknown as FunctionDeps,
    }),
    clock,
  }
}

// Scope sets are passed as strings cast past the type, to show they change nothing.
function caller(smuggledScopes?: readonly string[]): FunctionCaller {
  return smuggledScopes === undefined
    ? { surface: 'mcp', origin: 'agent' }
    : ({ surface: 'mcp', origin: 'agent', grantedScopes: smuggledScopes } as FunctionCaller)
}

const identity = (text: string): string => text

// ---- The recording registrar (the `resources.test.ts` slice) -----------------------------------

interface RecordedAppRegistration {
  readonly name: string
  readonly uriTemplate: string
  readonly mimeType: string | undefined
  readonly listCallback: unknown
  readonly read: (
    uri: URL,
    variables: Record<string, string>,
    ctx: unknown,
  ) => Promise<{
    contents: readonly { uri: string; mimeType?: string; text?: string; _meta?: unknown }[]
  }>
}

function recordingServer(): {
  readonly calls: RecordedAppRegistration[]
  registerResource: (
    name: string,
    template: { uriTemplate: { toString: () => string }; listCallback?: unknown },
    config: Record<string, unknown>,
    read: RecordedAppRegistration['read'],
  ) => void
} {
  const calls: RecordedAppRegistration[] = []
  return {
    calls,
    registerResource(name, template, config, read) {
      calls.push({
        name,
        uriTemplate: template.uriTemplate.toString(),
        mimeType: config['mimeType'] as string | undefined,
        listCallback: (template as { listCallback?: unknown }).listCallback,
        read,
      })
    },
  }
}

// The envelope a declaring host sends, as measured in `app-negotiation.test.ts`.
const negotiatedContext = {
  mcpReq: {
    envelope: {
      [APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY]: {
        extensions: { [MCP_APPS_EXTENSION_ID]: {} },
      },
    },
  },
}

/** The captured read, driven the way a negotiated host drives it. */
type NegotiatedRead = (uri: URL) => ReturnType<RecordedAppRegistration['read']>

const asNegotiated =
  (read: RecordedAppRegistration['read']): NegotiatedRead =>
  (uri: URL) =>
    read(uri, {}, negotiatedContext)

function registerAndCapture(options: FixtureOptions = {}): {
  readonly registered: readonly string[]
  readonly read: NegotiatedRead
  readonly clock: { now: () => number; at: () => number }
} {
  const { registry, clock } = fixtureRegistry(options)
  const server = recordingServer()
  const registered = registerAppResources(server as never, {
    registry,
    caller: caller(),
    maskText: identity,
  })
  expect(server.calls.length, 'exactly one app template is registered').toBe(1)
  return { registered, read: asNegotiated(server.calls[0]!.read), clock }
}

function htmlOf(result: { contents: readonly { text?: string }[] }): string {
  const text = result.contents[0]?.text
  expect(typeof text, 'the app resource serves TEXT, not a blob').toBe('string')
  return text as string
}

/**
 * Every `liveUrl` the served HTML carries, read the way a host would: the embed path for THIS run,
 * with the token in the fragment.
 *
 * Deliberately a scan over the whole document rather than a lookup into a structure — the claim is
 * that the tokens are IN the bytes the host renders, and reading them back out of the input the
 * renderer was handed would assert nothing about the output.
 */
function liveUrlsIn(html: string): readonly string[] {
  // Every dot escaped: a string pattern in `replace` replaces only the first.
  const pattern = new RegExp(
    `${FIXTURE_ORIGIN.replace(/\./g, '\\.')}/live/${FIXTURE_RUN_ID}#([A-Za-z0-9._-]+)`,
    'g',
  )
  return [...html.matchAll(pattern)].map((match) => match[0])
}

const tokenOf = (liveUrl: string): string => liveUrl.slice(liveUrl.indexOf('#') + 1)

/** The wrapper's declared state, read out of the served bytes rather than out of the input. */
function stateOf(html: string): string {
  const match = /data-app-state="([a-z-]+)"/.exec(html)
  expect(match, 'the served document declares no app state at all').not.toBeNull()
  return match![1]!
}

// Mints one pane per origin, which no shipped registry can do, to drive the multi-origin arm.
function mintingInvoke(origins: readonly string[]): AppResourceInvoke {
  return async (opId: string, input: unknown): Promise<unknown> => {
    if (opId === RUNS_EVENTS_FUNCTION_ID) {
      const roster = origins.map((_origin, index) => index)
      return (async function* stream() {
        yield runStartedEnvelope(roster)
      })()
    }
    if (opId === RUNS_LIVE_URL_FUNCTION_ID) {
      const handle = (input as { handle: number }).handle
      return {
        handle,
        liveUrl: `${origins[handle]!}/live/${FIXTURE_RUN_ID}#token-for-handle-${handle}`,
        // The renderer judges `expired` by `Date.now()`, so a literal expiry strips these panes.
        expiresAt: Date.now() + 300_000,
        stream: { kind: 'cdp-screencast' },
      }
    }
    throw new Error(`the fixture invoke was asked for an op it does not serve: ${opId}`)
  }
}

/**
 * Drive the read handler with no server and no registry at all.
 *
 * ONE cast, at ONE seam, and it is the same narrowing the recording registrar already does: the
 * SDK's `ReadResourceResult` types `contents` as a text-OR-blob union, and this surface only ever
 * serves text (`htmlOf` asserts exactly that on every result). Narrowing here rather than widening
 * `htmlOf` keeps the assertion where the claim is.
 */
const directRead = (invoke: AppResourceInvoke): ReturnType<RecordedAppRegistration['read']> =>
  createAppResourceReadHandler({ invoke, maskText: identity })(
    new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`),
    {} as never,
    negotiatedContext as never,
  ) as ReturnType<RecordedAppRegistration['read']>

// ---- The codec ---------------------------------------------------------------------------------

describe('parseAppUri — the ONE codec for ui:// app addresses', () => {
  it('reads the run id out of a canonical app address', () => {
    expect(parseAppUri(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`)).toEqual({
      runId: FIXTURE_RUN_ID,
    })
  })

  it('refuses a near-miss authority, a near-miss segment and a trailing path', () => {
    expect(parseAppUri(`ui://agent-qb/live-run/${FIXTURE_RUN_ID}`)).toBeUndefined()
    expect(parseAppUri(`ui://agent-qa/live-runs/${FIXTURE_RUN_ID}`)).toBeUndefined()
    expect(parseAppUri(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}/frames`)).toBeUndefined()
    expect(parseAppUri(`https://agent-qa/live-run/${FIXTURE_RUN_ID}`)).toBeUndefined()
    expect(parseAppUri('ui://agent-qa/live-run/')).toBeUndefined()
  })

  it('refuses a run id the run-directory codec would have to rewrite', () => {
    expect(parseAppUri('ui://agent-qa/live-run/..')).toBeUndefined()
    expect(parseAppUri('ui://agent-qa/live-run/%2E%2E%2Fetc')).toBeUndefined()
  })
})

// ---- Registration ------------------------------------------------------------------------------

describe('registerAppResources — which registries get the App template', () => {
  it('registers exactly one UNLISTED template, at the published address', () => {
    const { registry } = fixtureRegistry()
    const server = recordingServer()
    const registered = registerAppResources(server as never, {
      registry,
      caller: caller(),
      maskText: identity,
    })

    expect(registered).toEqual([APP_RESOURCE_URI_TEMPLATE])
    expect(server.calls[0]!.uriTemplate).toBe(APP_RESOURCE_URI_TEMPLATE)
    expect(server.calls[0]!.mimeType).toBe(APP_RESOURCE_MIME_TYPE)
    // The template never appears in a listing, so no enumeration walks to a minted token.
    expect(server.calls[0]!.listCallback).toBeUndefined()
  })

  it('registers the same template for a caller granted no read scope', () => {
    const { registry } = fixtureRegistry()
    const granted = recordingServer()
    const ungranted = recordingServer()
    const forReader = registerAppResources(granted as never, { registry, caller: caller(), maskText: identity })
    const forNobody = registerAppResources(ungranted as never, {
      registry,
      caller: caller([]),
      maskText: identity,
    })
    expect(forNobody).toEqual(forReader)
    expect(forNobody).toHaveLength(1)
    expect(ungranted.calls.map((call) => call.name)).toEqual(granted.calls.map((call) => call.name))
  })

  it('registers NOTHING on a registry that declares no mint op', () => {
    const server = recordingServer()
    const registered = registerAppResources(server as never, {
      registry: { list: () => [] },
      caller: caller(),
      maskText: identity,
    })
    expect(registered).toEqual([])
    expect(server.calls).toEqual([])
  })

  it('advertises the official Apps extension id, spelled once', () => {
    expect(MCP_APPS_EXTENSION_ID).toBe('io.modelcontextprotocol/ui')
    expect(APP_RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app')
  })
})

// ---- The read: mint by reference, per handle, fresh ---------------------------------------------

describe('resources/read mints through the ONE wall and serves the wrapper', () => {
  it('serves one liveUrl per announced handle, each validating against the SAME signer', async () => {
    const { read, clock } = registerAndCapture({ handles: [0, 1] })
    const result = await read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`))
    const html = htmlOf(result)

    const liveUrls = liveUrlsIn(html)
    expect(liveUrls.length, 'one mint per handle on the roster').toBe(2)
    expect(new Set(liveUrls).size, 'two handles, two distinct links').toBe(2)

    const handles = liveUrls.map((liveUrl) => {
      const verdict = validateLiveUrlToken(signer, tokenOf(liveUrl), {
        subject: { kind: 'run', id: FIXTURE_RUN_ID },
        now: clock.at(),
      })
      expect(verdict.kind, `the shipped validator accepts ${liveUrl}`).toBe('ok')
      return verdict.kind === 'ok' && verdict.claims.subject.kind === 'run'
        ? verdict.claims.subject.handle
        : -1
    })
    expect([...handles].sort()).toEqual([0, 1])
  })

  it('names the minted origin as the ONLY allowed frame AND connect domain', async () => {
    const { read } = registerAndCapture()
    const result = await read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`))
    expect(result.contents[0]!.mimeType).toBe(APP_RESOURCE_MIME_TYPE)
    // `connect-src` defaults to none, so the probe needs `connectDomains`; all of `_meta` is fixed.
    expect(result.contents[0]!._meta).toEqual({
      ui: { csp: { frameDomains: [FIXTURE_ORIGIN], connectDomains: [FIXTURE_ORIGIN] } },
    })
  })

  it('mints AGAIN on a second read — fresh-on-render, never a cached token', async () => {
    const { read } = registerAndCapture({ handles: [0] })
    const uri = new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`)
    const first = liveUrlsIn(htmlOf(await read(uri)))
    const second = liveUrlsIn(htmlOf(await read(uri)))

    expect(first.length).toBe(1)
    expect(second.length).toBe(1)
    expect(second[0], 'a second read carries different token bytes').not.toBe(first[0])
  })

  it('reads the roster off the run\'s OWN runStarted, not off a guess', async () => {
    const { read } = registerAndCapture({ handles: [0, 1, 2] })
    const html = htmlOf(await read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`)))
    expect(liveUrlsIn(html).length).toBe(3)
  })
})

// ---- The roster's two arms, and the allowance that covers the document --------------------------

describe('an announced-but-EMPTY roster is the SAME document as an unannounced one',
  () => {
    it('renders a live pane for handle 0, never `run-ended`, for a run announcing `handles: []`',
      async () => {
        // The run really announces the field, and it really says "no members" — `handleRosterOf`
        // answers `[]` here, not `undefined`. The host still holds a live session for handle 0,
        // which is what makes `run-ended` a false claim rather than an arity report.
        const { read } = registerAndCapture({ handles: [], liveHandles: [0] })
        const result = await read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`))
        const html = htmlOf(result)

        expect(
          liveUrlsIn(html).length,
          'an announced-but-empty roster minted nothing — `?? [0]` does not fire for `[]`, so the '
          + 'mint loop ran zero times and the document withdrew a variant that IS available',
        ).toBe(1)
        expect(stateOf(html), 'a run this host holds a live session for was rendered as ended')
          .not.toBe('run-ended')
      })

    it('agrees with the UNANNOUNCED arm — same state, same pane count, same handle', async () => {
      // The claim is the collapse itself: two different bytes on the wire, one decision in the
      // handler, one document out. Compared arm to arm rather than each pinned to a literal, so a
      // future change that moved BOTH would still have to move them together.
      const empty = registerAndCapture({ handles: [], liveHandles: [0] })
      const absent = registerAndCapture({ unannounced: true, liveHandles: [0] })

      const emptyHtml = htmlOf(await empty.read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`)))
      const absentHtml = htmlOf(
        await absent.read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`)),
      )

      expect(stateOf(emptyHtml)).toBe(stateOf(absentHtml))
      expect(liveUrlsIn(emptyHtml).length).toBe(liveUrlsIn(absentHtml).length)

      // And the pane really is handle 0 on both arms — proven at the token, so "one pane" cannot be
      // satisfied by a pane for some other member.
      for (const [label, html, clock] of [
        ['announced-but-empty', emptyHtml, empty.clock],
        ['unannounced', absentHtml, absent.clock],
      ] as const) {
        const liveUrls = liveUrlsIn(html)
        expect(liveUrls.length, `${label}: one pane`).toBe(1)
        const verdict = validateLiveUrlToken(signer, tokenOf(liveUrls[0]!), {
          subject: { kind: 'run', id: FIXTURE_RUN_ID },
          now: clock.at(),
        })
        expect(verdict.kind, `${label}: the shipped validator accepts the mint`).toBe('ok')
        const subject = verdict.kind === 'ok' ? verdict.claims.subject : undefined
        expect(subject?.kind === 'run' ? subject.handle : -1, `${label}: handle 0`).toBe(0)
      }
    })
  })

describe('the served allowance covers EVERY pane the document can show', () => {
  it('names the shared origin ONCE for a two-handle document — not once per mint', async () => {
    const { read } = registerAndCapture({ handles: [0, 1] })
    const result = await read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`))

    expect(liveUrlsIn(htmlOf(result)).length, 'two panes, so the derivation really ran twice').toBe(2)
    // The whole `_meta` object, so a duplicate entry or a third directive reds by name rather than
    // by a membership check that a longer array would still satisfy.
    expect(result.contents[0]!._meta).toEqual({
      ui: { csp: { frameDomains: [FIXTURE_ORIGIN], connectDomains: [FIXTURE_ORIGIN] } },
    })
  })

  it('CONTROL: a hand-composed single-origin document is served, with that origin allowed',
    async () => {
      // Without this the refusal below could be passing because `mintingInvoke` cannot serve
      // anything at all.
      const result = await directRead(mintingInvoke([FIXTURE_ORIGIN, FIXTURE_ORIGIN]))
      expect(liveUrlsIn(htmlOf(result)).length, 'the hand-composed flow minted two panes').toBe(2)
      expect(result.contents[0]!._meta).toEqual({
        ui: { csp: { frameDomains: [FIXTURE_ORIGIN], connectDomains: [FIXTURE_ORIGIN] } },
      })
    })

  it('REFUSES a document whose panes would span two origins, by name', async () => {
    // Refused rather than widened: an allowance for the first origin blanks every other pane.
    const spanning = directRead(mintingInvoke([FIXTURE_ORIGIN, 'http://127.0.0.1:7778']))
    await expect(spanning).rejects.toThrow(AppResourceOriginSpanError)
    await expect(spanning).rejects.toThrow(/would span 2 origins/)
  })
})

// ---- Honest absence ----------------------------------------------------------------------------

describe('absence is named, never an error surface', () => {
  it('renders the not-live wrapper for a run this host holds no live session for', async () => {
    const { read } = registerAndCapture({ liveRunIds: [] })
    const result = await read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`))
    const html = htmlOf(result)

    expect(html).toContain('data-app-state="run-ended"')
    expect(liveUrlsIn(html), 'nothing was minted for a run that is not live').toEqual([])
    // No inner frame, so the csp block is absent rather than present and empty.
    expect(result.contents[0]!._meta).toBeUndefined()
  })

  it('refuses a malformed app address by name, echoing only MASKED caller text', async () => {
    const seen: string[] = []
    const { registry } = fixtureRegistry()
    const server = recordingServer()
    registerAppResources(server as never, {
      registry,
      caller: caller(),
      maskText: (text) => {
        seen.push(text)
        return '<masked>'
      },
    })

    await expect(
      asNegotiated(server.calls[0]!.read)(new URL('ui://agent-qa/live-run/../../secrets')),
    ).rejects.toThrow(AppResourceUriError)
    expect(seen.some((text) => text.includes('secrets')), 'the echo went through the masker').toBe(
      true,
    )

    let message = ''
    try {
      await asNegotiated(server.calls[0]!.read)(new URL('ui://agent-qa/live-run/../../secrets'))
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('<masked>')
    expect(message).not.toContain('secrets')
  })
})

// ---- The scanner this file's claims are read through --------------------------------------------

describe('liveUrlsIn escapes its fixture origin — EVERY dot, not the first', () => {
  it('matches on the fixture origin and NOT on a near-miss where a dot stood as a wildcard', () => {
    const token = 'aaa.bbb-ccc'
    const positive = `<iframe src="${FIXTURE_ORIGIN}/live/${FIXTURE_RUN_ID}#${token}"></iframe>`
    // Differs from the fixture origin in exactly ONE character, and it is a character the
    // single-occurrence escape left standing as a `.` wildcard: the second dot of `127.0.0.1`.
    // Every claim in this file is read through this scanner, so a scanner that matches an origin
    // this host never served would let a document naming the wrong origin pass as proof.
    const negative = `<iframe src="http://127.0x0.1:7777/live/${FIXTURE_RUN_ID}#${token}"></iframe>`

    expect(liveUrlsIn(positive)).toEqual([`${FIXTURE_ORIGIN}/live/${FIXTURE_RUN_ID}#${token}`])
    expect(liveUrlsIn(negative), 'a near-miss origin matched — a dot is still a wildcard here')
      .toEqual([])
  })
})

// ---- The wrapper's own vocabulary --------------------------------------------------------------

describe('the wrapper page vocabulary', () => {
  it('closes the state set at five states', () => {
    expect([...APP_WRAPPER_STATES]).toEqual([
      'connecting',
      'live',
      'expired',
      'unreachable-origin',
      'run-ended',
    ])
  })

  it('renders no run state of its own — no step list, no status line', async () => {
    const { read } = registerAndCapture()
    const html = htmlOf(await read(new URL(`ui://agent-qa/live-run/${FIXTURE_RUN_ID}`)))
    expect(html).toContain('data-app-live-frame')
    expect(html).toContain('data-app-handle-picker')
    expect(html).not.toContain('data-app-step')
    expect(html).not.toContain('data-app-status')
  })
})
