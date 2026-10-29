// The three quarantine verbs' wire contract, and the port the ops dispatch through
//
// MINTED IN SCHEMA, not in `agent`. Two packages consume this contract and neither
// may import the other: `agent` declares the op specs against these validators, and
// knowledge-local implements {@link QuarantineOperationsPort} over the committed ledger. A
// port type declared beside the ops would have made the implementing package depend on the
// function layer, which is precisely the dependency the storage-neutral split forbids.
//
// THREE THINGS ARE DELIBERATE HERE:
//
//  1. THE VOCABULARIES ARE IMPORTED (388 C13). The entry DTO's `state` enum is constructed out
//     of the ledger's own {@link QUARANTINE_ENTRY_STATE_NAMES}, and its class enum out of the
//     canonical `VERDICT_CLASSES`. There is no second spelling of either union in this file,
//     so a fourth ledger state cannot arrive with the wire contract still admitting three.
//  2. ABSENCE AND RE-ENTRY ARE RESULT ARMS, NEVER THROWS. `release` on a test that is
//     not quarantined answers `no-entry`; `add` on one that already is answers `renewed`,
//     having extended the expiry and claimed the owner when one was supplied. Both are
//     ordinary states of the world an operator asks about, and a rejected promise would say
//     "that failed" while discarding the entry the caller asked to see. Same reasoning the
//     knowledge apply outcome records for its already-applied arm.
//  3. NO CLOCK CROSSES THIS CONTRACT. `add` may carry an explicit `expiresAt`, but an ABSENT
//     one is not defaulted here — the implementation stamps the pinned default lifetime at
//     write time, exactly as 390-01's fold takes `now` as an argument rather than reading it.
//     A caller-supplied "now" would let the caller forge the deadline the ledger records.

import { z } from 'zod'

import { VERDICT_CLASSES } from '../verdict/verdict'
import { QUARANTINE_ENTRY_STATE_NAMES } from './quarantine-ledger'
import type { QuarantineEntryState } from './quarantine-ledger'

/**
 * One folded ledger entry as every surface lists it — D-13's enumeration contract in full:
 * the three legs of stable test identity, the fingerprint that keyed the window, the resolved
 * class, the owner (D-12's `unassigned` literal until a human claims it), the entry instant,
 * the accumulated re-entry history, the deadline, and the computed state.
 *
 * The owner leg is a non-empty string rather than an enum on purpose: the ledger's own owner
 * type is the unassigned literal widened by whatever name a human claimed it under, so an
 * enum here would be a closed set the ledger deliberately does not have.
 *
 * `enteredCount` and `firstEnteredAt` are the ledger's own DERIVATIONS, not stored
 * bytes — the fold computes them over `entered` events already committed, so nothing about the
 * ledger's version or its migrations moves to carry them. They are on the wire because
 * "this test has re-entered quarantine 7 times, and its history began 214 days ago" is the fact
 * that prompts a human decision, and a surface cannot say it from a row that has no past. HOW a
 * surface phrases that is the surface's decision; this contract only carries the two numbers.
 *
 * The `satisfies` below is this widening's COMPLETENESS ORACLE: `QuarantineEntryState` gaining a
 * leg that this strict object does not carry is a compile error, so the wire contract cannot
 * silently answer less than the fold knows.
 */
export const QuarantineEntrySchema = z.object({
  product: z.string().min(1),
  filePath: z.string().min(1),
  testName: z.string().min(1),
  fingerprint: z.string().min(1),
  verdictClass: z.enum(VERDICT_CLASSES),
  owner: z.string().min(1),
  enteredAt: z.string().min(1),
  expiresAt: z.string().min(1),
  enteredCount: z.number().int().positive(),
  firstEnteredAt: z.string().min(1),
  state: z.enum(QUARANTINE_ENTRY_STATE_NAMES),
}).strict() satisfies z.ZodType<QuarantineEntryState>

/**
 * `quarantine.list` enumerates EVERYTHING the ledger folds to — no filter members.
 *
 * Owner and state filtering are reader concerns downstream (a dashboard column, a CLI flag
 * over the returned rows), and putting them here would have made the verb's answer depend on
 * how it was asked. The triage-queue ordering D-12 requires — unassigned owners first — is
 * the implementation's law, pinned where the implementation lands, never re-sorted by a
 * caller that received the rows.
 */
export const QuarantineListInputSchema = z.object({}).strict()

export type QuarantineListInput = z.infer<typeof QuarantineListInputSchema>

/** Every entry the ledger folds to, in the implementation's stable order. */
export const QuarantineListOutputSchema = z.object({
  entries: z.array(QuarantineEntrySchema),
}).strict()

export type QuarantineListOutput = z.infer<typeof QuarantineListOutputSchema>

