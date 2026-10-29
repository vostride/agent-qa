// The three quarantine verbs, over the committed ledger.
//
// `QuarantineOperationsPort` is declared in schema and bound at `composeLocalAgent`; this module is
// its ONE implementation, and it owns exactly the three things the port contract deliberately does
// not: the D-12 triage-queue ordering, the pinned default lifetime an absent deadline takes, and
// the instant every event is stamped with. All three are host facts, and a port that accepted them
// as arguments would let a caller decide them.
//
// WALL-CLOCK PURITY BY ARGUMENT. `now` is REQUIRED, not defaulted: this module reads no clock at
// all (asserted by a source scan in its suite), which is 390-01's ledger posture extended to the
// serving layer exactly as 390-03 extended it to the authoring reader. Each verb reads the injected
// clock ONCE and threads that one instant through the fold, the event stamps and the derived
// deadline — two reads inside one call could land either side of a deadline and answer a state the
// caller never asked about.
//
// COMMITTED-TRUTH READ POSTURE. Every verb folds the ledger before it decides anything, and a
// ledger this build cannot read PROPAGATES its typed error rather than degrading to an empty fold.
// Healing there would answer "nothing is quarantined" about a file full of entries — silently
// un-quarantining every one of them, which is the exact silent flip this phase exists to prevent.
//
// WRITES ARE ALL-OR-NOTHING. Every append goes through `appendQuarantineEvents`, whose shape and
// version check runs before a byte reaches the file. The text is written as handed over; no
// detector scans it.
//
// SERIALIZATION IS THIS MODULE'S, and it is taken here rather than assumed about a caller. `release`
// and `add` run their WHOLE read-fold-decide-append cycle inside the MRSW writer lease — acquired
// here, released here, on every exit — or inside the authority a host that already holds the lease
// hands in (`resolveWriterAuthority`; the daemon acquires at startup and would otherwise be told
// `held` by itself). That handed-in authority is CHECKED, not believed: both write verbs
// re-read the monotonic epoch and the lease file before deciding anything, and a process whose
// lease was reclaimed under it — the heartbeat-starved daemon — is refused with the lease module's
// own `WriterAuthorityLostError`, ledger byte-unchanged. WITH ITS BOUNDARY: that
// check runs inside NO lock, unlike the lease module's own `withCurrentWriterAuthority`, so it
// proves the authority was current at the moment of the check rather than for the duration of the
// decide that follows. The window is one synchronous `decide` instead of forever; it is not zero.
// See `lease/under-writer-lease.ts` for the residual in full. Riding an unfenced authority is how a
// reclaimed writer kept appending beside its reclaimer, which the two-OS-process harness measured
// as two `entered` lines for one identity. Serializing only the append would leave the other half
// of the interesting race intact: two writers folding a ledger with no entry for a test would both
// decide `entered` and both append, so the DECISION is inside the scope and there is no await
// point between the read and the write.
// `list` acquires nothing — a reader that took the lease would queue every enumeration behind
// whatever drain is running.
//
// This replaces a claim that serialization was the caller's, "positionally". It was false, and
// statically so: nothing on the path from `invokeFunction('quarantine.add')` to
// `appendQuarantineEvents` held a lease. The two-OS-process byte-interleaving consequence is a
// separately filed human-verification item; what is enforced and pinned here is that a lease held
// by another writer refuses this verb typed, with the ledger byte-unchanged.
//
// THE IDENTITY IS MINTED HERE, AT THE BOUNDARY, ON BOTH NORMALIZED LEGS. The
// ledger is keyed on `(product, filePath, testName)` and every reader compares those bytes with
// `===`, so a verb that stores the spelling a human typed writes into a partition nothing reads.
// `product` is slugged and `filePath` is minted through the host-supplied
// `workspaceRelativeIdentityPath` (see `mintIdentityPath`); `testName` is stored raw, because it
// is the one leg no reader transforms. An input that cannot mint is refused TYPED before a lease
// is taken or a byte is read — see `QuarantineIdentityRefusedError`, and see its division of labour
// with the ledger's own structural write guard.

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

