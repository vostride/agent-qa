// Each read mints the token the document carries, so it is unlisted and never cached (SEP-2575).

import { CLIENT_CAPABILITIES_META_KEY, ResourceTemplate } from '@modelcontextprotocol/server'
import type {
  ClientCapabilities,
  ReadResourceResult,
  ReadResourceTemplateCallback,
  RequestMetaEnvelope,
  ResourceMetadata,
  ServerContext,
  Variables,
} from '@modelcontextprotocol/server'
import {
  invokeFunction,
  FunctionNotBoundError,
  LiveViewUnavailableError,
  RUNS_EVENTS_FUNCTION_ID,
  RUNS_LIVE_URL_FUNCTION_ID,
  UnknownRunError,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import { handleRosterOf, RunsLiveUrlInputSchema } from '@vostride/agent-qa-schema'
import type {
  FunctionCaller,
  RunEventEnvelope,
  RunsLiveUrlResult,
} from '@vostride/agent-qa-schema'

import { renderAppWrapperPage } from './app-wrapper.js'
import type { AppWrapperMint } from './app-wrapper.js'
import { liveRunLinkOf } from './live-link.js'
import type { LiveLinkSupplier } from './live-link.js'

// Restated, not imported: ext-apps peer-depends on SDK v1, and this package ships the v2 split SDK.
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui'

/** The media type an App resource is served as. Restated locally for the reason above. */
export const APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

/** The published App address. ONE template, per run — the runId is the only variable. */
export const APP_RESOURCE_URI_TEMPLATE = 'ui://agent-qa/live-run/{runId}'

// `encodeURIComponent` inverts `parseAppUri`'s decode, so an address reads back the same id.
export function appResourceUriFor(runId: string): string {
  return APP_RESOURCE_URI_TEMPLATE.replace('{runId}', encodeURIComponent(runId))
}

/** The registered resource name. Prefixed like the tools, so one namespace reads as one server. */
export const APP_RESOURCE_NAME = 'agent_qa_live_run_app'

const APP_RESOURCE_TITLE = 'agent-qa live run'

// Authored prose about the SURFACE, not about any run — the same class of string as a tool's
// curated title, so it is not masked. Nothing interpolated here comes from a caller or from storage.
const APP_RESOURCE_DESCRIPTION =
  'The live view for one run, as an MCP App: a sandboxed page embedding the run\'s live preview '
  + 'for each member handle. Rendered fresh on every read.'

/** The `ui://` scheme and the two fixed path segments, spelled once for the one codec below. */
const APP_URI_PREFIX = 'ui://agent-qa/live-run/'

/**
 * The ONE parser of a `ui://` app address.
 *
 * TOTAL AND UNDECORATED: it answers the run id or `undefined`, and it never explains which clause
 * refused — the caller-facing sentence is the read handler's, phrased once.
 *
 * THE RUN ID IS JUDGED BY THE MINT OP'S OWN INPUT CONTRACT, not by a pattern this file invented.
 * `RunsLiveUrlInputSchema` carries `runIdSchema` — the codec that decides whether a string may name
 * this run's own directory, so an address carrying `..`, a path separator or a control character is
 * refused here by exactly the rule that refuses it everywhere else. Stated the other way round,
 * which is the honest reading: an app address is well-formed precisely when the op this read mints
 * through would accept the run it names, so the two can never disagree about one string.
 */
export function parseAppUri(href: string): { readonly runId: string } | undefined {
  if (!href.startsWith(APP_URI_PREFIX)) return undefined
  const tail = href.slice(APP_URI_PREFIX.length)
  if (tail === '') return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(tail)
  } catch {
    return undefined
  }
  const parsed = RunsLiveUrlInputSchema.safeParse({ runId: decoded })
  if (!parsed.success) return undefined
  return { runId: parsed.data.runId }
}

// Re-exported from the SDK so a spelling drift fails the build instead of never negotiating.
export const APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY = CLIENT_CAPABILITIES_META_KEY

/**
 * The ONE member of the SDK's read context this module reads.
 *
 * Declared structurally rather than as `Pick<ServerContext, 'mcpReq'>` for a reason a cell feels
 * immediately: the SDK's context carries a dozen live functions, and a predicate whose input
 * cannot be written down without them is a predicate only the wire can test. `ServerContext` is
 * assignable to this, so the production call site still hands over the SDK's own object untouched.
 */
export interface AppReadContext {
  readonly mcpReq?: { readonly envelope?: Partial<RequestMetaEnvelope> }
}