/**
 * The three legs of stable test identity — never `testId`, which is per-run and not durable.
 *
 * TWO of the three are accepted RAW here and normalized by the implementation, for one reason: a
 * leg the ledger's READERS transform needs a matching writer-side transform, and a schema that
 * demanded pre-transformed bytes would put the rule in two places and refuse the exact input the
 * human half of the exit path exists to accept. One rule, one home — and the home is
 * `createQuarantineOperations`, at the boundary of both write verbs.
 *
 * `product` lands in the slugged partition every reader compares:
 * `createQuarantineOperations` runs it through `slugBranch`, so a human typing `My Product` reaches
 * the `My-Product` partition `resolveRunQuarantineSnapshot` filters on.
 *
 * `filePath` lands as the durable workspace-relative IDENTITY every reader compares with `===`
 * the same boundary mints it through core's `workspaceRelativeIdentityPath`,
 * pre-bound by the host to its own config directory — which is why the rule cannot live here, in a
 * package that knows no checkout root. A path that cannot be canonicalized for this checkout is
 * refused typed by the implementation rather than stored. Before that mint existed, an absolute
 * path from a failure report became a permanently unreadable line in a COMMITTED artifact.
 *
 * `testName` is the leg no reader transforms, so nothing normalizes it anywhere.
 */
const identityShape = {
  product: z.string().min(1),
  filePath: z.string().min(1),
  testName: z.string().min(1),
} as const

/** `quarantine.release` addresses exactly one quarantined test — the human half of the exit path. */
export const QuarantineReleaseInputSchema = z.object({ ...identityShape }).strict()

export type QuarantineReleaseInput = z.infer<typeof QuarantineReleaseInputSchema>

/**
 * What a release did: the window it closed, or the named absence.
 *
 * `no-entry` is an ARM rather than a refusal because "that test is not quarantined" is an
 * ordinary answer to an ordinary question — a stale entry in someone's notes, a release that
 * already happened, an auto-exit that beat the human to it — and none of those is a broken
 * store. The released arm carries the entry so a surface can say WHAT it released without a
 * second read.
 *
 * The `released` discriminant is THIS VERB's outcome vocabulary and not the ledger's entry
 * state union — the two share a word and nothing else. An entry's state is read off
 * {@link QuarantineEntrySchema}, whose enum is constructed out of the ledger's own const.
 */
export const QuarantineReleaseOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('released'), entry: QuarantineEntrySchema }).strict(),
  z.object({ kind: z.literal('no-entry') }).strict(),
])

export type QuarantineReleaseOutput = z.infer<typeof QuarantineReleaseOutputSchema>

/**
 * `quarantine.add` is manual ENTRY, renewal and the owner claim in one verb.
 *
 * Not three verbs, because in an append-only event log they are one gesture with different
 * prior state: re-adding an already-quarantined identity is a `renewed` event that extends
 * the deadline and claims the owner when one was supplied. Splitting them would have made a
 * caller ask the ledger what state a test is in before it could pick a verb — a read whose
 * answer can change between the two calls.
 *
 * `owner` absent leaves an auto-entry's `unassigned` in place (D-12: honest absence over
 * invented attribution — nothing here stamps a git identity). `expiresAt` absent takes the
 * pinned default lifetime at the implementation.
 */
export const QuarantineAddInputSchema = z.object({
  ...identityShape,
  owner: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
}).strict()

export type QuarantineAddInput = z.infer<typeof QuarantineAddInputSchema>

/**
 * What an add did: opened a window, or extended one that was already open.
 *
 * Both arms carry the resulting entry, so a caller reading `renewed` learns the new deadline
 * and the owner in the same answer that told it the entry already existed. The discriminant is
 * the whole point — "already quarantined" is information an operator acts on, not an error.
 */
export const QuarantineAddOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entered'), entry: QuarantineEntrySchema }).strict(),
  z.object({ kind: z.literal('renewed'), entry: QuarantineEntrySchema }).strict(),
])

export type QuarantineAddOutput = z.infer<typeof QuarantineAddOutputSchema>

/**
 * The injected capability the three ops dispatch through — one OPTIONAL dep, three verbs.
 *
 * One port and not two (a reader plus a writer) because all three verbs need the same
 * substrate: the committed ledger under the knowledge root, folded through the one state fold.
 * The read/write asymmetry that matters is already stated where it is ENFORCED — `list`
 * declares read scopes and a read-only risk descriptor, `release` and `add` declare a write
 * scope and `readOnly: false` — so splitting the port would have restated at the composition
 * root a distinction the gate already makes at every call.
 *
 * `list` answers entries and NOT the wire envelope, so the ordering law and the envelope stay
 * separable: the op wraps, the implementation orders.
 *
 * Implementations own three things this contract deliberately does not: the D-12 triage-queue
 * ordering, the pinned default lifetime an absent `expiresAt` takes, and the wall clock every
 * event instant is stamped with. All three are host facts, and a port that accepted them as
 * arguments would let a caller decide them.
 */
export interface QuarantineOperationsPort {
  list(): Promise<readonly QuarantineEntryState[]>
  release(input: QuarantineReleaseInput): Promise<QuarantineReleaseOutput>
  add(input: QuarantineAddInput): Promise<QuarantineAddOutput>
}
