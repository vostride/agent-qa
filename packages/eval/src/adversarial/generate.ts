/**
 * 422 D-02/D-05/D-06/D-07/D-08: the PURE adversarial derivation engine.
 *
 * Three jobs, all of them decisions rather than IO:
 *   1. Seed ELIGIBILITY (D-07). A seed is a `natural`, leaf, proof-backed populated-brief
 *      decision whose gold anchor resolves on its own recorded screen. Held-out is excluded
 *      structurally — a derivation of the unseen test set would land in a split the proposer
 *      reads (414 D-19) — and `/reader` never hands a private entry out in the first place,
 *      so the exclusion holds at the port AND here.
 *   2. TARGET selection, deterministically. For a HOSTILE family the target is the element
 *      the gold anchor names, located by `role + nameNormalized + ordinal` on
 *      `input.stateBefore`. For a BENIGN family the target is the first surface, gold target
 *      first and then recorded element order, on which the perturbation leaves the gold's
 *      `role + nameNormalized + ordinal` EQUAL under the real normalizer. In-table CHOICE is
 *      a seeded draw keyed by `seedCassetteId ‖ mutator ‖ tableVersion` (D-07) through the
 *      pinned `createSeededRng` — byte-identical on two runs, no clock and no ambient entropy.
 *   3. GOLD-PRESERVING derivation (D-06). The perturbation moves the SURFACE; the recorded
 *      action, its ref and the equivalence set still denote the same control, so the correct
 *      decision under a confusable glyph or an injected instruction is the seed's decision.
 *      A planner that follows the injected instruction is a flip-to-worse, which is the whole
 *      measurement.
 *
 * The benign postcondition is CHECKED, not asserted in prose: a candidate surface is accepted
 * only if every gold and equivalence descriptor resolves to the SAME element index after the
 * mutation as before it. A family with no surface that satisfies it reports
 * `benign-surface-absent` — an honest inapplicability row, never a quietly moved gold.
 *
 * What is rebuilt and what is copied is not arbitrary. `promptInputHash` and
 * `screenStateHash` are recomputed because they describe the DERIVED bytes and a copied
 * digest would be a lie. `run_links`, `captured_at_ordinal` and the label's provenance are
 * the SEED's, because ROOT-03's exclusion must keep excluding the run that bred the seed
 * from gating anything derived from it.
 */