/**
 * Another writer holds the MRSW lease, so the verb declined instead of writing beside it.
 *
 * The port's result unions carry no lease arm by design, so a refusal that is not one of
 * the named outcomes surfaces as a typed throw. The ledger is byte-unchanged when this is raised — the acquisition fails before the
 * read, so nothing was decided either.
 *
 * The holder is carried, not just named in the message, because the operator's next question is
 * always "who?" and the answer is a live pid the CLI can report without re-reading the lease file.
 *
 * WHICH ARM THIS IS (390-12 / WR-03 — the previous wording named only one and read as if it were
 * the whole rule). `acquireWriterLease` answers `held` — and therefore raises this — only when the
 * lease on disk parses AND `deriveWriterLeaseFreshness` calls it FRESH. Against a fresh holder this
 * verb genuinely does not wait and does not delegate: an operator retrying by hand is a better
 * failure mode than a human-facing verb that blocks for as long as a drain takes.
 *
 * Against a STALE holder — one whose heartbeat is older than `LEASE_HEARTBEAT_TTL_MS`, or whose
 * epoch no longer matches the one on disk — nothing is raised at all: the acquisition enters the
 * standard MRSW path and RECLAIMS, bumping the epoch and sweeping staged epochs below it, exactly
 * as the apply path does. So this verb can bump a fence and take a lock another process minted;
 * that routing is deliberate and shared, and the corpus produces it (`RECLAIMS a STALE lease and
 * writes`) rather than leaving the arm asserted only by the code that implements it.
 */
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

/**
 * The `filePath` a caller sent cannot mint the durable identity the ledger is keyed on.
 *
 * Same shape and same reason as the lease refusal above: the port's result unions carry no refusal
 * arm by design, so a refusal that is not one of the named outcomes surfaces as a typed
 * throw. Raised BEFORE the knowledge root is resolved, before the lease is acquired and before a
 * byte is read, so a refused call costs the ledger nothing and the next writer nothing.
 *
 * WHAT THIS OWNS, AND WHAT THE LEDGER'S OWN WRITE GUARD OWNS. They are not two spellings
 * of one rule and neither subsumes the other:
 *
 *  - THIS decides what the identity IS. It is the only gate that knows the checkout root, so it is
 *    the only one that can turn `/Users/me/repo/tests/a.yaml` — a real file inside the workspace,
 *    the exact bytes an operator pastes out of a failure report — into `tests/a.yaml` and ACCEPT
 *    it. The structural guard would refuse that input; refusing it is the wrong answer, because
 *    the operator named a file the workspace genuinely contains.
 *  - The STRUCTURAL guard in `appendQuarantineEvents` decides what the FILE may carry, for every
 *    writer including one that never met a mint. It is a backstop with no host context, and it
 *    throws rather than answering data because a line the reader refuses is corruption.
 *
 * What cannot be canonicalized at all — a path escaping the config directory — is refused here,
 * with the mint's own message carried so the operator learns why rather than that.
 */
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
  /**
   * Mints the durable workspace-relative identity a `filePath` is stored under.
   *
   * Production supplies core's ONE recipe, `workspaceRelativeIdentityPath`, pre-bound to the host's
   * own config directory. INJECTED rather than imported for two independent reasons, and either
   * alone would be sufficient: this package may not depend on `@vostride/agent-qa-core` (only the
   * surface packages may), and — the load-bearing one — the checkout root is a HOST fact these
   * verbs cannot discover. A verb that guessed it would mint identities against the wrong root.
   *
   * REQUIRED, with no default. A default passthrough is exactly the unvalidated pass-through that
   * produced the round-2 regression: the verbs answered `entered` over lines the reader is
   * guaranteed to refuse. An absent mint must be a compile error at the composition that forgot it,
   * not a runtime surprise inside a committed artifact.
   *
   * @throws whatever the mint throws for a path it cannot canonicalize; re-raised as
   * {@link QuarantineIdentityRefusedError}.
   */
  mintIdentityPath: (filePath: string) => string
  /**
   * The writer lease THIS process already holds, when it holds one.
   *
   * Supplied by the daemon host, which acquires at startup and holds for its whole lifetime: a
   * holder that calls `acquireWriterLease` is answered `held` by itself and, unlike the apply path,
   * has nobody to delegate to. Absent on the CLI in-process host, which holds nothing and therefore
   * takes the lease per call.
   *
   * THE VALUE IS CONSULTED FOR FENCING, and this sentence used to say the
   * opposite. It is re-validated against disk on every write verb, so the question it answers is
   * "is this process STILL the holder?" rather than "did this process already serialize itself?".
   * The two are the same question only while nothing reclaims: a daemon whose heartbeat starved
   * and whose lease was then taken answers yes to the second one forever, and the two-OS-process
   * harness measured what that costs — two `entered` lines for one identity, and the verb
   * returning an owner committed truth does not record. See {@link underWriterLease}.
   *
   * AND WHAT THE RE-VALIDATION DOES NOT BUY: it is a read, not a lock. It answers
   * "still the holder?" as of the read, and the decide it licenses runs after it. A reclaim landing
   * between the two is still unfenced. `lease/under-writer-lease.ts` states the residual in full.
   */
  resolveWriterAuthority?: () => { leaseId: string; epoch: number } | undefined
}

