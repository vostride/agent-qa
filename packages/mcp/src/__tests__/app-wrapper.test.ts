// What the server serves; what a browser does with it is cli's `app-wrapper-dom.test.ts`.

import { describe, expect, it } from 'vitest'

import {
  APP_WRAPPER_CONNECTING_HINT,
  APP_WRAPPER_CONNECTING_MESSAGE,
  APP_WRAPPER_EXPIRED_HINT,
  APP_WRAPPER_EXPIRED_MESSAGE,
  APP_WRAPPER_LIVE_MESSAGE,
  APP_WRAPPER_LOAD_TIMEOUT_MS,
  APP_WRAPPER_PERMANENT_LINK_LABEL,
  APP_WRAPPER_RUN_ENDED_MESSAGE,
  APP_WRAPPER_STATES,
  APP_WRAPPER_UNREACHABLE_MESSAGE,
  renderAppWrapperPage,
} from '../app-wrapper.js'
import type { AppWrapperInput, AppWrapperMint, AppWrapperState } from '../app-wrapper.js'

const RUN_ID = 'run-wrapper'
const ORIGIN = 'http://127.0.0.1:7799'
const PERMANENT_LINK = `http://127.0.0.1:7799/runs/${RUN_ID}/live`
const NOW = 1_800_000_000_000

const mint = (handle: number, expiresAt: number): AppWrapperMint => ({
  handle,
  liveUrl: `${ORIGIN}/live/${RUN_ID}#v2.body${handle}.sig${handle}`,
  expiresAt,
  streamKind: 'cdp-screencast',
})

const render = (overrides: Partial<AppWrapperInput> = {}): string =>
  renderAppWrapperPage({
    runId: RUN_ID,
    mints: [mint(0, NOW + 300_000)],
    permanentLink: PERMANENT_LINK,
    runLive: true,
    now: NOW,
    ...overrides,
  })

const stateOf = (html: string): string | undefined =>
  /<main data-app-state="([^"]+)"/.exec(html)?.[1]

// An exhaustive record over the states, so a state added without a cell fails to compile.
const MESSAGE_OF: Readonly<Record<AppWrapperState, string>> = {
  connecting: APP_WRAPPER_CONNECTING_MESSAGE,
  live: APP_WRAPPER_LIVE_MESSAGE,
  expired: APP_WRAPPER_EXPIRED_MESSAGE,
  'unreachable-origin': APP_WRAPPER_UNREACHABLE_MESSAGE,
  'run-ended': APP_WRAPPER_RUN_ENDED_MESSAGE,
}

const HINT_OF: Readonly<Record<AppWrapperState, string>> = {
  connecting: APP_WRAPPER_CONNECTING_HINT,
  live: '',
  expired: APP_WRAPPER_EXPIRED_HINT,
  'unreachable-origin': '',
  'run-ended': '',
}

describe('the closed state vocabulary', () => {
  it('is exactly the five states this wrapper owns', () => {
    expect([...APP_WRAPPER_STATES]).toEqual([
      'connecting',
      'live',
      'expired',
      'unreachable-origin',
      'run-ended',
    ])
  })

  it('renders every sentence it can ever show, RANGED over the exported state list', () => {
    const html = render()
    // The census covers the vocabulary, not a subset of it a reader has to check by eye.
    expect(Object.keys(MESSAGE_OF), 'one message per state, no more').toHaveLength(
      APP_WRAPPER_STATES.length,
    )
    expect(Object.keys(HINT_OF), 'one hint slot per state, no more').toHaveLength(
      APP_WRAPPER_STATES.length,
    )

    for (const state of APP_WRAPPER_STATES) {
      expect(
        html.includes(MESSAGE_OF[state]),
        `the document carries ${state}'s sentence "${MESSAGE_OF[state]}"`,
      ).toBe(true)
      // A hint is optional per state — an EMPTY one is the honest absence of a second line, and the
      // stylesheet hides `p[data-app-hint]:empty` for exactly that reason. Only the named ones are
      // claims about bytes.
      if (HINT_OF[state] !== '') {
        expect(
          html.includes(HINT_OF[state]),
          `the document carries ${state}'s hint "${HINT_OF[state]}"`,
        ).toBe(true)
      }
    }
  })

  it('says exactly the CONTEXT sentence for a host that cannot reach the origin', () => {
    expect(APP_WRAPPER_UNREACHABLE_MESSAGE).toBe(
      "this host can't reach the live view — open it in your browser",
    )
  })
})