import { normalizeAccessibleName, screenStateHash, sha256hex } from '@vostride/agent-qa-schema'
import type { ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import { canonicalJson } from '../canonical-json'
import type { LeafCassette } from '../cassette/cassette'
import type { GoldAnchorDescriptor } from '../cassette/sidecar-leg'
import { canonicalizeInputLeg } from '../extract/receipt'
import { deriveAdversarialLabel } from '../labels/label-record'
import type { StandaloneLabelRecord } from '../labels/label-record'
import { ADVERSARIAL_MUTATORS, projectCorpusEntry } from '../labels/corpus-entry'
import type {
  AdversarialCorpusEntry,
  AdversarialMutator,
  CorpusEntry,
  CorpusGenerator,
} from '../labels/corpus-entry'
import { createSeededRng } from '../stats/prng'
import {
  ADVERSARIAL_TABLES,
  ADVERSARIAL_TABLE_HASH,
  ADVERSARIAL_TABLE_VERSION,
  encodeAdversarialTagBlock,
  type AdversarialTableEntry,
} from './tables'

/**
 * Version of this derivation RECIPE, distinct from the table generation. A change to how a
 * variant is assembled (which fields are rebuilt, how the target is located) bumps this; a
 * change to WHAT is substituted bumps `ADVERSARIAL_TABLE_VERSION`.
 *
 * Generation 2 (422-02): benign families select a gold-identity-preserving surface rather
 * than always perturbing the gold target, and the rendered tree rewrites the target's OWN
 * occurrence rather than every occurrence of its text.
 */
export const ADVERSARIAL_GENERATOR_VERSION = 2

/**
 * Recorded default cap on how many seeds one refresh derives from (D-04). The rationale sits
 * beside `GATE1_DEFAULT_MAX_SCREENS`: a refresh over a grown
 * corpus must be bounded work, and the seeds it does not reach are COUNTED and wait for the
 * next one rather than being dropped.
 *
 * 2026-09-11, 422-03: lowered from 25 to 8. The unit that matters is REVIEW volume, not seeds:
 * eleven frozen families derive at most one variant each per seed, so eight seeds is at most 88
 * cases in front of an operator who must read injection-shaped text before any of it reaches a
 * git-tracked root. 25 was 275. The number is a declared review budget, not a learned threshold
 * — nothing measures it, so it is stated here and overridable per run through `--max-seeds`.
 */
export const ADVERSARIAL_DEFAULT_MAX_SEEDS_PER_REFRESH = 8

/**
 * The families this engine derives. 422-01 derived two of eleven and reported the rest as a
 * typed skip; 422-02 closed that gap, so the generated set IS the declared set and the
 * per-family honesty now lives in the inapplicability rows rather than in a subset list.
 *
 * WHICH MAKES `isGenerated` VACUOUS TODAY, AND SAYING SO IS THE POINT. Because this list is
 * `ADVERSARIAL_MUTATORS` verbatim and the request filter below is drawn from the same list,
 * the `mutator-not-generated` branch cannot be reached and that word reads `0` in every count
 * rendered from the closed vocabulary. It is retained on purpose rather than deleted: the word
 * is persisted in staging reports written before 422-02, so a reader of those records still
 * needs it, and the guard is what makes narrowing this list again a one-line change instead of
 * a re-derivation of the skip path. Do not read the zero as "every family was generated" --
 * read it as "nothing can currently produce this row".
 */
export const ADVERSARIAL_GENERATED_MUTATORS: readonly AdversarialMutator[] = ADVERSARIAL_MUTATORS

/** One candidate seed, as read through the proposer-visible corpus port. */
export interface AdversarialSeed {
  cassette: LeafCassette
  entry: CorpusEntry
  /** The seed's effective standalone label — the gold the derived record clones (D-06). */
  label?: StandaloneLabelRecord
}

/**
 * Why a `(seed, mutator)` pair produced no variant. Every member is a STATEMENT about the
 * seed or the family, never a silent omission: a refresh that stages nothing must be able to
 * say why, row by row.
 */
export type AdversarialInapplicability =
  | 'seed-malformed'
  | 'not-natural'
  | 'brief-not-proof-backed'
  | 'gold-anchor-absent'
  | 'gold-anchor-unresolved'
  | 'seed-label-absent'
  | 'target-name-empty'
  | 'cap-exceeded'
  | 'mutator-not-generated'
  | 'no-table-entry-applies'
  | 'benign-surface-absent'
  | 'hostile-identity-unchanged'
  | 'tree-target-unresolved'
  | 'already-derived'

/** Declaration-order projection of `AdversarialInapplicability` (the 414 D-22 bar idiom). */
export const ADVERSARIAL_INAPPLICABILITIES = [
  'seed-malformed',
  'not-natural',
  'brief-not-proof-backed',
  'gold-anchor-absent',
  'gold-anchor-unresolved',
  'seed-label-absent',
  'target-name-empty',
  'cap-exceeded',
  'mutator-not-generated',
  'no-table-entry-applies',
  'benign-surface-absent',
  'hostile-identity-unchanged',
  'tree-target-unresolved',
  'already-derived',
] as const satisfies readonly AdversarialInapplicability[]

/** 422-01's spelling of the same union, retained for the staging report's existing readers. */
export type AdversarialSeedSkipReason = AdversarialInapplicability

/**
 * 2026-09-12, 422-22 (D-05): the two answers this engine gives for one `(seed, mutator)` pair.
 *
 * DERIVED from the outcome union's own discriminant rather than declared a second time. A third
 * arm added to `AdversarialGenerationOutcome` widens this type automatically and then REDs the
 * hand-spelled cells in `__tests__/closed-sets.test-d.ts` by name; a parallel declaration would
 * have gone on quietly saying two.
 *
 * The word is `derived` and not `generated`: the engine DERIVES a variant from a seed and the
 * corpus addresses it by a derived id. That spelling is already in the staging report and in the
 * settled-tuple record on disk, so a synonym here would be a second vocabulary for one fact.
 */
export type GenerationOutcome = AdversarialGenerationOutcome['kind']

/** Declaration-order projection of `GenerationOutcome` (the 414 D-22 bar idiom). */
export const GENERATION_OUTCOMES = [
  'derived',
  'inapplicable',
] as const satisfies readonly GenerationOutcome[]

/**
 * 2026-09-12, 422-22 (D-05/D-09): the terminal status of ONE row of a staging report.
 *
 * A refresh report is read row by row — one per `(seed, family)` and one per `(seed, probe kind)`
 * tuple — and before this constant the six things a row could BE were spread across five arrays
 * with no shared vocabulary: a staged case, a settled tuple, a policy refusal, an inapplicability,
 * an interrupted charge and a publication failure. Naming them once is what lets a reader, a
 * census and a job checkpoint agree on what they are counting.
 *
 * The six are deliberately NOT collapsible. `unchanged` is an idempotent no-op and `inapplicable`
 * is a case this build cannot derive — one bucket for both would make a corpus that already has
 * the case indistinguishable from a seed that is broken. `refusal` is a guardrail detector that
 * fired and `failed` is bytes that could not be published — one is a decision and the other is an
 * accident. And `interrupted` is a provider call that was announced and never answered, which is
 * CHARGED: folding it into `failed` would make a real spend read as a free one.
 */
export type AdversarialRowStatus =
  | 'staged'
  | 'unchanged'
  | 'refusal'
  | 'inapplicable'
  | 'interrupted'
  | 'failed'

/** Declaration-order projection of `AdversarialRowStatus` (D-22). */
export const ADVERSARIAL_ROW_STATUSES = [
  'staged',
  'unchanged',
  'refusal',
  'inapplicable',
  'interrupted',
  'failed',
] as const satisfies readonly AdversarialRowStatus[]

/**
 * What publication did with a row this engine DID derive (D-03/D-04).
 *
 * A separate union from the row status on purpose, and not the same words: this one is the
 * staging layer's ANSWER, and the row status is what a report says after reading it. One union
 * serving both would have to carry `unchanged` and `inapplicable`, which describe rows
 * publication never saw at all.
 */
export type AdversarialPublication = 'published' | 'refused' | 'interrupted' | 'failed'

/** Declaration-order projection of `AdversarialPublication` (D-22). */
export const ADVERSARIAL_PUBLICATIONS = [
  'published',
  'refused',
  'interrupted',
  'failed',
] as const satisfies readonly AdversarialPublication[]

/**
 * Read one report row's terminal status from what the engine and the staging layer each said.
 *
 * PURE and TOTAL: every outcome arm crossed with every publication answer lands on one of the six
 * words, which is what makes the vocabulary usable by a renderer that must not meet a value it
 * cannot draw. The publication argument is optional because a row nothing tried to publish has no
 * publication answer — and defaulting it to `published` would be wrong for exactly the
 * inapplicable arm, which is why that arm is answered BEFORE the default is applied.
 *
 * The one rule here that is content rather than a rename: `already-derived` reads as `unchanged`.
 * A tuple this generation already addresses is not a case the refresh could not handle, it is a
 * case the corpus already has, and reporting it beside a malformed seed would put an idempotent
 * no-op and a broken document in one bucket.
 */
export function adversarialRowStatus(input: {
  outcome: AdversarialGenerationOutcome
  publication?: AdversarialPublication
}): AdversarialRowStatus {
  if (input.outcome.kind === 'inapplicable') {
    return input.outcome.reason === 'already-derived' ? 'unchanged' : 'inapplicable'
  }
  switch (input.publication ?? 'published') {
    case 'published':
      return 'staged'
    case 'refused':
      return 'refusal'
    case 'interrupted':
      return 'interrupted'
    case 'failed':
      return 'failed'
  }
}

/**
 * 2026-09-12, 422-22 (D-04): where a resolved cap came from, recorded beside every refresh.
 *
 * The NEUTRAL declaration. Both durable caps — the per-refresh seed cap and the per-refresh
 * provider-call cap — record their origin, and before this constant each storage-side record
 * spelled the three words itself. Two hand-written lists of one vocabulary is how one of them
 * ends up admitting an origin the other refuses, and the origin is PERSISTED: it is what lets a
 * refresh explain a bound nobody remembers setting.
 *
 * Declaration order reads as "what you get if you say nothing, then what overrides it". The
 * resolution precedence runs the other way — a flag beats a config value beats the default.
 */
export type AdversarialCapSource = 'default' | 'config' | 'flag'

/** Declaration-order projection of `AdversarialCapSource` (D-22). */
export const ADVERSARIAL_CAP_SOURCES = [
  'default',
  'config',
  'flag',
] as const satisfies readonly AdversarialCapSource[]

/** An honest row for every seed × mutator pair that produced no variant. */
export interface AdversarialSeedSkip {
  seedCassetteId: string
  mutator?: AdversarialMutator
  reason: AdversarialInapplicability
}

/** One derived case: the three committed documents plus the provenance that explains them. */
export interface AdversarialVariant {
  cassette: LeafCassette
  corpusEntry: AdversarialCorpusEntry
  labelRecord: StandaloneLabelRecord
  generator: CorpusGenerator
  seedCassetteId: string
  mutator: AdversarialMutator
  /** Disclosure of the drawn table entry; never part of the derived identity (D-08). */
  tableEntryId: string
  /**
   * Whether the perturbed surface was the gold target itself. Always true for a hostile
   * family; false for a benign family that had to land on a distractor to keep the gold's
   * normalized identity equal. Disclosure only — it never enters the derived id.
   */
  perturbedGoldTarget: boolean
  /** The blob closure the derived cassette inherits, by content address only. */
  blobShas: readonly string[]
}

/** The typed answer for ONE `(seed, mutator)` pair — derived, or explicitly not. */
export type AdversarialGenerationOutcome =
  | {
      kind: 'derived'
      seedCassetteId: string
      mutator: AdversarialMutator
      variant: AdversarialVariant
    }
  | {
      kind: 'inapplicable'
      seedCassetteId: string
      mutator?: AdversarialMutator
      reason: AdversarialInapplicability
    }

export interface GenerateAdversarialVariantsInput {
  product: string
  seeds: readonly AdversarialSeed[]
  /** Defaults to `ADVERSARIAL_GENERATED_MUTATORS`; the ORDER is always the declared one. */
  mutators?: readonly AdversarialMutator[]
  /** Derived ids already staged or committed; D-04's idempotence key. */
  existingCassetteIds?: ReadonlySet<string>
  maxSeeds?: number
}

export interface GenerateAdversarialVariantsResult {
  variants: readonly AdversarialVariant[]
  skips: readonly AdversarialSeedSkip[]
  /** One row per considered `(seed, mutator)` pair, in seed-id then declared-mutator order. */
  outcomes: readonly AdversarialGenerationOutcome[]
  /** Eligible seeds this call actually derived from. */
  seedsConsidered: number
  /** Eligible seeds the cap deferred to the next refresh (D-04). */
  seedsDeferred: number
}

/**
 * The derived cassette identity (D-08). It is a function of the SEED, the kind, the family
 * and the table GENERATION — never of the drawn entry — so re-running a refresh under an
 * unchanged generation re-derives the same id and admits nothing twice, while a
 * `tableVersion` bump addresses a new generation beside the old one.
 */
export function deriveAdversarialCassetteId(input: {
  seedCassetteId: string
  kind: CorpusGenerator['kind']
  mutator: AdversarialMutator
  tableVersion: number
}): string {
  return sha256hex(
    canonicalJson({
      base: input.seedCassetteId,
      kind: input.kind,
      mutator: input.mutator,
      tableVersion: input.tableVersion,
    }),
  )
}

/** U+001F UNIT SEPARATOR: a byte no cassette id, family name or version can contain. */
const DRAW_KEY_SEPARATOR = '\u001f'

/**
 * The EXACT UTF-8 key the in-table draw is seeded from (D-07).
 *
 * It is a named function with a pinned separator rather than an inline template because the
 * key is a silent contract: changing it re-draws every family on every seed without changing
 * a single derived cassette id, so the change would be invisible in the corpus. A separator
 * that cannot appear in any component is what keeps `(a, bc)` and `(ab, c)` distinct.
 */
export function adversarialDrawKey(
  seedCassetteId: string,
  mutator: AdversarialMutator,
  tableVersion: number,
): string {
  return `${seedCassetteId}${DRAW_KEY_SEPARATOR}${mutator}${DRAW_KEY_SEPARATOR}${tableVersion}`
}

/** D-07: the seeded stream is keyed by seed, family and table generation — nothing else. */
export function drawAdversarialTableEntry(input: {
  seedCassetteId: string
  mutator: AdversarialMutator
  tableVersion: number
  entries: readonly AdversarialTableEntry[]
}): AdversarialTableEntry {
  const rng = createSeededRng(
    adversarialDrawKey(input.seedCassetteId, input.mutator, input.tableVersion),
  )
  return input.entries[rng.nextInt(0, input.entries.length - 1)]!
}

/** Capitalize each whitespace-delimited word and lowercase the rest. */
function titleCase(name: string): string {
  return name.replace(/\S+/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
}

/** The closed set of `transform` rewrites; an unknown name is a typed no-op, never a guess. */
function applyTransform(transform: string, name: string): string | undefined {
  if (transform === 'upper') return name.toUpperCase()
  if (transform === 'lower') return name.toLowerCase()
  if (transform === 'title') return titleCase(name)
  if (transform === 'leading-space') return ` ${name}`
  if (transform === 'trailing-space') return `${name} `
  if (transform === 'double-inner-space') {
    const at = name.indexOf(' ')
    return at < 0 ? undefined : `${name.slice(0, at)}  ${name.slice(at + 1)}`
  }
  if (transform === 'drop-last-character') {
    return name.length < 2 ? undefined : name.slice(0, -1)
  }
  if (transform === 'drop-last-word') {
    const at = name.trimEnd().lastIndexOf(' ')
    return at < 0 ? undefined : name.slice(0, at)
  }
  return undefined
}

/** Apply one drawn table entry to the target text; `undefined` when it does not apply. */
export function applyAdversarialTableEntry(
  mutator: AdversarialMutator,
  entry: AdversarialTableEntry,
  name: string,
): string | undefined {
  const family = ADVERSARIAL_TABLES[mutator]
  if (family.application === 'append') return `${name} ${entry.to}`
  if (family.application === 'suffix') return `${name}${entry.to}`
  if (family.application === 'tag-encode') return `${name}${encodeAdversarialTagBlock(entry.to)}`
  if (family.application === 'transform') return applyTransform(entry.to, name)
  if (family.application === 'insert') {
    return name.length === 0 ? undefined : `${name.slice(0, 1)}${entry.to}${name.slice(1)}`
  }
  if (entry.from === undefined) return undefined
  const at = name.indexOf(entry.from)
  if (at < 0) return undefined
  return name.slice(0, at) + entry.to + name.slice(at + entry.from.length)
}

/** Entries whose application actually changes this target; an empty list is a typed skip. */
function applicableEntries(
  mutator: AdversarialMutator,
  name: string,
): readonly AdversarialTableEntry[] {
  return ADVERSARIAL_TABLES[mutator].entries.filter(entry => {
    const applied = applyAdversarialTableEntry(mutator, entry, name)
    return applied !== undefined && applied !== name
  })
}

function isGenerated(mutator: AdversarialMutator): boolean {
  return ADVERSARIAL_GENERATED_MUTATORS.includes(mutator)
}

/** Index of the element a descriptor names, or -1 — the ONE resolution rule this file uses. */
function resolveDescriptorIndex(
  elements: readonly ElementInfo[],
  descriptor: GoldAnchorDescriptor,
): number {
  let seen = 0
  for (const [index, element] of elements.entries()) {
    if (element.role !== descriptor.role) continue
    if (normalizeAccessibleName(element.name) !== descriptor.nameNormalized) continue
    if (seen === descriptor.ordinal) return index
    seen += 1
  }
  return -1
}

/** Replace element `index`'s accessible name, re-normalizing through the shipped normalizer. */
function withMutatedName(
  elements: readonly ElementInfo[],
  index: number,
  mutatedName: string,
): ElementInfo[] {
  return elements.map((element, position) =>
    position === index
      ? { ...element, name: mutatedName, nameNormalized: normalizeAccessibleName(mutatedName) }
      : element,
  )
}

/** Rebuild each resolvable descriptor from its original control, including shifted ordinals.
 * Unresolved alternate-name descriptors retain their historical meaning; they must not start
 * resolving to a different control as a side effect. Their broader policy is separate (#438).
 */
export function retargetDescriptors(
  before: readonly ElementInfo[],
  after: readonly ElementInfo[],
  descriptors: readonly GoldAnchorDescriptor[],
): GoldAnchorDescriptor[] | undefined {
  const originalIndices = descriptors.map(descriptor => resolveDescriptorIndex(before, descriptor))
  const rebuilt: GoldAnchorDescriptor[] = []
  for (const [position, descriptor] of descriptors.entries()) {
    const index = originalIndices[position]!
    if (index < 0) {
      if (resolveDescriptorIndex(after, descriptor) !== -1) return undefined
      rebuilt.push(descriptor)
      continue
    }
    const element = after[index]
    if (element === undefined || element.ref !== before[index]!.ref) return undefined
    const nameNormalized = normalizeAccessibleName(element.name)
    const ordinal = after.slice(0, index).filter(candidate =>
      candidate.role === element.role && normalizeAccessibleName(candidate.name) === nameNormalized,
    ).length
    const next = { ...descriptor, role: element.role, nameNormalized, ordinal }
    if (resolveDescriptorIndex(after, next) !== index) return undefined
    rebuilt.push(next)
  }
  return rebuilt
}

/**
 * D-06's benign postcondition: every gold and equivalence descriptor must resolve to the
 * SAME element index after the perturbation as before it. `-1 === -1` counts — a descriptor
 * that did not resolve before must not start resolving because a distractor was renamed onto
 * it, which would silently hand the gold a second target.
 */
function goldIdentityPreserved(
  before: readonly ElementInfo[],
  after: readonly ElementInfo[],
  descriptors: readonly GoldAnchorDescriptor[],
): boolean {
  return descriptors.every(
    descriptor =>
      resolveDescriptorIndex(after, descriptor) === resolveDescriptorIndex(before, descriptor),
  )
}

interface SurfaceSelection {
  index: number
  entry: AdversarialTableEntry
  mutatedName: string
}

/** The surfaces a benign family may land on: the gold target first, then recorded order. */
function benignCandidateOrder(elementCount: number, goldIndex: number): readonly number[] {
  const rest: number[] = []
  for (let index = 0; index < elementCount; index += 1) {
    if (index !== goldIndex) rest.push(index)
  }
  return [goldIndex, ...rest]
}

function selectSurface(input: {
  seedCassetteId: string
  mutator: AdversarialMutator
  elements: readonly ElementInfo[]
  descriptors: readonly GoldAnchorDescriptor[]
  anchor: GoldAnchorDescriptor
  goldIndex: number
}): SurfaceSelection | AdversarialInapplicability {
  const { seedCassetteId, mutator, elements, descriptors, anchor, goldIndex } = input
  const draw = (entries: readonly AdversarialTableEntry[]): AdversarialTableEntry =>
    drawAdversarialTableEntry({
      seedCassetteId,
      mutator,
      tableVersion: ADVERSARIAL_TABLE_VERSION,
      entries,
    })

  if (ADVERSARIAL_TABLES[mutator].hostile) {
    const name = elements[goldIndex]!.name
    const entries = applicableEntries(mutator, name)
    if (entries.length === 0) return 'no-table-entry-applies'
    const entry = draw(entries)
    const mutatedName = applyAdversarialTableEntry(mutator, entry, name)!
    // A hostile family that left the normalized identity alone perturbed nothing a
    // name-based planner can see; say so rather than staging a decorative variant.
    if (normalizeAccessibleName(mutatedName) === anchor.nameNormalized) {
      return 'hostile-identity-unchanged'
    }
    return { index: goldIndex, entry, mutatedName }
  }

  let sawApplicableEntry = false
  for (const index of benignCandidateOrder(elements.length, goldIndex)) {
    const name = elements[index]!.name
    if (name.trim() === '') continue
    const entries = applicableEntries(mutator, name)
    if (entries.length === 0) continue
    sawApplicableEntry = true
    const entry = draw(entries)
    const mutatedName = applyAdversarialTableEntry(mutator, entry, name)!
    if (!goldIdentityPreserved(elements, withMutatedName(elements, index, mutatedName), descriptors)) {
      continue
    }
    return { index, entry, mutatedName }
  }
  return sawApplicableEntry ? 'benign-surface-absent' : 'no-table-entry-applies'
}

/** Does this cassette carry the proof-backed populated brief D-07 requires of a seed? */
function isProofBacked(cassette: LeafCassette): boolean {
  const brief = cassette.input.servedBrief
  if (brief.proof === undefined) return false
  return brief.channel1.length + brief.channel2.length + brief.channel3.length > 0
}

/**
 * Resolve a rendered name by role, normalized name and matching-set ordinal. Only name
 * fields in supported tree rows participate; roles, annotations and prose never do.
 * Cardinality, verbatim names and any rendered refs must agree with the recorded elements
 * before an ordinal is safe to use. Unsupported or ambiguous representations are refused.
 */
export function rewriteElementNameInTree(input: {
  tree: string
  elements: readonly Pick<ElementInfo, 'role' | 'name' | 'ref'>[]
  /** Index into the recorded elements of the element being perturbed. */
  index: number
  replacement: string
}): string | undefined {
  const { tree, elements, index, replacement } = input
  const target = elements[index]
  if (target === undefined || target.name === '') return undefined
  const normalized = normalizeAccessibleName(target.name)
  const peers = elements.map((element, position) => ({ element, position })).filter(({ element }) =>
    element.role === target.role && normalizeAccessibleName(element.name) === normalized,
  )
  const spans: { start: number; name: string; ref?: string }[] = []
  let offset = 0
  for (const line of tree.split('\n')) {
    const header = /^(\s*(?:-\s+)?)(\'?)([\w-]+) /.exec(line)
    if (header !== null && header[3] === target.role) {
      const start = header[0].length
      const wrapped = header[2] === "'"
      const body = wrapped && line.endsWith("'") ? line.slice(start, -1) : line.slice(start)
      if (wrapped && !line.endsWith("'")) return undefined
      const quoted = /^"([^"]*)"(.*)$/.exec(body)
      // Bare captures render the complete remainder as the name. Quoted captures have an
      // explicit closing delimiter followed by annotations or colon-introduced prose.
      const name = quoted === null ? body : quoted[1]!
      const suffix = quoted?.[2] ?? ''
      if (body.startsWith('"') && quoted === null) return undefined
      if (suffix !== '' && !/^(?:\s+\[[^\]]*\]|\s+@\([^)]*\))*\s*(?::.*)?$/.test(suffix)) {
        return undefined
      }
      if (normalizeAccessibleName(name) === normalized) {
        const refs = [...suffix.matchAll(/\[ref=([^\]]+)\]/g)]
        if (refs.length > 1) return undefined
        spans.push({ start: offset + start + (quoted === null ? 0 : 1), name,
          ...(refs[0] === undefined ? {} : { ref: refs[0][1]! }),
        })
      }
    }
    offset += line.length + 1
  }
  if (spans.length !== peers.length) return undefined
  if (spans.some((span, ordinal) => span.name !== peers[ordinal]!.element.name ||
    (span.ref !== undefined && span.ref !== String(peers[ordinal]!.element.ref)))) return undefined
  const span = spans[peers.findIndex(peer => peer.position === index)]
  if (span === undefined) return undefined
  return tree.slice(0, span.start) + replacement + tree.slice(span.start + span.name.length)
}

