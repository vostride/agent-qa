// 2026-09-11, 422 D-04/D-08: the durable adversarial refresh record — what a capped refresh
// already decided, so the next one does not spend its cap deciding it again.
//
// The problem this store exists to solve. A refresh is capped (D-04) because eleven frozen
// families over a grown corpus produce more cases than any operator reviews. A cap alone,
// however, starves the corpus: the seeds are selected in one deterministic order, so unless
// something on disk records that a leading seed is DONE, the same leading seeds are re-selected
// every time and the seeds behind them are never reached. Staged and committed cassette ids
// cover the seeds that produced a variant. They say nothing about the ones that produced an
// inapplicability — and those are exactly the seeds that would monopolise the cap forever,
// because they leave no trace to skip.
//
// The key (D-08). A completed `(seed, mutator)` tuple is settled for the table GENERATION it was
// decided under, and for nothing else: a `tableVersion` bump is a NEW generation. Its ids are
// different ids, so its tuples are open again — and it retires nothing:
// `derivedAdversarialCassetteIds` spans every generation, so an id committed under generation 1
// is never re-derived beneath a later one. Since 441-53 (D-15) no guardrail policy scopes a
// tuple; a record written before then carries a policy digest and is read as malformed (D-20).
//
// Publication. A record is named by its own content digest and linked
// into place write-once, with the file and its directory fsynced. Two refreshes racing over one
// unchanged corpus derive the same ids and settle the same tuples, so they publish the SAME
// bytes under the SAME name — an idempotent no-op rather than two competing histories. Different
// bytes under one name is a conflict and throws; this record is the audit trail a later refresh
// trusts, so overwriting it silently would let a bad write erase the reason a seed was skipped.
//
// Deliberately absent: a timestamp. `stagedAt` sits outside the batch digest for the same reason
// (422-01) — a clock reading inside the canonical bytes would make two identical concurrent
// refreshes conflict, which is precisely the collision this write-once shape exists to absorb.
// A record's time is its file mtime and its commit, not a field the content address depends on.

import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

import {
  ADVERSARIAL_CAP_SOURCES,
  ADVERSARIAL_DEFAULT_MAX_SEEDS_PER_REFRESH,
  ADVERSARIAL_MUTATORS,
  PROBE_GENERATOR_KINDS,
  canonicalJson,
  probeReservationStatus,
  type AdversarialCapSource,
  type AdversarialMutator,
  type ProbeGeneratorKind,
} from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'
import { z } from 'zod'

/**
 * Durable refresh state lives BESIDE the staging tree, never inside it: a staged batch
 * directory is reviewable data an operator may delete after admitting or rejecting it, and the
 * record of what was already decided must outlive that.
 */
export const ADVERSARIAL_STATE_SUBDIR = 'eval/adversarial-state'

export const ADVERSARIAL_STATE_SCHEMA_VERSION = 2

/**
 * The separator the settled-tuple key joins on — the `adversarialDrawKey` idiom. No cassette id
 * and no mutator can contain U+001F, so `(a, bc)` and `(ab, c)` can never collide into one key.
 */
const TUPLE_KEY_SEPARATOR = '\u001F'

const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const digestField = z.string().regex(LOWER_HEX_64)

/**
 * What a completed `(seed, mutator)` tuple resolved to.
 *
 * Both are COMPLETED work. `derived` produced reviewable bytes; `inapplicable` is the
 * generator's own typed statement that the family cannot act on this seed. A tuple that is
 * merely DEFERRED (`cap-exceeded`) or that was already settled earlier (`already-derived`) is not
 * an outcome and never lands here — recording either would settle work nobody did.
 */
export type AdversarialTupleOutcome = 'derived' | 'inapplicable'

export interface AdversarialRefreshTuple {
  seedCassetteId: string
  mutator: AdversarialMutator
  /** The derived id this tuple addresses — stable across outcomes, because it is a function of the generation, not of the result (D-08). */
  cassetteId: string
  outcome: AdversarialTupleOutcome
  /** The inapplicability reason for `inapplicable`; absent for `derived`. */
  detail?: string
}

/**
 * The resolved cap and where the operator set it — recorded so a refresh can explain itself.
 *
 * 2026-09-12, 422-22: `source` names the NEUTRAL vocabulary rather than re-spelling it. This
 * record is persisted, and a storage-side copy of a persisted vocabulary is a second list to keep
 * in step with the first — which is how one of them ends up admitting an origin the other refuses.
 */
