// Every row is produced from a real registry; `regen-capability-golden.sh --write` writes it.

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

// An instruction, not a bare path: the ledger changes only by a reviewed commit from this script.
export const GOLDEN_REGEN_INSTRUCTION = `run ${GOLDEN_REGEN_SCRIPT} --write from the agent-qa root `
  + 'and commit the ledger as a reviewed change'

/** The MCP partition a capability sits in — the third state is DATA, never a missing key. */
export type GoldenPartition =
  /** Projected onto the MCP surface by exactly this declared tool. */
  | { readonly kind: 'projected'; readonly tool: string }
  /** Deliberately not projected, citing the class of the shipped `UNPROJECTED_OPS` reason. */
  | { readonly kind: 'unprojected'; readonly reason: UnprojectedReasonKey }
  // A capability the mapping forgot is a real state, so it is spelled rather than dropped.
  | { readonly kind: 'uncatalogued' }

// Absence is kept, not defaulted: `false` and an absent key would be two spellings of one fact.
export interface GoldenRiskProjection {
  readonly name: string
  readonly recognized: boolean
  readonly destructive?: boolean
  readonly readOnly?: boolean
}

/** One capability, as the ledger records it. */
export interface GoldenRow {
  readonly id: string
  // An op that stops classifying reports `executed` for every arm; this column makes that a diff.
  readonly classifies?: true
  /** Present only when the op declares render lines on top of the payload. */
  readonly rendersResult?: true
  readonly resultKind: string
  // The third state is the literal `unbound`, so an unbound capability is a value, not a hole.
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
  'GENERATED — the capability ledger.',
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

// Every declaration key is projected or excluded with a reason, so a new field cannot vanish.
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
  // An unclassifiable reason stays `unprojected`: the classifier cell owns that failure.
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

// `AgentQaConfigSchema` requires `use.mobile.appState`, and one target gives the ordinary posture.
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

// Through `composeCliLocalAgent`, the root every shipped command composes.
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

// The declarations are inert frozen data, so they outlive the host and `beforeAll` takes them once.
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

// Pure and total, so a mismatch names its op and field without breaking the committed file.
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
export const GOLDEN_EMIT_FLAG = 'AGENT_QA_GOLDEN_EMIT'
export const GOLDEN_EMIT_BEGIN = '<<<GOLDEN-BEGIN>>>'
export const GOLDEN_EMIT_END = '<<<GOLDEN-END>>>'

/** True when the regen script asked for the text. Nothing else in the product reads this flag. */
export function goldenEmitRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GOLDEN_EMIT_FLAG] === '1'
}

/** Print the minted ledger between sentinels, for the script to lift out. */
export function emitGoldenText(text: string): void {
  process.stdout.write(`\n${GOLDEN_EMIT_BEGIN}\n${text}${GOLDEN_EMIT_END}\n`)
}
