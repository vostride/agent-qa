// Reads the editor lookup only, so an editor session can never become a watchable run.

import {
  EditorLiveUrlInputSchema,
  EditorLiveUrlResultSchema,
  LIVE_URL_SCOPE,
} from '@vostride/agent-qa-schema'
import type { EditorLiveUrlInput, EditorLiveUrlResult } from '@vostride/agent-qa-schema'

import { liveUrlOf, mintLiveUrlToken, LIVE_URL_TTL_MS } from '../live-url.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'
import { LiveViewUnavailableError } from './runs-live-url.js'

export const EDITOR_LIVE_URL_FUNCTION_ID = 'editor.liveurl'

/** No such live editor session on this host. Doors map it by `error.name`. */
export class UnknownLiveEditorSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown_session: no live editor session ${sessionId}`)
    this.name = 'UnknownLiveEditorSessionError'
  }
}

export const editorLiveUrlSpec: FunctionSpec<EditorLiveUrlInput, EditorLiveUrlResult> = {
  id: EDITOR_LIVE_URL_FUNCTION_ID,
  summary: 'Mint a short-lived, view-scoped live-view URL for one live editor session.',
  resultKind: 'unary',
  boundThrough: 'liveView',
  input: EditorLiveUrlInputSchema,
  output: EditorLiveUrlResultSchema,
  risk: { name: `fn:${EDITOR_LIVE_URL_FUNCTION_ID}`, recognized: true, readOnly: true },
  // A fixed sentence: the result carries a live credential, and clause verdicts are printed into
  // transcripts, receipts and the audit sink.
  classify(): ClauseVerdict {
    return { status: 'executed', outcome: 'liveUrl minted for a live editor session' }
  },
  async invoke(input, deps): Promise<EditorLiveUrlResult> {
    const liveView = deps.liveView
    if (!liveView) throw new LiveViewUnavailableError('no live-view port is bound on this host')
    const origin = liveView.origin()
    if (origin === undefined || origin === '') {
      throw new LiveViewUnavailableError('this host is not serving on a known origin')
    }
    if (!liveView.editorCapabilityOf) {
      throw new LiveViewUnavailableError('this host serves no live editor')
    }

    const stream = liveView.editorCapabilityOf(input.sessionId)
    if (stream === undefined) throw new UnknownLiveEditorSessionError(input.sessionId)

    const now = liveView.now()
    const exp = now + LIVE_URL_TTL_MS
    const token = mintLiveUrlToken(liveView.signer, {
      subject: { kind: 'editor', sessionId: input.sessionId },
      scope: LIVE_URL_SCOPE,
      iat: now,
      exp,
    })
    liveView.onMinted?.(token)

    return { liveUrl: liveUrlOf(origin, input.sessionId, token), expiresAt: exp, stream }
  },
}