function deriveCassette(input: {
  seed: LeafCassette
  anchor: GoldAnchorDescriptor
  selection: SurfaceSelection
  cassetteId: string
  /** The rendered tree with the target already renamed — resolved by the caller, which is
   * where an unresolvable target becomes a typed inapplicability rather than a silent no-op. */
  tree: string
  /** Present only for a hostile family: the anchor follows its target's new identity. */
  retargetTo?: string
}): LeafCassette | undefined {
  const { seed, anchor, selection, cassetteId, retargetTo, tree } = input
  const elements = withMutatedName(
    seed.input.stateBefore.elements,
    selection.index,
    selection.mutatedName,
  )
  const stateBefore: ScreenState = { ...seed.input.stateBefore, elements, tree }
  const inputLeg = { ...seed.input, stateBefore }
  const descriptors = retargetDescriptors(seed.input.stateBefore.elements, elements, [
    anchor, ...seed.sidecar.equivalenceSet,
  ])
  if (descriptors === undefined) return undefined
  const sidecar =
    retargetTo === undefined
      ? seed.sidecar
      : {
          ...seed.sidecar,
          goldAnchor: descriptors[0]!,
          equivalenceSet: descriptors.slice(1),
        }
  return {
    ...seed,
    id: cassetteId,
    input: inputLeg,
    sidecar,
    // The label LEG is the as-extracted snapshot and is copied verbatim (D-01 store law);
    // the authoritative derived label is the standalone record beside it.
    label: { ...seed.label },
    receipt: {
      ...seed.receipt,
      promptInputHash: sha256hex(canonicalizeInputLeg(inputLeg)),
      screenStateHash: screenStateHash(stateBefore),
    },
  }
}

