// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_FAVICON_HREF,
  getRunFaviconState,
  getRunStatusFaviconHref,
  type RunFaviconState,
  useRunStatusFavicon,
} from '@/hooks/use-run-status-favicon'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function FaviconProbe({ state }: { state: RunFaviconState }) {
  useRunStatusFavicon(state)
  return null
}

function resetCanonicalFavicon() {
  document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${DEFAULT_FAVICON_HREF}">`
}

function getCanonicalFavicon() {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
  if (!link) throw new Error('Missing canonical favicon link')
  return link
}

function getCanonicalFaviconHref() {
  return getCanonicalFavicon().getAttribute('href')
}

function decodeFaviconHref(href: string) {
  return decodeURIComponent(href.replace('data:image/svg+xml,', ''))
}

async function renderProbe(state: RunFaviconState) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(<FaviconProbe state={state} />)
  })
}

function unmountProbe() {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
}

beforeEach(() => {
  resetCanonicalFavicon()
})

afterEach(() => {
  unmountProbe()
  document.head.innerHTML = ''
})

describe('getRunFaviconState', () => {
  it('maps raw run status aliases into favicon states', () => {
    expect(getRunFaviconState('running')).toBe('running')
    expect(getRunFaviconState('pending')).toBe('running')
    expect(getRunFaviconState('queued')).toBe('running')

    expect(getRunFaviconState('passed')).toBe('passed')
    expect(getRunFaviconState('complete')).toBe('passed')
    expect(getRunFaviconState('completed')).toBe('passed')
    expect(getRunFaviconState('success')).toBe('passed')
    expect(getRunFaviconState('flaky')).toBe('passed')
    expect(getRunFaviconState('healed')).toBe('passed')

    expect(getRunFaviconState('failed')).toBe('failed')
    expect(getRunFaviconState('error')).toBe('failed')
    expect(getRunFaviconState('errored')).toBe('failed')
    expect(getRunFaviconState('timeout')).toBe('failed')
    expect(getRunFaviconState('timed_out')).toBe('failed')
    expect(getRunFaviconState('timedout')).toBe('failed')

    expect(getRunFaviconState('cancelled')).toBe('cancelled')
    expect(getRunFaviconState('canceled')).toBe('cancelled')

    expect(getRunFaviconState('skipped')).toBe('default')
    expect(getRunFaviconState('mystery')).toBe('default')
    expect(getRunFaviconState(null)).toBe('default')
    expect(getRunFaviconState(undefined)).toBe('default')
    expect(getRunFaviconState('')).toBe('default')
  })
})

describe('getRunStatusFaviconHref', () => {
  it('returns the default href exactly for the default state', () => {
    expect(getRunStatusFaviconHref('default')).toBe(DEFAULT_FAVICON_HREF)
  })

  it('builds deterministic SVG data URLs for non-default states', () => {
    for (const state of ['running', 'passed', 'failed', 'cancelled'] as const) {
      expect(getRunStatusFaviconHref(state)).toMatch(/^data:image\/svg\+xml,/)
    }
  })

  it('uses a large red X without a circular dot for the failed state', () => {
    const decoded = decodeFaviconHref(getRunStatusFaviconHref('failed'))

    expect(decoded).toContain('#EF4444')
    expect(decoded).toContain('stroke="#EF4444"')
    expect(decoded).toContain('stroke-width="26"')
    expect(decoded).toContain('M208 142L310 244M310 142L208 244')
    expect(decoded).not.toContain('<circle')
    expect(decoded).toContain('viewBox="0 0 324 257"')
    expect(decoded).toContain('fill="#1BA8A4"')
  })

  it('uses larger borderless color dots for running, passed, and cancelled', () => {
    for (const state of ['running', 'passed', 'cancelled'] as const) {
      const decoded = decodeFaviconHref(getRunStatusFaviconHref(state))

      expect(decoded).toContain('r="61"')
      expect(decoded).not.toContain('stroke="#FAF8F5"')
    }
  })
})

describe('useRunStatusFavicon', () => {
  it('updates the existing canonical SVG favicon for each non-default state', async () => {
    for (const state of ['running', 'passed', 'failed', 'cancelled'] as const) {
      await renderProbe(state)

      expect(getCanonicalFaviconHref()).toMatch(/^data:image\/svg\+xml,/)

      unmountProbe()
      resetCanonicalFavicon()
    }
  })

  it('restores the default href for the default state', async () => {
    getCanonicalFavicon().setAttribute('href', getRunStatusFaviconHref('failed'))

    await renderProbe('default')

    expect(getCanonicalFaviconHref()).toBe(DEFAULT_FAVICON_HREF)
  })

  it('restores the default href on cleanup', async () => {
    await renderProbe('running')

    expect(getCanonicalFaviconHref()).toMatch(/^data:image\/svg\+xml,/)

    unmountProbe()

    expect(getCanonicalFaviconHref()).toBe(DEFAULT_FAVICON_HREF)
  })

  it('creates the canonical SVG favicon link when it is missing', async () => {
    document.head.innerHTML = ''

    await renderProbe('passed')

    expect(getCanonicalFaviconHref()).toMatch(/^data:image\/svg\+xml,/)
    expect(document.head.contains(getCanonicalFavicon())).toBe(true)
  })

  it('does not mutate unrelated icon links', async () => {
    document.head.innerHTML = [
      `<link rel="icon" type="image/svg+xml" href="${DEFAULT_FAVICON_HREF}">`,
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    ].join('')

    await renderProbe('failed')

    const appleTouch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')
    expect(appleTouch?.getAttribute('href')).toBe('/apple-touch-icon.png')
    expect(getCanonicalFaviconHref()).toMatch(/^data:image\/svg\+xml,/)
  })
})
