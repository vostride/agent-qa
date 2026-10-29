// The golden capability ledger: the projection, the composition-root census, and the comparator
// (Phase 397 plan 06 — FUNC-05 leg 6, D-05 / D-06 / D-07 / D-08).
//
// WHAT THE GOLDEN IS FOR. Every other leg in this suite answers a question about TODAY: is this
// capability reachable, does this surface refuse it, do the two schemas agree. None of them can see
// a change — a risk hint quietly dropped, a capability quietly moved out of
// the MCP partition — because each of those leaves a tree that is entirely self-consistent. The
// golden is the only artifact here that compares the product against its own past, and it does it
// the way a reviewer can read: one committed JSON file, one row per capability, one line per field.
// A dropped risk hint is a one-line diff in a pull request. That is the whole mechanism. A widened
// scope was too until the scopes were deleted, and the ledger lost both permission columns.
//
// PRODUCED, NEVER AUTHORED. Every value in a row comes out of a real registry — the declarations of
// a REAL `composeLocalAgent()` composition (through the CLI's own `composeCliLocalAgent`), joined to
// the shipped `mapping.ts` partition. Nothing below states an op id, a risk hint or a tool name.
// A hand-written golden can encode a value the producer cannot produce, and the diff leg then reds
// only on that impossible row while agreeing with the code about everything real.
//
// THE REGEN CANNOT BE ONE KEYSTROKE. There is no `toMatchSnapshot` here and no `--update`
// path that reaches this file: nothing in this directory writes to `golden-registry.json` at all,
// and `parity.test.ts` asserts that absence as source. The ONE writer is
// `scripts/regen-capability-golden.sh --write`, which refuses to run while any other leg of the
// suite is red — so a regen cannot launder an unrelated failure — and whose `--selftest` proves
// that refusal fires. What this module offers the script is a PRINT (see
// {@link GOLDEN_EMIT_BEGIN}), never a write, so the script owns the gate and the file both.
//
// ONE RECIPE. The script and the diff leg call the same {@link goldenFileFromRoot}. A second
// spelling of the projection — a regen that re-derived the rows its own way — would agree with
// whatever the code does on the day it ran, which is a golden that pins nothing.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FunctionDeclaration, FunctionRegistry } from '@vostride/agent-qa-agent'
import { AGENT_QA_TOOL_PROJECTIONS, UNPROJECTED_OPS } from '@vostride/agent-qa-mcp'
import {
  canonicalJson,
  committedFileText,
  sha256hex,
} from '@vostride/agent-qa-schema'

import { composeCliLocalAgent } from '../../composition/local-agent-host.js'
import { CONFORMANCE_CENSUS_CALLER } from './adapters.js'
import { unprojectedReasonKeyOf, type UnprojectedReasonKey } from './scenario-table.js'

// ---- The file's location and shape --------------------------------------------------------------

/** This directory, so the golden is found rather than guessed at from a working directory. */
const CONFORMANCE_DIR = dirname(fileURLToPath(import.meta.url))

export const GOLDEN_FILE_NAME = 'golden-registry.json'
export const GOLDEN_PATH = join(CONFORMANCE_DIR, GOLDEN_FILE_NAME)

/**
 * The one sentence a reader of a red diff leg needs, and the token the regen script is named by.
 *
 * Exported so the failure messages, the file's own note and the Task-1 acceptance grep are all one
 * string rather than three that can drift.
 */
export const GOLDEN_REGEN_SCRIPT = 'scripts/regen-capability-golden.sh'

/**
 * What a person reading a red diff leg has to DO, in the imperative.
 *
 * Spelled as an instruction rather than as a bare path because the sentence is the whole user
 * interface of D-07: the ledger changed, and the way to change it is a reviewed commit produced by
 * this script — not an `--update` flag, which does not exist for this file.
 */
export const GOLDEN_REGEN_INSTRUCTION = `run ${GOLDEN_REGEN_SCRIPT} --write from the agent-qa root `
  + 'and commit the ledger as a reviewed change'

/** The MCP partition a capability sits in — the third state is DATA, never a missing key. */
export type GoldenPartition =
  /** Projected onto the MCP surface by exactly this declared tool. */
  | { readonly kind: 'projected'; readonly tool: string }
  /** Deliberately not projected, citing the class of the shipped `UNPROJECTED_OPS` reason. */
  | { readonly kind: 'unprojected'; readonly reason: UnprojectedReasonKey }
  /**
   * Neither — the capability appears in no half of the declared mapping.
   *
   * Pitfall 11's shape applied to the partition: a capability the mapping has simply forgotten is a
   * real state, and a projection that dropped the row (or wrote `null`) would hide it inside an
   * absent key. It is spelled, so the golden shows it and `parity.test.ts` reds by name.
   */
  | { readonly kind: 'uncatalogued' }

