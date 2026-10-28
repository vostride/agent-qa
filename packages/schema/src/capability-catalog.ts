// The capability-catalog row DTOs (Phase 398 plan 01 — XPLN-01, D-05 / D-06 / D-07 / D-08).
//
// WHAT THE CATALOG IS FOR. The golden ledger (397 D-05) is change control: it records what a
// capability IS so a widened scope is a one-line diff. This artifact answers a different question —
// what a PERSON or an external agent can reach, in the words they would read — and it is the one
// data source behind `init --agent`, the chat `/` type-ahead, the starter prompts and the `explain`
// op. Two committed projections of one registry could drift, so they do not: a census cell asserts
// the op rows here and the golden's rows are the same set in both directions (D-01).
//
// THREE ROW KINDS, ONE DISCRIMINATED UNION (D-05). A registry op, a chat alias that resolves to
// one, and a shipped skill are three different things a person can be told about, and a flat shape
// that could describe any of them would be a shape every consumer has to defend against. `kind` is
// the discriminant every consumer switches on. Capability count is the OP rows: adding an alias
// does not add a capability.
//
// NOTHING HERE IS HAND-WRITTEN AT THE ARTIFACT (D-08). Descriptions come from the zod/FunctionSpec
// summaries that already feed chat and MCP; `params` is the declaration's own inert input
// projection, carried VERBATIM through the one shipped lens and never converted a second time. A
// poorly-reading description is fixed at its zod source, where it improves every surface at once.
//
// PRESENCE RULES LIVE AT THE PRODUCER AND ITS CENSUS, NOT IN A REFINEMENT. `mcpTool` is present iff
// the row claims the `mcp` surface, `docAbsentReason` iff `docPath` is null. Those are asserted by
// named cells in `packages/cli/src/__tests__/conformance/catalog.test.ts` rather than by a
// `superRefine` here, because a refined member cannot sit under `z.discriminatedUnion` and the
// discriminant is the more load-bearing of the two properties.

import { z } from 'zod'

/**
 * The surface vocabulary IS the pinned roster (D-06), not a superset of it.
 *
 * `chat` and `mcp` are the two surfaces 397's parity suite measures; the CLI's handlers are
 * deliberately absent (397 D-03's two-surface claim). The catalog never claims a surface nothing
 * measures — a third member arrives here only when a third roster row and its adapter do.
 */
export const CatalogSurfaceSchema = z.enum(['chat', 'mcp'])
export type CatalogSurface = z.infer<typeof CatalogSurfaceSchema>

/**
 * One example call's arguments, DERIVED from the row's own params (spec §3.3, D-08).
 *
 * WHY IT IS AN OBJECT AND NOT A BARE RECORD. `"exampleCall": { "arguments": {} }` reads, in the
 * committed file, as "call this with no arguments" — which is a true and useful thing to say about
 * an op whose every property is optional. A bare `{}` in that position would read as a missing
 * value, and the distinction between "nothing is required" and "nobody derived one" is exactly what
 * the nullable arm plus {@link CatalogOpRowSchema.exampleCallAbsentReason} exists to keep apart.
 *
 * NOTHING HERE IS AUTHORED. The values come out of one pure function over the row's own JSON-Schema
 * projection; a hand-written example is a second contract that agrees with the schema until the day
 * the schema moves, and the agent that copied it is the one who finds out.
 */
export const CatalogExampleCallSchema = z.object({
  arguments: z.record(z.string(), z.unknown()),
}).strict()
export type CatalogExampleCall = z.infer<typeof CatalogExampleCallSchema>