export interface AdversarialSeedCap {
  value: number
  source: AdversarialCapSource
}

export interface AdversarialRefreshRecord {
  schemaVersion: typeof ADVERSARIAL_STATE_SCHEMA_VERSION
  product: string
  /** The frozen table generation these outcomes were decided under. */
  tableVersion: number
  /** The committed corpus digest this refresh read its seeds from. */
  sourceDigest: string
  cap: AdversarialSeedCap
  /** Novel eligible seeds counted BEFORE the cap was applied. */
  eligibleSeeds: number
  /** Novel eligible seeds the cap deferred to a later refresh. */
  excessSeeds: number
  /** Immutable batch membership: the seed ids this refresh selected, ascending. */
  seedIds: readonly string[]
  tuples: readonly AdversarialRefreshTuple[]
}

const tupleSchema = z.object({
  seedCassetteId: z.string().min(1),
  mutator: z.enum(ADVERSARIAL_MUTATORS),
  cassetteId: z.string().min(1),
  outcome: z.enum(['derived', 'inapplicable']),
  detail: z.string().min(1).optional(),
}).strict()

const recordSchema = z.object({
  schemaVersion: z.literal(ADVERSARIAL_STATE_SCHEMA_VERSION),
  product: z.string().min(1),
  tableVersion: z.number().int().nonnegative(),
  sourceDigest: digestField,
  cap: z.object({
    value: z.number().int().positive(),
    source: z.enum(ADVERSARIAL_CAP_SOURCES),
  }).strict(),
  eligibleSeeds: z.number().int().nonnegative(),
  excessSeeds: z.number().int().nonnegative(),
  seedIds: z.array(z.string().min(1)),
  tuples: z.array(tupleSchema),
}).strict()

/** The record's own content address — its file name, and the whole of its identity. */
export function adversarialRefreshRecordDigest(record: AdversarialRefreshRecord): string {
  return createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex')
}

/** The settled-tuple key. Public so a caller can build the same key it will be checked against. */
export function adversarialTupleKey(seedCassetteId: string, mutator: AdversarialMutator): string {
  return `${seedCassetteId}${TUPLE_KEY_SEPARATOR}${mutator}`
}

/**
 * Resolve the per-refresh seed cap (D-04).
 *
 * Every rejected boundary is rejected LOUDLY: zero, negative, fractional, nonfinite and
 * beyond-safe-integer caps are a TypeError rather than a silent fallback to the default. A cap
 * that quietly becomes 8 because the operator typed `0` is a cap the operator does not have.
 */
export function resolveAdversarialSeedCap(input: {
  value?: number
  source?: Exclude<AdversarialCapSource, 'default'>
}): AdversarialSeedCap {
  if (input.value === undefined) {
    return { value: ADVERSARIAL_DEFAULT_MAX_SEEDS_PER_REFRESH, source: 'default' }
  }
  if (!Number.isSafeInteger(input.value) || input.value < 1) {
    throw new TypeError('adversarial seed cap must be a positive safe integer')
  }
  return { value: input.value, source: input.source ?? 'flag' }
}

// ---------------------------------------------------------------------------
// Guarded local IO (the staging composition's posture, on this store's own tree).
// ---------------------------------------------------------------------------

function pathPresent(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Refuse links and wrong-kind ancestors rather than following a state path out of its root. */
function requireDirectories(path: string): void {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent !== absolute) requireDirectories(parent)
  if (pathPresent(absolute) && !lstatSync(absolute).isDirectory()) {
    throw new TypeError('unsafe adversarial state directory')
  }
}

/**
 * The product's state directory under a REAL root.
 *
 * `realpathSync` matches the staging composition's posture and is not cosmetic: the
 * ancestor-kind walk below refuses any non-directory component, and on macOS `/tmp` is itself a
 * symlink — an unresolved path would make every host whose root sits under a linked ancestor
 * look unsafe.
 */
function productStateDir(agentQaRoot: string, product: string): string {
  return join(realpathSync(agentQaRoot), ADVERSARIAL_STATE_SUBDIR, slugBranch(product))
}

function recordText(record: AdversarialRefreshRecord): string {
  return `${canonicalJson(record)}\n`
}