// Fails closed, but the caller writes the envelope unauthenticated: a capability signal, not auth.
export function negotiatedAppsExtension(ctx: AppReadContext | undefined): boolean {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined
  if (envelope === undefined) return false
  const capabilities = envelope[APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY] as
    | ClientCapabilities
    | undefined
  const extensions = capabilities?.extensions
  if (extensions === undefined) return false
  return Object.hasOwn(extensions, MCP_APPS_EXTENSION_ID)
}

// Thrown before the first mint, so its message holds no token and no caller text.
export class AppResourceNegotiationError extends Error {
  constructor() {
    super(
      `this resource is an MCP App: it is served only to a client that declared the `
      + `${MCP_APPS_EXTENSION_ID} extension in its capabilities`,
    )
    this.name = 'AppResourceNegotiationError'
  }
}

/** An address the one codec does not recognise. */
export class AppResourceUriError extends Error {
  constructor(detail: string) {
    super(`${detail} is not a canonical ui://agent-qa/live-run address`)
    this.name = 'AppResourceUriError'
  }
}

// A missing live session is rendered, never thrown; this class carries real read failures, masked.
export class AppResourceReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppResourceReadError'
  }
}

// The frame allowance names one origin, so a document spanning origins is refused, not widened.
export class AppResourceOriginSpanError extends Error {
  constructor(origins: readonly string[]) {
    super(
      `this App document would span ${origins.length} origins `
      + `(${[...origins].sort().join(', ')}) and one frame allowance covers one: refusing to serve `
      + `a document whose panes it could not all reach`,
    )
    this.name = 'AppResourceOriginSpanError'
  }
}

/** The host-bound `(registry, caller)` closure over `invokeFunction`. */
export type AppResourceInvoke = (opId: string, input: unknown) => Promise<unknown>

export interface AppResourceReadDeps {
  readonly invoke: AppResourceInvoke
  /** How CALLER text leaving this handler is masked. Required — see the header's channel split. */
  readonly maskText: (text: string) => string
  // Optional: without it the wrapper renders no anchor, and its expired states offer no link.
  readonly liveLink?: LiveLinkSupplier
}

function isNotLiveRefusal(error: unknown): boolean {
  return (
    error instanceof UnknownRunError
    || error instanceof LiveViewUnavailableError
    || error instanceof FunctionNotBoundError
  )
}

// `undefined` means no roster and `[]` an empty one; the read handler resolves both.
async function announcedRoster(
  invoke: AppResourceInvoke,
  runId: string,
): Promise<readonly number[] | undefined> {
  const stream = await invoke(RUNS_EVENTS_FUNCTION_ID, { runId })
  const iterable = stream as AsyncIterable<RunEventEnvelope> | undefined
  if (iterable === undefined || typeof iterable[Symbol.asyncIterator] !== 'function') {
    return undefined
  }
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done === true) return undefined
    return handleRosterOf(first.value)
  } finally {
    await iterator.return?.(undefined)
  }
}

/**
 * Build the App read.
 *
 * Exported so a cell can drive it without a server, and so the parse/mint/render behaviour is
 * observable independently of registration — the two halves fail in different directions.
 */
