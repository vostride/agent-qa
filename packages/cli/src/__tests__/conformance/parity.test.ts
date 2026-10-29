// The conformance & parity suite (Phase 397 plan 01 — FUNC-05 leg 5, D-01 / D-02 / D-03 / D-04).
//
// THE CLAIM. A capability exists iff it is one row in the registry, and every rostered surface
// reaches only rows that exist. This file carries the leg that makes the second half checkable:
// reverse completeness — `surface.enumerate() ⊆ registry.ids()` — asserted per surface, off real
// compositions, with every failure naming the op id and the surface it appeared on.
//
// ONE SUITE, RANGED OVER THE ROSTER AND THE REGISTRY. There is deliberately no `describe` per
// surface: a per-surface block is a place for a surface to acquire its own exceptions, and a claim
// that must hold everywhere has to be written once and driven over the members. Adding a surface
// adds a roster row and nothing here changes; adding a capability adds a registry row and nothing
// here changes. That is the structural half of the claim, and it is why the loops below read their
// per-surface work out of adapter output instead of out of a block.
//
// WHY THE ENUMERATIONS ARE TAKEN ONCE. The MCP side is a real protocol round trip against a real
// server instance. Taking it once and asserting many things about it keeps the cells fast and,
// more importantly, keeps every cell in this file asserting about THE SAME observed surface rather
// than about a fresh one that might differ — which would make a disagreement between two cells
// unattributable.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'

import { invokeFunction, CHAT_RESOLVER_TABLE } from '@vostride/agent-qa-agent'
import type { FunctionDeclaration } from '@vostride/agent-qa-agent'
import {
  CHAT_PLANNER_CALLER,
  CHAT_RESOLVER_CALLER,
} from '@vostride/agent-qa-agent-local'
import {
  advertisedContracts,
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  armWithoutDiscriminant,
  buildAgentQaMcpServer,
  compositionOf,
  DEGRADED_OUTPUT_CONTRACTS,
  foldArmFindings,
  UNPROJECTED_OPS,
  withoutDialect,
  withoutLegacyResultWrap,
} from '@vostride/agent-qa-mcp'
import type { JsonDocument, ToolProjection } from '@vostride/agent-qa-mcp'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { committedFileText } from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { composeMcpMasking, MCP_FUNCTION_CALLER } from '../../commands/mcp.js'
import { composeCliLocalAgent } from '../../composition/local-agent-host.js'

/**
 * the six names of the deleted capability-scope union, spelled by
 * hand because the union is gone. Used only as legacy data a caller record may still carry.
 */
const RETIRED_SCOPE_NAMES: readonly string[] = [
  'read', 'run', 'config-write', 'knowledge-write', 'approval-write', 'test-write',
]

/**
 * the retired MCP default grant — every scope but `config-write` —
 * spelled here as the legacy scope set a caller may still carry. The token resolver that minted it
 * is deleted; nothing reads the field, and the cells below use it to show exactly that.
 */
const LEGACY_DEFAULT_GRANT = RETIRED_SCOPE_NAMES.filter((scope) => scope !== 'config-write')

/**
 * The shipped tokenless MCP caller carrying a legacy scope set, SMUGGLED past the type: 432-39
 * deleted `FunctionCaller.grantedScopes`, so the set rides a cast. The C432-TOKENLESS-CATALOG cells
 * hand these to the MCP helpers so they still compare DIFFERENT callers — a helper that only ever
 * built the shipped caller would compare one caller with itself, and pass vacuously.
 */
function smuggledMcpCaller(grantedScopes: readonly string[]): FunctionCaller {
  return { ...MCP_FUNCTION_CALLER, grantedScopes } as FunctionCaller
}

// `legacyMcpCaller`, which stamped a legacy scope set onto the tokenless
// MCP caller as the retired `grantedScopes` field, is deleted; the root-host listings below use the
// shipped `MCP_FUNCTION_CALLER` itself.
import {
  CHAT_RESOLVER_PROBES,
  chatEnumerationOf,
  CONFORMANCE_CENSUS_CALLER,
  conformanceRegistry,
  enumerateMcpOpIds,
  expandMcpListedTools,
  listMcpToolNames,
  plausibleMcpToolSpelling,
  probeResolverTable,
  registryDeclarations,
  registryOpIds,
  withMcpClient,
  type ResolverOpTarget,
  type SurfaceEnumeration,
} from './adapters.js'
import * as policyFixtures from './policy-fixtures.js'
import {
  CONFORMANCE_EXECUTION_CONTEXT,
  coveringCallerFor,
  grantlessSurfaceCallers,
  surfaceInertCallers,
  surfaceShapedCallers,
} from './policy-fixtures.js'
import {
  buildGoldenRows,
  emitGoldenText,
  GOLDEN_FILE_NAME,
  GOLDEN_PATH,
  GOLDEN_REGEN_INSTRUCTION,
  GOLDEN_REGEN_SCRIPT,
  goldenEmitRequested,
  goldenFieldsThatMoved,
  goldenFileFromRoot,
  goldenFileOf,
  goldenFileText,
  goldenFindings,
  goldenPartitionOf,
  unaccountedGoldenFields,
  withGoldenRootRegistry,
  type GoldenFile,
  type GoldenRow,
} from './golden.js'
import {
  CANONICAL_ID_DOMAINS,
  domainCensus,
  domainOf,
  OP_ID_GRAMMAR,
  type CanonicalDomain,
} from './domain-list.js'
import { SURFACE_ROSTER } from './roster.js'
import {
  driveChatDispatch,
  driveChatLines,
  driveMcpCall,
  genericFnClause,
  pinClassFor,
} from './surface-dispatch.js'
import {
  censusDiff,
  OP_INPUT_CONTRACTS,
  SCENARIO_TABLE,
  scenarioRowFor,
  scenarioTableOpIds,
  UNPROJECTED_REASON_SIGNATURES,
  unprojectedReasonKeyOf,
  type ScenarioOpId,
} from './scenario-table.js'

/**
 * What the control cells plant, and it exists nowhere else in this product.
 *
 * NAMED CONSTANTS rather than literals buried in the cells, because 397-09's mutation script has to
 * be able to tell the control cells' own synthetic strays apart from the strays IT plants: a script
 * that grepped for a generic name would read this file's deliberate fixture as the defect it went
 * looking for.
 */
const SYNTHETIC_UNCATALOGUED_TOOL = 'agent_qa_control_uncatalogued_397_01'

const SYNTHETIC_STRAY_ALIAS_TARGET: ResolverOpTarget = Object.freeze({
  alias: 'control-stray-397-01',
  functionId: 'control.stray.397.01',
})

/**
 * Plan 03's own synthetic fixtures, named for THIS plan (never reusing 397-01's).
 *
 * Same reason the 397-01 constants above carry their plan number: 397-09's mutation script has to
 * tell each plan's deliberate fixtures from the strays it plants, and a shared name would make one
 * suite's control cell read as another suite's defect.
 */
const SYNTHETIC_UNCARRIED_OP_ID = 'control.uncarried.397.03'
const SYNTHETIC_STRAY_ROW_OP_ID = 'control.stray.row.397.03'
const SYNTHETIC_ABSENT_OP_ID = 'control.absent.397.03'
const SYNTHETIC_UNCLASSIFIABLE_REASON = 'control 397-03: prose in no declared class'

/**
 * Plan 04's own synthetic fixtures, named for the plan that plants them.
 *
 * 397-09's mutation script tells a plan's deliberate strays from the ones IT plants by name, so
 * each plan's constants carry its number and no plan reuses another's.
 */
const SYNTHETIC_DRIVER_ABSENT_OP_ID = 'control.absent.397.04'

/**
 * Plan 06's own synthetic fixtures, named for the plan that plants them.
 *
 * Same rule the three blocks above follow: 397-09's mutation script tells a plan's deliberate
 * fixtures from the strays it plants by NAME, so nothing here reuses another plan's constant.
 */
/**
 * Plan 08's own synthetic fixtures, named for the plan that plants them.
 *
 * Same rule every block above follows: 397-09's mutation script tells a plan's deliberate fixtures
 * from the strays it plants by NAME, so nothing here reuses another plan's constant. The domain
 * spellings are deliberately not real English domain words — a control that planted `billing` would
 * read, to a person scanning the taxonomy, like a domain someone meant to add.
 */
const SYNTHETIC_UNCATALOGUED_DOMAIN_OP_ID = 'controluncatalogued39708.probe'
const SYNTHETIC_MEMBERLESS_DOMAIN = 'controlmemberless39708'
const SYNTHETIC_RESERVED_DOMAIN = 'controlreserved39708'

const SYNTHETIC_GOLDEN_STRAY_OP_ID = 'control.golden.stray.397.06'
const SYNTHETIC_GOLDEN_UNCATALOGUED_OP_ID = 'control.golden.uncatalogued.397.06'
const SYNTHETIC_GOLDEN_STRAY_FIELD = 'controlGoldenField39706'

const enumerations = new Map<string, SurfaceEnumeration>()
let censusIds: readonly string[] = []
let censusIdSet: ReadonlySet<string> = new Set()

/**
 * The composition root's own listing, and each surface host's, taken from ONE composition.
 *
 * ONE COMPOSITION FOR ALL FOUR READS, because the question these cells ask is whether the root and
 * a host that runs over it can disagree — and four separately composed hosts would make a
 * disagreement unattributable to anything but the composing. The listings are inert frozen data, so
 * they outlive the host they were taken from without carrying a handle on it.
 */
let rootDeclarations: readonly FunctionDeclaration[] = []
const rootHostListings = new Map<string, readonly FunctionDeclaration[]>()

beforeAll(async () => {
  censusIds = registryOpIds()
  censusIdSet = new Set(censusIds)
  for (const entry of SURFACE_ROSTER) {
    enumerations.set(entry.id, await entry.adapter.enumerateOpIds())
  }
  await withGoldenRootRegistry((registry) => {
    rootDeclarations = registry.list(CONFORMANCE_CENSUS_CALLER)
    // The callers each shipped surface host actually lists under — the chat host's two stage mints
    // (392) and the MCP host's caller, under the two keys its two retired grants used to have (396's
    // default, which withheld `config-write`, and the every-scope grant; 2026-10-02, 432-39: no grant
    // exists, so both keys are the one tokenless caller). Read off the SAME registry object
    // the shipped commands hand their surface, which is what makes a disagreement here a fact about
    // the product rather than about this file's assembly.
    rootHostListings.set('chat:planner', registry.list(CHAT_PLANNER_CALLER))
    rootHostListings.set('chat:resolver', registry.list(CHAT_RESOLVER_CALLER))
    // both MCP grants are retired, so both MCP keys list under the one
    // tokenless caller the MCP host mints. The two keys stay, so the four-listing claim is unchanged.
    rootHostListings.set('mcp:every-scope', registry.list(MCP_FUNCTION_CALLER))
    rootHostListings.set('mcp:default-grant', registry.list(MCP_FUNCTION_CALLER))
  })
})

/** The enumeration for one roster id, or a failure that says which surface never produced one. */
function enumerationOf(surfaceId: string): SurfaceEnumeration {
  const enumeration = enumerations.get(surfaceId)
  expect(enumeration, `${surfaceId}: the roster names this surface but no enumeration was taken`)
    .toBeDefined()
  return enumeration as SurfaceEnumeration
}

const sorted = (ids: Iterable<string>): readonly string[] => [...ids].sort()

/** This directory, so a source assertion reads the file it names rather than a path it guessed. */
const CONFORMANCE_DIR = dirname(fileURLToPath(import.meta.url))