/**
 * The risk descriptor's STATIC fields, and only those.
 *
 * the descriptor's per-invocation `disclosure` and shell `command`
 * members are deleted, so every member left but the caller's `surface` is projected;
 * `parity.test.ts` holds a register asserting that no descriptor in the census carries a key this
 * projection would silently drop.
 *
 * Absence is preserved rather than defaulted, on the rule the declaration itself follows: `false`
 * and an absent key would be two spellings of one fact, and a defaulted column would make the
 * golden claim an opinion the op does not hold.
 */
export interface GoldenRiskProjection {
  readonly name: string
  readonly recognized: boolean
  readonly destructive?: boolean
  readonly readOnly?: boolean
}

/** One capability, as the ledger records it. */
export interface GoldenRow {
  readonly id: string
  // the `requiredScopes` and `requiresHumanOrigin` columns are
  // gone. Declarations carry no permission metadata, so the ledger has none to record.
  // the `discloses` column is gone with the per-op disclosure it recorded.
  /**
   * Present only when the op folds its own result into a clause verdict.
   *
   * CHANGE-CONTROL SURFACE, not decoration. An op that stops classifying its own result goes back
   * to reporting `executed` for every arm of its union — which is the defect G-399-2 measured, a
   * security control refusing while the terminal said the change completed. That regression is a
   * one-line diff in this column.
   */
  readonly classifies?: true
  /** Present only when the op declares render lines on top of the payload. */
  readonly rendersResult?: true
  readonly resultKind: string
  /**
   * Whether the ONE shipped composition root binds this capability.
   *
   * Read off a real `composeCliLocalAgent()` composition, never off a table. The third state is the
   * literal string `unbound`, so an unbound capability is a value in this column rather than a hole
   * a reader has to notice.
   */
  readonly bindingStatusAtRoot: string
  readonly risk: GoldenRiskProjection
  /** sha256 of the canonical JSON of the inert input projection. */
  readonly inputSchemaDigest: string
  /** sha256 of the canonical JSON of the inert output projection. */
  readonly outputSchemaDigest: string
  readonly partition: GoldenPartition
}

/** The committed file: a note for whoever opens it, a count, and the rows. */
export interface GoldenFile {
  readonly $note: readonly string[]
  readonly opCount: number
  readonly rows: readonly GoldenRow[]
}

/**
 * The note the committed file carries, in the file itself.
 *
 * It is PRODUCED from this constant rather than typed into the JSON, so a hand-edit to the note is
 * a red diff like any other. A reviewer opening a 41-row generated file should not have to find the
 * phase directory to learn what changing it means.
 */
export const GOLDEN_NOTE: readonly string[] = Object.freeze([
  'GENERATED — the capability ledger for Phase 397 (FUNC-05 leg 6, D-05/D-07).',
  'One row per registered capability. A dropped risk hint, a changed schema',
  'digest or a moved MCP partition lands here as a one-line reviewable diff.',
  `DO NOT EDIT BY HAND: regenerate with "bash ${GOLDEN_REGEN_SCRIPT} --write" and commit the result`,
  'as a deliberate, reviewed change. The script refuses to run while any other leg of the',
  'conformance suite is red, so a regeneration cannot launder an unrelated failure, and no',
  'test-runner update flag reaches this file.',
])

// ---- The projection ------------------------------------------------------------------------------

/** Every declaration key this projection consumes. The register in `parity.test.ts` uses it. */
export const GOLDEN_PROJECTED_DECLARATION_KEYS: readonly string[] = Object.freeze([
  'id',
  'classifies',
  'rendersResult',
  'resultKind',
  'bindingStatus',
  'risk',
  'input',
  'output',
])

/**
 * Declaration keys deliberately left out, each with the reason it is not change-control surface.
 *
 * A LIST WITH REASONS rather than a silent difference: `parity.test.ts` asserts that every key on
 * every declaration is either projected above or excluded here, so a declaration that gains a field
 * reds instead of being dropped without anybody noticing.
 */
export const GOLDEN_EXCLUDED_DECLARATION_KEYS: readonly (readonly [string, string])[] =
  Object.freeze([
    Object.freeze([
      'summary',
      'human-facing prose rendered by catalogues; a reworded sentence is not a capability change, '
        + 'and a golden that reds on copy-editing is a golden people stop reading',
    ] as const),
  ])

