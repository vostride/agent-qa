// The mint and the validator are composed together, so there is one parse of a `liveUrl` token.

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
  // Taken as a plain function so this module imports nothing from the dashboard server.
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
    // By reference; the dashboard server holds no parse of its own.
    validate: (token, expect) => validateLiveUrlToken(signer, token, expect),
  }
}

// Both doors call this; the strict result schema makes a grown field a throw, not a leak.
export function mintLiveUrlThrough(
  registry: FunctionRegistry,
  caller: FunctionCaller,
): (runId: string, handle: number) => Promise<RunsLiveUrlResult> {
  return async (runId, handle) => RunsLiveUrlResultSchema.parse(
    await invokeFunction(registry, RUNS_LIVE_URL_FUNCTION_ID, { runId, handle }, caller),
  )
}

// Mints an editor `liveUrl` the same way, parsed with the strict result schema.
export function mintEditorLiveUrlThrough(
  registry: FunctionRegistry,
  caller: FunctionCaller,
): (sessionId: string) => Promise<EditorLiveUrlResult> {
  return async (sessionId) => EditorLiveUrlResultSchema.parse(
    await invokeFunction(registry, EDITOR_LIVE_URL_FUNCTION_ID, { sessionId }, caller),
  )
}