/** A source file at an absolute path, with its comments removed. */
function commentStrippedFile(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

/** A source file with its comments removed, so a header may name what its body must not contain. */
function commentStrippedSource(fileName: string): string {
  return commentStrippedFile(join(CONFORMANCE_DIR, fileName))
}

// ---- The gate wall ---------------------------------------------------

/**
 * Where one invocation stopped, as a comparable answer.
 *
 * A CLOSED, ORDERED VOCABULARY rather than a boolean or an error instance, because the two things
 * the verdict legs ask are "did these two callers get the same answer" and "is that answer one that
 * means the gate was consulted at all". A boolean can say the first and not the second, and a cell
 * that could not say the second would report policy identity over two identical INPUT errors —
 * which is two callers agreeing about a fixture rather than about a policy.
 *
 * The bands follow `invoke.ts`'s pinned order: `refused-input`/`refused-unknown` are pre-gate and
 * pre-caller, `refused-scope`/`refused-origin` are the pre-gate CALLER band, `gate-denied` is the
 * gate's own answer, and the two `allowed-` members are places only a call the gate ALLOWED can
 * reach (step 6's binding check, and step 7's dispatch).
 */
type GateAnswerKind =
  | 'refused-unknown'
  | 'refused-input'
  | 'refused-scope'
  | 'refused-origin'
  | 'gate-denied'
  | 'allowed-unbound'
  | 'allowed-dispatched'

interface GateAnswer {
  readonly kind: GateAnswerKind
  /** The scopes the refusal named, where it named any — so a refusal is attributable. */
  readonly missingScopes: readonly string[]
}

/**
 * Ask the gate about one capability, on behalf of one caller, and report where the call stopped.
 *
 * The call is a REAL `invokeFunction` against the shipped registry: the same eight steps, in the
 * same order, that every surface's dispatch crosses. What differs from a surface drive is only who
 * is asking — which is the point, since this wall exists to answer independently of any surface.
 */
async function gateAnswerFor(
  opId: string,
  input: unknown,
  caller: Parameters<typeof invokeFunction>[3],
): Promise<GateAnswer> {
  const registry = conformanceRegistry()
  try {
    await invokeFunction(registry, opId, input, caller)
    return { kind: 'allowed-dispatched', missingScopes: [] }
  } catch (thrown) {
    const error = thrown as { name?: string; missingScopes?: readonly string[] }
    switch (error.name) {
      case 'UnknownFunctionError':
        return { kind: 'refused-unknown', missingScopes: [] }
      case 'FunctionInputError':
        return { kind: 'refused-input', missingScopes: [] }
      case 'FunctionScopeError':
        return { kind: 'refused-scope', missingScopes: [...(error.missingScopes ?? [])] }
      case 'FunctionOriginError':
        return { kind: 'refused-origin', missingScopes: [] }
      case 'FunctionDeniedError':
        return { kind: 'gate-denied', missingScopes: [] }
      case 'FunctionNotBoundError':
        // The gate ALLOWED and this composition cannot run it — step 6, which is only reachable
        // past step 5. Deliberately not lumped in with the refusals: "refused" and "allowed but
        // unrunnable here" are the disagreement `resolveBindingStatus` exists to prevent.
        return { kind: 'allowed-unbound', missingScopes: [] }
      default:
        // A dependency that is not there, reached because the gate let the call through to step 7.
        return { kind: 'allowed-dispatched', missingScopes: [] }
    }
  }
}

/** The answers that mean the call reached the gate band — i.e. that a verdict was actually taken. */
const REACHED_THE_GATE: readonly GateAnswerKind[] = Object.freeze([
  'gate-denied',
  'allowed-unbound',
  'allowed-dispatched',
])

// ---- Leg 2: structural schema equality, per OP, through the one lens -----------
//
// THE UNIVERSE HERE IS PER-OP, AND THAT IS THE WHOLE DIFFERENCE from the fidelity suite in
// `packages/mcp`. That suite ranges the fourteen TOOLS and asks whether each advertisement matches
// the contracts behind it; this leg ranges the twenty-two projected OPS and asks, of each
// capability, whether the shape a caller is shown for it is the shape `invokeFunction` validates it
// with. The two universes answer different questions — a fold's arm is one tool and several
// capabilities — and the per-op reading is the one FUNC-05 makes ("per spec × per surface"). Neither
// cell is duplicated: what is shared is the LENS, imported from the mcp barrel, never re-derived
// (D-06; a second normaliser drifts looser and the looser copy is the one that passes over drift).

/**
 * Why one op's schema is not compared byte for byte on one side, from a CLOSED vocabulary.
 *
 * Encoded as data with a reason apiece rather than as `if` branches, so the set of exemptions is
 * enumerable, each one is exercised (asserted below), and a new one has to be declared here rather
 * than added as a condition nobody counts. No skip-lists: every op is either compared or carries one
 * of these keys, and the arithmetic is pinned.
 */
// `apply-door-wire-envelope` LEFT this vocabulary with the two apply
// doors. No tool advertises a `confirmed` envelope any more, so every projected input is compared,
// and an exception nothing takes would be dead prose (the cell below asserts every key is taken).
type Leg2ExceptionKey =
  | 'pipeline-downstream-op'
  | 'degraded-output-contract'

const LEG2_EXCEPTIONS: readonly (readonly [Leg2ExceptionKey, string])[] = Object.freeze([
  Object.freeze([
    'pipeline-downstream-op',
    'a pipeline tool advertises its FIRST op\'s shapes; the downstream op runs inside the resolved '
      + 'arm and contributes no shape of its own. A document carrying one would mean the tool had '
      + 'invented a result envelope, which is the one thing a pure projection may not do',
  ] as const),
  Object.freeze([
    'degraded-output-contract',
    'a tool whose result contract contains a branded transform advertises NO outputSchema '
      + '(mapping.ts DEGRADED_OUTPUT_CONTRACTS). The absence is ASSERTED rather than skipped, in '
      + 'both directions, together with the sentence that tells a caller about it',
  ] as const),
])

/** What this leg does with one op on one side of the comparison. */
type Leg2Plan =
  | { readonly kind: 'whole' }
  | { readonly kind: 'arm'; readonly at: number }
  | { readonly kind: 'exception'; readonly key: Leg2ExceptionKey }

/**
 * PURE, over the declared mapping — so the plan for every op is derived from the shipped tables
 * rather than from a per-op list this file would have to keep in step with them.
 */
function leg2InputPlan(projection: ToolProjection, opId: string): Leg2Plan {
  // every door, the credential-required mark door included, takes its native op input.
  const composition = compositionOf(projection)
  if (composition === 'union') return { kind: 'arm', at: projection.ops.indexOf(opId) }
  if (composition === 'pipeline' && projection.ops[0] !== opId) {
    return { kind: 'exception', key: 'pipeline-downstream-op' }
  }
  return { kind: 'whole' }
}

function leg2OutputPlan(projection: ToolProjection, opId: string): Leg2Plan {
  if (DEGRADED_OUTPUT_CONTRACTS.some((entry) => entry.tool === projection.name)) {
    return { kind: 'exception', key: 'degraded-output-contract' }
  }
  const composition = compositionOf(projection)
  if (composition === 'pipeline' && projection.ops[0] !== opId) {
    return { kind: 'exception', key: 'pipeline-downstream-op' }
  }
  return { kind: 'whole' }
}

/** The advertised output documents an op's own projection may equal: the doc, or the union's arms. */
function advertisedOutputMembers(advertised: JsonDocument): readonly JsonDocument[] {
  const arms = advertised.anyOf as readonly JsonDocument[] | undefined
  return arms === undefined ? [advertised] : arms
}

/** One listed tool, as `tools/list` describes it. */
interface AdvertisedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: JsonDocument
  readonly outputSchema?: JsonDocument
}

