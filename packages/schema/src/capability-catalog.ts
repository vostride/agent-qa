// Presence rules are cli catalog-test cells: a refined member cannot sit in a discriminated union.

import { z } from 'zod'

// Only surfaces the parity suite measures; the catalog claims no surface nothing measures.
export const CatalogSurfaceSchema = z.enum(['chat', 'mcp'])
export type CatalogSurface = z.infer<typeof CatalogSurfaceSchema>

// An object, so `{ "arguments": {} }` reads as a call with no arguments, not a missing value.
export const CatalogExampleCallSchema = z.object({
  arguments: z.record(z.string(), z.unknown()),
}).strict()
export type CatalogExampleCall = z.infer<typeof CatalogExampleCallSchema>

// `mcpUnprojectedReasonKey` tells a deliberately unprojected op apart from one nobody looked at.
export const CatalogOpRowSchema = z.object({
  kind: z.literal('op'),
  /** The registry op id, under the dot taxonomy. */
  id: z.string().min(1),
  /** The declaration's own `summary` — the sentence every other surface already renders. */
  description: z.string().min(1),
  /** The declaration's inert input projection, verbatim. NEVER re-converted here. */
  params: z.record(z.string(), z.unknown()),
  surfaces: z.array(CatalogSurfaceSchema).min(1),
  /** Present iff `surfaces` contains `mcp`. */
  mcpTool: z.string().min(1).optional(),
  /** Present iff `surfaces` omits `mcp` — the visible-absence arm. */
  mcpUnprojectedReasonKey: z.string().min(1).optional(),
  /** Repo-relative path into a shipped doc, or an explicit null. Never a guessed URL. */
  docPath: z.string().min(1).nullable(),
  /** A heading within `docPath`, when the row deep-links rather than naming a whole file. */
  docAnchor: z.string().min(1).optional(),
  /** Present iff `docPath` is null — the dated reason there is no doc yet. */
  docAbsentReason: z.string().min(1).optional(),
  // Null means the derivation refused; an all-optional op gets `{ "arguments": {} }`.
  exampleCall: CatalogExampleCallSchema.nullable(),
  /** Present iff `exampleCall` is null — which construct the derivation would not guess at. */
  exampleCallAbsentReason: z.string().min(1).optional(),
}).strict()

// The census cell joins `targetOpId` to the registry in both directions.
export const CatalogAliasRowSchema = z.object({
  kind: z.literal('alias'),
  /** The word a person types, exactly as the resolver table names it. */
  alias: z.string().min(1),
  targetOpId: z.string().min(1),
  /** The target op's own summary — an alias does not get a second description to drift from. */
  description: z.string().min(1),
  docPath: z.string().min(1).nullable(),
  docAnchor: z.string().min(1).optional(),
  docAbsentReason: z.string().min(1).optional(),
}).strict()

/** One shipped skill, from its own SKILL.md frontmatter. */
export const CatalogSkillRowSchema = z.object({
  kind: z.literal('skill'),
  name: z.string().min(1),
  description: z.string().min(1),
  shortDescription: z.string().min(1),
  /** The skill's own SKILL.md, repo-relative — a skill always has a doc, because it IS one. */
  docPath: z.string().min(1),
}).strict()

export const CatalogRowSchema = z.discriminatedUnion('kind', [
  CatalogOpRowSchema,
  CatalogAliasRowSchema,
  CatalogSkillRowSchema,
])

// `rowCount` and `rowsDigest` catch a truncated mint and tell reordering from changed content.
export const CapabilityCatalogSchema = z.object({
  $note: z.array(z.string().min(1)).min(1),
  rowCount: z.number().int().nonnegative(),
  rowsDigest: z.string().min(1),
  rows: z.array(CatalogRowSchema),
}).strict()

// The `init --agent` manifest: the catalog's rows, unfiltered, plus this workspace's posture.

// No arm carries a reason string: a validation message can quote the file credentials sit beside.
export const AgentManifestPostureSchema = z.object({
  /** Whether this workspace has a configuration, and whether it read. */
  configuration: z.enum(['resolved', 'absent', 'unresolved']),
}).strict()
export type AgentManifestPosture = z.infer<typeof AgentManifestPostureSchema>

/** What `agent-qa init --agent` prints, in full. */
export const AgentManifestSchema = z.object({
  $note: z.array(z.string().min(1)).min(1),
  rows: z.array(CatalogRowSchema),
  posture: AgentManifestPostureSchema,
}).strict()
export type AgentManifest = z.infer<typeof AgentManifestSchema>

export type CatalogOpRow = z.infer<typeof CatalogOpRowSchema>
export type CatalogAliasRow = z.infer<typeof CatalogAliasRowSchema>
export type CatalogSkillRow = z.infer<typeof CatalogSkillRowSchema>
export type CatalogRow = z.infer<typeof CatalogRowSchema>
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>

/**
 * The row's identity within its kind — the key every census, sort and named RED uses.
 *
 * ONE SPELLING, because "which row" is asked by the producer's sort, the freshness comparator's
 * findings and three census cells; three spellings of it would be three answers on the day a kind
 * gains a field.
 */
export function catalogRowKey(row: CatalogRow): string {
  switch (row.kind) {
    case 'op':
      return row.id
    case 'alias':
      return row.alias
    case 'skill':
      return row.name
  }
}