/**
 * D-12's triage order, spelled once.
 *
 * Unassigned entries FIRST because they are the queue a human works — an owned entry already has
 * somebody accountable for it. Then `firstEnteredAt` ascending, so the oldest unclaimed
 * suppression is the first thing anyone sees. Ties break on identity bytes, which is what makes
 * the answer a function of the ledger's CONTENT rather than of the order events happened to be
 * appended in: two entries stamped in the same second must not swap places between two reads.
 *
 * THE INSTANT COMPARED IS `firstEnteredAt`, NOT `enteredAt`. A test's place in
 * the queue is set by when its quarantine history BEGAN, so re-entering can never move it back
 * down the list. Comparing the current window's instant did the opposite: a test on its seventh
 * re-entry sorted as the newest thing in the queue, which put the longest-suffering test last —
 * the sort inverted against the purpose stated in the paragraph above it. The two instants are
 * different questions (see `QuarantineEntryState`), and this is the one the triage queue is about.
 */
function triageOrder(left: QuarantineEntryState, right: QuarantineEntryState): number {
  const leftUnassigned = left.owner === QUARANTINE_UNASSIGNED_OWNER
  const rightUnassigned = right.owner === QUARANTINE_UNASSIGNED_OWNER
  if (leftUnassigned !== rightUnassigned) return leftUnassigned ? -1 : 1
  if (left.firstEnteredAt !== right.firstEnteredAt) {
    return left.firstEnteredAt < right.firstEnteredAt ? -1 : 1
  }
  // The subsystem's ONE identity ordering, imported rather than re-spelled. This
  // module's byte comparison is where the shared comparator was lifted FROM — it was already
  // correct here, and the detection ladder's collated spelling was the one deciding committed
  // bytes. Two spellings of one rule is how they came to disagree.
  return compareQuarantineIdentity(left, right)
}

/**
 * The deadline an absent `expiresAt` takes, derived from the SUPPLIED instant.
 *
 * `Date.parse` of a caller's argument is arithmetic, not a clock read. An unparseable `now` is a
 * caller bug, so it surfaces as a thrown RangeError from `toISOString` rather than silently minting
 * a forever entry — the same arm `detection.ts`'s `expiryFrom` documents for its own copy, stated
 * here too because a reader of this function should not have to find the sibling to learn it
 */
function defaultExpiry(now: string): string {
  return new Date(Date.parse(now) + QUARANTINE_DEFAULT_EXPIRY_DAYS * MS_PER_DAY).toISOString()
}

/**
 * This module's serialized section — DELEGATED, since 391, to the one shared spelling of the rule.
 *
 * The whole read-fold-decide-append cycle (never just the append), the handed-in-authority
 * re-validation, the compile-time refusal of an async `decide` and the three exhaustive acquisition
 * arms all live in {@link underKnowledgeWriterLease} now. They moved because the grant verbs mutate
 * a SECOND committed artifact under the SAME writer lease, and a serialization rule written twice
 * is a serialization rule that agrees until it does not — this module's own history is a
 * serialization claim that turned out to be false, so a second copy of the corrected one is exactly
 * the wrong thing to author beside it. Read that module for the ladder, the ordering and the WR-07
 * residual in full.
 *
 * What stays HERE is the one thing that is genuinely this subsystem's: which refusal a held lease
 * raises. The port contract carries no lease arm, so it surfaces as a typed throw, and a
 * throw naming the wrong committed artifact would send an operator looking in the wrong file.
 *
 * The signature is UNCHANGED and the export is kept: the `@ts-expect-error` pin that proves the
 * async-`decide` refusal is a guard rather than a claim points at this name, and a constraint
 * nothing exercises is a claim. Deliberately NOT added to this package's barrel (`src/index.ts`),
 * on 390-11's reasoning about `appendQuarantineEvents`: the committed-write surface only ever
 * shrinks.
 */
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