describe('the parity suite ranges the registry census over every rostered surface', () => {
  it('pins the roster at the four surfaces that exist today', () => {
    // D-04. An exact list rather than a length check or a contains check: a surface REPLACED would
    // pass both of those while the claim quietly moved to a different set of doors.
    //
    // the `fn` door joins. The order is registration order and is asserted
    // as such — `roster.ts` reads as a dated history and a row that moved would be a row somebody
    // re-decided.
    //
    // the dashboard chat door joins, on the day the door itself is first
    // committed rather than at the end of the phase that builds it. That is the whole content of
    // "day one, not at its end": every plan after this one builds under a suite that already ranges
    // the door, so a private power added to it is a named RED in the change that adds it.
    //
    // the authed run service joins, in the phase that ships it, as the
    // third and last of the three arrivals `roster.ts`'s 2026-08-16 registration note reserved.
    //
    // the dashboard chat door leaves with its routes, and the
    // title above is true again. PXH-SURF-02's "three doors" miscounted a roster that also carries
    // `run-service`; four doors is the delivered set, and a returning `dashboard` row reds here.
    expect(SURFACE_ROSTER.map((entry) => entry.id))
      .toEqual(['chat', 'mcp', 'fn', 'run-service'])
    for (const entry of SURFACE_ROSTER) {
      expect(entry.adapter.id, `${entry.id}: the roster row and its adapter must name one surface`)
        .toBe(entry.id)
    }
  })

  it('makes every door state what it cannot do, by shape rather than by omission', () => {
    // 402-07, D-04. The four wide doors declare an EMPTY list and the run service declares a
    // populated one; what is asserted here is that BOTH are declarations. A door whose narrowness
    // showed up only as ops it happened not to enumerate reads exactly like a door that lost half
    // its reach in a regression, and 397 D-12's refusal to keep a skip list is what makes the
    // distinction matter: a skip list says which cells not to run, and this says which capabilities
    // the door does not have.
    //
    // THE FIELD IS REQUIRED ON THE INTERFACE, so this cell cannot be satisfied by absence — every
    // member below has to exist for the file to compile. What it adds is that a populated entry
    // carries a REASON, because an unexplained "not applicable" is the omission wearing a label.
    for (const entry of SURFACE_ROSTER) {
      expect(
        Array.isArray(entry.adapter.notApplicable),
        `${entry.id}: a rostered door must DECLARE its not-applicable set, even when it is empty`,
      ).toBe(true)
      for (const declared of entry.adapter.notApplicable) {
        expect(
          declared.capability.trim().length > 0 && declared.why.trim().length > 0,
          `${entry.id}: "${declared.capability}" is declared not-applicable with no reason`,
        ).toBe(true)
      }
    }
    // The narrow door is narrow ON PURPOSE and says so — asserted by NAME rather than over the
    // whole roster, because "some door declares something" is a claim any future row could satisfy
    // while this one went quiet.
    const runService = SURFACE_ROSTER.find((entry) => entry.id === 'run-service')
    expect(runService, 'the run-service row is what this cell is about').toBeDefined()
    expect(
      (runService as { adapter: { notApplicable: readonly unknown[] } }).adapter.notApplicable.length,
      'the run service reaches one op and a stream; a door that narrow must say what it declines',
    ).toBeGreaterThan(0)
  })

  it('reaches, on every rostered surface, only capabilities the registry declares', async () => {
    // FUNC-05 leg 5, and the driver is the roster with the census as the comparand. Two named REDs
    // per surface: a capability enumerated on the surface that no registry row declares, and a
    // listed door the declared data does not catalogue at all.
    for (const entry of SURFACE_ROSTER) {
      const enumeration = enumerationOf(entry.id)

      expect(
        enumeration.strays.map((stray) => `${stray.kind}: ${stray.name}`),
        `${entry.id}: reachable here and catalogued in no declared table — an uncatalogued capability`,
      ).toEqual([])

      expect(
        enumeration.opIds.size,
        `${entry.id}: enumerated nothing at all, which no surface in this product does`,
      ).toBeGreaterThan(0)

      for (const opId of sorted(enumeration.opIds)) {
        expect(
          censusIdSet.has(opId),
          `${opId} on ${entry.id}: reachable on this surface but absent from the registry census`,
        ).toBe(true)
      }
    }
  })

  it('drives every row of the deterministic chat table, and no row it no longer has', () => {
    // The chat enumeration's own honesty check, and it reds in BOTH directions: a resolver row
    // nothing here probes would enter the surface unwatched, and a probe naming a row that has been
    // deleted would keep this file asserting about an alias that is gone. A register that can only
    // red on one side is half a register.
    const probed = probeResolverTable(CHAT_RESOLVER_TABLE, CHAT_RESOLVER_PROBES)
    expect(probed.unprobedAliases, 'chat resolver rows reaching the surface with nothing driving them')
      .toEqual([])
    expect(probed.unknownProbeAliases, 'probes naming a chat resolver row that no longer exists')
      .toEqual([])
    expect(
      probed.roleMismatches,
      'chat resolver rows whose produced entry disagrees with the kind declared for them',
    ).toEqual([])
    expect(
      probed.targets.length,
      'the chat resolver table bound no capability at all, which would make its half of the '
        + 'enumeration vacuous',
    ).toBeGreaterThan(0)
  })

  it('enumerates over MCP exactly the op set the declared mapping projects', () => {
    // The comparand is DERIVED from the mapping rather than pinned here, because pinning tool names
    // in this suite would be a second catalogue: what this cell claims is that the LIVE listing,
    // folded through the declared mapping, reaches the ops that mapping declares.
    const projected = sorted(AGENT_QA_TOOL_PROJECTIONS.flatMap((p) => [...p.ops]))
    expect(sorted(enumerationOf('mcp').opIds), 'the live MCP listing, fold-expanded to op ids')
      .toEqual(projected)
  })

  it('enumerates over chat every capability the registry declares', () => {
    // The chat planner binds the listing 1:1, so the chat surface's reach IS the census — which is
    // what makes the MCP surface's smaller reach a decision rather than an accident.
    expect(sorted(enumerationOf('chat').opIds), 'the chat planner and resolver routes, as op ids')
      .toEqual(sorted(censusIds))
  })

  it('accounts for every declared capability as MCP-reachable or declared-unprojected', () => {
    // The registry is the iteration driver here, and the partition it closes is consumed from the
    // mapping rather than restated: an op reachable over MCP, or an op with a dated reason for not
    // being. An op in neither has landed with nobody having decided anything about it.
    const mcpReach = enumerationOf('mcp').opIds
    const unprojected = new Set(UNPROJECTED_OPS.map((entry) => entry.opId))
    for (const opId of sorted(censusIds)) {
      expect(
        mcpReach.has(opId) !== unprojected.has(opId),
        `${opId} on mcp: must be reachable OR carry a declared unprojected reason — exactly one`,
      ).toBe(true)
    }
    // And the other direction, so a stale scoping-note row cannot sit here forever: every declared
    // unprojected op is a real capability.
    for (const opId of sorted(unprojected)) {
      expect(
        censusIdSet.has(opId),
        `${opId} on mcp: declared unprojected, but the registry declares no such capability`,
      ).toBe(true)
    }
  })

  // ---- The control cells: proof that the two detectors above can FIRE --------------------------
  //
  // A detector nobody has seen fire is a comment. Every cell before this one asserts an ABSENCE —
  // no stray tool, no stray alias — and an absence is exactly what a detector that cannot detect
  // reports. The two cells below drive the pure cores with synthetic input, so the branches are
  // exercised without mutating a shipped file and without a skip-list anywhere. Each also feeds a
  // CLEAN input in the same cell, because a detector that fires on everything is no better than one
  // that fires on nothing.
  //
  // 397-09's mutation script names these two cells: they are what makes its "an allowed cell failed
  // to red" side of the discrimination meaningful.

  it('control: the MCP stray-tool branch fires on a listed tool the mapping does not catalogue', () => {
    const catalogued = AGENT_QA_TOOL_PROJECTIONS[0]
    expect(catalogued, 'the declared mapping projects no tool at all').toBeDefined()

    const clean = expandMcpListedTools([catalogued!.name], AGENT_QA_TOOL_PROJECTIONS)
    expect(clean.strayTools, 'a catalogued listing must produce no stray').toEqual([])
    expect(sorted(clean.opIds), 'a catalogued tool expands to its declared ops').toEqual(
      sorted(catalogued!.ops),
    )

    const planted = expandMcpListedTools(
      [catalogued!.name, SYNTHETIC_UNCATALOGUED_TOOL],
      AGENT_QA_TOOL_PROJECTIONS,
    )
    expect(
      planted.strayTools,
      'a listed tool absent from the declared mapping must be reported by name',
    ).toEqual([SYNTHETIC_UNCATALOGUED_TOOL])
    // And the op ids are UNCHANGED by the stray: an uncatalogued tool expands to nothing, which is
    // precisely why its absence from the mapping has to be reported rather than inferred from a
    // shortfall in the op set.
    expect(sorted(planted.opIds), 'a stray tool contributes no op id').toEqual(
      sorted(catalogued!.ops),
    )
  })

  it('control: the chat stray-alias branch fires on an alias target the registry does not declare', () => {
    const realTarget = { alias: 'status', functionId: censusIds[0]! }

    const clean = chatEnumerationOf([], [realTarget], censusIdSet)
    expect(clean.strayAliasTargets, 'an alias bound to a declared op must produce no stray').toEqual(
      [],
    )
    expect(sorted(clean.opIds), 'a declared alias target is counted into the reach').toEqual([
      realTarget.functionId,
    ])

    const planted = chatEnumerationOf(
      [],
      [realTarget, SYNTHETIC_STRAY_ALIAS_TARGET],
      censusIdSet,
    )
    expect(
      planted.strayAliasTargets,
      'an alias bound to something the registry does not declare must be reported by alias and id',
    ).toEqual([SYNTHETIC_STRAY_ALIAS_TARGET])
    // Counted in as well as reported, which is what lets the reverse-completeness leg above red on
    // this same defect rather than leaving one leg to carry it alone.
    expect(
      planted.opIds.has(SYNTHETIC_STRAY_ALIAS_TARGET.functionId),
      'a stray alias target is part of what the surface reaches, not merely a diagnostic',
    ).toBe(true)
  })

  // RE-SPELLED 2026-10-01 from 'pins the config-write listing delta between the
  // every-scope and the default MCP grant'. MCP visibility was a scope-union subset check, so the
  // config folds were absent from a default caller's instance. The check is deleted: the delta is
  // now EMPTY, in both directions, and the two grants list the same surface.
  it('pins an EMPTY listing delta between the every-scope and the default MCP grant', async () => {
    const everyScope = enumerationOf('mcp')
    const defaultGrant = await enumerateMcpOpIds(smuggledMcpCaller(LEGACY_DEFAULT_GRANT))
    const nothing = await enumerateMcpOpIds(smuggledMcpCaller([]))
    expect(
      defaultGrant.strays,
      'mcp under the default grant: an uncatalogued door in the listing',
    ).toEqual([])
    expect(everyScope.opIds.size, 'the every-scope enumeration found nothing').toBeGreaterThan(0)
    expect(
      sorted([...everyScope.opIds].filter((opId) => !defaultGrant.opIds.has(opId))),
      'ops a default-grant MCP caller cannot see — a per-caller listing filter survived',
    ).toEqual([])
    expect(sorted([...defaultGrant.opIds])).toEqual(sorted([...everyScope.opIds]))
    expect(sorted([...nothing.opIds]), 'a caller granted nothing lists a different surface')
      .toEqual(sorted([...everyScope.opIds]))
  })

  // ---- The census: ONE denominator, asserted in both directions ----------

  it('carries exactly one scenario row per registered capability, in both directions', () => {
    // THIS CELL IS SC-4's CI RULE. The suite is an ordinary vitest suite inside
    // `turbo run test`, so it already runs in the workspace CI job on every PR — which means "a new
    // capability landed without a parity scenario" is a structurally named RED there, by op id, in
    // the existing job. There is deliberately no second mechanism: a diff-parsing check would be a
    // rule about what a patch looks like rather than about what the product contains, and the two
    // would disagree the first time a capability arrived by any route the parser did not model.
    //
    // BOTH DIRECTIONS, because a census that only checks one is the register that never notices it
    // has stopped growing. `censusDiff`'s ability to fire on each side is proven by the
    // control cell below rather than assumed from this cell's green.
    const diff = censusDiff(registryOpIds(), scenarioTableOpIds())
    expect(
      diff.missing,
      'capabilities the registry declares that no scenario row carries — add a row to the scenario '
        + 'table (this is SC-4: a capability without a scenario is not shippable)',
    ).toEqual([])
    expect(
      diff.stray,
      'scenario rows naming a capability the registry no longer declares — delete the row',
    ).toEqual([])
    // …and the census is not empty, which every line above would pass on.
    expect(scenarioTableOpIds().length, 'the scenario table is empty').toBeGreaterThan(0)
  })

  it('control: the census self-check fires on a missing row AND on a stray row', () => {
    // The Edge-Coverage-Register lesson, made mechanical. Each side is driven with synthetic input
    // so the branch is exercised without mutating a shipped file and without a skip, and a CLEAN
    // input is fed in the same cell — a self-check that fires on everything certifies as little as
    // one that fires on nothing.
    const census = registryOpIds()

    expect(censusDiff(census, census), 'identical id sets must diff to nothing').toEqual({
      missing: [],
      stray: [],
    })

    const withARowMissing = census.filter((id) => id !== census[0])
    expect(
      censusDiff([...census, SYNTHETIC_UNCARRIED_OP_ID], census).missing,
      'a registered capability carried by no row must be named on the missing side',
    ).toEqual([SYNTHETIC_UNCARRIED_OP_ID])
    expect(
      censusDiff(census, withARowMissing).missing,
      'a row deleted from the table must be named on the missing side',
    ).toEqual([census[0]])

    expect(
      censusDiff(census, [...census, SYNTHETIC_STRAY_ROW_OP_ID]).stray,
      'a row naming a capability the registry does not declare must be named on the stray side',
    ).toEqual([SYNTHETIC_STRAY_ROW_OP_ID])
  })

  // ---- The taxonomy census: ONE canonical domain list, both directions ----------

  it('names every capability over the ONE canonical domain list, in both directions', () => {
    // THE MANDATORY DIRECTION IS ids → list. A capability whose domain is absent from
    // `domain-list.ts` is a named RED here, by op id and by domain — which is what makes the pinned
    // list a thing the product is checked against rather than a comment nobody reads. This is the
    // duty the retired 384 stub's `ALLOWED_ID_DOMAINS` sweep carried, re-derived off the census.
    //
    // THE REVERSE DIRECTION IS ASSERTED TOO, because a taxonomy is exactly the kind of table that
    // quietly accumulates members nothing uses. A member matching no op must carry a dated
    // `reserved` sentence saying who holds the name and against what; a member carrying one while
    // ops exist is a reservation somebody forgot to retire. Both are named, neither is counted.
    const census = domainCensus(registryOpIds())

    expect(
      census.uncatalogued,
      'capabilities whose id domain is on no row of domain-list.ts — add the domain there with a '
        + 'one-line charter (D-18: ids are the locked contract, the taxonomy serves them, and a '
        + 'widening is a reviewed one-line diff rather than a silent Set.add)',
    ).toEqual([])
    expect(
      census.memberless,
      'domains pinned in domain-list.ts that no shipped capability uses and that carry no dated '
        + 'reserved marker — either an op was deleted, or the row is decoration',
    ).toEqual([])
    expect(
      census.staleReservations,
      'domains carrying a dated `reserved` marker that shipped capabilities now use — the marker '
        + 'says the name is merely held, and it is not',
    ).toEqual([])

    // …and neither side was empty, which every assertion above would pass on.
    expect(CANONICAL_ID_DOMAINS.length, 'the canonical domain list read back empty')
      .toBeGreaterThan(0)
    expect(new Set(registryOpIds().map(domainOf)).size, 'the census produced no domains at all')
      .toBeGreaterThan(0)

    // The list is a SET of domains, not a bag: two rows for one domain is how the retired stub's
    // literal came to hold fifteen entries for fourteen distinct domains (see the fold note).
    const domains = CANONICAL_ID_DOMAINS.map((entry) => entry.domain)
    expect(sorted(new Set(domains)), 'domain-list.ts repeats a domain').toEqual(domains)

    // Every row states what it owns, so "add a domain" is a claim a reviewer can refuse.
    for (const entry of CANONICAL_ID_DOMAINS) {
      expect(entry.charter.trim(), `${entry.domain}: the row states no charter`).not.toBe('')
      expect(entry.domain, `${entry.domain}: a domain is one lowercase id segment`)
        .toMatch(/^[a-z]+$/)
    }
  })

  it('spells every capability id in the grammar both surfaces can carry', () => {
    // Carried across from the retired 384 stub, and it is not cosmetic: `chat/tool-names.ts` maps
    // `.` ↔ `_` as a bijection and refuses an id carrying the separator it maps onto, so an id with
    // an underscore is an id the chat surface cannot reach. `authoring.draft.verify` is spelled
    // that way — rather than `authoring.verify_draft` — for exactly this reason.
    const ids = registryOpIds()
    expect(ids.length, 'the census read back empty').toBeGreaterThan(0)
    for (const opId of ids) {
      expect(opId, `${opId}: not a lowercase dot-namespaced id`).toMatch(OP_ID_GRAMMAR)
    }
    // The grammar is not vacuous: the two spellings it exists to refuse are refused.
    expect('authoring.verify_draft', 'the grammar stopped refusing an underscore')
      .not.toMatch(OP_ID_GRAMMAR)
    expect('Runs.Get', 'the grammar stopped refusing an uppercase segment').not.toMatch(OP_ID_GRAMMAR)
  })

  it('control: the domain census fires on an uncatalogued domain, a memberless row and a stale reservation', () => {
    // Driven over the PURE core with synthetic taxonomies, so every branch is exercised without
    // mutating a shipped table and without a skip — and a CLEAN input is fed in the same cell,
    // because a self-check that fires on everything certifies as little as one that fires on
    // nothing (the 394 Edge-Coverage-Register lesson, made mechanical).
    const live = registryOpIds()

    expect(domainCensus(live), 'the shipped taxonomy must diff to nothing against the live ids')
      .toEqual({ uncatalogued: [], memberless: [], staleReservations: [] })

    // (a) an id whose domain is on no row.
    expect(
      domainCensus([...live, SYNTHETIC_UNCATALOGUED_DOMAIN_OP_ID]).uncatalogued,
      'an op carrying a domain the list does not pin must be named on the uncatalogued side',
    ).toEqual([SYNTHETIC_UNCATALOGUED_DOMAIN_OP_ID])

    // (b) a row no id matches, carrying no reserved marker.
    const withAMemberlessRow: readonly CanonicalDomain[] = [
      ...CANONICAL_ID_DOMAINS,
      { domain: SYNTHETIC_MEMBERLESS_DOMAIN, charter: 'control 397-08: a row nothing uses' },
    ]
    expect(
      domainCensus(live, withAMemberlessRow).memberless,
      'a pinned domain no capability uses, with no reserved marker, must be named',
    ).toEqual([SYNTHETIC_MEMBERLESS_DOMAIN])
    // …and the SAME row goes quiet once it carries a marker, which is the marker's whole job.
    expect(
      domainCensus(live, [
        ...CANONICAL_ID_DOMAINS,
        {
          domain: SYNTHETIC_MEMBERLESS_DOMAIN,
          charter: 'control 397-08: a row nothing uses',
          reserved: 'control 397-08: held deliberately',
        },
      ]).memberless,
      'a dated reserved marker must silence the memberless side for that row and no other',
    ).toEqual([])

    // (c) a reservation the ids have overtaken.
    expect(
      domainCensus([...live, `${SYNTHETIC_RESERVED_DOMAIN}.probe`], [
        ...CANONICAL_ID_DOMAINS,
        {
          domain: SYNTHETIC_RESERVED_DOMAIN,
          charter: 'control 397-08: a held name',
          reserved: 'control 397-08: held, but an op arrived',
        },
      ]).staleReservations,
      'a reserved row that shipped ids now use must be named on the stale side',
    ).toEqual([SYNTHETIC_RESERVED_DOMAIN])

    // …and dropping a real domain from the taxonomy reds the mandatory side, which is the case a
    // list-shaped guard is most likely to be silently wrong about.
    const withRunsDropped = CANONICAL_ID_DOMAINS.filter((entry) => entry.domain !== 'runs')
    expect(
      domainCensus(live, withRunsDropped).uncatalogued.map(domainOf),
      'deleting a live domain from the list must name every op that used it',
    ).toEqual(live.filter((opId) => domainOf(opId) === 'runs').map(() => 'runs'))
  })

  // ---- The rows are typed against the ops' OWN contracts, and it is checkable -----------

  it('types every scenario input against the contract the registry itself published for that op', () => {
    // The compile-time guarantee D-09 chose TypeScript for is only worth what the PAIRING is worth:
    // a row typed against the wrong op's schema would compile happily and certify nothing. So the
    // pairing is asserted two ways, and neither is a re-derivation of a contract.
    //
    // (a) OBJECT IDENTITY, wherever a published handle exists. `AGENT_QA_OP_CONTRACTS` names the
    //     live schemas for the 22 projected ops; `toBe` is the strongest available statement that
    //     the table holds the same object rather than a lookalike.
    // (b) For all 41, the PROJECTION relation: the schema the table paired, projected the way the
    //     registry projects it, must equal the projection the registry itself published on the
    //     declaration. That reaches the 19 ops no surface publishes a handle for.
    const declarations = registryDeclarations()
    let identityChecked = 0

    for (const declaration of declarations) {
      const paired = OP_INPUT_CONTRACTS[declaration.id as ScenarioOpId]
      expect(paired, `${declaration.id}: the scenario table pairs no input contract`).toBeDefined()

      const published = AGENT_QA_OP_CONTRACTS[declaration.id]
      if (published !== undefined) {
        expect(
          paired as unknown,
          `${declaration.id}: the table's contract must BE the object the MCP mapping projects, `
            + 'not an equal-looking copy',
        ).toBe(published.input as unknown)
        identityChecked += 1
      }

      expect(
        z.toJSONSchema(paired, { io: 'input' }),
        `${declaration.id}: the paired contract projects to a different document than the one the `
          + 'registry published on this declaration — the table is typed against another op',
      ).toEqual(declaration.input)
    }

    // …and the identity half actually ran over the projected partition rather than zero ops.
    expect(
      identityChecked,
      'no op contract was checked by identity, which the projected partition makes impossible',
    ).toBe(Object.keys(AGENT_QA_OP_CONTRACTS).length)
  })

  it('holds an invocation fixture every op would accept — every scenario sample still valid', () => {
    // D-10's fold made the scenario row the invocation sample, so the sample's original obligation
    // travels with it: `invokeFunction` validates input BEFORE it consults binding, and a fixture
    // that stopped parsing would make 397-04's refusal legs report an input error while looking
    // like they had measured a policy verdict.
    for (const row of SCENARIO_TABLE) {
      const parsed = OP_INPUT_CONTRACTS[row.opId].safeParse(row.input)
      expect(
        parsed.success ? '' : JSON.stringify(parsed.error.issues),
        `${row.opId}: the scenario input no longer satisfies this op's own input contract`,
      ).toBe('')
    }
  })

  it('refuses by NAME every capability this composition cannot run — covered, not missing', async () => {
    // PITFALL 11, re-derived here from the retired 384 stub. `unbound` is
    // COVERED-BUT-UNBOUND, not missing: a declared-but-unbound capability has a contract, a listing
    // row, a gate verdict and an audit trail, and reading it as a hole in the API is the silent gap
    // `bindingStatus` exists to prevent. The claim it carries is that the refusal is ATTRIBUTABLE —
    // the error names the op, so a caller can tell "this host cannot run that" from "that does not
    // exist" and from "you were not granted it".
    //
    // WHY IT LANDS HERE RATHER THAN STAYING IN `packages/agent`. It needs an input per op — and the
    // scenario table is the ONE place those live now. Restating them agent-side would have rebuilt
    // the second denominator this plan just retired.
    //
    // the covering caller holds no grant at all, and no scope or origin check stands
    // before the binding check, so nothing here can be refused on an axis that precedes it and be
    // mistaken for a binding refusal (the 387-08 measurement).
    // the retired, unread `resolveExecutionContext` registry option is dropped.
    const registry = conformanceRegistry()
    const unbound = registry
      .list(CONFORMANCE_CENSUS_CALLER)
      .filter((declaration) => declaration.bindingStatus === 'unbound')

    // Not an assertion that the count stays where it is — that the state EXISTS and is refused
    // distinctly. A composition binding everything would pass the loop below on zero iterations.
    expect(unbound.length, 'no capability reads unbound here, so this cell measured nothing')
      .toBeGreaterThan(0)

    for (const declaration of unbound) {
      const row = scenarioRowFor(declaration.id)
      expect(row, `${declaration.id}: no scenario row, so no input to reach the binding check with`)
        .toBeDefined()

      let thrown: unknown
      try {
        await invokeFunction(
          registry,
          declaration.id,
          (row as { input: unknown }).input,
          coveringCallerFor(declaration),
        )
      } catch (error) {
        thrown = error
      }

      // ASSERTED ON THE SHAPE OF THE ANSWER, never on "it threw": 397-04 measured a cell passing
      // because a `TypeError` was read as a dispatch. Both fields are checked, because the name
      // alone would not say WHICH capability the host refused.
      const error = thrown as { name?: string; functionId?: string } | undefined
      expect(
        { name: error?.name, functionId: error?.functionId },
        `${declaration.id}: an unbound capability must refuse by name at the binding check — a `
          + 'refusal on any other axis certifies nothing about binding',
      ).toEqual({ name: 'FunctionNotBoundError', functionId: declaration.id })
    }
  })

  // ---- D-12: per-surface row data, joined to the shipped tables in BOTH directions -------------

  it('joins every row MCP expectation to the declared mapping, in both directions', () => {
    const toolByOpId = new Map<string, string>()
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      for (const opId of projection.ops) toolByOpId.set(opId, projection.name)
    }
    const unprojectedByOpId = new Map(UNPROJECTED_OPS.map((entry) => [entry.opId, entry]))

    // Direction 1 — every row's claim must be true of the mapping.
    for (const row of SCENARIO_TABLE) {
      const mcp = row.perSurface.mcp
      if ('unprojected' in mcp) {
        expect(
          toolByOpId.get(row.opId),
          `${row.opId} on mcp: the row claims unprojected, but the mapping projects it through a tool`,
        ).toBeUndefined()
        const shipped = unprojectedByOpId.get(row.opId)
        expect(
          shipped?.reason,
          `${row.opId} on mcp: the row claims unprojected, but the mapping carries no reason for it`,
        ).toBeDefined()
        expect(
          unprojectedReasonKeyOf(shipped!.reason),
          `${row.opId} on mcp: the row cites the ${mcp.unprojected} class, and the mapping's own `
            + 'reason is no longer written in it — scoping drift',
        ).toBe(mcp.unprojected)
      } else {
        expect(
          unprojectedByOpId.has(row.opId),
          `${row.opId} on mcp: the row claims a tool, but the mapping declares it unprojected`,
        ).toBe(false)
        expect(
          toolByOpId.get(row.opId),
          `${row.opId} on mcp: the row names a tool the mapping does not project it through`,
        ).toBe(mcp.reachable.tool)
      }
    }

    // Direction 2 — every mapping row must be true of the table. A row silently deleted, or one
    // whose partition moved without its row following, is named here rather than in a shortfall.
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      for (const opId of projection.ops) {
        expect(
          scenarioRowFor(opId)?.perSurface.mcp,
          `${opId} on mcp: projected by ${projection.name}, and its scenario row does not say so`,
        ).toEqual({ reachable: { tool: projection.name } })
      }
    }
    for (const entry of UNPROJECTED_OPS) {
      const mcp = scenarioRowFor(entry.opId)?.perSurface.mcp
      expect(
        mcp !== undefined && 'unprojected' in mcp,
        `${entry.opId} on mcp: declared unprojected by the mapping, and its scenario row claims reach`,
      ).toBe(true)
    }
  })

  it('classifies every shipped unprojected reason into exactly one declared class', () => {
    // The register's own self-check on the reason vocabulary. An unprojected op written with prose
    // outside the declared classes must RED rather than be filed under whichever class happened to
    // match last — "we scoped this out" and "this can never work here" are the two answers a reader
    // needs to be able to tell apart, and the second is the one D-03 wrote for `agent.ask`.
    const unclassifiable = UNPROJECTED_OPS.filter(
      (entry) => unprojectedReasonKeyOf(entry.reason) === undefined,
    ).map((entry) => entry.opId)
    expect(
      unclassifiable,
      'unprojected ops whose reason falls into no declared class — extend the vocabulary in '
        + 'scenario-table.ts, or write the reason in an existing class',
    ).toEqual([])
    expect(UNPROJECTED_OPS.length, 'the mapping declares no unprojected op at all').toBeGreaterThan(
      0,
    )
  })

  it('carries the dated mint ruling in the shipped credential-mint reason', () => {
    // WHY THIS CELL EXISTS. `credential-mint-deferral` was admitted in 403 for one reason: the op
    // hands out a credential and WHO MAY MINT ONE OVER MCP was left to Phase 408. 408 D-01 answered
    // it — internal mint only, the token confined to host-rendered App HTML, a projected mint tool
    // rejected — and D-14 requires that answer RECORDED rather than silently absorbed. The record
    // lives in the shipped `UNPROJECTED_OPS` prose, which is the artifact a reader actually meets,
    // so this cell reads it there. A future rewrite that tidies the entry back into a bare
    // deferral, or drops the date, reds HERE by name instead of leaving a permanent absence
    // wearing an open question's clothes.
    // CORRECTED 2026-09-01 (408-08, the gap round, road `demote`; the ruling is in
    // `app-resource.ts`'s header and `mapping.ts`'s reason carries the same dated addendum). The
    // rationale above summarises D-01 as "the token confined to host-rendered App HTML", and that
    // half is WITHDRAWN rather than reworded away: whether the document this server serves is
    // host-rendered HTML or text a model consumes is a property of the CALLER, not of this server.
    // What holds is that the server writes the token into exactly one place — the frame src of the
    // document the `ui://` read serves — bounded by the operator-granted `read` scope plus a bound
    // mint. This is the most load-bearing of the four sites the 408-15 census found, because THIS
    // cell is the one that gates the shipped ruling prose: a gate whose own stated reason asserts a
    // withdrawn claim teaches every reader of it the thing the gate exists to stop. The assertions
    // below are untouched by the correction — the ruling they read is dated 2026-08-31 and is what
    // 408 actually decided; only this rationale's gloss on its channel was ever wrong.
    const entry = UNPROJECTED_OPS.find((candidate) => candidate.opId === 'runs.liveurl')
    expect(entry, 'runs.liveurl left the unprojected register — re-home this ruling before it does')
      .toBeDefined()
    // The class must still DERIVE from the prose: the ruling is an addendum to the 403 reason, not
    // a replacement of it, so the signature phrase the classifier keys on has to survive the edit.
    expect(
      unprojectedReasonKeyOf(entry!.reason),
      'the 408 ruling must EXTEND the credential reason, not overwrite the phrase its class derives '
        + 'from — a resolution that changes the class silently re-files a security decision',
    ).toBe('credential-mint-deferral')
    expect(entry!.reason, 'the credential fact the class is named for').toContain('MINTS A CREDENTIAL')
    // …and the ruling itself, dated, with its operative words.
    expect(entry!.reason, 'the dated 408 ruling marker (D-14: answered, never silently reclassified)')
      .toContain('408 D-01')
    expect(entry!.reason, 'the ruling is dated at its own artifact').toContain('2026-08-31')
    expect(entry!.reason, 'what 408 actually ruled').toContain('INTERNAL MINT ONLY')
    // The adjudicator column moves with the ruling: 403 deferred, 408 decided.
    expect(
      entry!.adjudication,
      'the provenance column still credits 403 with a ruling it explicitly declined to make',
    ).toBe('408')
    // And the row is unchanged in the one way that matters: the op is STILL unprojected. D-01
    // answered the question with a NO, so a resolution that quietly produced a tool would be the
    // opposite outcome wearing the same paperwork.
    expect(
      scenarioRowFor('runs.liveurl')?.perSurface.mcp,
      'the ruling keeps runs.liveurl unprojected — a mint tool is rejected, not deferred',
    ).toEqual({ unprojected: 'credential-mint-deferral' })
  })

  it('EDITOR-LIVEURL-UNPROJECTED-RULING: editor.liveurl stays unprojected by its ruling', () => {
    // an editor session's view credential is private to the dashboard page that owns it, and
    // the owner declined an MCP watch carrier for a draft execution. This cell pins the ruling on
    // the conformance layer, so a mint tool for an editor session reds here by name.
    const entry = UNPROJECTED_OPS.find((candidate) => candidate.opId === 'editor.liveurl')
    expect(entry, 'editor.liveurl left the unprojected register — re-home this ruling before it does')
      .toBeDefined()
    expect(
      unprojectedReasonKeyOf(entry!.reason),
      'the 428 ruling files the editor mint under the credential class, as runs.liveurl is filed',
    ).toBe('credential-mint-deferral')
    expect(entry!.reason, 'the credential fact the class is named for').toContain('MINTS A CREDENTIAL')
    expect(entry!.reason, 'the dated 428 ruling marker').toContain('2026-09-25')
    expect(entry!.adjudication, 'the provenance column credits the phase that ruled').toBe('428')
    expect(
      scenarioRowFor('editor.liveurl')?.perSurface.mcp,
      'the ruling keeps editor.liveurl unprojected — an editor watch tool is declined, not deferred',
    ).toEqual({ unprojected: 'credential-mint-deferral' })
  })

  it('control: the reason classifier answers per class, and refuses prose it does not know', () => {
    for (const [key, signature] of UNPROJECTED_REASON_SIGNATURES) {
      expect(
        unprojectedReasonKeyOf(`a reason mentioning ${signature} and nothing else`),
        `${key}: its own signature must classify as it`,
      ).toBe(key)
    }
    expect(
      unprojectedReasonKeyOf(SYNTHETIC_UNCLASSIFIABLE_REASON),
      'prose in no declared class must classify as nothing rather than as the last class tried',
    ).toBeUndefined()
    // …and precedence is a DECISION rather than an accident of iteration order: a reason carrying
    // two signatures answers with the stronger one. RE-SPELLED 2026-10-01: the shipped case
    // was `grants.revoke` (requiresHumanOrigin over a mid-flight line), deleted with the grant ledger
    // and its class with it; the rule is measured on the surviving overlap.
    expect(
      unprojectedReasonKeyOf('answers machine discovery. Not a mid-flight workflow read.'),
      'a reason in two classes must answer with the higher-precedence one',
    ).toBe('discovery-answered-by-protocol')
    expect(
      UNPROJECTED_REASON_SIGNATURES.map(([key]) => key),
      'the human-origin class left the vocabulary with its last member (432-18)',
    ).not.toContain('requires-human-origin')
  })

  it('joins every row chat expectation to the live chat enumeration, in both directions', () => {
    const chatReach = enumerationOf('chat').opIds
    for (const row of SCENARIO_TABLE) {
      expect(
        chatReach.has(row.opId),
        `${row.opId} on chat: the row claims reachable=${String(row.perSurface.chat.reachable)}, `
          + 'and the live composition disagrees',
      ).toBe(row.perSurface.chat.reachable)
    }
    for (const opId of sorted(chatReach)) {
      expect(
        scenarioRowFor(opId)?.perSurface.chat.reachable,
        `${opId} on chat: reachable in the live composition and claimed by no row`,
      ).toBe(true)
    }
  })

  it('joins every row fn expectation to the live fn listing, in both directions', () => {
    // 2026-08-20, the chat cell above with the third door substituted. The comparand
    // is the door's OWN `--list --json` stdout, folded through commander and the CLI composition
    // root — not this file's reading of a registry — so a `fn` listing that started filtering (a
    // narrowed CLI grant, a safe-mode default, a projection that dropped a column) reds here by
    // name rather than being absorbed by a comparison of the census against itself.
    const fnReach = enumerationOf('fn').opIds
    for (const row of SCENARIO_TABLE) {
      expect(
        fnReach.has(row.opId),
        `${row.opId} on fn: the row claims reachable=${String(row.perSurface.fn.reachable)}, `
          + 'and the shipped `agent-qa fn --list` disagrees',
      ).toBe(row.perSurface.fn.reachable)
    }
    for (const opId of sorted(fnReach)) {
      expect(
        scenarioRowFor(opId)?.perSurface.fn.reachable,
        `${opId} on fn: listed by the shipped command and claimed by no row`,
      ).toBe(true)
    }
  })

  // ---- D-12: the ASSERTED absences. No skip-list — a skip asserts nothing --------------------

  it('asserts the absence of every unprojected op over MCP: no fold, and no door of its own', async () => {
    const listed = await listMcpToolNames()
    const projectedOpIds = new Set(AGENT_QA_TOOL_PROJECTIONS.flatMap((p) => [...p.ops]))
    const unprojectedRows = SCENARIO_TABLE.filter((row) => 'unprojected' in row.perSurface.mcp)

    // The loop's own non-vacuity: it must range the whole declared unprojected partition, so a
    // table that quietly stopped claiming absences cannot make this cell pass by iterating nothing.
    expect(
      unprojectedRows.map((row) => row.opId).sort(),
      'the rows claiming unprojected must be exactly the mapping unprojected partition',
    ).toEqual(UNPROJECTED_OPS.map((entry) => entry.opId).sort())

    await withMcpClient(async (client) => {
      for (const row of unprojectedRows) {
        const mcp = row.perSurface.mcp as { readonly unprojected: string }
        const label = `${row.opId} on mcp (${mcp.unprojected})`

        // Wall 1: nothing the surface lists folds to it.
        expect(
          projectedOpIds.has(row.opId),
          `${label}: declared unprojected and reachable through a listed tool`,
        ).toBe(false)

        // Wall 2: the door does not exist under the spelling a caller would reach for. Read off the
        // REAL client/handler round trip rather than inferred from the mapping — the mapping is one
        // of the two artifacts this cell is comparing, so believing it about itself would be the
        // comparison of a table against itself the whole suite refuses.
        const spelling = plausibleMcpToolSpelling(row.opId)
        expect(
          listed,
          `${label}: the probe spelling collides with a live tool, so this cell would be calling a `
            + 'capability rather than probing an absence',
        ).not.toContain(spelling)
        await expect(
          client.callTool({ name: spelling, arguments: {} }),
          `${label}: a direct tools/call must answer unknown-tool`,
        ).rejects.toThrow(`Tool ${spelling} not found`)
      }
    })
  })

  it('control: the unknown-tool probe tells an absent door from a present one', async () => {
    // An asserted absence is worth exactly what the probe's ability to see a PRESENCE is worth. The
    // same call shape is sent to a name that exists and to one that does not, and the two answers
    // are different in kind: a registered tool answers in-band (an input-validation result), an
    // unregistered one is refused by the protocol before any tool is reached.
    const listed = await listMcpToolNames()
    const present = listed[0]
    expect(present, 'the live server listed no tool at all').toBeDefined()

    await withMcpClient(async (client) => {
      const absent = plausibleMcpToolSpelling(SYNTHETIC_ABSENT_OP_ID)
      expect(listed, 'the synthetic absent name must not be a live tool').not.toContain(absent)
      await expect(
        client.callTool({ name: absent, arguments: {} }),
        'a name no tool carries must be refused as unknown',
      ).rejects.toThrow(`Tool ${absent} not found`)

      const answered = await client.callTool({
        name: present!,
        arguments: { agent_qa_control_397_03: true },
      })
      expect(
        JSON.stringify(answered),
        `${present}: a REGISTERED tool must not answer the unknown-tool refusal, or the probe `
          + 'above would fire on every tool in the catalogue',
      ).not.toContain('not found')
    })
  })

  it('derives its policy fixtures from the declarations, and never from the ambient environment', () => {
    // Pitfall 3, as a source assertion rather than a hope. The shipped resolver answers `ci`
    // wherever CI markers are set — so a fixture that read the ambient context would compute one
    // answer on a laptop and a different one on the PR that is supposed to be checking it. Comments are stripped BEFORE the
    // sweep, because the file's own header names these very identifiers to explain why it avoids
    // them, and a grep that counted prose would make the header unwritable.
    const source = readFileSync(new URL('./policy-fixtures.ts', import.meta.url), 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')

    for (const forbidden of ['getActiveExecutionContext', 'process.env', 'isTTY', 'isatty']) {
      expect(code, `policy-fixtures.ts reads the ambient environment through ${forbidden}`).not
        .toContain(forbidden)
    }
    // …and the sweep is over the real file rather than an empty string.
    expect(code, 'the policy fixtures source read back empty').toContain('CONFORMANCE_EXECUTION_CONTEXT')
    // The covering and refusing callers are DERIVED: no scope literal appears in the file at all.
    for (const scope of RETIRED_SCOPE_NAMES) {
      expect(code, `policy-fixtures.ts spells the ${scope} scope instead of reading it off the `
        + 'declaration').not.toContain(`'${scope}'`)
    }
  })

  // RE-SPELLED 2026-10-01 from 'derives a covering and a refusing caller for every
  // capability, from its own declaration'. The covering caller holds no grant and the refusing one is
  // retired with the grants it withheld.
  it('derives one grantless covering caller for every capability, and no refusing caller', () => {
    for (const declaration of registryDeclarations()) {
      const covering = coveringCallerFor(declaration)
      expect(Object.keys(covering), `${declaration.id}: the covering caller holds a grant`)
        .not.toContain('grantedScopes')
      expect(Object.keys(declaration), `${declaration.id}: a declaration carries scopes again`)
        .not.toContain('requiredScopes')
    }
    expect(Object.keys(policyFixtures)).not.toContain('refusingCallerFor')
  })

  // ---- Plan 04: the surface drivers (FUNC-05 legs 3 and 4) --------------------------------------

  it('drives a capability through the chat surface\'s own composed dispatch, model-free', async () => {
    // The plan-04 tracer. `quarantine.list` is the safe subject: read-only, bound in this host, and
    // its declared input is the empty object, so nothing about the drive depends on a store having
    // anything in it. (2026-10-01, 432-17: `proposals.list`, the subject until now, is deleted with
    // the inbox; `quarantine.list` has the same three properties.)
    //
    // WHAT PRODUCES THIS ANSWER is the shipped REPL: a typed clause, split by the shipped splitter,
    // routed by the shipped resolver's `/fn` branch, minted a caller by the composition, and
    // dispatched through the composed `ChatInvokeBinding`. The receipt read back is the record the
    // printed line renders.
    const row = scenarioRowFor('quarantine.list')
    expect(row, 'the scenario table no longer carries quarantine.list').toBeDefined()

    const outcome = await driveChatDispatch({ opId: 'quarantine.list', input: row!.input })

    expect(
      outcome.unhandled,
      'the generic /fn route failed to resolve the clause the driver typed — the surface never '
        + 'reached a dispatch, so nothing below is a statement about a verdict',
    ).toEqual([])
    expect(outcome.receipt?.status, 'quarantine.list on chat: the surface reached a definitive '
      + 'outcome').toBe('executed')
    // ORIGIN IS THE MODEL-FREE PROOF, and it is a fact the surface recorded rather than a promise
    // this file makes: the deterministic route mints `human` and the planner route mints `agent`
    // so a receipt stamped `human` cannot have been planned by a model.
    expect(outcome.receipt?.origin, 'quarantine.list on chat: the receipt must come from the '
      + 'deterministic route, or a model planned this call').toBe('human')
    // THIS CALL WAS DISPATCHED — a differential, not a presence check.
    //
    // RE-SPELLED 2026-09-30. This read the gate's `fn:quarantine.list` rows against a
    // `config.get` baseline, because the banner's opening reads write rows of their own (397-09's
    // measured vacuity). No gate writes a row since 432-13, so the differential moves to the
    // clause's own RESULT record: the opening reads are not clauses and file none, so a drive of
    // `config.get` files no `quarantine.list` result and this drive files exactly one.
    const baselineRow = scenarioRowFor('config.get')
    expect(baselineRow, 'the scenario table no longer carries config.get').toBeDefined()
    const baselineDrive = await driveChatDispatch({
      opId: 'config.get',
      input: baselineRow!.input,
    })
    const resultsFrom = (drive: typeof outcome): number =>
      drive.results.filter((result) => result.functionId === 'quarantine.list').length
    expect(resultsFrom(baselineDrive), 'a config.get drive filed a quarantine.list result').toBe(0)
    expect(
      resultsFrom(outcome),
      'quarantine.list on chat: the clause filed no result of its own, so it did not dispatch',
    ).toBe(1)
    // …and no approval row was written for it.
    expect(outcome.auditRows.filter((auditRow) => auditRow.action === pinClassFor('quarantine.list')))
      .toEqual([])
  })

  it('drives the chat surface with no provider credential in the environment at all', async () => {
    // ZERO PROVIDER SPEND, asserted as behaviour rather than argued. Every environment variable
    // whose name could carry a model credential is removed for the duration of the drive; the
    // deterministic route still routes, because `chatCapabilities` resolves to the shipped HEADLESS
    // posture and the resolver table never touches a model.
    const removed: [string, string][] = []
    for (const [name, value] of Object.entries(process.env)) {
      if (/(_API_KEY|_TOKEN|_SECRET|_KEY)$/u.test(name) && value !== undefined) {
        removed.push([name, value])
        delete process.env[name]
      }
    }
    try {
      const outcome = await driveChatDispatch({ opId: 'quarantine.list', input: {} })
      expect(
        outcome.receipt?.status,
        `quarantine.list on chat: the drive needed one of the ${removed.length} credential-shaped `
          + 'environment variables it was denied',
      ).toBe('executed')
    } finally {
      for (const [name, value] of removed) process.env[name] = value
    }
  })

  it('drives a tool through the MCP surface\'s real protocol door', async () => {
    // The MCP half of the tracer, over the same `withMcpClient` wiring every enumeration leg reads
    // through — so an enumeration and a call in this suite cannot be talking to two servers.
    // `agent_qa_list_proposals` left with the proposal round; the bundle read is the empty-
    // argument read tool that stands in.
    const answered = await driveMcpCall({
      toolName: 'agent_qa_list_knowledge_bundles',
      args: {},
    })
    expect(
      answered.answered,
      'agent_qa_list_knowledge_bundles on mcp: the protocol refused a tool the mapping projects',
    ).toBe(true)
    // The discriminating half: the SAME call shape against a name no server registers is refused
    // by the protocol rather than answered in band, which is what makes an absence probe a probe.
    const absent = await driveMcpCall({
      toolName: plausibleMcpToolSpelling(SYNTHETIC_DRIVER_ABSENT_OP_ID),
      args: {},
    })
    expect(
      absent.answered,
      'the MCP driver answered in band for a tool that does not exist — it cannot tell an absent '
        + 'door from a present one that declined',
    ).toBe(false)
  })

  // ---- LEG 3: policy identity ---------------------------------------------------

  it('answers identically for two callers that differ only in which surface minted them', async () => {
    // FUNC-03's claim, measured. `invoke.ts` reads the caller record in exactly three places and
    // `surface` is in none of them — it is attribution. So two callers agreeing on grants, origin
    // and safe mode and disagreeing only on `surface` must reach the same place for every one of
    // the 41 capabilities, and `if (caller.surface === 'chat')` anywhere under the gate reds here.
    //
    // WHAT PRODUCES EACH SIDE: the left caller is `CHAT_RESOLVER_CALLER` — the frozen record
    // `composeLocalAgent` spreads at its own per-stage mint — regranted to this op's declared
    // scopes; the right is `MCP_FUNCTION_CALLER`, the record `commands/mcp.ts` composes its server
    // with. Two producers in two packages, two `invokeFunction` calls, one comparison. A
    // helper that shaped both sides would be comparing a value to itself.
    const divergent: string[] = []
    for (const declaration of registryDeclarations()) {
      const row = scenarioRowFor(declaration.id as ScenarioOpId)
      const callers = surfaceInertCallers()
      const onChat = await gateAnswerFor(declaration.id, row!.input, callers.chat)
      const onMcp = await gateAnswerFor(declaration.id, row!.input, callers.mcp)

      if (onChat.kind !== onMcp.kind) divergent.push(`${declaration.id}: ${onChat.kind}/${onMcp.kind}`)
      // NON-VACUITY, in the same loop rather than in a cell somebody could delete: an identity that
      // held over two identical INPUT errors would be two callers agreeing about a fixture. Under
      // its surface's own mint every capability must reach the gate band.
      expect(
        REACHED_THE_GATE,
        `${declaration.id}: under the surface's own mint the call stopped at ${onChat.kind}, `
          + 'before any verdict was taken — the grant point measured the pre-gate band',
      ).toContain(onChat.kind)
    }
    expect(
      divergent,
      'capabilities whose verdict depends on WHICH SURFACE minted an otherwise identical caller — '
        + 'caller-as-data is broken and a surface has a private policy (FUNC-03)',
    ).toEqual([])
  }, 120_000)

  // RE-SPELLED 2026-10-01 from 'diverges between the surfaces\' own mints on exactly the
  // human-origin capabilities': the last op declaring `requiresHumanOrigin` (`grants.revoke`) is
  // deleted, so the derived divergent set is EMPTY and both directions hold over the whole census.
  it('the surfaces\' own mints diverge on no capability, because none declares requiresHumanOrigin', async () => {
    // The other half of leg 3, and the reason the cell above harmonises `origin`. The surfaces'
    // REAL mints differ on origin as well as on surface (391 D-06: a person typing an alias decided
    // that call; an MCP client did not), so their answers legitimately differ — but only where an
    // op declares it needs a human, and the divergent set is DERIVED from the declarations rather
    // than listed here. A cell that demanded blanket agreement would be asserting the product wrong;
    // one that never checked would let a surface acquire an exception nobody named.
    const divergent: string[] = []
    const declaredHumanOrigin: string[] = []
    for (const declaration of registryDeclarations()) {
      const row = scenarioRowFor(declaration.id as ScenarioOpId)
      const callers = surfaceShapedCallers()
      const onChat = await gateAnswerFor(declaration.id, row!.input, callers.chat)
      const onMcp = await gateAnswerFor(declaration.id, row!.input, callers.mcp)
      // the key itself, since declarations no longer carry it at all.
      if (Object.keys(declaration).includes('requiresHumanOrigin')) declaredHumanOrigin.push(declaration.id)
      if (onChat.kind === onMcp.kind) continue
      divergent.push(declaration.id)
      expect(
        onMcp.kind,
        `${declaration.id}: the two surfaces' own mints disagree, and not on the origin axis — `
          + 'a divergence with no declared reason is a private policy',
      ).toBe('refused-origin')
    }
    expect(
      sorted(divergent),
      'the capabilities whose answer differs between the surfaces\' own caller mints must be '
        + 'exactly the ones declaring requiresHumanOrigin',
    ).toEqual(sorted(declaredHumanOrigin))
    // …and the census is not empty, or the two directions above would hold over nothing.
    expect(registryDeclarations().length).toBeGreaterThan(0)
    expect(declaredHumanOrigin, 'an op declares requiresHumanOrigin again').toEqual([])
    expect(divergent).toEqual([])
  }, 120_000)

  // ---- LEG 4: the refuse direction, two independent walls --------------------------------

  // RE-SPELLED 2026-10-01 from 'refuses at the GATE WALL for every capability,
  // naming the one withheld grant'. The scope check is deleted: a caller holding no grant at all, on
  // either surface's mint, reaches the gate band for every capability, and no refusal names a scope.
  it('refuses at the GATE WALL for no capability, on either surface (gate wall)', async () => {
    const callers = grantlessSurfaceCallers()
    for (const declaration of registryDeclarations()) {
      const row = scenarioRowFor(declaration.id as ScenarioOpId)
      const onChat = await gateAnswerFor(declaration.id, row!.input, callers.chat)
      const onMcp = await gateAnswerFor(declaration.id, row!.input, callers.mcp)

      expect(row!.policyPoints.refuse, `${declaration.id} (gate wall): the refuse point`).toBe('allow')
      expect(REACHED_THE_GATE, `${declaration.id} on chat (gate wall): a grantless caller stopped `
        + `at ${onChat.kind}`).toContain(onChat.kind)
      expect(onMcp.kind, `${declaration.id} on mcp (gate wall): the surfaces land differently`)
        .toBe(onChat.kind)
      expect(onChat.missingScopes, `${declaration.id} on chat (gate wall)`).toEqual([])
      expect(onMcp.missingScopes, `${declaration.id} on mcp (gate wall)`).toEqual([])
    }
  }, 120_000)

  // RE-SPELLED 2026-09-30. The chat surface wall was `/pin`: a session
  // deny overlay the gate consulted, producing `FunctionDeniedError` and a `session-pin-denied` row.
  // `/pin` and the overlay's only reader are gone, and a chat caller holds every scope (the cell
  // below), so the chat surface has no per-capability refusal left to drive. What this cell pins now
  // is that absence, through the surface's own dispatch: `/pin fn:<id>` is not a directive, and the
  // capability typed after it is not refused by anything a pin could have set.
  it('refuses at the CHAT SURFACE WALL for no capability: /pin is unhandled and nothing is denied', async () => {
    const opId = 'quarantine.list'
    const row = scenarioRowFor(opId)
    const outcome = await driveChatDispatch({
      opId,
      input: row!.input,
      pinBefore: [pinClassFor(opId)],
    })
    expect(
      outcome.unhandled,
      `${opId} on chat: /pin must reach the resolver as an unknown clause, not as a directive`,
    ).toEqual([`/pin ${pinClassFor(opId)}`])
    expect(outcome.receipt?.status, `${opId} on chat: the capability after /pin did not run`)
      .toBe('executed')
    expect(outcome.receipt?.outcome).not.toBe('FunctionDeniedError')
    expect(
      outcome.auditRows.filter((auditRow) => auditRow.verdict === 'deny'),
      `${opId} on chat: a deny row was written, so something on the surface still refuses`,
    ).toEqual([])
  }, 120_000)

  // RE-SPELLED 2026-10-01 from 'refuses at the MCP SURFACE WALL for every projected
  // capability: no door under the short grant'. The visibility law is deleted, so the surface wall is
  // gone: every projected tool is listed to a caller granted nothing, and a direct call is answered
  // in band rather than refused by the protocol. 2026-10-01: the mark door's
  // credential refusal, the one in-band permission answer that was left, is deleted too.
  it('refuses at the MCP SURFACE WALL for no projected capability', async () => {
    const listedUnderEveryScope = await listMcpToolNames(smuggledMcpCaller(RETIRED_SCOPE_NAMES))
    const listedUnderNothing = await listMcpToolNames(smuggledMcpCaller([]))
    expect(sorted(listedUnderNothing), 'a caller granted nothing lists a different catalogue')
      .toEqual(sorted(listedUnderEveryScope))
    for (const row of SCENARIO_TABLE) {
      if (!('reachable' in row.perSurface.mcp)) continue
      const tool = row.perSurface.mcp.reachable.tool
      expect(
        listedUnderNothing,
        `${row.opId} on mcp (surface wall): the tool is not listed to a caller granted nothing`,
      ).toContain(tool)
      const called = await driveMcpCall({ toolName: tool, args: {}, caller: smuggledMcpCaller([]) })
      expect(
        called.answered,
        `${row.opId} on mcp (surface wall): a grantless caller's call was refused by the protocol `
          + 'rather than answered in band — the door is still hidden',
      ).toBe(true)
      // 432-21 (D-12, routed 432-20 #3): the mark door has no credential refusal, so this
      // empty-argument call is answered by the ordinary schema refusal like every other tool's —
      // in band, and never `credential-required`.
      if (called.answered) {
        expect(JSON.stringify(called.structured ?? {}), `${tool}: no credential refusal survives`)
          .not.toContain('credential-required')
      }
    }
  }, 300_000)

  it('records WHY the chat surface has no wall since /pin left', async () => {
    // THE MEASUREMENT BEHIND THE DESIGN, pinned so it cannot go stale silently. Until 432-21 both
    // chat stage callers held `CHAT_STAGE_SCOPES`, the WHOLE closed scope union. 2026-10-01 (432-21,
    // D-12): the constant is deleted and the stage callers carry no scope set at all — nothing reads
    // one — so a chat surface wall cannot be a scope refusal however it were written. It was a pin
    // until 432-13.
    for (const caller of [CHAT_PLANNER_CALLER, CHAT_RESOLVER_CALLER]) {
      expect(
        Object.keys(caller).sort(),
        'a chat stage caller carries a grant field again — a scope wall would be a state to assert',
      ).toEqual(['origin', 'surface'])
    }
    // Every capability's risk name is still `fn:<id>`: it is the declaration's published risk
    // descriptor (432-19 deleted the in-run gate hook and the audit row that compared these bytes).
    for (const declaration of registryDeclarations()) {
      expect(
        declaration.risk.name,
        `${declaration.id}: the risk name must be fn:<id>`,
      ).toBe(pinClassFor(declaration.id))
    }
  })

  it('keeps the two walls in two cells: no assertion is fed by both a surface and the gate', () => {
    // D-11's "never averaged into one assertion", as a structural claim about this file. Splitting
    // on `it(` is coarse but exact enough for what is being forbidden: a cell that produced both a
    // surface answer and a gate answer could merge them, and none does.
    const code = commentStrippedSource('parity.test.ts')
    const gateProducers = ['gateAnswerFor']
    const surfaceProducers = ['driveChatDispatch', 'driveMcpCall', 'listMcpToolNames']
    // This cell's OWN body names every producer by construction — it is the sweep — so it is
    // excluded by the one token only the sweep uses. Without that, the check would report itself.
    const bodies = code
      .split(/\bit\(/u)
      .slice(1)
      .filter((body) => !body.includes('commentStrippedSource('))
    const merged = bodies
      .filter((body) => gateProducers.some((name) => body.includes(name)))
      .filter((body) => surfaceProducers.some((name) => body.includes(name)))
    expect(
      merged.length,
      'a cell produces BOTH a gate answer and a surface answer, so the two walls D-11 requires to '
        + 'be independent can be averaged into one expect',
    ).toBe(0)
    // Non-vacuity: both kinds of cell exist to be kept apart.
    expect(bodies.filter((body) => body.includes('gateAnswerFor')).length).toBeGreaterThan(0)
    expect(bodies.filter((body) => body.includes('driveChatDispatch')).length).toBeGreaterThan(0)
    // And no scope is spelled anywhere the refuse legs could have hand-typed one: the withheld
    // grant is derived per op or it is not derived at all.
    for (const wallBody of bodies.filter((body) => body.includes('(gate wall)'))) {
      for (const scope of RETIRED_SCOPE_NAMES) {
        expect(wallBody, `the gate-wall leg spells the ${scope} scope instead of deriving it from `
          + 'the declaration').not.toContain(`'${scope}'`)
      }
    }
  })

  // ---- Direct dispatch: every capability lands at its direct step --------------------------------
  //
  // `invokeFunction` evaluates no policy, so both surfaces' callers land every capability at the
  // step its binding status names, and the execution context does not move it.

  it('dispatches every capability directly, identically on both surfaces\' callers', async () => {
    for (const declaration of registryDeclarations()) {
      const row = scenarioRowFor(declaration.id as ScenarioOpId)
      const callers = surfaceInertCallers()
      const onChat = await gateAnswerFor(declaration.id, row!.input, callers.chat)
      const onMcp = await gateAnswerFor(declaration.id, row!.input, callers.mcp)
      const direct = declaration.bindingStatus === 'unbound' ? 'allowed-unbound' : 'allowed-dispatched'
      expect(onChat.kind, `${declaration.id}: the call did not reach its direct step`).toBe(direct)
      expect(onMcp.kind, `${declaration.id}: the two surfaces' callers land at different steps`)
        .toBe(onChat.kind)
    }
  }, 120_000)

  it('lands every capability at the same step in a ci context as in an interactive one', async () => {
    // Each call runs inside its own safety scope, the seam every ambient reader of the execution
    // context resolves through, so the two contexts are really different.
    for (const declaration of registryDeclarations()) {
      const row = scenarioRowFor(declaration.id as ScenarioOpId)
      const callers = surfaceInertCallers()
      const interactive = await runSafetyScope({ executionContext: 'local-interactive' }, () =>
        gateAnswerFor(declaration.id, row!.input, callers.chat))
      const ci = await runSafetyScope({ executionContext: 'ci' }, () =>
        gateAnswerFor(declaration.id, row!.input, callers.chat))
      expect(ci.kind, `${declaration.id}: the execution context changed where the call landed`)
        .toBe(interactive.kind)
    }
  }, 120_000)

  it('observes each surface through its own dispatch, never through the gate directly', () => {
    // PITFALL 5, AS A SOURCE ASSERTION. Every behavioural cell above would pass over a driver that
    // called `invokeFunction` itself — and such a driver is blind to D-14's ungated-op mutation by
    // construction, because the thing the mutation removes is the very call the driver would be
    // making. Comments are stripped first so this file's own prose may name what the driver's body
    // must not.
    //
    // the sweep covers the FILE rather than naming a function, so it covers the
    // file's remaining drivers (chat and MCP) now that the dashboard driver is gone with its door,
    // and a driver added later inherits the rule instead of having to be remembered.
    const code = commentStrippedSource('surface-dispatch.ts')
    // Named identifiers rather than a bare word: the drivers' fixture config declares a
    // `registry.targets` block, and a token scan would have read the project's own configuration
    // vocabulary as a reach into the function registry (the rollcall's own negative control).
    for (const forbidden of [
      'invokeFunction',
      'evaluate(',
      'composeCliLocalAgent',
      'conformanceRegistry',
      'createFunctionRegistry',
      'registryDeclarations',
    ]) {
      expect(code, `surface-dispatch.ts reaches past the surface via ${forbidden}`)
        .not.toContain(forbidden)
    }
    // …and the sweep is over the real file rather than an empty string. Each driver's own shipped
    // entry point is named, so a file that had stopped driving a surface reads as an empty sweep
    // here rather than as a pass.
    expect(code, 'the surface-dispatch source read back empty').toContain('createChatCommand')
    // The CLI chat command resolves its context ambiently, so its driver sets and restores the
    // process resolver (Pitfall 3); a driver that quietly started inheriting the process's answer
    // reds here.
    expect(code, 'the chat driver must inject the execution context it decides under')
      .toContain('setActiveExecutionContextResolver')
  })

  // ---- The golden capability ledger (plan 06 — FUNC-05 leg 6, D-05/D-06/D-07/D-08) --------------
  //
  // WHAT THIS SECTION ADDS THAT NOTHING ABOVE HAS. Every leg above is a statement about the tree as
  // it stands: what is reachable, what refuses, what agrees. All of them stay green while a scope is
  // widened, a risk hint is dropped or a capability is moved out of the MCP partition, because each
  // of those leaves a self-consistent tree. The ledger is the one artifact that compares the product
  // against its own past, and the comparison is readable: one line per field per capability.

  it('matches the committed golden registry, op by op and field by field', () => {
    // A MISSING LEDGER IS A RED, NEVER A SKIP. Until the file is minted this is the only cell in the
    // directory that fails, and it fails saying exactly what to do about it.
    expect(
      existsSync(GOLDEN_PATH),
      `the committed capability ledger ${GOLDEN_FILE_NAME} does not exist — ${GOLDEN_REGEN_INSTRUCTION}`,
    ).toBe(true)

    const committedText = readFileSync(GOLDEN_PATH, 'utf8')
    const committed = JSON.parse(committedText) as GoldenFile
    const live = goldenFileOf(rootDeclarations)

    // Non-vacuity first: a comparison over zero rows passes for the wrong reason, and this cell is
    // the one most able to. The census leg above owns the registry ≡ scenario-table equality; the
    // ledger joins that same denominator rather than starting a third.
    expect(live.rows.length, 'the ledger was minted over no capabilities at all').toBe(
      censusIds.length,
    )
    expect(live.rows.length, 'the registry census read back empty').toBeGreaterThan(0)
    expect(
      sorted(live.rows.map((row) => row.id)),
      'the ledger and the registry census must range the same capabilities',
    ).toEqual(sorted(censusIds))
    expect(
      sorted(committed.rows.map((row) => row.id)),
      'the COMMITTED ledger and the scenario table must range the same capabilities, in both '
        + `directions — a capability with no ledger row is a capability nobody reviewed; ${GOLDEN_REGEN_INSTRUCTION}`,
    ).toEqual(sorted(scenarioTableOpIds()))

    const findings = goldenFindings(live.rows, committed.rows)
    const committedById = new Map(committed.rows.map((row) => [row.id, row]))

    // PER OP, STRUCTURALLY. The label names the capability and the FIELDS that moved; the diff
    // vitest prints under it is the structure itself. A bare digest inequality — "expected 9f3a… to
    // be 71bc…" — is what D-06 forbids, and it is what a comparison of two hashes can only ever say.
    for (const row of live.rows) {
      const moved = goldenFieldsThatMoved(findings, row.id)
      const label = moved.length === 0
        ? `${row.id}: the golden pins a different declaration projection`
        : `${row.id}: the golden pins a different ${moved.join(', ')} — if this change is `
          + `intended, ${GOLDEN_REGEN_INSTRUCTION}`
      expect(row, label).toEqual(committedById.get(row.id))
    }

    // The whole-set view, so a run reports every disagreement rather than the first one.
    expect(
      findings.map((finding) => finding.message),
      `the live registry and the committed ledger disagree; ${GOLDEN_REGEN_INSTRUCTION}`,
    ).toEqual([])

    expect(committed.opCount, 'the ledger\'s own count sentence disagrees with its rows')
      .toBe(committed.rows.length)
    expect(committed.$note, `the ledger's note was edited by hand; ${GOLDEN_REGEN_INSTRUCTION}`)
      .toEqual(live.$note)

    // LAST, AND ONLY AFTER EVERY NAMED COMPARISON ABOVE: the bytes. This catches a reformat, a lost
    // trailing newline or a key order the canonical serializer would not have produced — real drift
    // in the committed artifact that a structural comparison cannot see. It runs last so that a
    // genuine field change is named by the loop above rather than reported as a 40 kB text diff.
    expect(
      goldenFileText(live) === committedText,
      'the ledger\'s BYTES differ from the canonical serialization while every field agrees — the '
        + `file was reformatted or hand-edited; ${GOLDEN_REGEN_INSTRUCTION}`,
    ).toBe(true)

    // AND THE INSTRUCTION IS FOLLOWABLE. Every message above tells a reader to run one script; a
    // message naming a file that does not exist is worse than no message. Asserted here, where the
    // instruction is written, rather than in the prohibition cell below — so a missing ledger and a
    // missing regen script are one red rather than two saying the same thing.
    expect(
      existsSync(join(CONFORMANCE_DIR, '..', '..', '..', '..', '..', GOLDEN_REGEN_SCRIPT)),
      `${GOLDEN_REGEN_SCRIPT} is named by every ledger failure message but does not exist`,
    ).toBe(true)
  })

  it('mints the ledger deterministically, and offers the regen script a print rather than a write', async () => {
    // TWO INDEPENDENT COMPOSITIONS, in two different temp workspaces, compared byte for byte. That
    // is a stronger claim than calling the projection twice on one listing: it rules out a
    // workspace path, a clock or a per-composition identity reaching a digest, which is the way a
    // generated ledger becomes a file that reds on every regeneration and is therefore never
    // regenerated.
    const fresh = await withGoldenRootRegistry((registry) =>
      goldenFileText(goldenFileOf(registry.list(CONFORMANCE_CENSUS_CALLER))),
    )
    expect(fresh, 'two compositions of the one root minted two different ledgers').toBe(
      goldenFileText(goldenFileOf(rootDeclarations)),
    )

    // The committed SHAPE: pretty canonical JSON, sorted keys at every level, exactly one trailing
    // newline. Asserted as idempotence under the workspace's own serializer rather than by
    // inspecting the string, so this cell cannot disagree with the file the script writes.
    expect(committedFileText(JSON.parse(fresh)), 'the ledger text is not in canonical committed form')
      .toBe(fresh)
    expect(fresh.endsWith('\n'), 'the ledger must end in exactly one newline').toBe(true)
    expect(fresh.endsWith('\n\n'), 'the ledger must end in exactly one newline').toBe(false)

    // THE EMIT PORT. The regen script runs this suite with the flag set and lifts the text
    // out from between the sentinels; the SCRIPT then writes the file, after its own refuse-while-red
    // gate. Nothing here writes anything — see the source assertion two cells below.
    if (goldenEmitRequested()) emitGoldenText(fresh)
  })

  it('projects every declaration field into the ledger, or excludes it with a stated reason', () => {
    // THE NO-SILENT-DROP REGISTER. A projection that lists what it carries loses the next field
    // somebody adds, silently and forever: the ledger keeps its 41 identical rows and the column a
    // reviewer would have wanted never exists. Both sides are accounted, so a new declaration field
    // reds here by name instead of vanishing.
    expect(
      unaccountedGoldenFields(rootDeclarations).map(
        (field) => `${field.opId}: ${field.on}.${field.key}`,
      ),
      'declaration fields the ledger would drop without saying so — project them in golden.ts or '
        + 'add them to the excluded list WITH the reason they are not change-control surface',
    ).toEqual([])

    // The register is over a real census rather than an empty one.
    expect(rootDeclarations.length, 'the field register ranged no declarations').toBe(
      censusIds.length,
    )

    // …and it can fire. A synthetic declaration carrying a key nobody wrote, on each side.
    const sample = rootDeclarations[0]
    expect(sample, 'the census read back empty').toBeDefined()
    const withStrayDeclarationKey = {
      ...(sample as FunctionDeclaration),
      [SYNTHETIC_GOLDEN_STRAY_FIELD]: true,
    } as unknown as FunctionDeclaration
    const withStrayRiskKey = {
      ...(sample as FunctionDeclaration),
      risk: { ...(sample as FunctionDeclaration).risk, [SYNTHETIC_GOLDEN_STRAY_FIELD]: 'x' },
    } as unknown as FunctionDeclaration
    expect(
      unaccountedGoldenFields([withStrayDeclarationKey]).map((field) => `${field.on}.${field.key}`),
      'the register cannot see a new declaration field',
    ).toEqual([`declaration.${SYNTHETIC_GOLDEN_STRAY_FIELD}`])
    expect(
      unaccountedGoldenFields([withStrayRiskKey]).map((field) => `${field.on}.${field.key}`),
      'the register cannot see a new risk-descriptor field',
    ).toEqual([`risk.${SYNTHETIC_GOLDEN_STRAY_FIELD}`])
  })

  it('control: the ledger comparator names the op and the field that moved', () => {
    // THE NAMED-RED REQUIREMENT, DRIVEN. D-06/D-07 ask that a mismatch identify the capability and
    // the field rather than announce that two hashes differ. Proving that by breaking the committed
    // file would be a mutation of a shipped artifact; the comparator is pure, so the changes D-05
    // exists to make visible — a dropped risk hint, a moved partition — are driven over real rows
    // here, plus the presence columns, the result kind, a digest and the binding.
    const rows = buildGoldenRows(rootDeclarations)
    expect(goldenFindings(rows, rows), 'a ledger compared against itself must report nothing')
      .toEqual([])

    const subject = rows[0] as GoldenRow
    // the `requiredScopes` and `requiresHumanOrigin` columns are gone, so their
    // two mutations left this list; `classifies` and `resultKind` take their places.
    const mutations: readonly (readonly [string, GoldenRow])[] = [
      [
        'risk',
        {
          ...subject,
          risk: {
            ...subject.risk,
            destructive: subject.risk.destructive === true ? undefined : true,
          },
        },
      ],
      ['partition', { ...subject, partition: { kind: 'unprojected', reason: 'not-mid-flight-read' } }],
      ['rendersResult', { ...subject, rendersResult: subject.rendersResult === true ? undefined : true }],
      ['classifies', { ...subject, classifies: subject.classifies === true ? undefined : true }],
      ['resultKind', { ...subject, resultKind: subject.resultKind === 'unary' ? 'stream' : 'unary' }],
      ['inputSchemaDigest', { ...subject, inputSchemaDigest: 'f'.repeat(64) }],
      ['bindingStatusAtRoot', { ...subject, bindingStatusAtRoot: 'unbound' }],
    ]
    for (const [field, mutated] of mutations) {
      const findings = goldenFindings([mutated, ...rows.slice(1)], rows)
      expect(findings.map((finding) => finding.field), `a moved ${field} must be named`)
        .toEqual([field])
      expect(findings[0]?.opId, `a moved ${field} must name the capability`).toBe(subject.id)
      expect(findings[0]?.message, `a moved ${field} must name the capability and the field`)
        .toContain(`${subject.id}.${field}`)
    }

    // Row presence, both directions — the two shapes a capability change takes.
    const strayRow: GoldenRow = { ...subject, id: SYNTHETIC_GOLDEN_STRAY_OP_ID }
    expect(
      goldenFindings(rows, [...rows, strayRow]).map((finding) => finding.opId),
      'a ledger row for a capability the registry no longer declares must be named',
    ).toEqual([SYNTHETIC_GOLDEN_STRAY_OP_ID])
    expect(
      goldenFindings([...rows, strayRow], rows).map((finding) => finding.opId),
      'a capability with no ledger row must be named',
    ).toEqual([SYNTHETIC_GOLDEN_STRAY_OP_ID])
  })

  it('control: the partition join answers all three states, including the uncatalogued one', () => {
    // Pitfall 11's shape at the partition. The third state is reachable only through a synthetic
    // mapping — which is exactly why it is driven here rather than left as a branch nobody has seen.
    const projectingTool = new Map([[SYNTHETIC_GOLDEN_STRAY_OP_ID, 'agent_qa_control_397_06']])
    expect(goldenPartitionOf(SYNTHETIC_GOLDEN_STRAY_OP_ID, projectingTool, [])).toEqual({
      kind: 'projected',
      tool: 'agent_qa_control_397_06',
    })
    expect(
      goldenPartitionOf(SYNTHETIC_GOLDEN_UNCATALOGUED_OP_ID, new Map(), [
        { opId: SYNTHETIC_GOLDEN_UNCATALOGUED_OP_ID, reason: 'a mid-flight workflow read' },
      ]),
    ).toEqual({ kind: 'unprojected', reason: 'not-mid-flight-read' })
    expect(
      goldenPartitionOf(SYNTHETIC_GOLDEN_UNCATALOGUED_OP_ID, new Map(), []),
      'a capability in neither half of the mapping must read uncatalogued, never a missing key',
    ).toEqual({ kind: 'uncatalogued' })

    // …and no LIVE capability sits in that third state.
    for (const row of buildGoldenRows(rootDeclarations)) {
      expect(
        row.partition.kind,
        `${row.id}: the declared mapping neither projects this capability nor declares it `
          + 'unprojected — it is catalogued nowhere',
      ).not.toBe('uncatalogued')
    }
  })

  it('censuses binding status at the one shipped composition root, spelling the third state', () => {
    // D-08. THE COLUMN IS A FACT ABOUT A COMPOSITION, not about the catalogue, and that is what
    // makes reading it off the RIGHT composition load-bearing. `composeCliLocalAgent` — the function
    // every shipped CLI surface composes through — binds all 41; this suite's own enumeration
    // registry supplies empty deps and binds 11. Same 41 capabilities, different answers.
    for (const declaration of rootDeclarations) {
      expect(
        ['bound', 'unbound'],
        `${declaration.id}: binding status at the root must be one of the two spelled states, `
          + 'never absent (Pitfall 11: the third state is data)',
      ).toContain(declaration.bindingStatus)
    }

    const suiteRegistryStatuses = new Map(
      registryDeclarations().map((declaration) => [declaration.id, declaration.bindingStatus]),
    )
    expect(
      sorted(suiteRegistryStatuses.keys()),
      'the two compositions must declare the same capabilities — binding is not membership',
    ).toEqual(sorted(rootDeclarations.map((declaration) => declaration.id)))

    // MEASURED 2026-08-16: 41 bound at the CLI root, 11 bound under empty deps, so 30 disagree. The
    // assertion is that the disagreement is NON-EMPTY rather than that it is thirty, because the
    // claim is "this column describes a composition" and a host binding one more capability is not
    // a reason for this cell to red. A ledger built off the suite's own registry instead of the
    // root would make this set empty, which is the mistake it exists to catch.
    const disagree = rootDeclarations.filter(
      (declaration) => suiteRegistryStatuses.get(declaration.id) !== declaration.bindingStatus,
    )
    expect(
      disagree.length,
      'the composition root and the empty-deps enumeration registry agree on every capability, so '
        + 'the ledger\'s binding column may be reading the wrong composition',
    ).toBeGreaterThan(0)

    // THE COLUMN HAS ONE PRODUCER, AND IT IS A READ. A hand-typed op → status map would satisfy
    // every assertion above on the day it was written and describe a composition nobody builds a
    // week later; `golden.ts` therefore spells neither status anywhere in its code. Comments are
    // stripped first, so its own docstrings may explain the states it must not literalise.
    const goldenCode = commentStrippedSource('golden.ts')
    expect(goldenCode, 'the ledger\'s binding column must be READ off the root\'s declaration')
      .toContain('bindingStatusAtRoot: declaration.bindingStatus')
    for (const status of ['bound', 'unbound']) {
      expect(goldenCode, `golden.ts spells the binding status '${status}' instead of reading it`)
        .not.toContain(`'${status}'`)
    }

    // The ledger's column is the ROOT's answer, per op.
    const rowById = new Map(buildGoldenRows(rootDeclarations).map((row) => [row.id, row]))
    for (const declaration of rootDeclarations) {
      expect(rowById.get(declaration.id)?.bindingStatusAtRoot, `${declaration.id}: ledger column`)
        .toBe(declaration.bindingStatus)
    }
  })

  it('agrees with the composition root on every capability each surface host can see', () => {
    // D-08's DIVERGENCE ASSERTION: "lists bound here, refuses there" is the disagreement
    // `resolveBindingStatus` exists to prevent, and the only way it can arise is a surface host that
    // composes a registry of its own. Each shipped host's listing — the chat host's two stage mints,
    // the MCP host's one tokenless caller under its two legacy keys (432-31/432-39) — is compared to
    // the root's answer per
    // capability. The cell below pins the structural reason this holds.
    const rootStatus = new Map(
      rootDeclarations.map((declaration) => [declaration.id, declaration.bindingStatus]),
    )
    let compared = 0
    for (const [host, listing] of rootHostListings) {
      expect(listing.length, `${host}: the host listed no capabilities at all`).toBeGreaterThan(0)
      for (const declaration of listing) {
        expect(
          declaration.bindingStatus,
          `${declaration.id}: lists ${declaration.bindingStatus} on the ${host} host and `
            + `${rootStatus.get(declaration.id)} at the composition root`,
        ).toBe(rootStatus.get(declaration.id))
        compared += 1
      }
    }
    // Non-vacuity, and the shape of the roster's own claim: four listings, none of them empty.
    expect(rootHostListings.size, 'no surface host listing was taken').toBe(4)
    expect(compared, 'the divergence cell compared nothing').toBeGreaterThan(censusIds.length)
  })

  it('pins that neither surface host composes a registry of its own', () => {
    // WHY THIS CELL EXISTS BESIDE THE ONE ABOVE. That comparison is taken over the registry object
    // the shipped hosts hand their surface, so it can only stay meaningful while that remains true.
    // A host that built its own registry would answer its own questions consistently and diverge
    // from the root invisibly. Comments are stripped so this file may name what those files must not
    // contain.
    for (const command of ['mcp.ts', 'chat.ts']) {
      const code = commentStrippedFile(join(CONFORMANCE_DIR, '..', '..', 'commands', command))
      expect(code, `commands/${command} read back empty`).toContain('composeCliLocalAgent')
      expect(
        code,
        `commands/${command} composes a function registry of its own instead of taking the `
          + 'composition root\'s — a host with its own registry can list bound and refuse',
      ).not.toContain('createFunctionRegistry')
    }
  })

  it('never writes the golden ledger: the only writer is the regen script', () => {
    // THE PROHIBITION, AS SOURCE. "A capability ledger must not be one keystroke from silently
    // blessed" is a claim about what this directory CAN do, not about what it happens to do today,
    // so the sweep ranges every file in the directory — including one added tomorrow — rather than
    // a list written now.
    const files = readdirSync(CONFORMANCE_DIR).filter((name) => name.endsWith('.ts'))
    expect(files.length, 'the conformance directory read back empty').toBeGreaterThan(4)

    // ASSEMBLED FROM FRAGMENTS, on `compose-authority-topology.test.ts`'s precedent and for its
    // reason: the sweep ranges every `.ts` file in this directory, THIS FILE INCLUDED, so a
    // forbidden token written out here would be the sweep reading its own prohibition as the defect.
    // Measured: it did, the first time this cell ran.
    const forbidden: readonly string[] = [
      ['toMatch', 'Snapshot'].join(''),
      ['toMatch', 'File', 'Snapshot'].join(''),
      ['toMatch', 'Inline', 'Snapshot'].join(''),
      ['writeFileSync(', 'GOLDEN_PATH'].join(''),
      ['writeFile(', 'GOLDEN_PATH'].join(''),
      ['appendFileSync(', 'GOLDEN_PATH'].join(''),
    ]
    let nameMentions = 0
    for (const file of files) {
      const code = commentStrippedSource(file)
      nameMentions += code.split(GOLDEN_FILE_NAME).length - 1
      for (const token of forbidden) {
        expect(code, `${file} carries a path that could bless the ledger: ${token}`)
          .not.toContain(token)
      }
    }
    // The ledger's own file name appears exactly once in the directory — as the constant golden.ts
    // resolves the read path from. A second spelling is a second place a writer could open it.
    expect(nameMentions, `${GOLDEN_FILE_NAME} is spelled more than once in the conformance sources`)
      .toBe(1)

    // …and the sweep is not vacuous: every forbidden shape is recognised in a control that carries
    // it, so a fragment assembled wrong cannot leave the sweep quietly searching for nothing.
    for (const token of forbidden) {
      expect(`prefix ${token} suffix`, `the sweep no longer recognises ${token}`).toContain(token)
    }
  })

  // ---- FUNC-05 leg 2: structural schema equality, per OP, through ONE lens ---------------

  it('advertises, for every projected capability, the very shape the gate validates it with', async () => {
    const advertised = new Map(
      (await withMcpClient(async (client) => (await client.listTools()).tools)).map(
        (tool) => [tool.name, tool as unknown as AdvertisedTool],
      ),
    )
    const declared = new Map(registryDeclarations().map((row) => [row.id, row]))

    let inputsCompared = 0
    let outputsCompared = 0
    const exceptionsTaken = new Map<Leg2ExceptionKey, number>()
    const takeException = (key: Leg2ExceptionKey): void => {
      exceptionsTaken.set(key, (exceptionsTaken.get(key) ?? 0) + 1)
    }

    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      const tool = advertised.get(projection.name)
      expect(tool, `${projection.name}: declared by the mapping but not advertised`).toBeDefined()
      const composition = compositionOf(projection)

      for (const opId of projection.ops) {
        const declaration = declared.get(opId)
        expect(declaration, `${opId}: projected by ${projection.name} but not declared`).toBeDefined()
        const ownInput = withoutDialect(declaration!.input)
        const ownOutput = withoutDialect(declaration!.output)

        // ---- the input side --------------------------------------------------------------------
        const inputPlan = leg2InputPlan(projection, opId)
        if (inputPlan.kind === 'exception') {
          takeException(inputPlan.key)
        } else if (inputPlan.kind === 'arm') {
          // THE UNION-ARM NORMALISATION, through the lens's own function: the fold adds a
          // discriminant key whose value is the op id, and taking it back out is what makes the
          // composed arm and the op's own document the same claim. 2026-10-20: the
          // fold lists one object, so the listing is held to the lens's fold check, and the arm
          // compared whole is the composed union's, which is what the call is validated with.
          const listed = withoutDialect(tool!.inputSchema)
          expect(
            foldArmFindings(listed, projection.discriminant!, opId, ownInput),
            `${opId} on mcp (input, listed by ${projection.name}): the listing does not cover `
              + 'this capability\'s own contract',
          ).toEqual([])
          const composed = advertisedContracts(projection)!.input['~standard'].jsonSchema.input({
            target: 'draft-2020-12',
          })
          const arms = (withoutDialect(composed).oneOf ?? []) as readonly JsonDocument[]
          expect(arms.length, `${projection.name}: fold arms vs declared ops`)
            .toBe(projection.ops.length)
          expect(
            armWithoutDiscriminant(arms[inputPlan.at]!, projection.discriminant!),
            `${opId} on mcp (input, arm ${inputPlan.at} of ${projection.name}): the composed `
              + 'shape is not this capability\'s own contract',
          ).toEqual(ownInput)
          inputsCompared += 1
        } else {
          expect(
            withoutDialect(tool!.inputSchema),
            `${opId} on mcp (input, via ${projection.name}): the advertised shape is not this `
              + 'capability\'s own contract',
          ).toEqual(ownInput)
          inputsCompared += 1
        }

        // ---- the output side -------------------------------------------------------------------
        const outputPlan = leg2OutputPlan(projection, opId)
        if (outputPlan.kind === 'exception') {
          takeException(outputPlan.key)
          if (outputPlan.key === 'degraded-output-contract') {
            // PITFALL 9: the ABSENCE is asserted, never skipped — a skip asserts nothing, and the
            // one thing a degraded tool must never do is quietly start advertising a stand-in.
            const entry = DEGRADED_OUTPUT_CONTRACTS.find((row) => row.tool === projection.name)!
            expect(
              tool!.outputSchema,
              `${opId} on mcp (output): ${projection.name} is a declared degradation and must `
                + 'advertise NO outputSchema',
            ).toBeUndefined()
            expect(
              tool!.description,
              `${opId} on mcp (output): the degradation must travel in the one channel that `
                + 'reaches the caller — the tool description',
            ).toContain('advertises no outputSchema')
            expect(
              tool!.description,
              `${opId} on mcp (output): the description must name the contract that degraded`,
            ).toContain(entry.schema)
          }
          continue
        }

        // a non-object output root (the run list) arrives `{ result }`-wrapped under the
        // 2025-11-25 codec; the published lens undoes exactly that transport wrap.
        const advertisedOutput = withoutDialect(withoutLegacyResultWrap(tool!.outputSchema ?? {}))
        expect(
          tool!.outputSchema,
          `${opId} on mcp (output): ${projection.name} advertises no outputSchema and is not a `
            + 'declared degradation',
        ).toBeDefined()
        const members = advertisedOutputMembers(advertisedOutput)

        // the mark door's `op outcome OR credential refusal` output
        // left with the bearer credential; it advertises its op's own contract and is
        // compared on the single-op arm below like every other 1:1 tool.

        if (composition === 'union') {
          // A fold whose arms answer one shape advertises that shape; the one whose arms differ
          // advertises an `anyOf`. Either way this capability's own document must BE one of them.
          expect(
            members.map((member) => JSON.stringify(member)),
            `${opId} on mcp (output, via ${projection.name}): this capability's own contract is not `
              + 'among the shapes the fold advertises',
          ).toContain(JSON.stringify(ownOutput))
          // …and the advertised set is exactly the fold's distinct arm outputs, so membership
          // cannot be satisfied by a sibling arm's shape while this op's own went unadvertised.
          const distinct = [
            ...new Set(
              projection.ops.map((armOpId) =>
                JSON.stringify(withoutDialect(declared.get(armOpId)!.output)),
              ),
            ),
          ]
          expect(
            sorted(members.map((member) => JSON.stringify(member))),
            `${projection.name}: the advertised output set is not the fold's own distinct arms`,
          ).toEqual(sorted(distinct))
          outputsCompared += 1
          continue
        }

        expect(members.length, `${projection.name}: a 1:1 tool advertises one output shape`).toBe(1)
        expect(
          members[0],
          `${opId} on mcp (output, via ${projection.name}): the advertised shape is not this `
            + 'capability\'s own contract',
        ).toEqual(ownOutput)
        outputsCompared += 1
      }
    }

    // THE ARITHMETIC, so a future reader can tell a real change from a loop that stopped ranging.
    // Twenty-six projected capabilities, on each side, every one of them either compared or
    // carrying a declared exception (2026-09-15, 423-21 D-18: the two feedback read tools add one
    // compared input and one compared output each):
    //   inputs  — 26 less the 2 proposal apply doors and 1 pipeline downstream op = 23
    //   outputs — 26 less the 1 degraded contract and 1 pipeline downstream op    = 24
    // (2026-09-28, 431-03: `runs.list` left the degraded list with its canonical output contract.)
    // (2026-09-28, 431-04 D-04/D-07: nine more projected capabilities, each compared on both sides:
    // seven single reads and the evidence fold's two arms — 32 inputs and 33 outputs.)
    // (2026-09-30, 432-12 D-05: thirty projected capabilities. The two apply doors, the two proposal
    // reads and the undo arm leave: 30 less 1 pipeline downstream op = 29 inputs, all compared now
    // that no door wraps its input; 30 less 1 degraded and 1 pipeline downstream = 28 outputs.)
    const projectedOpCount = AGENT_QA_TOOL_PROJECTIONS.reduce(
      (total, projection) => total + projection.ops.length,
      0,
    )
    const exceptionTotal = [...exceptionsTaken.values()].reduce((total, at) => total + at, 0)
    expect(inputsCompared, 'leg 2 compared a different number of inputs').toBe(29)
    expect(outputsCompared, 'leg 2 compared a different number of outputs').toBe(28)
    expect(
      inputsCompared + outputsCompared + exceptionTotal,
      'every projected capability must be compared or excepted on BOTH sides — no skip-lists',
    ).toBe(projectedOpCount * 2)

    // Every declared exception is EXERCISED. An exemption nothing takes is dead prose that will
    // outlive the reason it was written for.
    for (const [key] of LEG2_EXCEPTIONS) {
      expect(exceptionsTaken.get(key) ?? 0, `the declared exception '${key}' is taken by nothing`)
        .toBeGreaterThan(0)
    }
    expect(
      sorted(exceptionsTaken.keys()),
      'an exception was taken that the declared vocabulary does not contain',
    ).toEqual(sorted(LEG2_EXCEPTIONS.map(([key]) => key)))
  }, 120_000)

  it('joins the declared output degradations to the live listing, in both directions', () => {
    // The REVERSE direction of the absence assertion above, and the one that keeps the exception
    // vocabulary from becoming a place to hide: a tool that advertises no output schema and is not
    // declared degraded is a caller being told less than the contract says, silently.
    return withMcpClient(async (client) => {
      const tools = (await client.listTools()).tools as unknown as readonly AdvertisedTool[]
      expect(tools.length, 'the listing read back empty').toBeGreaterThan(0)
      const undeclaredSilent = tools
        .filter((tool) => tool.outputSchema === undefined)
        .map((tool) => tool.name)
      expect(
        sorted(undeclaredSilent),
        'tools advertising no outputSchema must be exactly the declared degradations',
      ).toEqual(sorted(DEGRADED_OUTPUT_CONTRACTS.map((entry) => entry.tool)))
    })
  })

  it('looks through the ONE published lens, and defines no normaliser of its own', () => {
    // D-06's one-lens rule, as a source assertion (397-02 extracted the three normalisers to
    // `packages/mcp/src/conformance-support.ts` precisely so this leg would not have to re-derive
    // them). A second copy fails SILENTLY: the looser one passes over real drift, and nothing
    // compares the two copies to each other. Comments stripped so this file may name what its body
    // must not define.
    const definitionKeywords = ['function ', 'const ']
    for (const file of readdirSync(CONFORMANCE_DIR).filter((name) => name.endsWith('.ts'))) {
      const code = commentStrippedSource(file)
      for (const normaliser of [
        'withoutDialect',
        'stripRedundantObjectStamp',
        'armWithoutDiscriminant',
        'withoutLegacyResultWrap',
        'foldArmFindings',
      ]) {
        for (const keyword of definitionKeywords) {
          expect(code, `${file} defines its own ${normaliser} instead of importing the one lens`)
            .not.toContain(`${keyword}${normaliser}`)
        }
      }
    }
    // …and the lens IS reached, from the barrel rather than from a path into another package.
    const code = commentStrippedSource('parity.test.ts')
    expect(code, 'the leg-2 comparison no longer imports the lens').toContain('withoutDialect')
    expect(code, 'the lens must come from the mcp barrel').toContain('@vostride/agent-qa-mcp')
    // Assembled from fragments for the reason the ledger sweep's tokens are: this cell reads its
    // own file, so a token written out here is the sweep finding its own prohibition.
    expect(code, 'the lens must be reached through the barrel, never by a path into its module')
      .not.toContain(['conformance', '-support.js'].join(''))
  })
})

