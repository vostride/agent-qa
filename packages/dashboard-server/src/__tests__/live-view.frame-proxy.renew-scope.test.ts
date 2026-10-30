// A renew must name the greeted handle, and a replayed older token never shortens the deadline.

import { createHmac, timingSafeEqual } from 'node:crypto'

import { LIVE_URL_SCOPE, type LiveUrlSigner, type RunSession } from '@vostride/agent-qa-schema'
import { mintLiveUrlToken, validateLiveUrlToken } from '@vostride/agent-qa-agent'
import type WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFrameProxy } from '../live-view/frame-proxy.js'
import { LIVE_VIEW_REFUSAL_CLOSE_CODE } from '../live-view/protocol.js'

const SIGNING_KEY = 'zz-review-renew-scope-signing-key'
const BASE_TIME = 1_700_000_000_000

const signer: LiveUrlSigner = {
  sign: (data) => createHmac('sha256', SIGNING_KEY).update(data).digest('base64url'),
  equals: (a, b) => {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  },
}

function tokenFor(handle: number, exp: number): string {
  return mintLiveUrlToken(signer, {
    subject: { kind: 'run', runId: 'r1', handle },
    scope: LIVE_URL_SCOPE,
    iat: Date.now(),
    exp,
  })
}

function viewer() {
  const texts: Array<Record<string, unknown>> = []
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  let closed: { code?: number; reason?: string } | undefined
  let readyState = 1
  const socket = {
    OPEN: 1,
    get readyState() {
      return readyState
    },
    bufferedAmount: 0,
    send: (data: unknown) => {
      if (typeof data === 'string') texts.push(JSON.parse(data) as Record<string, unknown>)
    },
    close: (code?: number, reason?: string) => {
      closed ??= { code, reason }
      readyState = 3
    },
    ping: () => {},
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return this
    },
  }
  const session = {
    streamCapabilityOf: () => ({ kind: 'none' }),
    subscribeFrames: () => undefined,
    done: new Promise(() => undefined),
  } as unknown as RunSession
  const proxy = createFrameProxy({
    validate: (token, expectation) => validateLiveUrlToken(signer, token, expectation),
    attach: () => session,
  })
  proxy(socket as unknown as WebSocket, 'r1')
  const speak = (message: object) => {
    for (const handler of handlers.get('message') ?? []) handler(Buffer.from(JSON.stringify(message)), false)
  }
  return {
    texts,
    closed: () => closed,
    greet: (token: string) => speak({ type: 'hello', token }),
    renew: (token: string) => speak({ type: 'renew', token }),
  }
}

describe('a frame-socket renew keeps to what the socket greeted with', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('RENEW-KEEPS-HANDLE: a valid token for another handle of the same run is refused scope_mismatch', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const socket = viewer()
    socket.greet(tokenFor(0, BASE_TIME + 60_000))
    expect(socket.texts[0]?.type, 'the witness: the socket is open on handle 0').toBe('ready')

    socket.renew(tokenFor(1, BASE_TIME + 120_000))
    expect(socket.texts.filter((text) => text.type === 'renewed')).toEqual([])
    expect(socket.texts.at(-1)).toEqual({ type: 'refused', reason: 'scope_mismatch' })
    expect(socket.closed()?.code).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
  })

  it('RENEW-NEVER-SHORTENS: an older still-valid token leaves the later deadline in place', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const socket = viewer()
    socket.greet(tokenFor(0, BASE_TIME + 60_000))
    const later = BASE_TIME + 120_000
    socket.renew(tokenFor(0, later))
    socket.renew(tokenFor(0, BASE_TIME + 30_000))

    expect(socket.texts.filter((text) => text.type === 'renewed').map((text) => text.expiresAt))
      .toEqual([later, later])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.closed(), 'not refused on the older token\'s expiry').toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.closed()).toEqual({ code: LIVE_VIEW_REFUSAL_CLOSE_CODE, reason: 'expired' })
  })
})
