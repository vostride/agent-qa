// The pinned entity route and its slug (Phase 387 plan 07, ENTY-02 / D-10).
//
// Two claims live here that no consumer can make on its own: the route TEMPLATE is the value
// M5 will build its router from, and the slug segment is produced by the repo's ONE
// security-reviewed path-segment sanitizer rather than by a second one written for links.

import { describe, expect, it } from 'vitest'

import { ENTITY_KINDS, ENTITY_URI_SEGMENTS } from '../kinds'
import {
  ENTITY_URL_ROUTE,
  ENTITY_URL_ROUTE_PARAMS,
  ENTITY_URL_SLUG_MAX_LENGTH,
  entityTitleSlug,
  formatEntityUrl,
} from '../url'

const BASE = { baseUrl: 'https://qa.example.com', workspace: 'acme' }

describe('ENTITY_URL_ROUTE is the pinned route contract', () => {
  it('is the spec route, with every declared parameter present exactly once', () => {
    expect(ENTITY_URL_ROUTE).toBe('/t/:workspace/:kind/:shortId/:slug')
    for (const param of ENTITY_URL_ROUTE_PARAMS) {
      expect(ENTITY_URL_ROUTE.split(`:${param}`), param).toHaveLength(2)
    }
    // The parameter list is the route's own, not a second hand-kept list: every `:name`
    // segment in the template is declared, and every declared name appears.
    const inTemplate = ENTITY_URL_ROUTE.split('/')
      .filter((segment) => segment.startsWith(':'))
      .map((segment) => segment.slice(1))
    expect(inTemplate).toEqual([...ENTITY_URL_ROUTE_PARAMS])
  })

  it('renders the URI-segment word for every kind, never the prefix', () => {
    for (const kind of ENTITY_KINDS) {
      const url = formatEntityUrl({
        ...BASE,
        kind,
        shortId: `${kind}-001`,
        title: 'a title',
      })
      expect(url, kind).toBe(
        `https://qa.example.com/t/acme/${ENTITY_URI_SEGMENTS[kind]}/${kind}-001/a-title`,
      )
    }
  })

  it('keeps a base path prefix rather than discarding it', () => {
    expect(formatEntityUrl({
      baseUrl: 'https://qa.example.com/qa/',
      workspace: 'acme',
      kind: 'MEM',
      shortId: 'MEM-001',
      title: 'x',
    })).toBe('https://qa.example.com/qa/t/acme/memory/MEM-001/x')
  })

  it('drops a base query and fragment instead of inheriting a config mistake', () => {
    expect(formatEntityUrl({
      baseUrl: 'https://qa.example.com/?tenant=old#top',
      workspace: 'acme',
      kind: 'MEM',
      shortId: 'MEM-001',
      title: 'x',
    })).toBe('https://qa.example.com/t/acme/memory/MEM-001/x')
  })

  it('answers undefined — never a partial link — for inputs that cannot render one', () => {
    for (const bad of [
      { ...BASE, baseUrl: 'not-a-url' },
      { ...BASE, baseUrl: '/relative/only' },
      { ...BASE, baseUrl: 'mailto:qa@example.com' },
      { ...BASE, workspace: '' },
      { ...BASE, workspace: '   ' },
    ]) {
      expect(
        formatEntityUrl({ ...bad, kind: 'MEM', shortId: 'MEM-001', title: 'x' }),
        bad.baseUrl + '|' + bad.workspace,
      ).toBeUndefined()
    }
  })
})

describe('the slug segment is produced by the ONE sanitizer', () => {
  it('cannot traverse out of its own segment', () => {
    // The reason `slugBranch` is reused rather than reimplemented. A title is free text and
    // ends up in a URL path; a second sanitizer written for links is a second answer to which
    // bytes are legal there.
    for (const title of ['../../etc/passwd', '..\\..\\windows', './hidden', 'a/b/c']) {
      const slug = entityTitleSlug(title)
      expect(slug, title).not.toContain('/')
      expect(slug, title).not.toContain('\\')
      expect(slug, title).not.toContain('..')
      expect(slug.startsWith('.'), title).toBe(false)
    }
  })

  it('lower-cases and caps length', () => {
    expect(entityTitleSlug('Cart Totals VAT')).toBe('cart-totals-vat')
    expect(entityTitleSlug('X'.repeat(200))).toHaveLength(ENTITY_URL_SLUG_MAX_LENGTH)
  })

  it('escapes whatever the sanitizer keeps, so the segment count is fixed', () => {
    // Non-vacuity for the encode step: the rendered URL has exactly the route's segment
    // count whatever the title was, so a title can never add a path segment.
    for (const title of ['a/b', 'plain', '../..', '%2f']) {
      const url = formatEntityUrl({ ...BASE, kind: 'MEM', shortId: 'MEM-001', title })
      expect(new URL(url ?? '').pathname.split('/'), title).toHaveLength(6)
    }
  })
})
