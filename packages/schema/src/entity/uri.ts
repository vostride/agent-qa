// Parsed with an anchored pattern, not `new URL()`, which accepts unknown schemes and folds case.

import { z } from 'zod'

import {
  canonicalShortId,
  entityKindForUriSegment,
  entityUriSegmentFor,
  parseShortId,
} from './kinds'
import type { EntityKind } from './kinds'

export const ENTITY_URI_SCHEME = 'agentqa'

const ENTITY_URI_PREFIX = `${ENTITY_URI_SCHEME}://`

/**
 * Anchored, and with exactly two path segments.
 *
 * A pattern that allowed a trailing path would let `agentqa://memory/MEM-001/raw` resolve as
 * `MEM-001`, which is how a caller ends up believing a sub-resource exists because the thing
 * it hangs off resolved.
 */
const ENTITY_URI_RE = new RegExp(`^${ENTITY_URI_SCHEME}://([a-z]+)/([^/]+)$`, 'u')

export interface ParsedEntityUri {
  readonly kind: EntityKind
  /** Canonical spelling — `agentqa://memory/MEM-1` parses to `MEM-001`. */
  readonly shortId: string
}

export function formatEntityUri(kind: EntityKind, shortId: string): string {
  const canonical = canonicalShortId(shortId)
  if (canonical === undefined) {
    throw new TypeError(`not a well-formed entity short-ID: ${shortId}`)
  }
  const parsed = parseShortId(canonical)
  if (parsed === undefined || parsed.kind !== kind) {
    throw new TypeError(`short-ID ${canonical} does not belong to kind ${kind}`)
  }
  return `${ENTITY_URI_PREFIX}${entityUriSegmentFor(kind)}/${canonical}`
}

/**
 * Parse an entity URI, or `undefined` when the value is not one.
 *
 * The two halves must AGREE: `agentqa://memory/TST-001` is refused rather than resolved as
 * the test it names, because a URI whose segment and prefix disagree is one that some
 * surface built by concatenation, and honouring it would make the segment decorative.
 */
export function parseEntityUri(value: string): ParsedEntityUri | undefined {
  const match = ENTITY_URI_RE.exec(value.trim())
  if (match === null) return undefined

  const kind = entityKindForUriSegment(match[1] ?? '')
  if (kind === undefined) return undefined

  const parsed = parseShortId(match[2] ?? '')
  if (parsed === undefined || parsed.kind !== kind) return undefined

  const canonical = canonicalShortId(match[2] ?? '')
  return canonical === undefined ? undefined : { kind, shortId: canonical }
}

export function isEntityUri(value: string): boolean {
  return parseEntityUri(value) !== undefined
}

/** The refined-string codec cards and key facts validate their links against. */
export const EntityUriSchema = z
  .string()
  .refine(isEntityUri, `expected a canonical ${ENTITY_URI_SCHEME}:// entity URI`)