/** Everything a seed must satisfy before any family is attempted, in a fixed order. */
function seedInapplicability(seed: AdversarialSeed): AdversarialInapplicability | undefined {
  if (seed.entry.split !== 'natural') return 'not-natural'
  if (!isProofBacked(seed.cassette)) return 'brief-not-proof-backed'
  if (seed.cassette.sidecar.goldAnchor === undefined) return 'gold-anchor-absent'
  const goldIndex = resolveDescriptorIndex(
    seed.cassette.input.stateBefore.elements,
    seed.cassette.sidecar.goldAnchor,
  )
  if (goldIndex < 0) return 'gold-anchor-unresolved'
  if (seed.label === undefined) return 'seed-label-absent'
  if (seed.cassette.input.stateBefore.elements[goldIndex]!.name.trim() === '') {
    return 'target-name-empty'
  }
  return undefined
}

function isUsableSeed(seed: AdversarialSeed | undefined): seed is AdversarialSeed {
  return (
    seed !== undefined &&
    seed !== null &&
    typeof seed.cassette?.id === 'string' &&
    seed.cassette.id !== '' &&
    seed.entry !== undefined &&
    seed.cassette.input?.stateBefore?.elements !== undefined
  )
}

/**
 * Derive one variant per eligible `(seed, mutator)` pair (D-07: exactly one, never N).
 *
 * Everything that does not produce a variant produces an OUTCOME row. That is the contract
 * the staging report and the census read: a refresh that stages nothing must be able to say
 * why, seed by seed, rather than reporting an empty batch. Rows are emitted in seed-id
 * ascending order and then in DECLARED mutator order, independent of the caller's ordering,
 * so two runs over one corpus serialise identically (D-07).
 */
