// Cells drive the production `startServer` with the `Origin` and `Sec-Fetch-Site` a browser sends.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  LIVE_URL_SCOPE,
  type EditorLiveUrlResult,
  type LiveUrlSigner,
  type LiveUrlVerdict,
} from '@vostride/agent-qa-schema'
import { mintLiveUrlToken, validateLiveUrlToken } from '@vostride/agent-qa-agent'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import { LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE } from '../live-editor/types.js'
import { createLiveEditorSubjects } from '../live-view/editor-subjects.js'
import type { LiveEditorAttachment, LiveEditorSubjects } from '../live-view/editor-subjects.js'
import { LIVE_EMBED_PATH_PREFIX, LIVE_VIEW_WS_PATH } from '../live-view/protocol.js'
import { startServer } from '../server/server.js'

const FOREIGN_ORIGIN = 'http://evil.example'

interface Served {
  readonly port: number
  readonly selfOrigin: string
  close(): void
}

const opened: Served[] = []

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close()
})

type EditorMint = (sessionId: string) => Promise<EditorLiveUrlResult>

const signer: LiveUrlSigner = {
  sign: (data) => createHmac('sha256', 'zz-editor-doors-signing-key').update(data).digest('base64url'),
  equals: (a, b) => {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  },
}

async function serve(input: {
  mintEditorLiveUrl?: EditorMint
  liveView?: false
  liveEditorSubjects?: LiveEditorSubjects
} = {}): Promise<Served> {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    ...(input.liveEditorSubjects === undefined ? {} : { liveEditorSubjects: input.liveEditorSubjects }),
    ...(input.liveView === false
      ? {}
      : {
          liveView: {
            validate: (token, expectation): LiveUrlVerdict => validateLiveUrlToken(signer, token, expectation),
            mintLiveUrl: async () => { throw new Error('this fixture mints no run view') },
            ...(input.mintEditorLiveUrl === undefined ? {} : { mintEditorLiveUrl: input.mintEditorLiveUrl }),
          },
        }),
  })
  const port = (started.server.address() as AddressInfo).port
  const served: Served = {
    port,
    selfOrigin: `http://127.0.0.1:${String(port)}`,
    close: () => { started.close() },
  }
  opened.push(served)
  return served
}

interface Answer {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  json(): unknown
}

function call(
  served: Served,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: served.port,
      method,
      path,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: text,
          json: () => JSON.parse(text) as unknown,
        })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

interface UpgradeOutcome {
  /** True only when the server answered `101 Switching Protocols`. */
  readonly switched: boolean
  readonly closeCode: number | undefined
  readonly closeReason: string
}