describe('expiry is an honest STATE, decided at render time', () => {
  it('renders `expired` when every mint has already aged out, with the sentence, the hint and the link', () => {
    const html = render({
      mints: [mint(0, NOW - 1), mint(1, NOW - 60_000)],
    })

    expect(stateOf(html)).toBe('expired')
    expect(html).toContain(APP_WRAPPER_EXPIRED_MESSAGE)
    expect(html).toContain(APP_WRAPPER_EXPIRED_HINT)
    // The refresh story is a sentence: the link is the way out, a fresh watch call the way back.
    expect(html).toContain('<a data-app-permanent-link')
    expect(html).toContain(PERMANENT_LINK)
    expect(html).toContain(APP_WRAPPER_PERMANENT_LINK_LABEL)
  })

  it('renders `connecting` while ANY mint is still good, and arms the timer from the LOWEST expiry', () => {
    const html = render({
      mints: [mint(0, NOW + 120_000), mint(1, NOW + 30_000)],
    })

    expect(stateOf(html)).toBe('connecting')
    // The clock is read once, at render, and enters the script as a delta, not as an epoch.
    expect(html).toContain('30000')
    expect(html).not.toContain(String(NOW))
  })

  it('never re-mints from inside the sandbox, and issues exactly ONE kind of request', () => {
    const html = render()
    for (const forbidden of ['runs.liveurl', 'XMLHttpRequest', 'ui/mint', 'remint', 'liveurl']) {
      expect(html.includes(forbidden), `the wrapper must not contain ${forbidden}`).toBe(false)
    }

    // Chromium fires `load` for a refused connection, so one no-cors origin probe decides `live`.
    expect(html.match(/fetch\(/g) ?? [], 'exactly one fetch call site').toHaveLength(1)
    expect(html).toContain("mode: 'no-cors'")
    expect(html.includes('#v2.body0.sig0\', {'), 'the probe never carries a minted url').toBe(false)
  })
})

describe('a run this host holds no live session for', () => {
  it('renders `run-ended` with its sentence and assigns NO iframe src anywhere', () => {
    const html = renderAppWrapperPage({
      runId: RUN_ID,
      mints: [],
      permanentLink: PERMANENT_LINK,
      runLive: false,
      now: NOW,
    })

    expect(stateOf(html)).toBe('run-ended')
    expect(html).toContain(APP_WRAPPER_RUN_ENDED_MESSAGE)
    expect(html.includes('src='), 'nothing in a not-live document has a src').toBe(false)
  })

  it('carries NO minted byte when the run is not live, even if a mint is handed in', () => {
    // The renderer is AUTHORITATIVE about this rather than trusting its caller: `runLive: false`
    // means the document must not be able to show a pane, so the urls never reach the script.
    const html = renderAppWrapperPage({
      runId: RUN_ID,
      mints: [mint(0, NOW + 300_000)],
      permanentLink: PERMANENT_LINK,
      runLive: false,
      now: NOW,
    })

    expect(stateOf(html)).toBe('run-ended')
    expect(html.includes('#v2.body0.sig0'), 'no token bytes in a not-live document').toBe(false)
  })
})

describe('the frame, the picker and the link', () => {
  it('renders exactly one iframe, sandboxed and referrer-free', () => {
    const html = render({ mints: [mint(0, NOW + 300_000), mint(1, NOW + 300_000)] })
    expect(html.match(/<iframe\b/g) ?? []).toHaveLength(1)
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).toContain('referrerpolicy="no-referrer"')
  })

  it('carries one pre-minted url per handle and the picker that swaps among them', () => {
    const html = render({ mints: [mint(0, NOW + 300_000), mint(1, NOW + 300_000)] })
    expect(html).toContain('#v2.body0.sig0')
    expect(html).toContain('#v2.body1.sig1')
    expect(html).toContain('data-app-handle-picker')
  })

  it('renders no anchor at all when no permanent link is composed — never a link to nothing', () => {
    const html = render({ permanentLink: undefined })
    // The ANCHOR, not the selector the script uses to look for one — the slot is absent from the
    // markup, so there is no element for a person to click and none for a host to serialise.
    expect(html.includes('<a data-app-permanent-link')).toBe(false)
  })

  // Served in markup, so a host that never runs the script still hands over a working link.
  it('renders the anchor COMPLETE in markup — href and label, before any script runs', () => {
    const html = render()

    expect(html).toContain(`href="${PERMANENT_LINK}"`)
    expect(html).toContain(`>${APP_WRAPPER_PERMANENT_LINK_LABEL}</a>`)
    expect(html.match(/<a data-app-permanent-link/g) ?? [], 'exactly one anchor').toHaveLength(1)
    expect(html).toContain('rel="noreferrer"')
    expect(html).toContain('target="_blank"')

    expect(html.includes('link.href'), 'the script assigns no href').toBe(false)
    expect(html.includes('[data-app-permanent-link]'), 'the script does not look the anchor up')
      .toBe(false)
  })

  // A `javascript:` base would run under `allow-scripts`; it falls into the absent-link case.
  it('drops a non-http(s) permanent link entirely — the hostile base renders the absent case', () => {
    const absent = render({ permanentLink: undefined })
    for (const hostile of [
      'javascript:alert(1)',
      'javascript:alert(1)/runs/x/live',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'not a url at all',
    ]) {
      const html = render({ permanentLink: hostile })
      expect(html.includes('<a data-app-permanent-link'), `${hostile} composes no anchor`).toBe(false)
      expect(html.includes('javascript:'), `${hostile} leaves no javascript: byte`).toBe(false)
      expect(html, `${hostile} renders the absent-link document`).toBe(absent)
    }

    // The control: an https base still renders, so the cell is not passing by refusing everything.
    expect(render({ permanentLink: 'https://dash.example/runs/r/live' }))
      .toContain('href="https://dash.example/runs/r/live"')
  })

  // This value enters an attribute, where the hole is the quote rather than `</script`.
  it('escapes a quote and an angle bracket in the href instead of closing the attribute', () => {
    const hostile = 'http://127.0.0.1:7799/runs/a"><img src=x onerror=alert(1)>/live'
    const html = render({ permanentLink: hostile })

    expect(html.includes('"><img'), 'the attribute cannot be closed early').toBe(false)
    expect(html).toContain('&quot;&gt;&lt;img')
    // One anchor, and the document still parses as one: nothing became a second element.
    expect(html.match(/<a data-app-permanent-link/g) ?? []).toHaveLength(1)
    expect(html.match(/<img/g) ?? [], 'no injected element').toHaveLength(0)
    // An ampersand in a legitimate query string survives as an entity rather than as a bare `&`.
    expect(render({ permanentLink: 'http://h/live?a=1&b=2' })).toContain('href="http://h/live?a=1&amp;b=2"')
  })

  it('exports the load timeout and puts THAT number in the script', () => {
    expect(APP_WRAPPER_LOAD_TIMEOUT_MS).toBeGreaterThan(0)
    expect(render()).toContain(String(APP_WRAPPER_LOAD_TIMEOUT_MS))
  })
})