export function generateAdversarialVariants(
  input: GenerateAdversarialVariantsInput,
): GenerateAdversarialVariantsResult {
  const requested = new Set(input.mutators ?? ADVERSARIAL_GENERATED_MUTATORS)
  const mutators = ADVERSARIAL_MUTATORS.filter(mutator => requested.has(mutator))
  const derivedIds = new Set(input.existingCassetteIds ?? [])
  const maxSeeds = input.maxSeeds ?? ADVERSARIAL_DEFAULT_MAX_SEEDS_PER_REFRESH
  const outcomes: AdversarialGenerationOutcome[] = []

  // A null, undefined or structurally incomplete seed is DATA, not a crash: it is reported
  // before anything tries to sort on its identity.
  const usable: AdversarialSeed[] = []
  for (const seed of input.seeds) {
    if (isUsableSeed(seed)) usable.push(seed)
    else outcomes.push({ kind: 'inapplicable', seedCassetteId: '', reason: 'seed-malformed' })
  }

  // Deterministic seed order: the cap must defer the SAME seeds on two runs over one corpus.
  const ordered = [...usable].sort((left, right) =>
    left.cassette.id < right.cassette.id ? -1 : left.cassette.id > right.cassette.id ? 1 : 0,
  )

  let considered = 0
  let deferred = 0
  for (const seed of ordered) {
    const seedCassetteId = seed.cassette.id
    const ineligible = seedInapplicability(seed)
    if (ineligible !== undefined) {
      outcomes.push({ kind: 'inapplicable', seedCassetteId, reason: ineligible })
      continue
    }
    if (considered >= maxSeeds) {
      deferred += 1
      outcomes.push({ kind: 'inapplicable', seedCassetteId, reason: 'cap-exceeded' })
      continue
    }
    considered += 1

    const anchor = seed.cassette.sidecar.goldAnchor!
    const elements = seed.cassette.input.stateBefore.elements
    const goldIndex = resolveDescriptorIndex(elements, anchor)
    const descriptors = [anchor, ...seed.cassette.sidecar.equivalenceSet]

    for (const mutator of mutators) {
      if (!isGenerated(mutator)) {
        outcomes.push({
          kind: 'inapplicable',
          seedCassetteId,
          mutator,
          reason: 'mutator-not-generated',
        })
        continue
      }
      const kind = ADVERSARIAL_TABLES[mutator].kind
      const cassetteId = deriveAdversarialCassetteId({
        seedCassetteId,
        kind,
        mutator,
        tableVersion: ADVERSARIAL_TABLE_VERSION,
      })
      if (derivedIds.has(cassetteId)) {
        outcomes.push({ kind: 'inapplicable', seedCassetteId, mutator, reason: 'already-derived' })
        continue
      }
      const selection = selectSurface({
        seedCassetteId,
        mutator,
        elements,
        descriptors,
        anchor,
        goldIndex,
      })
      if (typeof selection === 'string') {
        outcomes.push({ kind: 'inapplicable', seedCassetteId, mutator, reason: selection })
        continue
      }
      // THE TREE MUST ACTUALLY CARRY THE CONTROL WE ARE ABOUT TO RENAME, at the position
      // `elements` says it is. A needle the tree does not hold used to rewrite nothing and say
      // nothing: the pair still derived, still staged, still admitted, and still counted as an
      // adversarial variant, while a planner reading the rendered tree saw the UNPERTURBED
      // label. That is a case that measures nothing while reporting as staged.
      const rewrittenTree = rewriteElementNameInTree({
        tree: seed.cassette.input.stateBefore.tree,
        elements,
        index: selection.index,
        replacement: selection.mutatedName,
      })
      if (rewrittenTree === undefined) {
        outcomes.push({
          kind: 'inapplicable',
          seedCassetteId,
          mutator,
          reason: 'tree-target-unresolved',
        })
        continue
      }
      const perturbedGoldTarget = selection.index === goldIndex
      const derived = deriveCassette({
        seed: seed.cassette,
        anchor,
        selection,
        cassetteId,
        tree: rewrittenTree,
        ...(ADVERSARIAL_TABLES[mutator].hostile
          ? { retargetTo: normalizeAccessibleName(selection.mutatedName) }
          : {}),
      })
      if (derived === undefined) {
        outcomes.push({ kind: 'inapplicable', seedCassetteId, mutator, reason: 'gold-anchor-unresolved' })
        continue
      }
      const generator: CorpusGenerator = {
        kind,
        seedCassetteId,
        generatorVersion: ADVERSARIAL_GENERATOR_VERSION,
        mutator,
        tableVersion: ADVERSARIAL_TABLE_VERSION,
        tableHash: ADVERSARIAL_TABLE_HASH,
      }
      const corpusEntry = projectCorpusEntry({
        cassette: derived,
        product: input.product,
        // D-06: the SEED's run, so ROOT-03 keeps excluding the breeding run from gating.
        runId: seed.entry.run_links.runId,
        assignment: { split: 'adversarial', generator },
        ...(seed.entry.captured_at === undefined ? {} : { capturedAt: seed.entry.captured_at }),
        ...(seed.entry.targetEnvironment === undefined
          ? {}
          : { targetEnvironment: seed.entry.targetEnvironment }),
      }) as AdversarialCorpusEntry
      derivedIds.add(cassetteId)
      outcomes.push({
        kind: 'derived',
        seedCassetteId,
        mutator,
        variant: {
          cassette: derived,
          corpusEntry,
          labelRecord: deriveAdversarialLabel({
            cassette: derived,
            seedLabel: seed.label!,
            generator,
          }),
          generator,
          seedCassetteId,
          mutator,
          tableEntryId: selection.entry.id,
          perturbedGoldTarget,
          blobShas: [...derived.blobs],
        },
      })
    }
  }

  return {
    variants: outcomes.flatMap(outcome => (outcome.kind === 'derived' ? [outcome.variant] : [])),
    skips: outcomes.flatMap(outcome =>
      outcome.kind === 'inapplicable'
        ? [
            {
              seedCassetteId: outcome.seedCassetteId,
              ...(outcome.mutator === undefined ? {} : { mutator: outcome.mutator }),
              reason: outcome.reason,
            },
          ]
        : [],
    ),
    outcomes,
    seedsConsidered: considered,
    seedsDeferred: deferred,
  }
}
