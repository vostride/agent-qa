// No clock crosses this contract: a caller-supplied now would let the caller forge the deadline.

import { z } from 'zod'

import { VERDICT_CLASSES } from '../verdict/verdict'
import { QUARANTINE_ENTRY_STATE_NAMES } from './quarantine-ledger'
import type { QuarantineEntryState } from './quarantine-ledger'

// `satisfies` fails to compile when `QuarantineEntryState` gains a leg the wire lacks.
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

// No filter members: the implementation orders unassigned owners first, and callers never re-sort.
export const QuarantineListInputSchema = z.object({}).strict()

export type QuarantineListInput = z.infer<typeof QuarantineListInputSchema>

/** Every entry the ledger folds to, in the implementation's stable order. */
export const QuarantineListOutputSchema = z.object({
  entries: z.array(QuarantineEntrySchema),
}).strict()

export type QuarantineListOutput = z.infer<typeof QuarantineListOutputSchema>

// `product` and `filePath` arrive raw and are normalized by `createQuarantineOperations`.
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

// One verb: re-adding a quarantined identity is a `renewed` event, not a separate call.
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

// Ordering, the default lifetime and the clock are host facts the implementation owns.
export interface QuarantineOperationsPort {
  list(): Promise<readonly QuarantineEntryState[]>
  release(input: QuarantineReleaseInput): Promise<QuarantineReleaseOutput>
  add(input: QuarantineAddInput): Promise<QuarantineAddOutput>
}