function upgradeControlSocket(
  served: Served,
  sessionId: string,
  origin?: string,
): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(served.port)}/api/live-editor/ws?sessionId=${encodeURIComponent(sessionId)}`,
      origin === undefined ? {} : { origin },
    )
    let switched = false
    const budget = setTimeout(() => {
      socket.terminate()
      reject(new Error('the upgrade neither closed nor failed within 5000 ms'))
    }, 5_000)
    socket.on('upgrade', () => { switched = true })
    socket.on('error', () => { /* a destroyed upgrade reports here and then closes */ })
    socket.on('close', (code: number, reason: Buffer) => {
      clearTimeout(budget)
      resolve({ switched, closeCode: switched ? code : undefined, closeReason: reason.toString('utf8') })
    })
  })
}

const MINTED: EditorLiveUrlResult = {
  liveUrl: 'http://127.0.0.1:3470/live/session-1#t=v2.token',
  expiresAt: 1_900_000_000_000,
  stream: { kind: 'cdp-screencast' },
}

function namedError(name: string): Error {
  const error = new Error(`a ${name}`)
  error.name = name
  return error
}

describe('EDITOR-MINT-ROUTE: GET /api/live-editor/sessions/:id/live-url', () => {
  it('EDITOR-MINT-ROUTE answers the mint result verbatim, with no wildcard grant', async () => {
    const mint = vi.fn<EditorMint>(async () => MINTED)
    const served = await serve({ mintEditorLiveUrl: mint })

    const answer = await call(served, 'GET', '/api/live-editor/sessions/session-1/live-url')

    expect(answer.status).toBe(200)
    expect(answer.json()).toEqual(MINTED)
    expect(answer.headers['access-control-allow-origin']).toBeUndefined()
    expect(mint).toHaveBeenCalledWith('session-1')
  })

  it('EDITOR-MINT-ROUTE maps UnknownLiveEditorSessionError to 404 unknown_session', async () => {
    const served = await serve({
      mintEditorLiveUrl: async () => { throw namedError('UnknownLiveEditorSessionError') },
    })

    const answer = await call(served, 'GET', '/api/live-editor/sessions/gone/live-url')

    expect(answer.status).toBe(404)
    expect(answer.json()).toEqual({ error: 'unknown_session' })
    expect(answer.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('EDITOR-MINT-ROUTE maps LiveViewUnavailableError to 503 live_view_unavailable', async () => {
    const served = await serve({
      mintEditorLiveUrl: async () => { throw namedError('LiveViewUnavailableError') },
    })

    const answer = await call(served, 'GET', '/api/live-editor/sessions/session-1/live-url')

    expect(answer.status).toBe(503)
    expect(answer.json()).toEqual({ error: 'live_view_unavailable' })
  })

  it('EDITOR-MINT-ROUTE maps any other failure to 500 live_url_mint_failed', async () => {
    const served = await serve({ mintEditorLiveUrl: async () => { throw new Error('boom') } })

    const answer = await call(served, 'GET', '/api/live-editor/sessions/session-1/live-url')

    expect(answer.status).toBe(500)
    expect(answer.json()).toEqual({ error: 'live_url_mint_failed' })
  })

  it('EDITOR-MINT-ROUTE answers 503 live_view_unavailable when no editor mint is bound', async () => {
    const withoutMint = await serve()
    const withoutLiveView = await serve({ liveView: false })

    for (const served of [withoutMint, withoutLiveView]) {
      const answer = await call(served, 'GET', '/api/live-editor/sessions/session-1/live-url')
      expect(answer.status).toBe(503)
      expect(answer.json()).toEqual({ error: 'live_view_unavailable' })
      expect(answer.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('EDITOR-MINT-ROUTE refuses a cross-site caller before the mint is dispatched', async () => {
    const mint = vi.fn<EditorMint>(async () => MINTED)
    const served = await serve({ mintEditorLiveUrl: mint })

    const answer = await call(served, 'GET', '/api/live-editor/sessions/session-1/live-url', {
      origin: FOREIGN_ORIGIN,
    })

    expect(answer.status).toBe(403)
    expect(answer.json()).toEqual({ error: 'cross_site_refused' })
    expect(answer.headers['access-control-allow-origin']).toBeUndefined()
    expect(mint).not.toHaveBeenCalled()
  })

  it('EDITOR-MINT-ROUTE leaves DELETE /api/live-editor/sessions/:id to its own arm', async () => {
    const served = await serve({ mintEditorLiveUrl: async () => MINTED })

    const answer = await call(served, 'DELETE', '/api/live-editor/sessions/never-created')

    expect(answer.status).toBe(404)
    expect(answer.json()).toEqual({ error: 'Session not found' })
  })
})

describe('the control-socket upgrade: /api/live-editor/ws', () => {
  it('EDITOR-UPGRADE-CROSS-SITE-DESTROYED: a foreign Origin gets no 101', async () => {
    const served = await serve()

    const outcome = await upgradeControlSocket(served, 'any-session', FOREIGN_ORIGIN)

    expect(outcome.switched, 'a cross-site upgrade is destroyed bare').toBe(false)
  })

  it('EDITOR-UPGRADE-CROSS-SITE-DESTROYED: the literal null Origin gets no 101', async () => {
    const served = await serve()

    const outcome = await upgradeControlSocket(served, 'any-session', 'null')

    expect(outcome.switched, 'null is an origin that declined to name itself').toBe(false)
  })

  it('EDITOR-UPGRADE-ADMITS-SAME-ORIGIN: a same-host Origin is admitted and then named', async () => {
    const served = await serve()

    const outcome = await upgradeControlSocket(served, 'unknown-session', served.selfOrigin)

    expect(outcome.switched, 'the dashboard page driving its own socket is admitted').toBe(true)
    expect(outcome.closeCode).toBe(LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE)
  })

  it('EDITOR-UPGRADE-ADMITS-SAME-ORIGIN: an absent Origin is admitted and then named', async () => {
    const served = await serve()

    const outcome = await upgradeControlSocket(served, 'unknown-session')

    expect(outcome.switched, 'a non-browser client sends no Origin and is admitted').toBe(true)
    expect(outcome.closeCode).toBe(LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE)
  })

  it('EDITOR-UPGRADE-UNKNOWN-SESSION-4404: an unknown session closes 4404 unknown_session', async () => {
    const served = await serve()

    const outcome = await upgradeControlSocket(served, 'session-this-process-never-held')

    expect(LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE).toBe(4404)
    expect(outcome.switched).toBe(true)
    expect(outcome.closeCode).toBe(4404)
    expect(outcome.closeReason).toBe('unknown_session')
  })
})

describe('the frame socket serves editor subjects from liveEditorSubjects', () => {
  it('FRAME-SERVES-EDITOR-SUBJECT: an editor token opens a registered session on the production frame', async () => {
    const subjects = createLiveEditorSubjects()
    const attachment: LiveEditorAttachment = {
      streamCapabilityOf: () => ({ kind: 'none' }),
      subscribeFrames: () => undefined,
      ended: new Promise<void>(() => {}),
    }
    subjects.register('session-1', attachment)
    // No run registry: the editor registry alone is enough to serve the embed page and the socket.
    const served = await serve({ liveEditorSubjects: subjects })

    const embed = await call(served, 'GET', `${LIVE_EMBED_PATH_PREFIX}session-1`)
    expect(embed.status, 'the embed page is served for an editor-only host').toBe(200)

    const now = Date.now()
    const token = mintLiveUrlToken(signer, {
      subject: { kind: 'editor', sessionId: 'session-1' },
      scope: LIVE_URL_SCOPE,
      iat: now,
      exp: now + 60_000,
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(served.port)}${LIVE_VIEW_WS_PATH}?runId=session-1`)
    const first = await new Promise<{ type?: string; runId?: string; stream?: { kind?: string } }>((resolve, reject) => {
      const budget = setTimeout(() => { reject(new Error('no answer to hello within 5000 ms')) }, 5_000)
      socket.once('open', () => { socket.send(JSON.stringify({ type: 'hello', token })) })
      socket.once('message', (data: Buffer) => {
        clearTimeout(budget)
        resolve(JSON.parse(data.toString('utf8')) as { type?: string })
      })
      socket.once('error', reject)
    })
    socket.close()

    expect(first.type).toBe('ready')
    expect(first.runId).toBe('session-1')
    expect(first.stream?.kind).toBe('none')
  })
})