export function createAppResourceReadHandler(
  deps: AppResourceReadDeps,
): (uri: URL, variables: Variables, ctx: AppReadContext) => Promise<ReadResourceResult> {
  return async (
    uri: URL,
    _variables: Variables,
    ctx: AppReadContext,
  ): Promise<ReadResourceResult> => {
    // A rendering-capability filter, not authorization; it runs first so a refusal mints nothing.
    if (!negotiatedAppsExtension(ctx)) throw new AppResourceNegotiationError()

    const parsed = parseAppUri(uri.href)
    if (parsed === undefined) {
      // The echoed address is caller-supplied text, so it is masked exactly as `resources.ts`
      // masks its own — this is the refusal channel, and the channel split is the point.
      throw new AppResourceUriError(deps.maskText(uri.href))
    }
    const { runId } = parsed

    let roster: readonly number[] | undefined
    let notLive = false
    try {
      roster = await announcedRoster(deps.invoke, runId)
    } catch (err) {
      if (!isNotLiveRefusal(err)) {
        throw new AppResourceReadError(
          deps.maskText(err instanceof Error ? err.message : String(err)),
        )
      }
      notLive = true
    }

    // `??` misses `[]`; an announced-empty roster mints handle 0 instead of reading as `run-ended`.
    const rosterToMint = roster === undefined || roster.length === 0 ? [0] : roster

    const mints: AppWrapperMint[] = []
    if (!notLive) {
      for (const handle of rosterToMint) {
        // Fresh on every read: nothing is cached, so no stale token is served.
        let minted: RunsLiveUrlResult
        try {
          minted = (await deps.invoke(RUNS_LIVE_URL_FUNCTION_ID, {
            runId,
            handle,
          })) as RunsLiveUrlResult
        } catch (err) {
          if (!isNotLiveRefusal(err)) {
            throw new AppResourceReadError(
              deps.maskText(err instanceof Error ? err.message : String(err)),
            )
          }
          // One member of a suite can finish while the run continues, so a per-handle refusal
          // drops that PANE rather than the whole document. Zero surviving mints is the run-level
          // not-live case, decided below by counting rather than by a second flag.
          continue
        }
        mints.push({
          handle: minted.handle,
          liveUrl: minted.liveUrl,
          expiresAt: minted.expiresAt,
          streamKind: minted.stream.kind,
        })
      }
    }

    // `liveRunLinkOf` builds the address carrier results use; with no base the link stays absent.
    const base = deps.liveLink?.dashboardBaseUrl()
    const permanentLink
      = base === undefined || base.trim() === '' ? undefined : liveRunLinkOf(base.trim(), runId)

    // Distinct origins of every mint; more than one is refused before the wrapper is composed.
    const frameOrigins = [
      ...new Set(
        mints
          .map((mint) => originOf(mint.liveUrl))
          .filter((origin): origin is string => origin !== undefined),
      ),
    ]
    if (frameOrigins.length > 1) throw new AppResourceOriginSpanError(frameOrigins)
    const frameDomain = frameOrigins[0]

    const html = renderAppWrapperPage({
      runId,
      mints,
      permanentLink,
      runLive: mints.length > 0,
    })

    // Not masked: the payload is a credential minted for this read; masking it breaks the embed.
    return {
      contents: [
        {
          // Re-formatted through the codec's own vocabulary rather than echoed, so the address a
          // caller reads back is the canonical one.
          uri: `${APP_URI_PREFIX}${runId}`,
          mimeType: APP_RESOURCE_MIME_TYPE,
          text: html,
          // Hosts default `frame-src` and `connect-src` to none; allow the minted origin in both.
          ...(frameDomain === undefined
            ? {}
            : {
                _meta: {
                  ui: { csp: { frameDomains: [frameDomain], connectDomains: [frameDomain] } },
                },
              }),
        },
      ],
    }
  }
}

/** The origin of a minted `liveUrl`, or `undefined` if it is not a URL this host can name. */
function originOf(liveUrl: string): string | undefined {
  try {
    return new URL(liveUrl).origin
  } catch {
    return undefined
  }
}

// A narrow `McpServer` slice; the read callback keeps the SDK type, as the gate reads its context.
export interface AppResourceRegistrar {
  registerResource(
    name: string,
    template: ResourceTemplate,
    config: ResourceMetadata,
    read: ReadResourceTemplateCallback,
  ): unknown
}

/** Exactly what this module needs from the host — the same record `catalog.ts` already holds. */
export interface AppResourceDeps {
  readonly registry: FunctionRegistry
  readonly caller: FunctionCaller
  readonly maskText: (text: string) => string
  readonly liveLink?: LiveLinkSupplier
}

// Registers only when both ops are declared and the mint is bound; otherwise no template, no error.
export function registerAppResources(
  server: AppResourceRegistrar,
  deps: AppResourceDeps,
): readonly string[] {
  const declared = deps.registry.list(deps.caller)
  const mint = declared.find((candidate) => candidate.id === RUNS_LIVE_URL_FUNCTION_ID)
  const roster = declared.find((candidate) => candidate.id === RUNS_EVENTS_FUNCTION_ID)
  if (mint === undefined || roster === undefined) return []
  if (mint.bindingStatus !== 'bound') return []

  const read = createAppResourceReadHandler({
    // The wall, bound once: every mint crosses `invokeFunction` with this host's registry and this
    // caller, so input validation and the binding check run exactly as they do for a tool call.
    // There is no store, no cache and no second data path.
    invoke: (opId, input) => invokeFunction(deps.registry, opId, input, deps.caller),
    maskText: deps.maskText,
    // Absent stays ABSENT rather than becoming a present `undefined` supplier: the house rule for
    // an optional member, and the two are the same posture to the read either way.
    ...(deps.liveLink === undefined ? {} : { liveLink: deps.liveLink }),
  })

  server.registerResource(
    APP_RESOURCE_NAME,
    // Unlisted, so no model walking `resources/list` finds an address whose read mints a token.
    new ResourceTemplate(APP_RESOURCE_URI_TEMPLATE, { list: undefined }),
    {
      title: APP_RESOURCE_TITLE,
      description: APP_RESOURCE_DESCRIPTION,
      mimeType: APP_RESOURCE_MIME_TYPE,
    },
    read,
  )

  return [APP_RESOURCE_URI_TEMPLATE]
}