// ---- 432-40: the conformance rows at the guidance cutover ------
//
// The cells above were re-spelled one deletion at a time (432-13 through 432-39): no ask, no grant
// wall, no human-origin divergence, no credential refusal. These two blocks state what replaced
// them, as behaviour on the shipped doors, and pin the live partition the rows, the golden and the
// catalogue range: a config change lands in its one call on the chat and MCP doors of one project.

interface ParityProject {
  readonly root: string
  readonly configPath: string
  readonly agentQaRoot: string
}

/** One project with one local target. */
function parityProject(): ParityProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-qa-432-40-parity-')))
  writeFileSync(join(root, 'agent-qa.config.yaml'), [
    'workspace:',
    '  testMatch:',
    "    - 'tests/**/*.yaml'",
    '  suiteMatch:',
    "    - 'suites/**/*.suite.yaml'",
    '  hooksFile: hooks.yaml',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'registry:',
    '  targets:',
    '    local-site:',
    '      platform: web',
    '      url: http://127.0.0.1:9/local',
    '      product: parity-product',
    '      environment: local',
    'use:',
    '  timeout:',
    '    step: 30s',
    '    test: 90m',
    '    navigation: 2m',
    '  mobile:',
    '    appState: reset',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(root, '.env'), '')
  writeFileSync(join(root, '.env.secrets.local'), '')
  return {
    root,
    configPath: join(root, 'agent-qa.config.yaml'),
    agentQaRoot: join(root, '.agent-qa'),
  }
}

