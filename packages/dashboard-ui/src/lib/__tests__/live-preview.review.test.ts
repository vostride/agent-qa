// Each cell pins a preview report or refusal against a claim the facts do not support.

import { describe, expect, it } from 'vitest'

import {
  LIVE_RECONNECT_BACKOFF_MS,
  NO_STREAM_TEXT,
  PREVIEW_UNAVAILABLE_TEXT,
  createInitialLivePreview,
  deriveLivePreview,
  reduceLivePreview,
} from '@/lib/live-preview'

const T = 1_700_000_000_000

describe("the live preview machine's failure, refusal and empty-stream states", () => {
  it('TRANSIENT-MINT-FAILURE-RECONNECTS: a failed fetch or a 5xx gets the quiet reconnect, not a dead end', () => {
    for (const word of ['live_url_mint_failed', 'Failed to fetch', 'API error 502']) {
      const state = reduceLivePreview(createInitialLivePreview(), { type: 'mint-refused', word }, T)
      expect(deriveLivePreview(state, T), word).toMatchObject({
        state: 'reconnecting',
        retryInMs: LIVE_RECONNECT_BACKOFF_MS[0],
      })
    }
  })

  it('TRANSIENT-MINT-FAILURE-RECONNECTS: repeated failures end on Reconnect, never on a state with no action', () => {
    let state = createInitialLivePreview()
    for (let attempt = 0; attempt <= LIVE_RECONNECT_BACKOFF_MS.length; attempt += 1) {
      state = reduceLivePreview(state, { type: 'mint-refused', word: 'live_url_mint_failed' }, T + attempt)
    }
    expect(deriveLivePreview(state, T + 10)).toMatchObject({ state: 'disconnected', action: 'reconnect' })
  })

  it('DEFINITE-REFUSAL-UNAVAILABLE: only a host that will not serve a live view says unavailable', () => {
    for (const word of ['live_view_unavailable', 'invalid_handle', 'cross_site_refused']) {
      const state = reduceLivePreview(createInitialLivePreview(), { type: 'mint-refused', word }, T)
      expect(deriveLivePreview(state, T), word).toMatchObject({ state: 'unavailable', words: PREVIEW_UNAVAILABLE_TEXT })
    }
  })

  it('READY-NONE-IS-NO-STREAM: a greet that finds no stream under an up iframe says so instead of loading forever', () => {
    const embedded = reduceLivePreview(
      createInitialLivePreview(),
      { type: 'minted', stream: { kind: 'cdp-screencast' }, memberAnswered: true },
      T,
    )
    const reconnecting = reduceLivePreview(embedded, { type: 'embed', report: { event: 'lost' } }, T + 1)
    for (const [name, state] of [['embedded', embedded], ['reconnecting', reconnecting]] as const) {
      const next = reduceLivePreview(state, { type: 'embed', report: { event: 'ready', kind: 'none' } }, T + 2)
      expect(deriveLivePreview(next, T + 3), name).toMatchObject({ state: 'no-stream', words: NO_STREAM_TEXT })
    }

    const ready = reduceLivePreview(embedded, { type: 'embed', report: { event: 'ready', kind: 'cdp-screencast' } }, T + 2)
    expect(deriveLivePreview(ready, T + 3).state, 'a real stream still waits for its first frame').toBe('loading')
  })
})
