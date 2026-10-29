import { normalizeAccessibleName } from '../screen/index'
import type { Anchor } from './anchor'

function normalizeHumanText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeRoute(route: string): string {
  const normalized = normalizeHumanText(route)
  const hashIndex = normalized.indexOf('#')
  const withoutHash = hashIndex === -1 ? normalized : normalized.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : withoutHash.slice(queryIndex)
  const pathWithoutTrailingSlash = path === '/' ? path : path.replace(/\/+$/, '')
  return `${pathWithoutTrailingSlash}${query}`
}

// Page routes casefold and drop hashes and trailing slashes; error digit runs become `#`.
export function normalizeAnchor(anchor: Anchor): Anchor {
  switch (anchor.t) {
    case 'page':
      return { t: 'page', route: normalizeRoute(anchor.route) }
    case 'flow':
      return { t: 'flow', name: normalizeAccessibleName(anchor.name) }
    case 'el': {
      const normalized = {
        t: 'el' as const,
        role: normalizeHumanText(anchor.role),
        name: normalizeAccessibleName(anchor.name),
      }
      return anchor.ordinal === undefined ? normalized : { ...normalized, ordinal: anchor.ordinal }
    }
    case 'platform':
      return anchor
    case 'selector':
      return { t: 'selector', literal: anchor.literal.trim() }
    case 'error':
      return { t: 'error', message: normalizeHumanText(anchor.message).replace(/\d+/g, '#') }
  }
}