interface Door {
  readonly name: string
  readonly method: string
  readonly path: string
  readonly body?: string
}

const LIVE_EDITOR_DOORS: readonly Door[] = [
  { name: 'POST /api/live-editor/sessions', method: 'POST', path: '/api/live-editor/sessions', body: '{"platform":"web"}' },
  { name: 'GET /api/live-editor/sessions', method: 'GET', path: '/api/live-editor/sessions' },
  { name: 'DELETE /api/live-editor/sessions/abc', method: 'DELETE', path: '/api/live-editor/sessions/abc' },
  {
    name: 'POST /api/live-editor/sessions/abc/auth-state',
    method: 'POST',
    path: '/api/live-editor/sessions/abc/auth-state',
    body: '{"name":"main"}',
  },
]

const CROSS_SITE_CALLERS: readonly { readonly name: string; readonly headers: Record<string, string> }[] = [
  { name: 'a foreign Origin', headers: { origin: FOREIGN_ORIGIN } },
  { name: 'Sec-Fetch-Site cross-site with no Origin', headers: { 'sec-fetch-site': 'cross-site' } },
]

describe('LIVE-EDITOR-DOORS-REFUSE-CROSS-SITE', () => {
  for (const door of LIVE_EDITOR_DOORS) {
    for (const caller of CROSS_SITE_CALLERS) {
      it(`LIVE-EDITOR-DOORS-REFUSE-CROSS-SITE: ${door.name} refuses ${caller.name}`, async () => {
        const served = await serve()

        const answer = await call(served, door.method, door.path, caller.headers, door.body)

        expect(answer.status).toBe(403)
        expect(answer.json()).toEqual({ error: 'cross_site_refused' })
      })
    }
  }
})

describe('LIVE-EDITOR-DOORS-CARRY-NO-ACAO', () => {
  it('LIVE-EDITOR-DOORS-CARRY-NO-ACAO: no refused answer carries a wildcard grant', async () => {
    const served = await serve()

    for (const door of LIVE_EDITOR_DOORS) {
      for (const caller of CROSS_SITE_CALLERS) {
        const answer = await call(served, door.method, door.path, caller.headers, door.body)
        expect(answer.headers['access-control-allow-origin'], `${door.name}, ${caller.name}`)
          .toBeUndefined()
      }
    }
  })

  it('LIVE-EDITOR-DOORS-CARRY-NO-ACAO: no admitted answer carries a wildcard grant', async () => {
    const served = await serve()
    const admitted: readonly { readonly name: string; readonly headers: Record<string, string> }[] = [
      { name: 'a same-host Origin', headers: { origin: served.selfOrigin, 'sec-fetch-site': 'same-origin' } },
      { name: 'no Origin', headers: {} },
    ]

    for (const door of LIVE_EDITOR_DOORS) {
      for (const caller of admitted) {
        const answer = await call(served, door.method, door.path, caller.headers, door.body)
        expect(answer.status, `${door.name}, ${caller.name} is admitted`).not.toBe(403)
        expect(answer.headers['access-control-allow-origin'], `${door.name}, ${caller.name}`)
          .toBeUndefined()
      }
    }
  })

  it('LIVE-EDITOR-DOORS-CARRY-NO-ACAO: an admitted GET lists sessions and an admitted DELETE of an unknown id answers as before', async () => {
    const served = await serve()

    const listed = await call(served, 'GET', '/api/live-editor/sessions', { origin: served.selfOrigin })
    expect(listed.status).toBe(200)
    expect(listed.json()).toEqual({ sessions: [] })

    const deleted = await call(served, 'DELETE', '/api/live-editor/sessions/abc')
    expect(deleted.status).toBe(404)
    expect(deleted.json()).toEqual({ error: 'Session not found' })

    const saved = await call(served, 'POST', '/api/live-editor/sessions/abc/auth-state', {}, '{"name":"main"}')
    expect(saved.status).toBe(404)
    expect(saved.json()).toEqual({ error: 'Session not found' })
  })
})
