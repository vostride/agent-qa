// The live-view COMPOSITION (403 D-03/D-04, Q4(b)) — the one place a signer, a live run registry
// and the function layer's validator are joined.
//
// WHAT IT PRODUCES, AND WHY TWO THINGS RATHER THAN ONE. `liveView` is the mint-side port the
// function layer needs; `validate` is the read-side the dashboard's frame proxy binds BY REFERENCE
// (so there is exactly one parse of a `liveUrl` token in this system). Both directions are composed
// together deliberately — a mint whose validator was composed elsewhere is a token system with two
// opinions about what a valid token is.
//
// it registers no minted token for masking. A door-minted credential is not a
// declared secret; the token's guarantee is structural — a URL fragment, the frame socket's first
// message, and an op `classify` that refuses to interpolate it.

import {
  EDITOR_LIVE_URL_FUNCTION_ID,
  invokeFunction,
  RUNS_LIVE_URL_FUNCTION_ID,
  validateLiveUrlToken,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry, LiveViewPort } from '@vostride/agent-qa-agent'
import { EditorLiveUrlResultSchema, RunsLiveUrlResultSchema } from '@vostride/agent-qa-schema'
import type {
  EditorLiveUrlResult,
  FunctionCaller,
  LiveStreamDeclaration,
  LiveUrlSigner,
  LiveUrlVerdict,
  LiveViewSubjectRef,
  RunsLiveUrlResult,
} from '@vostride/agent-qa-schema'

import { createEphemeralLiveUrlSigner } from './live-url-signer.js'
import type { RunServiceSessionRegistry } from './run-service-session-registry.js'

export interface ComposeLiveViewInput {
  readonly sessions: RunServiceSessionRegistry
  readonly origin: () => string | undefined
  readonly signer?: LiveUrlSigner
  readonly now?: () => number
  /**
   * The editor session lookup, taken STRUCTURALLY as a plain function so this module
   * imports nothing from the dashboard server. Absent means the host serves no live editor, and
   * `editor.liveurl` refuses `LiveViewUnavailableError`.
   */
  readonly editorCapabilityOf?: (sessionId: string) => LiveStreamDeclaration | undefined
}

export interface ComposedLiveView {
  /** The mint-side port `FunctionDeps.liveView` binds to. */
  readonly liveView: LiveViewPort
  /** The read side — the function layer's own validator, closed over the same signer. */
  validate(token: string, expect: { subject: LiveViewSubjectRef; now: number }): LiveUrlVerdict
}

export function composeLiveView(input: ComposeLiveViewInput): ComposedLiveView {
  const signer = input.signer ?? createEphemeralLiveUrlSigner()
  const now = input.now ?? ((): number => Date.now())

  const liveView: LiveViewPort = {
    signer,
    origin: input.origin,
    now,
    capabilityOf(runId: string, handle: number): LiveStreamDeclaration | undefined {
      const session = input.sessions.attach(runId)
      if (!session) return undefined
      return session.streamCapabilityOf(handle)
    },
    ...(input.editorCapabilityOf === undefined ? {} : { editorCapabilityOf: input.editorCapabilityOf }),
  }

  return {
    liveView,
    // BY REFERENCE, not re-implemented. The dashboard-server holds no parse of its own.
    validate: (token, expect) => validateLiveUrlToken(signer, token, expect),
  }
}

/**
 * Mint one `liveUrl` through the SHIPPED dispatcher, for whichever door asked (403 D-03, Q3).
 *
 * ONE FUNCTION, CALLED BY BOTH DOORS BY REFERENCE. The local dashboard door and the remote authed
 * door mint the same credential and differ in exactly one thing: the caller identity they run
 * under. Writing that twice would be two dispatch sites free to drift — one of them forgetting the
 * parse, or reaching the port underneath the dispatcher, or shaping the result — and the drift
 * would be invisible until somebody diffed them. The parity corpus compares the two doors' BYTES;
 * this is what makes that comparison a claim about one implementation rather than about two that
 * happen to agree.
 *
 * THE DISPATCHER, NOT THE PORT UNDERNEATH IT. Going straight to `liveView.signer` would skip
 * the op-level gate and the receipt classification — the carve-out the no-private-powers law
 * refuses. `runs.liveurl` is the ONLY producer of these tokens and this
 * is the only way to reach it from a door.
 *
 * PARSED, NOT CAST. `RunsLiveUrlResultSchema` is `.strict()`, so a result that grew a field — a
 * flattened session, a live capability handle — is a throw here rather than a leak on the wire.
 */
export function mintLiveUrlThrough(
  registry: FunctionRegistry,
  caller: FunctionCaller,
): (runId: string, handle: number) => Promise<RunsLiveUrlResult> {
  return async (runId, handle) => RunsLiveUrlResultSchema.parse(
    await invokeFunction(registry, RUNS_LIVE_URL_FUNCTION_ID, { runId, handle }, caller),
  )
}

/**
 * Mint one editor `liveUrl` through the SHIPPED dispatcher, exactly as
 * {@link mintLiveUrlThrough} mints a run's: the same dispatcher, the same caller, the editor
 * subject. Parsed with the `.strict()` result schema, never cast.
 */
export function mintEditorLiveUrlThrough(
  registry: FunctionRegistry,
  caller: FunctionCaller,
): (sessionId: string) => Promise<EditorLiveUrlResult> {
  return async (sessionId) => EditorLiveUrlResultSchema.parse(
    await invokeFunction(registry, EDITOR_LIVE_URL_FUNCTION_ID, { sessionId }, caller),
  )
}