/** Every risk-descriptor key this projection consumes. */
export const GOLDEN_PROJECTED_RISK_KEYS: readonly string[] = Object.freeze([
  'name',
  'recognized',
  'destructive',
  'readOnly',
])

/** Risk-descriptor keys deliberately left out, with reasons. See the declaration list above. */
export const GOLDEN_EXCLUDED_RISK_KEYS: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze([
    'surface',
    'attribution of the CALLER, not a property of the op; nothing in the function layer branches '
      + 'on it',
  ] as const),
])

/** A declaration field this projection neither carries nor has ruled out of scope. */
export interface UnaccountedField {
  readonly opId: string
  /** `declaration` or `risk` — which object the stray key sits on. */
  readonly on: 'declaration' | 'risk'
  readonly key: string
}

/**
 * Every field the golden would drop WITHOUT SAYING SO.
 *
 * THE NO-SILENT-DROP REGISTER (the phase's own house law, and 394's lesson stated as code). A
 * projection that lists the fields it carries is a projection that silently loses the next field
 * somebody adds: the declaration gains `costsMoney`, the ledger keeps 41 identical rows, and the
 * one column a reviewer would have wanted never exists. So the accounting is two-sided — every key
 * on every declaration must be either PROJECTED or EXCLUDED-WITH-A-REASON — and this function is
 * pure so `parity.test.ts` can drive it with a synthetic declaration carrying a key nobody wrote.
 */
export function unaccountedGoldenFields(
  declarations: readonly FunctionDeclaration[],
): readonly UnaccountedField[] {
  const projectedDeclaration = new Set(GOLDEN_PROJECTED_DECLARATION_KEYS)
  const excludedDeclaration = new Set(GOLDEN_EXCLUDED_DECLARATION_KEYS.map(([key]) => key))
  const projectedRisk = new Set(GOLDEN_PROJECTED_RISK_KEYS)
  const excludedRisk = new Set(GOLDEN_EXCLUDED_RISK_KEYS.map(([key]) => key))
  const unaccounted: UnaccountedField[] = []
  for (const declaration of declarations) {
    for (const key of Object.keys(declaration)) {
      if (projectedDeclaration.has(key) || excludedDeclaration.has(key)) continue
      unaccounted.push({ opId: declaration.id, on: 'declaration', key })
    }
    for (const key of Object.keys(declaration.risk as unknown as Record<string, unknown>)) {
      if (projectedRisk.has(key) || excludedRisk.has(key)) continue
      unaccounted.push({ opId: declaration.id, on: 'risk', key })
    }
  }
  return unaccounted
}

/** Op id -> the tool that projects it, folded out of the declared mapping. */
function projectingToolByOpId(): ReadonlyMap<string, string> {
  const byOp = new Map<string, string>()
  for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
    for (const opId of projection.ops) byOp.set(opId, projection.name)
  }
  return byOp
}

/**
 * Which half of the declared mapping a capability sits in.
 *
 * PURE AND TOTAL over the two shipped tables, so a control cell can drive all three branches — the
 * `uncatalogued` one especially, which is the branch that would otherwise only be reachable by
 * breaking a shipped file.
 */
export function goldenPartitionOf(
  opId: string,
  projectingTool: ReadonlyMap<string, string> = projectingToolByOpId(),
  unprojected: readonly { readonly opId: string; readonly reason: string }[] = UNPROJECTED_OPS,
): GoldenPartition {
  const tool = projectingTool.get(opId)
  if (tool !== undefined) return { kind: 'projected', tool }
  const entry = unprojected.find((candidate) => candidate.opId === opId)
  if (entry === undefined) return { kind: 'uncatalogued' }
  const reason = unprojectedReasonKeyOf(entry.reason)
  // An unclassifiable reason is NOT quietly rewritten as `uncatalogued`: the op is catalogued, its
  // prose simply moved outside the declared vocabulary, and 397-03's classifier cell owns that
  // failure by name. Reporting it here as `uncatalogued` would move one file's defect into another
  // file's column.
  return reason === undefined ? { kind: 'uncatalogued' } : { kind: 'unprojected', reason }
}

/** The digest family this file uses, in one place: sha256 over the ONE canonical serializer. */
export function schemaDigest(projection: unknown): string {
  return sha256hex(canonicalJson(projection))
}

/**
 * One declaration, projected into one ledger row.
 *
 * PURE, so the comparator's control cell can build a synthetically altered row from a real one
 * without composing anything, and so the script and the suite provably share this recipe.
 */