interface ParityToolAnswer {
  readonly isError: boolean
  readonly text: string
  readonly structured: Record<string, unknown> | undefined
}

/** One call on the shipped MCP server, over the shipped composition of THIS project. */
async function callOnProjectMcp(
  project: ParityProject,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ParityToolAnswer> {
  const host = composeCliLocalAgent({ agentQaRoot: project.agentQaRoot, configPath: project.configPath })
  const masking = composeMcpMasking({ configPath: project.configPath })
  const handler = createMcpHandler(() => buildAgentQaMcpServer({
    registry: host.registry,
    caller: MCP_FUNCTION_CALLER,
    maskText: (text: string) => masking.mask(text),
  }))
  const client = new Client({ name: 'agent-qa-432-40-parity', version: '0.0.0' })
  try {
    return await runSafetyScope({ executionContext: 'local-headless' }, async () => {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://parity.local/mcp'), {
        fetch: ((url: URL | string, init?: RequestInit) =>
          handler.fetch(new Request(url, init))) as typeof fetch,
      }))
      const result = await client.callTool({ name: toolName, arguments: args }) as {
        content?: readonly { type: string; text?: string }[]
        structuredContent?: Record<string, unknown>
        isError?: boolean
      }
      return {
        isError: result.isError === true,
        text: (result.content ?? []).map((entry) => entry.text ?? '').join('\n'),
        structured: result.structuredContent,
      }
    })
  } finally {
    await client.close().catch(() => {})
    await handler.close().catch(() => {})
    await host.close().catch(() => {})
  }
}

