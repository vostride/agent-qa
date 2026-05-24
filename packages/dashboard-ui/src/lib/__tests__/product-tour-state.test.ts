// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PRODUCT_TOUR_AUTO_START_PATHS,
  foundationProductTourSteps,
  getKnownProductTourStepIds,
  resolveProductTourStepRoute,
  type ProductTourStep,
} from '@/lib/product-tour-steps'
import {
  PRODUCT_TOUR_COOKIE,
  PRODUCT_TOUR_SCHEMA_VERSION,
  PRODUCT_TOUR_VERSION,
  clearProductTourStateCookie,
  readProductTourStateCookie,
  writeProductTourStateCookie,
  type ProductTourState,
} from '@/lib/product-tour-state'

const now = '2026-05-24T15:00:00.000Z'

afterEach(() => {
  vi.unstubAllGlobals()
  clearCookie()
})

function clearCookie() {
  document.cookie = `${PRODUCT_TOUR_COOKIE}=; path=/; max-age=0`
}

function writeRawCookie(value: unknown) {
  document.cookie = `${PRODUCT_TOUR_COOKIE}=${encodeURIComponent(JSON.stringify(value))}; path=/`
}

function validState(overrides: Partial<ProductTourState> = {}): ProductTourState {
  return {
    schemaVersion: PRODUCT_TOUR_SCHEMA_VERSION,
    tourVersion: PRODUCT_TOUR_VERSION,
    lastStartedAt: now,
    activeStepId: 'intro',
    activeRoute: '/runs',
    ...overrides,
  }
}

function rawState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...validState(),
    ...overrides,
  }
}

function captureCookieWrite(action: () => void): string {
  let written = ''
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  if (!descriptor?.get || !descriptor.set) {
    throw new Error('document.cookie descriptor is unavailable')
  }

  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => descriptor.get?.call(document) as string,
    set: (value: string) => {
      written = value
      descriptor.set?.call(document, value)
    },
  })

  try {
    action()
  } finally {
    Object.defineProperty(document, 'cookie', descriptor)
  }

  return written
}

describe('readProductTourStateCookie', () => {
  it('returns null when document is unavailable or the cookie is absent', () => {
    expect(readProductTourStateCookie()).toBeNull()

    vi.stubGlobal('document', undefined)

    expect(readProductTourStateCookie()).toBeNull()
  })

  it('returns null for malformed, stale, or tampered cookie values', () => {
    const invalidValues = [
      '%7Bbad-json',
      JSON.stringify([]),
      JSON.stringify(rawState({ schemaVersion: 2 })),
      JSON.stringify(rawState({ tourVersion: 'old-tour' })),
      JSON.stringify(rawState({ completedAt: 'not-a-date' })),
      JSON.stringify(rawState({ skippedAt: '2026-99-99T00:00:00.000Z' })),
      JSON.stringify(rawState({ lastStartedAt: 'yesterday' })),
      JSON.stringify(rawState({ activeStepId: 'unknown-step' })),
      JSON.stringify(rawState({ activeRoute: 42 })),
    ]

    for (const value of invalidValues) {
      document.cookie = `${PRODUCT_TOUR_COOKIE}=${value}; path=/`

      expect(readProductTourStateCookie()).toBeNull()

      clearCookie()
    }
  })

  it('returns only the compact schema fields for a valid cookie', () => {
    writeRawCookie({
      ...validState({
        completedAt: '2026-05-24T15:01:00.000Z',
        skippedAt: '2026-05-24T15:02:00.000Z',
      }),
      copiedFromCookie: '<script>alert(1)</script>',
    })

    expect(readProductTourStateCookie()).toEqual({
      schemaVersion: PRODUCT_TOUR_SCHEMA_VERSION,
      tourVersion: PRODUCT_TOUR_VERSION,
      completedAt: '2026-05-24T15:01:00.000Z',
      skippedAt: '2026-05-24T15:02:00.000Z',
      lastStartedAt: now,
      activeStepId: 'intro',
      activeRoute: '/runs',
    })
  })
})

describe('writeProductTourStateCookie and clearProductTourStateCookie', () => {
  it('writes encoded JSON with path, max-age, and SameSite attributes', () => {
    const state = validState({ skippedAt: '2026-05-24T15:03:00.000Z' })
    const written = captureCookieWrite(() => writeProductTourStateCookie(state))

    expect(written).toBe(
      `${PRODUCT_TOUR_COOKIE}=${encodeURIComponent(
        JSON.stringify(state),
      )}; path=/; max-age=31536000; samesite=lax`,
    )
  })

  it('clears the tour cookie with path and max-age=0', () => {
    const written = captureCookieWrite(() => clearProductTourStateCookie())

    expect(written).toBe(`${PRODUCT_TOUR_COOKIE}=; path=/; max-age=0; samesite=lax`)
  })

  it('swallows browser cookie write failures', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
    if (!descriptor?.get || !descriptor.set) {
      throw new Error('document.cookie descriptor is unavailable')
    }

    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => descriptor.get?.call(document) as string,
      set: () => {
        throw new Error('cookies blocked')
      },
    })

    try {
      expect(() => writeProductTourStateCookie(validState())).not.toThrow()
      expect(() => clearProductTourStateCookie()).not.toThrow()
    } finally {
      Object.defineProperty(document, 'cookie', descriptor)
    }
  })
})

describe('foundation product tour step contracts', () => {
  it('exports the exact auto-start allowlist', () => {
    expect(PRODUCT_TOUR_AUTO_START_PATHS).toEqual([
      '/runs',
      '/tests',
      '/hooks',
      '/suites',
      '/memory',
      '/config',
    ])
  })

  it('includes a centered intro and routed foundation page steps', () => {
    expect(foundationProductTourSteps[0]).toMatchObject({ id: 'intro', centered: true })

    expect(
      foundationProductTourSteps.map((step) => ({
        id: step.id,
        route: resolveProductTourStepRoute(step),
      })),
    ).toEqual([
      { id: 'intro', route: null },
      { id: 'llm-setup', route: '/config?bucket=registry&item=llms' },
      { id: 'runs', route: '/runs' },
      { id: 'tests', route: '/tests' },
      { id: 'suites', route: '/suites' },
      { id: 'hooks', route: '/hooks' },
      { id: 'memory', route: '/memory' },
      { id: 'config', route: '/config' },
      { id: 'example-test', route: null },
      { id: 'example-missing', route: '/tests' },
      { id: 'run-action', route: '/tests' },
      { id: 'live-run', route: null },
      { id: 'run-detail', route: null },
      { id: 'github-nudge', route: null },
      { id: 'runs-fallback', route: '/runs' },
    ])

    expect(getKnownProductTourStepIds()).toEqual([
      'intro',
      'llm-setup',
      'runs',
      'tests',
      'suites',
      'hooks',
      'memory',
      'config',
      'example-test',
      'example-missing',
      'run-action',
      'live-run',
      'run-detail',
      'github-nudge',
      'runs-fallback',
    ])
  })

  it('does not invent entity routes when a descriptor route cannot resolve', () => {
    const unresolvedStep: ProductTourStep = {
      id: 'future-run-detail',
      title: 'Run detail',
      body: 'Future route descriptor.',
      route: () => null,
      targetId: 'tour-run-detail',
    }

    expect(resolveProductTourStepRoute(unresolvedStep)).toBeNull()
  })
})