/**
 * Every published refresh record for one product, in file-name order.
 *
 * An absent tree is an empty history, not a failure — the first refresh on a host has no state
 * and must not be told the store is broken. A record that fails the strict schema (one written
 * before Phase 441 carries a policy digest) is absent too: D-20 migrates nothing (441-64, CR-C02).
 * Unparseable bytes, and a record that parses but whose digest name or product does not match,
 * are still failures.
 */
export function readAdversarialRefreshRecords(input: {
  agentQaRoot: string
  product: string
}): AdversarialRefreshRecord[] {
  if (!pathPresent(input.agentQaRoot)) return []
  const dir = productStateDir(input.agentQaRoot, input.product)
  requireDirectories(dir)
  if (!pathPresent(dir)) return []
  const names = readdirSync(dir, { withFileTypes: true })
    .filter(entry => {
      if (entry.name.startsWith('.')) return false
      if (!entry.isFile()) throw new TypeError('unexpected adversarial state path')
      return entry.name.endsWith('.json')
    })
    .map(entry => entry.name)
    .sort()
  return names.flatMap(name => {
    const parsed = recordSchema.safeParse(JSON.parse(readFileSync(join(dir, name), 'utf8')))
    if (!parsed.success) return []
    const record = parsed.data as AdversarialRefreshRecord
    if (`${adversarialRefreshRecordDigest(record)}.json` !== name) {
      throw new TypeError('adversarial refresh record identity mismatch')
    }
    if (slugBranch(record.product) !== slugBranch(input.product)) {
      throw new TypeError('adversarial refresh record product mismatch')
    }
    return [record]
  })
}

/**
 * Publish one refresh record write-once, under its own content address.
 *
 * `unchanged` means the identical record was already published — the concurrent-refresh case,
 * and the re-run-over-an-unchanged-corpus case. Anything else under that name is a conflict.
 */