export function goldenRowOf(
  declaration: FunctionDeclaration,
  projectingTool: ReadonlyMap<string, string> = projectingToolByOpId(),
): GoldenRow {
  const risk = declaration.risk as unknown as Record<string, unknown>
  return {
    id: declaration.id,
    ...(declaration.classifies === undefined ? {} : { classifies: true as const }),
    ...(declaration.rendersResult === undefined ? {} : { rendersResult: true as const }),
    resultKind: declaration.resultKind,
    bindingStatusAtRoot: declaration.bindingStatus,
    risk: {
      name: String(risk['name']),
      recognized: risk['recognized'] === true,
      ...(risk['destructive'] === undefined ? {} : { destructive: risk['destructive'] === true }),
      ...(risk['readOnly'] === undefined ? {} : { readOnly: risk['readOnly'] === true }),
    },
    inputSchemaDigest: schemaDigest(declaration.input),
    outputSchemaDigest: schemaDigest(declaration.output),
    partition: goldenPartitionOf(declaration.id, projectingTool),
  }
}

/**
 * The whole ledger, from the declarations of a composition root.
 *
 * Sorted by op id, because the registry's enumeration order is a walk and a ledger whose rows moved
 * when a registration order changed would produce a 41-row diff for a zero-row change.
 */
export function buildGoldenRows(
  rootDeclarations: readonly FunctionDeclaration[],
): readonly GoldenRow[] {
  const projectingTool = projectingToolByOpId()
  return [...rootDeclarations]
    .map((declaration) => goldenRowOf(declaration, projectingTool))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

export function goldenFileOf(rootDeclarations: readonly FunctionDeclaration[]): GoldenFile {
  const rows = buildGoldenRows(rootDeclarations)
  return { $note: GOLDEN_NOTE, opCount: rows.length, rows }
}

/** The committed bytes: the workspace's ONE pretty canonical serializer, one trailing newline. */
export function goldenFileText(file: GoldenFile): string {
  return committedFileText(file)
}

// ---- The composition root -----------------------------------------------------------------

/**
 * A deterministic project the composition root can be built over, and nothing more.
 *
 * The 397-04 driver's fixture, for its reasons: `AgentQaConfigSchema` requires `use.mobile.appState`
 * unconditionally, and one declared target puts the project in the ordinary posture rather than the
 * empty-project one. Nothing here is read to produce a binding status — `resolveBindingStatus` asks
 * only whether this composition supplied the optional dep an op names — but a composition built over
 * an unopenable project is not the composition the product builds.
 */
function goldenRootWorkspace(): { readonly configPath: string; readonly projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agent-qa-397-06-root-'))
  const configPath = join(projectRoot, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      registry: {
        targets: { conformance: { platform: 'web', url: 'https://conformance.invalid' } },
      },
    })}\n`,
    'utf8',
  )
  return { configPath, projectRoot: dirname(resolve(configPath)) }
}

/**
 * Compose the ONE shipped composition root and hand its declarations to a body.
 *
 * THROUGH `composeCliLocalAgent`, which is `composeLocalAgent` plus this host's own bindings — the
 * function every shipped CLI surface composes through (`commands/chat.ts`, `commands/mcp.ts`,
 * `commands/fn.ts`). Composing `composeLocalAgent` directly here would be composing a host no
 * command builds, and the binding column would then describe an assembly that ships to nobody.
 *
 * The host is closed and the workspace removed in a `finally`, so no cell can observe what another
 * left behind and no run leaves a project tree in the temp directory.
 */
export async function withGoldenRootRegistry<Answer>(
  body: (registry: FunctionRegistry) => Answer | Promise<Answer>,
): Promise<Answer> {
  const { configPath, projectRoot } = goldenRootWorkspace()
  const host = composeCliLocalAgent({ agentQaRoot: join(projectRoot, '.agent-qa'), configPath })
  try {
    return await body(host.registry)
  } finally {
    await host.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

/**
 * The root's own listing, under the census caller (every caller sees the same list since 432-20).
 *
 * The declarations are inert frozen data, so carrying them out past the host's lifetime carries no
 * handle on the composition — which is what lets a `beforeAll` take the census once.
 */
export async function withGoldenRootDeclarations<Answer>(
  body: (declarations: readonly FunctionDeclaration[]) => Answer | Promise<Answer>,
): Promise<Answer> {
  return withGoldenRootRegistry((registry) => body(registry.list(CONFORMANCE_CENSUS_CALLER)))
}

/** The ledger as the live tree produces it today — THE recipe, shared by the suite and the script. */
export async function goldenFileFromRoot(): Promise<GoldenFile> {
  return withGoldenRootDeclarations((declarations) => goldenFileOf(declarations))
}

// ---- The comparator -----------------------------------------------------------------------

/** One disagreement between the live ledger and the committed one, named by op and field. */
export interface GoldenFinding {
  readonly opId: string
  /** `id` for a whole-row presence disagreement, otherwise the top-level field that moved. */
  readonly field: string
  readonly message: string
}

const ROW_FIELDS: readonly string[] = Object.freeze([
  'classifies',
  'rendersResult',
  'resultKind',
  'bindingStatusAtRoot',
  'risk',
  'inputSchemaDigest',
  'outputSchemaDigest',
  'partition',
])

/** Deep equality through the ONE canonical serializer — sorted keys, so field order cannot lie. */
function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

/**
 * Every field on every row that disagrees, as data.
 *
 * PURE, TOTAL AND DRIVABLE. The named-RED requirement is that a mismatch identifies the
 * OP and the FIELD rather than announcing that two hashes differ, and a comparator that only threw
 * could not be shown to do that without breaking the committed file. `parity.test.ts` drives this
 * with synthetically altered rows — a widened scope, a dropped risk hint, a moved partition — and
 * asserts each one is named.
 *
 * It reports FIELDS, not a diff document: the structural diff is vitest's own, printed by the
 * `toEqual` the leg performs per named op. Building a second diff renderer here would be a second
 * mechanism for a job the runner already does better.
 */
export function goldenFindings(
  live: readonly GoldenRow[],
  committed: readonly GoldenRow[],
): readonly GoldenFinding[] {
  const liveById = new Map(live.map((row) => [row.id, row]))
  const committedById = new Map(committed.map((row) => [row.id, row]))
  const findings: GoldenFinding[] = []

  for (const row of live) {
    if (!committedById.has(row.id)) {
      findings.push({
        opId: row.id,
        field: 'id',
        message:
          `${row.id}: the registry declares this capability and the golden has no row for it — a `
          + `new capability is a reviewed ledger entry, so ${GOLDEN_REGEN_INSTRUCTION}`,
      })
    }
  }
  for (const row of committed) {
    if (!liveById.has(row.id)) {
      findings.push({
        opId: row.id,
        field: 'id',
        message:
          `${row.id}: the golden carries a row for a capability the registry no longer declares — a `
          + `removed capability is a reviewed ledger entry, so ${GOLDEN_REGEN_INSTRUCTION}`,
      })
    }
  }

  for (const liveRow of live) {
    const committedRow = committedById.get(liveRow.id)
    if (committedRow === undefined) continue
    for (const field of ROW_FIELDS) {
      const liveValue = (liveRow as unknown as Record<string, unknown>)[field]
      const committedValue = (committedRow as unknown as Record<string, unknown>)[field]
      if (sameValue(liveValue, committedValue)) continue
      findings.push({
        opId: liveRow.id,
        field,
        message:
          `${liveRow.id}.${field}: the live registry says ${canonicalJson(liveValue)}, the golden `
          + `pins ${canonicalJson(committedValue)}`,
      })
    }
  }

  return findings
}

/** The fields that moved for one op, for a failure label that names them before the diff prints. */
export function goldenFieldsThatMoved(
  findings: readonly GoldenFinding[],
  opId: string,
): readonly string[] {
  return findings.filter((finding) => finding.opId === opId).map((finding) => finding.field)
}

// ---- The emit port the regen script reads -------------------------------------------------

/**
 * The env flag under which the suite PRINTS a freshly minted ledger, and never writes one.
 *
 * A PRINT AND NOT A WRITE, deliberately. `scripts/regen-capability-golden.sh` runs the suite with
 * this set, lifts the text out from between the sentinels below and writes the file ITSELF — only
 * after its refuse-while-red gate has passed and only under `--write`. Nothing in this directory
 * opens the golden for writing (`parity.test.ts` asserts that as source), so there is no value of
 * any environment variable, and no runner flag, that causes a test run to bless the ledger.
 */
export const GOLDEN_EMIT_FLAG = 'AGENT_QA_397_GOLDEN_EMIT'
export const GOLDEN_EMIT_BEGIN = '<<<397-06-GOLDEN-BEGIN>>>'
export const GOLDEN_EMIT_END = '<<<397-06-GOLDEN-END>>>'

/** True when the regen script asked for the text. Nothing else in the product reads this flag. */
export function goldenEmitRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GOLDEN_EMIT_FLAG] === '1'
}

/** Print the minted ledger between sentinels, for the script to lift out. */
export function emitGoldenText(text: string): void {
  process.stdout.write(`\n${GOLDEN_EMIT_BEGIN}\n${text}${GOLDEN_EMIT_END}\n`)
}
