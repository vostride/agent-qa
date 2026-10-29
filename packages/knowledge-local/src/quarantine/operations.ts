// Each verb reads `now` once, and decides and appends inside one lease scope with no await.

import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  slugBranch,
} from '@vostride/agent-qa-schema'
import type {
  QuarantineAddInput,
  QuarantineAddOutput,
  QuarantineEntryState,
  QuarantineLedgerEvent,
  QuarantineOperationsPort,
  QuarantineReleaseInput,
  QuarantineReleaseOutput,
  VerdictClass,
} from '@vostride/agent-qa-schema'

import { underKnowledgeWriterLease } from '../lease/under-writer-lease.js'
import type { SynchronousDecision } from '../lease/under-writer-lease.js'
import type { WriterLease } from '../lease/writer-lease.js'
import { QUARANTINE_DEFAULT_EXPIRY_DAYS, compareQuarantineIdentity } from './detection.js'
import { quarantineIdentityKey } from './identity.js'
import {
  appendQuarantineEvents,
  foldQuarantineLedgerState,
  readQuarantineLedger,
} from './ledger.js'

const MS_PER_DAY = 86_400_000

/**
 * What a manually added window records where an auto-entry records the fingerprint that crossed.
 *
 * A human quarantining a known-broken test is not reporting a recurrence, so there is no window key
 * to carry — and the `entered` event REQUIRES one (an entry with no fingerprint would fail the
 * ledger's own shape guard). A typed literal that cannot be mistaken for a real key is the honest
 * answer: every computed fingerprint contains `::`, this one contains none.
 */
export const QUARANTINE_MANUAL_ENTRY_FINGERPRINT = 'manual-entry'

/**
 * The class a manual entry records: `unknown`, on the merits rather than for convenience.
 *
 * `unknown` is precisely "a failure carrying no verdict" — nothing classified this test, because a
 * human decided to suppress it rather than a detector deciding it recurred. Recording a made-up
 * `flake` would put an assertion nobody made into committed truth, and the detection ladder reads
 * the class of AUTO entries only, so no rule changes behaviour on the strength of this value.
 */
export const QUARANTINE_MANUAL_ENTRY_CLASS: VerdictClass = 'unknown'

// Raised only for a fresh holder; a stale lease is reclaimed and the verb writes.
export class QuarantineLeaseHeldError extends Error {
  constructor(readonly holder: WriterLease) {
    super(
      'the quarantine ledger write was refused: the knowledge writer lease is held by pid '
        + `${holder.pid} (lease ${holder.leaseId}, epoch ${holder.epoch}). `
        + 'Retry once that writer finishes.',
    )
    this.name = 'QuarantineLeaseHeldError'
  }
}

// Raised before the lease or any read, so a refused call costs the ledger nothing.
export class QuarantineIdentityRefusedError extends Error {
  constructor(readonly filePath: string, readonly reason: unknown) {
    super(
      'the quarantine ledger write was refused: this file path cannot mint the durable '
        + `workspace-relative identity the ledger is keyed on: ${filePath} `
        + `(${reason instanceof Error ? reason.message : String(reason)})`,
    )
    this.name = 'QuarantineIdentityRefusedError'
  }
}

export interface QuarantineOperationsOptions {
  /** The committed knowledge root. A FACTORY, because the CLI host resolves it asynchronously. */
  resolveKnowledgeRoot: () => Promise<string> | string
  /** The ONLY way wall clock enters these verbs. Required — see the module head. */
  now: () => string
  // Injected and required: only the host knows the checkout root.
  mintIdentityPath: (filePath: string) => string
  // Re-validated on every write, but as a read, not a lock: a reclaim after it is still unfenced.
  resolveWriterAuthority?: () => { leaseId: string; epoch: number } | undefined
}

// Unassigned first, then `firstEnteredAt` so re-entry never demotes a test, then identity bytes.
function triageOrder(left: QuarantineEntryState, right: QuarantineEntryState): number {
  const leftUnassigned = left.owner === QUARANTINE_UNASSIGNED_OWNER
  const rightUnassigned = right.owner === QUARANTINE_UNASSIGNED_OWNER
  if (leftUnassigned !== rightUnassigned) return leftUnassigned ? -1 : 1
  if (left.firstEnteredAt !== right.firstEnteredAt) {
    return left.firstEnteredAt < right.firstEnteredAt ? -1 : 1
  }
  return compareQuarantineIdentity(left, right)
}

// An unparseable `now` throws a `RangeError` from `toISOString` instead of minting a forever entry.
function defaultExpiry(now: string): string {
  return new Date(Date.parse(now) + QUARANTINE_DEFAULT_EXPIRY_DAYS * MS_PER_DAY).toISOString()
}

// Kept exported because the type-level async-decide test names it; not in the package barrel.
export async function underWriterLease<T>(
  knowledgeRoot: string,
  resolveWriterAuthority: (() => { leaseId: string; epoch: number } | undefined) | undefined,
  decide: () => T & SynchronousDecision<T>,
): Promise<T> {
  return await underKnowledgeWriterLease(
    knowledgeRoot,
    resolveWriterAuthority,
    decide,
    (holder: WriterLease) => new QuarantineLeaseHeldError(holder),
  )
}