describe('every value entering the script crosses the escape helper', () => {
  it('escapes a hostile run id that tries to close the script element', () => {
    const hostile = `run-</script><img src=x onerror=alert(1)>`
    const html = renderAppWrapperPage({
      runId: hostile,
      mints: [],
      permanentLink: undefined,
      runLive: false,
      now: NOW,
    })

    // The literal `</script` never appears: the escape turns the `<` into `\u003c`, so the parser
    // never sees a closing tag and the payload can never become markup.
    expect(html.includes('</script><img'), 'the script element cannot be closed early').toBe(false)
    expect(html).toContain('\\u003c/script')
  })

  // The link lands in markup, so the escape that matters is the attribute's, not the script's.
  it('escapes a hostile permanent link in ITS OWN context — the attribute, not the script', () => {
    const html = render({ permanentLink: 'http://x/</script><b>' })
    expect(html.includes('</script><b>'), 'the script element cannot be closed early').toBe(false)
    expect(html).toContain('&lt;/script&gt;&lt;b&gt;')
    // Exactly one `</script>` in the document: the real one that ends the wrapper's script.
    expect(html.match(/<\/script>/g) ?? []).toHaveLength(1)
  })
})

describe('the wrapper renders NO run state of its own', () => {
  it('has no step, status or verdict surface — structurally, not by wording', () => {
    const html = render({ mints: [mint(0, NOW + 300_000), mint(1, NOW + 300_000)] })
    for (const forbidden of [
      'data-app-step',
      'data-app-steps',
      'data-app-status',
      'data-app-verdict',
      'data-app-progress',
    ]) {
      expect(html.includes(forbidden), `the wrapper must own no ${forbidden}`).toBe(false)
    }
    // And no element renders per-step data: the only repeated structure in the document is the
    // picker's options, one per HANDLE, which is identity rather than run state.
    expect(html.match(/<option\b/g) ?? []).toHaveLength(0)
    expect(html).toContain('createElement(\'option\')')
  })
})