/**
 * The three verbs over one committed ledger.
 *
 * Each call is a full read-fold-decide-append cycle. Nothing is cached between calls, which is what
 * makes `quarantine.list` and the sentence's ladder clause two readings of ONE live computation
 * (SC4): an event appended between two calls is visible to both.
 */
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

  /**
   * The mint's throw, re-raised typed. Only the mint's failure is caught here: a
   * `slugBranch` that threw would be a bug in this module, not a refusal about the caller's input.
   */
  function mintFilePath(filePath: string): string {
    try {
      return options.mintIdentityPath(filePath)
    } catch (error) {
      throw new QuarantineIdentityRefusedError(filePath, error)
    }
  }

  /**
   * The write verbs' ONE normalization, taken at the boundary before anything decides.
   *
   * TWO of the three identity legs are normalized, and the third deliberately is not. The rule is
   * the same for both: a leg the READER transforms gets a WRITER-side transform, so the ledger keeps
   * one vocabulary instead of two that agree only by convention.
   *
   *  - `product` is SLUGGED. Every reader compares the slugged partition —
   *    `resolveRunQuarantineSnapshot` filters on `entry.product === slugBranch(input.product)`, and
   *    the detection path authors from projection rows already partitioned that way. Storing the raw
   *    spelling wrote a real entry into a partition nothing reads.
   *  - `filePath` is MINTED through {@link QuarantineOperationsOptions.mintIdentityPath} (390-12,
   *    the round-2 regression). Every reader compares `===` against core's workspace-relative
   *    identity, so an absolute path became a permanently refused, unlistable, unreleasable,
   *    self-duplicating line in a COMMITTED artifact, and `./x`, `x\y`, `../x` folded and listed as
   *    `quarantined` while suppressing nothing. This half exists because the round hardened the READ
   *    and the RUN path and left these two verbs — the documented human half of the exit path, the
   *    surface most likely to receive a hand-typed path — as an unvalidated door into the same file.
   *  - `testName` is stored RAW. It is the one leg no reader transforms; inventing a rule for it
   *    here would be the mirror-image defect.
   *
   * Normalizing (rather than refusing a mismatch) is the choice on the merits: a human exit-path
   * verb should DO what was meant. Both rules are idempotent on their own output, so an input
   * already in canonical form round-trips byte-identically and no existing entry moves.
   *
   * Applied once, here, and threaded to all four places the identity is used — the fold lookup, the
   * authored event, the answered entry, and the release join. A rule applied at only one of them is
   * strictly worse than none: the write and the lookup would then disagree with each other as well
   * as with the reader.
   */
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
        // An OPEN window is one no release event has closed — `expired` counts, because D-11 keeps
        // an expired entry listed, renewable AND releasable; it stopped suppressing, it did not
        // vanish. Absent or already-closed answers the named arm and appends nothing: "that test is
        // not quarantined" is an ordinary answer, and an event recording a release that released
        // nothing would put a lie in committed history.
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

        // An open window (suppressing OR lapsed) is EXTENDED rather than reopened, so the ledger
        // keeps one continuous window instead of two overlapping ones. A closed window re-enters —
        // D-10's "re-entry needs no special rule", and the repeated `entered` lines are the history
        // the event log was chosen to keep (390-05: the intended record, not duplication).
        if (entry !== undefined && entry.state !== 'released') {
          append(knowledgeRoot, [{
            schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
            kind: 'renewed',
            at: now,
            product: entry.product,
            filePath: entry.filePath,
            testName: entry.testName,
            expiresAt,
            // OMITTED when the caller named nobody: an absent owner leaves the existing claim (or
            // the unassigned literal) exactly as it was. Writing `unassigned` here would silently
            // UN-claim a window somebody had taken.
            //
            // TWO AUTHORING PATHS, ONE RULE. `ownerForAutoEntry` (detection.ts) makes the same
            // decision for an AUTO re-entry, stated over the prior entry's state: carry across a
            // lapse, start unassigned after a deliberate release. Until 390-18 the rule was
            // written down here and applied only here, and the auto path did exactly what this
            // comment refuses to. If you change one, change the other.
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
