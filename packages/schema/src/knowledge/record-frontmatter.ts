import { z } from 'zod'

import type { BundleKind, FactSubtype } from '../delta/envelope'
import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'
import { createVersionGuard } from '../versioning/create-version-guard'
import { BUNDLE_SCHEMA_VERSION } from './bundle-files'
import type { OriginClass } from './outcome-event'

export interface RecordFrontmatter {
  schemaVersion: number
  id: string
  kind: BundleKind
  subtype?: FactSubtype
  anchors: readonly { raw: Anchor; normalized: Anchor }[]
  scope: ScopeKey
  createdAtOrdinal: number
  originClass: OriginClass
  evidenceIncomplete: boolean
}

const bundleKindSchema = z.enum(['fact', 'procedure', 'caution', 'unknown', 'policy'])
const factSubtypeSchema = z.enum([
  'selector',
  'behavioral',
  'navigational',
  'measurement',
  'content',
])
const anchorSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('page'), route: z.string() }).strict(),
  z.object({ t: z.literal('flow'), name: z.string() }).strict(),
  z
    .object({
      t: z.literal('el'),
      role: z.string(),
      name: z.string(),
      ordinal: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('platform'),
      platform: z.enum(['web', 'android', 'ios']),
    })
    .strict(),
  z.object({ t: z.literal('selector'), literal: z.string() }).strict(),
  z.object({ t: z.literal('error'), message: z.string() }).strict(),
])

export const RecordAnchorsSchema = z.array(z.object({ raw: anchorSchema, normalized: anchorSchema }).strict())
export const RecordScopeSchema = z.object({
  tier: z.enum(['global', 'product', 'suite', 'test']),
  key: z.string(),
}).strict()

const recordFrontmatterSchema: z.ZodType<RecordFrontmatter> = z
  .object({
    schemaVersion: z.literal(BUNDLE_SCHEMA_VERSION),
    id: z.string(),
    kind: bundleKindSchema,
    subtype: factSubtypeSchema.optional(),
    anchors: RecordAnchorsSchema,
    scope: RecordScopeSchema,
    createdAtOrdinal: z.number(),
    originClass: z.enum(['user', 'agent-verified', 'agent-observed', 'import']),
    evidenceIncomplete: z.boolean(),
  })
  .strict()
  .superRefine((frontmatter, ctx) => {
    if (frontmatter.kind === 'fact' && frontmatter.subtype === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['subtype'],
        message: 'fact record frontmatter requires a fact subtype (D-06)',
      })
    }
    if (frontmatter.kind !== 'fact' && frontmatter.subtype !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['subtype'],
        message: 'only fact record frontmatter may carry a subtype (D-06)',
      })
    }
  })

const guardRecordFrontmatterVersion = createVersionGuard<RecordFrontmatter>({
  name: 'RecordFrontmatter',
  current: BUNDLE_SCHEMA_VERSION,
  migrations: {},
})

const FRONTMATTER_KEY_ORDER = [
  'schemaVersion',
  'id',
  'kind',
  'subtype',
  'anchors',
  'scope',
  'createdAtOrdinal',
  'originClass',
  'evidenceIncomplete',
] as const satisfies readonly (keyof RecordFrontmatter)[]

const FRONTMATTER_KEYS = new Set<string>(FRONTMATTER_KEY_ORDER)
const REQUIRED_FRONTMATTER_KEYS = FRONTMATTER_KEY_ORDER.filter((key) => key !== 'subtype')
const FORBIDDEN_DERIVED_KEYS = new Set(['trust', 'counters', 'status', 'validity'])
const OPENING_FENCE = '---\n'
const CLOSING_FENCE = '\n---\n\n'
const SUMMARY_PREFIX = '## Summary\n\n'
const DETAIL_SEPARATOR = '\n\n## Detail\n\n'

function validateFrontmatter(value: unknown): RecordFrontmatter {
  return recordFrontmatterSchema.parse(guardRecordFrontmatterVersion(value))
}

/** Deterministic record.md rendering over immutable-at-creation fields only. */
export function emitRecordMarkdown(
  frontmatter: RecordFrontmatter,
  body: { summary: string; body: string },
): string {
  const parsed = validateFrontmatter(frontmatter)
  const lines = FRONTMATTER_KEY_ORDER.flatMap((key) => {
    const value = parsed[key]
    if (value === undefined) return []
    const encoded = JSON.stringify(value)
    if (encoded === undefined) {
      throw new TypeError(`frontmatter key "${key}" is not JSON-serializable`)
    }
    return `${key}: ${encoded}`
  })

  return (
    `${OPENING_FENCE}${lines.join('\n')}${CLOSING_FENCE}` +
    `${SUMMARY_PREFIX}${body.summary}${DETAIL_SEPARATOR}${body.body}`
  )
}

function parseFrontmatterLines(block: string): RecordFrontmatter {
  const values: Record<string, unknown> = {}

  for (const line of block.split('\n')) {
    const separator = line.indexOf(': ')
    if (separator <= 0) {
      throw new TypeError(`malformed frontmatter line: ${JSON.stringify(line)}`)
    }

    const key = line.slice(0, separator)
    if (FORBIDDEN_DERIVED_KEYS.has(key)) {
      throw new TypeError(`BNDL-03 forbids derived frontmatter key "${key}"`)
    }
    if (!FRONTMATTER_KEYS.has(key)) {
      throw new TypeError(`unknown frontmatter key "${key}"`)
    }
    if (Object.hasOwn(values, key)) {
      throw new TypeError(`duplicate frontmatter key "${key}"`)
    }

    try {
      values[key] = JSON.parse(line.slice(separator + 2))
    } catch {
      throw new TypeError(`invalid JSON for frontmatter key "${key}"`)
    }
  }

  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (!Object.hasOwn(values, key)) {
      throw new TypeError(`missing frontmatter key "${key}"`)
    }
  }

  return validateFrontmatter(values)
}

/** Strict parser for the writer-owned frontmatter and deterministic markdown section layout. */
export function parseRecordMarkdown(text: string): {
  frontmatter: RecordFrontmatter
  summary: string
  body: string
} {
  if (!text.startsWith(OPENING_FENCE)) {
    throw new TypeError('record.md must start with a frontmatter fence')
  }

  const closingFence = text.indexOf(CLOSING_FENCE, OPENING_FENCE.length)
  if (closingFence < 0) {
    throw new TypeError('record.md is missing its closing frontmatter fence')
  }

  const frontmatter = parseFrontmatterLines(
    text.slice(OPENING_FENCE.length, closingFence),
  )
  const markdown = text.slice(closingFence + CLOSING_FENCE.length)
  if (!markdown.startsWith(SUMMARY_PREFIX)) {
    throw new TypeError('record.md body must start with the Summary section')
  }

  const sections = markdown.slice(SUMMARY_PREFIX.length)
  const detailSeparator = sections.indexOf(DETAIL_SEPARATOR)
  if (detailSeparator < 0) {
    throw new TypeError('record.md body is missing the Detail section')
  }

  return {
    frontmatter,
    summary: sections.slice(0, detailSeparator),
    body: sections.slice(detailSeparator + DETAIL_SEPARATOR.length),
  }
}