export function publishAdversarialRefreshRecord(input: {
  agentQaRoot: string
  record: AdversarialRefreshRecord
}): 'published' | 'unchanged' {
  const record = recordSchema.parse(input.record) as AdversarialRefreshRecord
  mkdirSync(input.agentQaRoot, { recursive: true })
  const dir = productStateDir(input.agentQaRoot, record.product)
  requireDirectories(dir)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${adversarialRefreshRecordDigest(record)}.json`)
  const text = recordText(record)
  const temporary = join(dir, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    const fd = openSync(temporary, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    let published: 'published' | 'unchanged' = 'published'
    try {
      linkSync(temporary, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (readFileSync(file, 'utf8') !== text) {
        throw new Error('adversarial refresh record conflict')
      }
      published = 'unchanged'
    }
    const directory = openSync(dir, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    return published
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * The `(seed, mutator)` tuples already decided under THIS generation.
 *
 * A refresh skips these, which is what lets its cap reach the seeds behind them. Scoping by the
 * generation is the whole contract: a new generation does not inherit a decision that was not
 * made about it.
 */
export function settledAdversarialTuples(
  records: readonly AdversarialRefreshRecord[],
  scope: { tableVersion: number },
): ReadonlySet<string> {
  return new Set(settledAdversarialTupleIndex(records, scope).keys())
}

/**
 * The same scoped settlement, keyed so a caller can say WHY a tuple was skipped.
 *
 * A refresh that silently drops a settled seed reports an empty batch with no explanation,
 * which is the disclosure regression a bounded refresh must not introduce: the operator has to
 * be able to tell "nothing new applies" from "nothing ran".
 */
export function settledAdversarialTupleIndex(
  records: readonly AdversarialRefreshRecord[],
  scope: { tableVersion: number },
): ReadonlyMap<string, AdversarialRefreshTuple> {
  const settled = new Map<string, AdversarialRefreshTuple>()
  for (const record of records) {
    if (record.tableVersion !== scope.tableVersion) continue
    for (const tuple of record.tuples) {
      settled.set(adversarialTupleKey(tuple.seedCassetteId, tuple.mutator), tuple)
    }
  }
  return settled
}

/**
 * Every id this product has EVER derived, across all generations.
 *
 * Unscoped on purpose (D-08): a generation bump creates new ids beside the old, and the old
 * ones are committed history. Re-deriving one would address bytes that already exist, so this
 * set only ever grows.
 */
export function derivedAdversarialCassetteIds(
  records: readonly AdversarialRefreshRecord[],
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const record of records) {
    for (const tuple of record.tuples) {
      if (tuple.outcome === 'derived') ids.add(tuple.cassetteId)
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// 422 D-04/D-11: the PROBE RESERVATION store — an ask that is durable before it is asked.
//
// WHY THIS IS A SECOND STORE AND NOT AN ARM OF THE RECORD ABOVE. `AdversarialRefreshRecord` is
// named by its own content digest, which is exactly what lets two concurrent refreshes over one
// unchanged corpus publish the same bytes instead of fighting. A reservation cannot work that
// way: its content is a claim about work that has NOT happened yet, so the outcome is unknown at
// the moment the name would have to be computed, and content-addressing a row whose content
// changes is a contradiction. 422-03 recorded that its record "will need a reservation arm"; the
// truthful answer is that it needs a SIBLING, and the property that makes the record good is
// precisely the property that stops it from carrying one.
//
// THREE STATES, ENCODED STRUCTURALLY. `unattempted` is no reservation. `completed` is a
// reservation plus a completion. `interrupted` is a reservation with NO completion — and it is
// derived rather than written, because the one thing a dying process cannot do is record that it
// died. A status field would have to be updated by the very code that failed to run.
//
// WHAT A RESERVATION MAY SAY. Its KEY is `(product, seed, kind, promptVersion)` and nothing else
// (D-11): not the returned text, which does not exist yet, and not the author, because a second
// host with a second model must not buy a second copy of a probe this corpus already holds. Its
// BODY names the author by DIGEST and family rather than by raw model id — a configured model id
// can itself embed a credential (422-05).
// ---------------------------------------------------------------------------

/**
 * Probe reservations live beside the refresh-state tree, never inside a staged batch: a batch is
 * reviewable data an operator may delete, and the record of what was already PAID FOR must
 * outlive that even more emphatically than the record of what was already decided.
 */
export const ADVERSARIAL_PROBE_SUBDIR = 'eval/adversarial-probes'

export const ADVERSARIAL_PROBE_SCHEMA_VERSION = 2

/** D-11's idempotence key, as durable fields. */
export interface ProbeReservationKey {
  product: string
  seedCassetteId: string
  kind: ProbeGeneratorKind
  promptVersion: number
}

/** The row written BEFORE a provider is contacted. Its existence is the charge. */
export interface ProbeReservation extends ProbeReservationKey {
  schemaVersion: typeof ADVERSARIAL_PROBE_SCHEMA_VERSION
  /** The frozen prompt hash the request was rendered from. */
  promptHash: string
  /** sha256 of the configured model id — never the id, which can embed a credential. */
  authorDigest: string
  /** The resolved provider family, which cannot. */
  authorFamily: string
}

/**
 * What a provider call resolved to.
 *
 * All four are ANSWERS — the port returned control. `derived` carries the authored text so a
 * later refresh can re-derive the same case for free; `refused` is a policy block recorded
 * before 441-42 and only read back now, `invalid` an
 * answer the pure contract rejected, and `error` a call that failed. None of the last three
 * carries text: a refused surface is data, not a diagnostic.
 */
export type ProbeCompletionOutcome = 'derived' | 'refused' | 'invalid' | 'error'

export interface ProbeCompletion {
  schemaVersion: typeof ADVERSARIAL_PROBE_SCHEMA_VERSION
  outcome: ProbeCompletionOutcome
  /** Present only on `derived`: the authored text and the id it produced. */
  text?: string
  cassetteId?: string
  /** Reported spend, present only when the provider reported it. ABSENT is not zero. */
  promptTokens?: number
  completionTokens?: number
  /** The firing detector or the refusal reason; never the refused text. */
  detail?: string
}

/**
 * The store's answer about one tuple.
 *
 * `usageKnown` is on every arm and is never inferred from a zero: an interrupted attempt and a
 * failed one both have unknown tokens, and reporting them as `0` would make a real charge read
 * as a free one.
 */
export type ProbeAttemptState =
  | { kind: 'unattempted'; usageKnown: false }
  | { kind: 'interrupted'; reservation: ProbeReservation; usageKnown: false }
  | { kind: 'completed'; reservation: ProbeReservation; completion: ProbeCompletion; usageKnown: boolean }

/** Build the durable reservation for one tuple. Pure; the author is reduced to a digest here. */
export function probeReservationOf(
  key: ProbeReservationKey,
  input: { promptHash: string; author: { id: string; family: string } },
): ProbeReservation {
  return {
    schemaVersion: ADVERSARIAL_PROBE_SCHEMA_VERSION,
    ...key,
    promptHash: input.promptHash,
    authorDigest: createHash('sha256').update(input.author.id, 'utf8').digest('hex'),
    authorFamily: input.author.family,
  }
}

const probeReservationSchema = z.object({
  schemaVersion: z.literal(ADVERSARIAL_PROBE_SCHEMA_VERSION),
  product: z.string().min(1),
  seedCassetteId: z.string().min(1),
  kind: z.enum(PROBE_GENERATOR_KINDS),
  promptVersion: z.number().int().nonnegative(),
  promptHash: digestField,
  authorDigest: digestField,
  authorFamily: z.string().min(1),
}).strict()

const probeCompletionSchema = z.object({
  schemaVersion: z.literal(ADVERSARIAL_PROBE_SCHEMA_VERSION),
  outcome: z.enum(['derived', 'refused', 'invalid', 'error']),
  text: z.string().min(1).optional(),
  cassetteId: z.string().min(1).optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  detail: z.string().min(1).optional(),
}).strict()

/** The tuple's address on disk. NOT content-addressed: this names the QUESTION, not the answer. */
function probeTupleDigest(key: ProbeReservationKey): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        product: key.product,
        seedCassetteId: key.seedCassetteId,
        kind: key.kind,
        promptVersion: key.promptVersion,
      }),
      'utf8',
    )
    .digest('hex')
}

function probeStateDir(agentQaRoot: string, product: string): string {
  return join(realpathSync(agentQaRoot), ADVERSARIAL_PROBE_SUBDIR, slugBranch(product))
}

function reservationFileName(key: ProbeReservationKey): string {
  return `${probeTupleDigest(key)}.reservation.json`
}

function completionFileName(key: ProbeReservationKey): string {
  return `${probeTupleDigest(key)}.completion.json`
}

/** Write `text` at `file` exactly once, fsynced, with its directory fsynced behind it. */
function linkOnce(dir: string, file: string, text: string): 'published' | 'exists' {
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    const fd = openSync(temporary, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    let outcome: 'published' | 'exists' = 'published'
    try {
      linkSync(temporary, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      outcome = 'exists'
    }
    const directory = openSync(dir, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    return outcome
  } finally {
    rmSync(temporary, { force: true })
  }
}

function readJsonIfPresent(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Whether a completion's tokens are actually KNOWN.
 *
 * `derived`, `refused` and `invalid` all came back from a provider that reported usage, so both
 * counts are present. `error` never does. The predicate reads the FIELDS rather than the outcome
 * word, so a completion that somehow lacks them is reported as unknown rather than as zero.
 */
function completionUsageKnown(completion: ProbeCompletion): boolean {
  return completion.promptTokens !== undefined && completion.completionTokens !== undefined
}

function attemptStateFrom(dir: string, key: ProbeReservationKey): ProbeAttemptState {
  const rawReservation = readJsonIfPresent(join(dir, reservationFileName(key)))
  if (rawReservation === undefined) return { kind: 'unattempted', usageKnown: false }
  const reservation = probeReservationSchema.parse(rawReservation) as ProbeReservation
  const rawCompletion = readJsonIfPresent(join(dir, completionFileName(key)))
  // THE DERIVATION THAT MATTERS. A reservation with no completion is `interrupted`, and it is
  // read that way rather than written that way because the one thing a dying process cannot do
  // is record that it died. A status field would have to be updated by the code that failed.
  //
  // 2026-09-12, 422-22: the derivation itself is the NEUTRAL `probeReservationStatus`, and the arm
  // takes its name from the word that function returned — so this reader's arm names and the
  // staging report's status words are one vocabulary rather than the same three facts spelled
  // twice. A rename on either side stops compiling here.
  const status = probeReservationStatus({
    reservationRecorded: true,
    completionRecorded: rawCompletion !== undefined,
  })
  if (status === 'interrupted') return { kind: status, reservation, usageKnown: false }
  const completion = probeCompletionSchema.parse(rawCompletion) as ProbeCompletion
  return { kind: 'completed', reservation, completion, usageKnown: completionUsageKnown(completion) }
}

/** What the durable store says about ONE tuple. An absent tree is an empty history, not a failure. */
export function readProbeAttempt(input: {
  agentQaRoot: string
  key: ProbeReservationKey
}): ProbeAttemptState {
  if (!pathPresent(input.agentQaRoot)) return { kind: 'unattempted', usageKnown: false }
  const dir = probeStateDir(input.agentQaRoot, input.key.product)
  requireDirectories(dir)
  if (!pathPresent(dir)) return { kind: 'unattempted', usageKnown: false }
  return attemptStateFrom(dir, input.key)
}

/**
 * Every attempt this product has on disk, in tuple-digest order.
 *
 * The disclosure surface: a report that wants to say "these calls were made and this one is
 * still unanswered" reads it here. A PRESENT but malformed row is a failure, never silently
 * dropped — this is the evidence a later refresh declines to spend on.
 */
export function readProbeAttempts(input: {
  agentQaRoot: string
  product: string
}): ProbeAttemptState[] {
  if (!pathPresent(input.agentQaRoot)) return []
  const dir = probeStateDir(input.agentQaRoot, input.product)
  requireDirectories(dir)
  if (!pathPresent(dir)) return []
  const reservations = readdirSync(dir, { withFileTypes: true })
    .filter(entry => {
      if (entry.name.startsWith('.')) return false
      if (!entry.isFile()) throw new TypeError('unexpected adversarial probe state path')
      return entry.name.endsWith('.reservation.json')
    })
    .map(entry => entry.name)
    .sort()
  return reservations.map(name => {
    const reservation = probeReservationSchema.parse(
      JSON.parse(readFileSync(join(dir, name), 'utf8')),
    ) as ProbeReservation
    if (reservationFileName(reservation) !== name) {
      throw new TypeError('adversarial probe reservation identity mismatch')
    }
    if (slugBranch(reservation.product) !== slugBranch(input.product)) {
      throw new TypeError('adversarial probe reservation product mismatch')
    }
    return attemptStateFrom(dir, reservation)
  })
}

/**
 * Claim the allowance for ONE tuple, exclusively, BEFORE anything reaches a provider.
 *
 * `already-claimed` is not an error and is not a retry: it is the answer a concurrent owner —
 * or a later run over the same disk — must get, together with the reservation that actually
 * exists. Unlike the refresh record above this one is NOT content-addressed, so differing bytes
 * under one name are not a conflict: two hosts with two authors asking the same question is
 * exactly the race this arbitrates, and the first claim wins outright.
 */
export function reserveProbeCall(input: {
  agentQaRoot: string
  reservation: ProbeReservation
}): { kind: 'claimed' | 'already-claimed'; state: ProbeAttemptState } {
  const reservation = probeReservationSchema.parse(input.reservation) as ProbeReservation
  mkdirSync(input.agentQaRoot, { recursive: true })
  const dir = probeStateDir(input.agentQaRoot, reservation.product)
  requireDirectories(dir)
  const file = join(dir, reservationFileName(reservation))
  const outcome = linkOnce(dir, file, `${canonicalJson(reservation)}\n`)
  return {
    kind: outcome === 'published' ? 'claimed' : 'already-claimed',
    state: attemptStateFrom(dir, reservation),
  }
}

/**
 * Record what ONE reserved call resolved to, write-once.
 *
 * Two refusals, both deliberate. A completion for a tuple nothing reserved is refused, because
 * it would show an answer nobody was ever charged for. A SECOND, different completion for one
 * tuple is refused, because the completion is the reason a tuple is closed and overwriting it
 * would erase why — the same law the refresh record keeps, for the same reason. An identical
 * re-write is `unchanged`: a retry that recomputes the same answer is a no-op, not a conflict.
 */
export function completeProbeCall(input: {
  agentQaRoot: string
  key: ProbeReservationKey
  completion: ProbeCompletion
}): 'published' | 'unchanged' {
  const completion = probeCompletionSchema.parse(input.completion) as ProbeCompletion
  if (!pathPresent(input.agentQaRoot)) {
    throw new TypeError('adversarial probe completion without a reservation')
  }
  const dir = probeStateDir(input.agentQaRoot, input.key.product)
  requireDirectories(dir)
  if (!pathPresent(join(dir, reservationFileName(input.key)))) {
    throw new TypeError('adversarial probe completion without a reservation')
  }
  const file = join(dir, completionFileName(input.key))
  const text = `${canonicalJson(completion)}\n`
  if (linkOnce(dir, file, text) === 'published') return 'published'
  if (readFileSync(file, 'utf8') !== text) {
    throw new Error('adversarial probe completion conflict')
  }
  return 'unchanged'
}