// Nothing is cached between calls, so an event appended between two calls is visible to both.
export function createQuarantineOperations(
  options: QuarantineOperationsOptions,
): QuarantineOperationsPort {
  /** One read of the injected clock, one fold against it — the whole state a verb decides on. */
  function readState(knowledgeRoot: string): {
    now: string
    entries: QuarantineEntryState[]
  } {
    const now = options.now()
    // Typed refusals propagate — see the module head. `refusedLines` are the ledger's own
    // line-level damage report and do not stop the neighbours from folding.
    const { events } = readQuarantineLedger(knowledgeRoot)
    return { now, entries: foldQuarantineLedgerState(events, now) }
  }

  /** This composition's serialized section, over the module-scope lease scope. */
  async function serialized<T>(
    knowledgeRoot: string,
    decide: () => T & SynchronousDecision<T>,
  ): Promise<T> {
    return await underWriterLease(knowledgeRoot, options.resolveWriterAuthority, decide)
  }

  function append(knowledgeRoot: string, events: readonly QuarantineLedgerEvent[]): void {
    appendQuarantineEvents(knowledgeRoot, events)
  }

  function entryFor(
    entries: readonly QuarantineEntryState[],
    identity: { product: string; filePath: string; testName: string },
  ): QuarantineEntryState | undefined {
    const key = quarantineIdentityKey(identity)
    return entries.find((entry) => quarantineIdentityKey(entry) === key)
  }

  // Only the mint's throw is caught; a `slugBranch` throw is a bug here, not a refusal.
  function mintFilePath(filePath: string): string {
    try {
      return options.mintIdentityPath(filePath)
    } catch (error) {
      throw new QuarantineIdentityRefusedError(filePath, error)
    }
  }

  // Each leg is stored as readers compare it: `product` slugged, `filePath` minted, `testName` raw.
  function normalize(
    input: { product: string; filePath: string; testName: string },
  ): { product: string; filePath: string; testName: string } {
    return {
      product: slugBranch(input.product),
      filePath: mintFilePath(input.filePath),
      testName: input.testName,
    }
  }

  return {
    async list(): Promise<readonly QuarantineEntryState[]> {
      // Acquisition-free ON PURPOSE: this reads and answers, and a reader that took the writer
      // lease would queue every enumeration behind whatever drain happens to be running.
      const { entries } = readState(await options.resolveKnowledgeRoot())
      // Every state, unfiltered (the op's own contract): an operator deciding what to release
      // needs the expired and released rows as much as the suppressing ones.
      return [...entries].sort(triageOrder)
    },

    async release(input: QuarantineReleaseInput): Promise<QuarantineReleaseOutput> {
      // FIRST, before the root is resolved and before the lease is acquired: an input that cannot
      // mint an identity has no business taking a lock or opening a committed file.
      const identity = normalize(input)
      const knowledgeRoot = await options.resolveKnowledgeRoot()
      return await serialized(knowledgeRoot, () => {
        const { now, entries } = readState(knowledgeRoot)
        const entry = entryFor(entries, identity)
        // `expired` is still releasable; a release of nothing would put a lie in committed history.
        if (entry === undefined || entry.state === 'released') return { kind: 'no-entry' }

        append(knowledgeRoot, [{
          schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
          kind: 'released-manual',
          at: now,
          product: entry.product,
          filePath: entry.filePath,
          testName: entry.testName,
        }])

        // The entry as it stands AFTER the release — a caller reading `released` learns what it
        // closed without a second read, and the state it reports is the post-write one.
        return { kind: 'released', entry: { ...entry, state: 'released' } }
      })
    },

    async add(input: QuarantineAddInput): Promise<QuarantineAddOutput> {
      // Same ordering as `release`, for the same reason: the refusal costs the ledger nothing and
      // the next writer nothing, and an input tripping BOTH this and a held lease answers THIS.
      const identity = normalize(input)
      const knowledgeRoot = await options.resolveKnowledgeRoot()
      return await serialized(knowledgeRoot, () => {
        const { now, entries } = readState(knowledgeRoot)
        const entry = entryFor(entries, identity)
        const expiresAt = input.expiresAt ?? defaultExpiry(now)

        // An open window is extended; a closed one re-enters with a new `entered` line.
        if (entry !== undefined && entry.state !== 'released') {
          append(knowledgeRoot, [{
            schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
            kind: 'renewed',
            at: now,
            product: entry.product,
            filePath: entry.filePath,
            testName: entry.testName,
            expiresAt,
            // An absent owner keeps the claim; `ownerForAutoEntry` follows the same rule.
            ...(input.owner === undefined ? {} : { owner: input.owner }),
          }])
          return {
            kind: 'renewed',
            entry: {
              ...entry,
              owner: input.owner ?? entry.owner,
              expiresAt,
              // A renewal on a lapsed entry puts it back under suppression, which is the whole
              // point of keeping an expired entry renewable.
              state: 'quarantined',
            },
          }
        }

        const owner = input.owner ?? QUARANTINE_UNASSIGNED_OWNER
        append(knowledgeRoot, [{
          schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
          kind: 'entered',
          at: now,
          ...identity,
          fingerprint: QUARANTINE_MANUAL_ENTRY_FINGERPRINT,
          verdictClass: QUARANTINE_MANUAL_ENTRY_CLASS,
          owner,
          expiresAt,
        }])

        return {
          kind: 'entered',
          entry: {
            // The identity that was STORED, never the spelling the caller sent: an answer naming
            // the raw product would tell an operator a partition exists that does not.
            ...identity,
            fingerprint: QUARANTINE_MANUAL_ENTRY_FINGERPRINT,
            verdictClass: QUARANTINE_MANUAL_ENTRY_CLASS,
            owner,
            enteredAt: now,
            expiresAt,
            // The history the NEXT fold of this file will answer, answered here too. This branch
            // is reached both for a first entry and for a re-entry over a CLOSED window, so the
            // count continues the prior entry's rather than restarting — an answer that restarted
            // would disagree with the ledger one read later, and the caller would have no way to
            // know which of the two was lying.
            enteredCount: (entry?.enteredCount ?? 0) + 1,
            firstEnteredAt: entry?.firstEnteredAt ?? now,
            state: 'quarantined',
          },
        }
      })
    },
  }
}