describe('one call on the chat and MCP doors', () => {
  it('a non-production config change lands in its one call on the chat and MCP doors, with nothing filed for later', async () => {
    const project = parityProject()
    try {
      const onMcp = await callOnProjectMcp(project, 'agent_qa_change_config', {
        action: 'config.field.set', path: 'use.timeout.step', value: '45s',
      })
      expect(onMcp.isError, `mcp refused a non-production change: ${onMcp.text}`).toBe(false)
      expect(onMcp.structured?.['outcome'], 'mcp: the answer is not the applied change').toBe('applied')
      expect(readFileSync(project.configPath, 'utf8'), 'mcp: the change is not on disk after one call')
        .toContain('step: 45s')

      const onChat = await driveChatLines(
        [genericFnClause('config.field.set', { path: 'use.timeout.navigation', value: '3m' })],
        'local-interactive',
        { configPath: project.configPath },
      )
      const receipt = onChat.receipts.find((candidate) => candidate.functionId === 'config.field.set')
      expect(onChat.unhandled, 'chat: the /fn clause did not route').toEqual([])
      expect(receipt?.status, `chat: the change did not execute: ${receipt?.outcome ?? 'no receipt'}`)
        .toBe('executed')
      const written = readFileSync(project.configPath, 'utf8')
      expect(written, 'chat: the change is not on disk after one call').toContain('navigation: 3m')
      expect(written, 'chat: the MCP change was lost').toContain('step: 45s')

      // One call each: no proposal store, no pending file and no second step anywhere.
      expect(existsSync(join(project.agentQaRoot, 'proposals')), 'a proposal store was created').toBe(false)
      expect(onChat.auditRows, 'chat: an approval row was written').toEqual([])
      expect(`${onMcp.text}\n${onChat.stdout}`).not.toMatch(/\bpropos|\bapprov|\bpending\b|\bconfirm/iu)
    } finally {
      rmSync(project.root, { recursive: true, force: true })
    }
  }, 120_000)
})