/**
 * One registry op, as a person reads it.
 *
 * `mcpUnprojectedReasonKey` is the VISIBLE ABSENCE arm (D-06): an op with no MCP door carries the
 * class of the shipped `UNPROJECTED_OPS` reason rather than a blank column, so "deliberately not
 * projected" and "nobody has looked at it" are different values instead of the same hole.
 */
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
  /** Repo-relative path into a shipped doc, or an explicit null. Never a guessed URL (D-07). */
  docPath: z.string().min(1).nullable(),
  /** A heading within `docPath`, when the row deep-links rather than naming a whole file. */
  docAnchor: z.string().min(1).optional(),
  /** Present iff `docPath` is null — the dated reason there is no doc yet. */
  docAbsentReason: z.string().min(1).optional(),
  // 2026-10-02 (432-39, D-12): no `requiredScopes` column. Declarations carry no scopes, the
  // generator has written none since 432-20, and the strict row now refuses one.
  /**
   * A call an agent can copy, derived from `params` — or an explicit null (spec §3.3, D-08).
   *
   * NULL IS NOT "no arguments". An op whose properties are all optional gets
   * `{ "arguments": {} }`, because calling it with nothing is a real call. Null means the
   * derivation REFUSED to show a value it could not prove the shipped contract would accept, and
   * `exampleCallAbsentReason` says which construct it refused on. An example that would be
   * rejected on arrival is worse than none: the agent that copies it learns a shape the product
   * does not have, and learns it from the product's own manifest.
   */
  exampleCall: CatalogExampleCallSchema.nullable(),
  /** Present iff `exampleCall` is null — which construct the derivation would not guess at. */
  exampleCallAbsentReason: z.string().min(1).optional(),
}).strict()

/**
 * One chat alias, and the op it resolves to.
 *
 * `targetOpId` is joined to the registry in BOTH directions by the census cell: an alias naming a
 * non-registry target is a named RED, and an op-alias in the shipped resolver table with no row
 * here is the same RED from the other side (D-05).
 */
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

/**
 * The committed artifact.
 *
 * `rowCount` and `rowsDigest` are the file's own mechanical self-check, on the golden's precedent:
 * a mint that produced a truncated document must not be able to reach the committed file, and a
 * reader must be able to tell a re-ordering from a re-content-ing without diffing every row. The
 * digest is sha256 over the ONE canonical serializer, so it is byte-level and locale-independent
 * (edge XPLN-01/encoding).
 */
export const CapabilityCatalogSchema = z.object({
  $note: z.array(z.string().min(1)).min(1),
  rowCount: z.number().int().nonnegative(),
  rowsDigest: z.string().min(1),
  rows: z.array(CatalogRowSchema),
}).strict()

// ---- The `init --agent` manifest (398-08, D-16 · XPLN-01) ----------------------------------------
//
// WHAT THE MANIFEST IS. One local, non-interactive, idempotent read: the committed catalog's rows,
// verbatim and UNFILTERED, plus this workspace's posture. It is the machine entry point spec §3.3
// names — what an external agent reads instead of guessing — and because it is produced by LOADING
// the committed artifact rather than by re-deriving anything, `manifest ≡ catalog` is a cell rather
// than a promise.
//
// IT IS UNFILTERED, AND THE SHAPE SAYS SO. The rows are every row, for every caller. 2026-10-02
// (432-39, D-12): no door filters a listing per caller any more (432-20 deleted the MCP `tools/list`
// visibility law), so there is no permission for a manifest to report either.

// 2026-10-02 (432-39, D-02/D-12): `AgentManifestTokenRefSchema` is deleted with the posture's
// `tokenEnvRefs`, `defaultScopes` and `safeMode` members. No MCP credential is declared or read
// (432-21/22), no scope is granted and no composition hides an op, so each member could only ever
// report the same constant. The strict posture now refuses all three.

/**
 * Whether THIS workspace has a configuration, and whether it read — the local half of the
 * manifest (D-16).
 *
 * `configuration` has THREE arms and they are three different things to tell a person. `init --agent`
 * is the command an agent runs in a directory that may not be a project yet — that is what `init` is
 * for — so `absent` (no configuration file here) is an ordinary answer and not an error. `unresolved`
 * is the other one: a file IS here and it did not parse or validate, which is a thing to FIX rather
 * than a thing to run `init` for. Folding those two together would have an agent recommend the wrong
 * action.
 *
 * NO ARM CARRIES A REASON STRING, deliberately. A validation message quotes the input that failed to
 * validate, and the input here is the file an operator's credentials are declared beside (395-16:
 * Node's own printer walks a cause chain with `util.inspect`, which is how a config file's contents
 * once reached a terminal). The FACT is reportable; the text is not.
 */
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
