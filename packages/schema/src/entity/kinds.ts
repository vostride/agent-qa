// `TGT` is slug-addressed because its machine id is already the name the config gave it.

// Order is the canonical listing order.
export const ENTITY_KINDS = ['TST', 'RUN', 'MEM', 'POL', 'TGT'] as const

export type EntityKind = (typeof ENTITY_KINDS)[number]

/**
 * The kind ↔ URI-segment table (`agentqa://memory/MEM-001`).
 *
 * A separate vocabulary on purpose: the prefix is what a human types in a sentence and the
 * segment is what a URI path reads like, and collapsing them would have produced
 * `agentqa://mem/MEM-001`. Both directions are derived below so the mapping cannot drift
 * apart into two half-maintained tables.
 */
export const ENTITY_URI_SEGMENTS = {
  TST: 'test',
  RUN: 'run',
  MEM: 'memory',
  POL: 'policy',
  TGT: 'target',
} as const satisfies Record<EntityKind, string>

export type EntityUriSegment = (typeof ENTITY_URI_SEGMENTS)[EntityKind]

const SEGMENT_TO_KIND = new Map<string, EntityKind>(
  ENTITY_KINDS.map((kind) => [ENTITY_URI_SEGMENTS[kind], kind]),
)

// A table, so a second slug-addressed kind is added once, not at each site.
export const SLUG_ADDRESSED_ENTITY_KINDS = {
  TST: false,
  RUN: false,
  MEM: false,
  POL: false,
  TGT: true,
} as const satisfies Record<EntityKind, boolean>

export function isSlugAddressedKind(kind: EntityKind): boolean {
  return SLUG_ADDRESSED_ENTITY_KINDS[kind]
}

// Ordinals render zero-padded to three digits and parse at any width; ids are never renumbered.
export const ENTITY_ORDINAL_MIN_DIGITS = 3

/** The first ordinal a kind ever mints. Zero is not an address. */
export const ENTITY_FIRST_ORDINAL = 1

export function formatEntityOrdinal(ordinal: number): string {
  return String(ordinal).padStart(ENTITY_ORDINAL_MIN_DIGITS, '0')
}

/** `MEM-001`. Refuses a slug-addressed kind rather than inventing an ordinal for it. */
export function formatOrdinalShortId(kind: EntityKind, ordinal: number): string {
  if (isSlugAddressedKind(kind)) {
    throw new TypeError(`${kind} is slug-addressed; it has no ordinal short-ID`)
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < ENTITY_FIRST_ORDINAL) {
    throw new TypeError(`entity ordinals start at ${String(ENTITY_FIRST_ORDINAL)}`)
  }
  return `${kind}-${formatEntityOrdinal(ordinal)}`
}

/** `TGT-checkout`. Refuses an ordinal-addressed kind for the same reason. */
export function formatSlugShortId(kind: EntityKind, slug: string): string {
  if (!isSlugAddressedKind(kind)) {
    throw new TypeError(`${kind} is ordinal-addressed; it has no slug short-ID`)
  }
  if (!ENTITY_SLUG_RE.test(slug)) {
    throw new TypeError(`not a well-formed entity slug: ${slug}`)
  }
  return `${kind}-${slug}`
}

/**
 * The two anchored bodies. Anchored at BOTH ends: an unanchored ordinal pattern accepts
 * `MEM-1 and also MEM-2`, and a resolver that took the first capture off that string would
 * silently answer about one of two entities the caller named.
 */
const ENTITY_ORDINAL_RE = /^[0-9]+$/u
const ENTITY_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/**
 * Built OVER `ENTITY_KINDS` rather than restating the five prefixes, so the parser and the
 * union cannot disagree about what a kind is. The body capture is deliberately loose — which
 * FORM is legal is a per-kind question the table above answers, not something a single
 * pattern should try to encode.
 */
const SHORT_ID_RE = new RegExp(`^(${ENTITY_KINDS.join('|')})-(.+)$`, 'u')

export type ParsedShortId =
  | { readonly kind: EntityKind; readonly form: 'ordinal'; readonly ordinal: number }
  | { readonly kind: EntityKind; readonly form: 'slug'; readonly slug: string }

/**
 * Parse a short-ID, or `undefined` when the value is not one.
 *
 * Absence is a RESULT here, never a throw: the resolver hands this every free-text reference
 * a user types, and "that bundle about checkout" is an ordinary input, not an error
 * condition. The typed refusal belongs to the resolver, which knows whether a well-formed
 * address names an entity nobody minted or matches nothing at all.
 */
export function parseShortId(value: string): ParsedShortId | undefined {
  const match = SHORT_ID_RE.exec(value.trim())
  if (match === null) return undefined

  const kind = match[1] as EntityKind
  const body = match[2] ?? ''

  if (isSlugAddressedKind(kind)) {
    return ENTITY_SLUG_RE.test(body) ? { kind, form: 'slug', slug: body } : undefined
  }
  if (!ENTITY_ORDINAL_RE.test(body)) return undefined

  const ordinal = Number.parseInt(body, 10)
  if (!Number.isSafeInteger(ordinal) || ordinal < ENTITY_FIRST_ORDINAL) return undefined
  return { kind, form: 'ordinal', ordinal }
}

/**
 * The canonical spelling of whatever a caller typed — `MEM-1` and `MEM-001` are one address.
 *
 * The ledger is keyed on the canonical form, so this is what makes "any digit width parses"
 * a parsing convenience rather than a second set of rows.
 */
export function canonicalShortId(value: string): string | undefined {
  const parsed = parseShortId(value)
  if (parsed === undefined) return undefined
  return parsed.form === 'ordinal'
    ? formatOrdinalShortId(parsed.kind, parsed.ordinal)
    : formatSlugShortId(parsed.kind, parsed.slug)
}

export function entityUriSegmentFor(kind: EntityKind): EntityUriSegment {
  return ENTITY_URI_SEGMENTS[kind]
}

export function entityKindForUriSegment(segment: string): EntityKind | undefined {
  return SEGMENT_TO_KIND.get(segment)
}

export function isEntityKind(value: string): value is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(value)
}