/** Op ids the approval and permission waves deleted. */
const RETIRED_OP_ID = /^(?:proposals\.|grants\.|knowledge\.proposal\.|config\.proposal\.|config\.undo\.)/u

describe('the registry, the twenty-tool mapping, the rows and the ledger agree', () => {
  it('44 ops partition into 30 projected behind 20 tools and 14 unprojected, and the rows say the same', async () => {
    // Measured 2026-10-02 after 432-39 removed the permission types: unchanged since 432-18.
    const ids = registryOpIds()
    const projected = new Set(AGENT_QA_TOOL_PROJECTIONS.flatMap((projection) => [...projection.ops]))
    const unprojected = UNPROJECTED_OPS.map((entry) => entry.opId)
    expect(ids.length, 'registry op count').toBe(44)
    expect(AGENT_QA_TOOL_PROJECTIONS.length, 'MCP tool count').toBe(20)
    expect(projected.size, 'projected op count').toBe(30)
    expect(unprojected.length, 'unprojected op count').toBe(14)
    expect(unprojected.filter((opId) => projected.has(opId)), 'an op is both projected and not').toEqual([])
    expect(sorted([...projected, ...unprojected]), 'the partition is the registry, exactly').toEqual(sorted(ids))
    expect(ids.filter((id) => RETIRED_OP_ID.test(id)), 'a retired op is registered again').toEqual([])

    const toolOf = new Map(AGENT_QA_TOOL_PROJECTIONS.flatMap((projection) =>
      projection.ops.map((opId) => [opId, projection.name] as const)))
    for (const row of SCENARIO_TABLE) {
      const mcp = row.perSurface.mcp
      if ('reachable' in mcp) expect(mcp.reachable.tool, row.opId).toBe(toolOf.get(row.opId))
      else expect(projected.has(row.opId), `${row.opId}: the row says unprojected`).toBe(false)
      expect(row.policyPoints.refuse, row.opId).toBe('allow')
    }

    // The live ledger, minted from the one shipped composition root: 42 bound and 2 unbound there.
    const live = await goldenFileFromRoot()
    expect(sorted(live.rows.map((row) => row.id))).toEqual(sorted(ids))
    expect(live.rows.filter((row) => row.bindingStatusAtRoot === 'bound').length, 'bound at the root').toBe(42)
    expect(live.rows.filter((row) => row.bindingStatusAtRoot === 'unbound').map((row) => row.id).length).toBe(2)
    for (const row of live.rows) {
      expect(row.partition.kind, row.id).toBe(projected.has(row.id) ? 'projected' : 'unprojected')
    }
  }, 120_000)

  it('the committed ledger carries no permission column and no retired op', () => {
    const committed = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile
    const keys = new Set(committed.rows.flatMap((row) => Object.keys(row)))
    for (const retired of ['requiredScopes', 'requiresHumanOrigin', 'credential', 'grantedScopes']) {
      expect(keys, `the ledger carries a ${retired} column`).not.toContain(retired)
    }
    expect(committed.rows.map((row) => row.id).filter((id) => RETIRED_OP_ID.test(id))).toEqual([])
    expect(committed.opCount).toBe(committed.rows.length)
    expect(committed.rows.length, 'the ledger read back empty').toBeGreaterThan(0)
  })
})
