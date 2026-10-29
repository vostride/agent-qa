// The committed quarantine ledger: read, pure state fold, shape-checked append
//
// `quarantine.jsonl` sits DIRECTLY under the committed knowledge root as its OWN top-level
// artifact beside memory/ and policies/. It is the FIRST committed top-level operational artifact
// — there is no sibling precedent to copy (the build-tag ordinal map lives under the gitignored
// runtime root), so its placement is reconciled against the knowledge-store layout deliberately:
// none of the root ignore rules (memory/index, memory/queue, the lease and epoch markers,
// **/artifacts, skills/.staging) match this filename, which is pinned by a test.
//
// READ POSTURE — refusal as data, never healing to absence. The derived run-outcome projection
// heals malformed bytes to an empty window because it is a rebuildable derivation. This file is
// COMMITTED TRUTH that humans may hand-edit, and healing a quarantine entry to absent
// silently UN-quarantines a test — the exact silent flip this phase exists to prevent. So a line
// that fails to parse or fails the shape guard is REFUSED and surfaced in `refusedLines`, while
// its neighbours still fold. A line declaring a NEWER schemaVersion propagates the typed
// QuarantineLedgerVersionError: a build that cannot read the truth must not guess at it.
//
// WALL-CLOCK PURITY — the fold takes `now` as an argument and this module reads no clock. `at` and
// `expiresAt` are stamped by callers at write time. That is what lets expiry boundaries be
// pinned one second either side with no flake.
//
// WRITE POSTURE — fail-closed on ONE gate. Every append first pre-checks each event against BOTH
// legs the READ's guard ranges — the VERSION IDENTITY (`=== CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION`)
// and schema's `hasQuarantineEventShape`, which is the LAST of that guard's FIVE legs (390-22 /
// IN-02) and asserts only that `schemaVersion` is a NUMBER — and only after all of it does a byte
// reach the file. The pre-check asks "can this ever be read back?" and THROWS: a write the reader
// refuses is corruption of a committed artifact, not a refusal a caller can sensibly carry on from
// (it is invisible to `list`, unreleasable, and duplicates on retry). The text itself is written as
// handed over; no detector scans it. Quarantine events are CODE-authored — threshold crossings, auto-exits, the gated verbs — never model output, which is
// why CTX-FUT-01's propose-only posture deliberately does not bind these writes (D-04; the dated
// posture note lands in REQUIREMENTS.md).
//
// SERIALIZATION belongs to two NAMED callers, and this module is not one of them — it holds no lock
// of its own. Both mechanisms are real and each is enforced in code:
//   - the POST-RUN FOLD appends under a lease the drain already holds. `post-run-tail.ts:458`
//     acquires the writer lease and the fold runs inside that scope.
//   - the GATED VERBS acquire the lease INSIDE `createQuarantineOperations` and release it per
//     call, or ride the handed-in `writerAuthority` when the host process is already the holder
//     (the daemon). The whole read-fold-decide cycle is inside that scope, not just the append.
// This paragraph previously claimed the verb half serialized POSITIONALLY, "because of where the
// callers are invoked from". That was false and statically so — 390-09 / CR-03: no caller on the
// path from `invokeFunction('quarantine.add')` to this function held any lease. It is true now
// because the verb module takes one, not because anything here does.
// The residual is honest and small, and 390-11 / WR-07 closed half of it — say both halves plainly:
//   - SERIALIZATION stays open. A THIRD caller of `appendQuarantineEvents`, added outside those two
//     paths, would be unserialized and would have to take the lease itself.
//   - SHAPE AND VERSION are both closed AT THIS SEAM. A third caller cannot author a structurally
//     unreadable line, because the append pre-checks every event against the read's structural
//     predicate before writing; and it cannot stamp a version the read refuses either, because the
//     same loop compares `schemaVersion` against CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION (390-14 /
//     the structural predicate alone admitted five such versions, since it asks only that
//     the field be a number). That class needed closing here rather than at each caller precisely
//     because the caller set can grow.
//
// IDENTITY — entries are keyed by `(product, filePath, testName)`, never `testId`.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  canonicalJson,
  guardQuarantineLedgerEvent,
  hasQuarantineEventShape,
} from '@vostride/agent-qa-schema'
import type {
  QuarantineEntryState,
  QuarantineEntryStateName,
  QuarantineLedgerEvent,
  QuarantineOwner,
} from '@vostride/agent-qa-schema'
// The identity key, imported rather than re-spelled. The fold below keys entries
// on exactly the bytes the detection ladder and `operations.ts`'s triage queue key on; a second
// copy here is how two folds start disagreeing about which lines are the same test.
//
// THIS IMPORT sits on no cycle BY CONSTRUCTION: `identity.ts` is a leaf with zero import
// statements, so there is no path out of it and therefore none back here. The claim is about this
// edge and nothing more. It replaced a sentence asserting subsystem acyclicity off a check run one
// hop deep, which was false — while the key lived in `detection.ts`, this import closed a four-edge
// value cycle through the window read (`-> detection.ts -> fingerprint-window-read.ts ->
// run-outcomes.ts -> ledger.ts`), round-5 gap 3a. That is why the key moved to a leaf rather than
// getting a longer comment. Other cycles in this subsystem are unaffected and still stand.
import { quarantineIdentityKey } from './identity.js'

/** The ledger's fixed name directly under the committed knowledge root — never caller-supplied. */
export const QUARANTINE_LEDGER_FILENAME = 'quarantine.jsonl'

/** One line the read refused, surfaced as data so a caller can print or audit it. */
export interface RefusedQuarantineLine {
  /** 1-based, so it matches what an editor shows the human who has to fix the file. */
  lineNumber: number
  reason: string
}

export interface QuarantineLedgerRead {
  events: readonly QuarantineLedgerEvent[]
  refusedLines: readonly RefusedQuarantineLine[]
}

/** The ledger's absolute path under one knowledge root. */
export function quarantineLedgerPath(knowledgeRoot: string): string {
  return join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME)
}

/**
 * Read every event the committed ledger carries, in file order.
 *
 * A missing ledger is an EMPTY ledger — no test is quarantined and run behavior is byte-identical
 * to pre-390 (the FLAK-03 empty-input edge). Blank lines are skipped silently; they are whitespace,
 * not damage. Everything else that fails is refused and reported.
 *
 * Throws {@link QuarantineLedgerVersionError} (typed) when a line declares a schemaVersion this
 * build cannot consume — committed truth hard-fails rather than degrading silently.
 */
export function readQuarantineLedger(knowledgeRoot: string): QuarantineLedgerRead {
  let text: string
  try {
    text = readFileSync(quarantineLedgerPath(knowledgeRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], refusedLines: [] }
    }
    throw error
  }

  const events: QuarantineLedgerEvent[] = []
  const refusedLines: RefusedQuarantineLine[] = []

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      refusedLines.push({
        lineNumber: index + 1,
        reason: `unparseable line: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    // The version guard's own reject-newer arm must propagate; only its structural rejection
    // folds to a refusal. Distinguishing them keeps a build-level "cannot read this truth at all"
    // apart from a line-level "this one record is damaged".
    let event: QuarantineLedgerEvent
    try {
      event = guardQuarantineLedgerEvent(parsed)
    } catch (error) {
      if (error instanceof TypeError) {
        refusedLines.push({ lineNumber: index + 1, reason: error.message })
        continue
      }
      throw error
    }
    events.push(event)
  }

  return { events, refusedLines }
}

interface MutableEntry {
  product: string
  filePath: string
  testName: string
  fingerprint: string
  verdictClass: QuarantineEntryState['verdictClass']
  owner: QuarantineOwner
  enteredAt: string
  expiresAt: string
  /** Accumulated across every `entered` event for this key — never reset by the re-entry arm. */
  enteredCount: number
  /** The FIRST `entered` event's instant for this key; set once and carried forward. */
  firstEnteredAt: string
  /** The state the EVENTS put the entry in; expiry is applied against `now` afterwards. */
  eventState: 'quarantined' | 'released'
}

/**
 * Fold the event log into current per-entry state. PURE — identical `(events, now)` inputs answer
 * identically, and no clock is read.
 *
 * Per key, in event order: `entered` opens (or re-opens — D-10's re-entry needs no special rule,
 * the sliding window self-heals) a window carrying owner/expiry/fingerprint/class; `renewed`
 * extends the expiry and claims the owner when one is supplied; either released kind closes it.
 *
 * TWO OF THE ANSWERED FIELDS ARE HISTORY, NOT WINDOW FACTS. `enteredCount` is how many
 * `entered` events this key has accumulated — a renewal extends a window rather than opening one,
 * so it never increments — and `firstEnteredAt` is the first of those events' instant. They are
 * DERIVED here from bytes the log already holds: no new event kind carries them, no migration
 * exists for them and {@link CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION} is unmoved by them. A
 * reader meeting two new fields on a versioned artifact's state type will reasonably ask whether
 * the file format moved; it did not, and every ledger written before this fold existed answers
 * both questions correctly on its next read. This is the question D-03 chose an append-only log to
 * make free, finally being asked.
 *
 * THE TWO INSTANTS ANSWER DIFFERENT QUESTIONS and their names are close enough to be a drift
 * hazard, so: `enteredAt` is WHEN THIS WINDOW OPENED, which is the fact `expiresAt` and the
 * computed state are about; `firstEnteredAt` is WHEN THIS TEST'S QUARANTINE HISTORY BEGAN, which
 * is the fact a human triaging it needs (and the key `triageOrder` sorts on, so that a test on its
 * seventh re-entry cannot present as the newest thing in the queue).
 *
 * A renewal can extend an OPEN window — quarantined or lapsed — but NEVER re-opens a CLOSED one
 * A release is the operator's decision, and re-entry has its own event:
 * `operations.add` already routes a released entry to the `entered` branch, so honoring a `renewed`
 * against a closed window would only ever resurrect a suppression a human deliberately ended. That
 * case is reachable solely through the committed file's documented human-editability — no
 * code path authors it — which is exactly why the fold, not the verb, is where it has to be
 * refused. The guard keys on the EVENT state, never the computed one: a lapsed entry still carries
 * `eventState: 'quarantined'` (expiry is applied after this loop), so D-11's renew-an-expired-entry
 * behavior is untouched.
 *
 * `'expired'` is then COMPUTED, never read from an event: an open window whose `expiresAt` is at or
 * before `now` answers `'expired'`. Its suppression has stopped — the test fails builds again — and
 * the entry stays LISTED, renewable and releasable.
 *
 * SCOPE OF THAT GUARANTEE, stated because it is narrower than it reads: the lapse ends THIS
 * window, not the suppression. A fingerprint still crossing the threshold re-enters on the very
 * next fold with a fresh full-lifetime deadline, so a permanently failing test costs one red build
 * per lifetime and no human decision, indefinitely. Nothing in this fold or in the ladder bounds
 * that repetition (measured 2026-08-06; pinned in `cli/src/__tests__/quarantine-lifecycle.e2e.test.ts`'s
 * multi-cycle leg, and made legible to a human by plan 390-18's re-entry counter). What the lapse
 * IS, honestly: a 30-day review cadence on an indefinitely renewable suppression.
 *
 * `now` is an ISO-8601 instant, compared on the same scale the events are stamped on.
 */
export function foldQuarantineLedgerState(
  events: readonly QuarantineLedgerEvent[],
  now: string,
): QuarantineEntryState[] {
  const entries = new Map<string, MutableEntry>()

  for (const event of events) {
    const key = quarantineIdentityKey(event)
    switch (event.kind) {
      case 'entered': {
        // Read the prior record BEFORE overwriting it. The arm still overwrites every mutable
        // fact — that is deliberate, a re-entry genuinely re-states owner, expiry, fingerprint and
        // class — but two of them are HISTORY rather than facts about the current window, and a
        // whole-record `set` discarded exactly the history D-03 chose an event log to keep.
        const prior = entries.get(key)
        entries.set(key, {
          product: event.product,
          filePath: event.filePath,
          testName: event.testName,
          fingerprint: event.fingerprint,
          verdictClass: event.verdictClass,
          owner: event.owner,
          enteredAt: event.at,
          expiresAt: event.expiresAt,
          enteredCount: (prior?.enteredCount ?? 0) + 1,
          firstEnteredAt: prior?.firstEnteredAt ?? event.at,
          eventState: 'quarantined',
        })
        break
      }
      case 'renewed': {
        const existing = entries.get(key)
        // A renewal with no window to renew is meaningless — refusing to synthesize one keeps the
        // fold honest about what the log actually says (no invented entries reach any surface).
        if (existing === undefined) break
        // Nor does a renewal re-open a CLOSED window: the release stands until an `entered` event
        // says otherwise (WR-04, above).
        if (existing.eventState === 'released') break
        existing.expiresAt = event.expiresAt
        if (event.owner !== undefined) existing.owner = event.owner
        existing.eventState = 'quarantined'
        break
      }
      case 'released-manual':
      case 'released-auto': {
        const existing = entries.get(key)
        if (existing === undefined) break
        existing.eventState = 'released'
        break
      }
    }
  }

  const nowMs = Date.parse(now)
  return [...entries.values()].map((entry) => {
    let state: QuarantineEntryStateName = entry.eventState
    if (state === 'quarantined') {
      const expiresMs = Date.parse(entry.expiresAt)
      // An unparseable deadline is treated as lapsed: the failing test fails builds again, which is
      // the safe direction. Silently suppressing forever on a mangled date is the one outcome D-11
      // exists to make impossible.
      if (Number.isNaN(expiresMs) || expiresMs <= nowMs) state = 'expired'
    }
    return {
      product: entry.product,
      filePath: entry.filePath,
      testName: entry.testName,
      fingerprint: entry.fingerprint,
      verdictClass: entry.verdictClass,
      owner: entry.owner,
      enteredAt: entry.enteredAt,
      expiresAt: entry.expiresAt,
      enteredCount: entry.enteredCount,
      firstEnteredAt: entry.firstEnteredAt,
      state,
    }
  })
}

/** What an append answers: how many lines it wrote. */
export type QuarantineAppendOutcome = { kind: 'appended'; lines: number }

/**
 * Append lifecycle events to the committed ledger, as ONE fail-closed unit.
 *
 * Order is the whole point: shape-check EVERY event → serialize → only then write. Because the
 * check covers the unit, a single refused event withholds its clean siblings too, and the existing
 * file is left byte-unchanged. Partial writes are the failure mode that would leave the committed
 * truth half-updated and a reviewer unable to tell.
 *
 * Throws a `TypeError` naming the offending index — and which leg refused — when an event would
 * not survive {@link readQuarantineLedger}'s own guard, on EITHER of that guard's legs: the version
 * identity or the structural predicate. This is deliberately a
 * THROW rather than an outcome: authoring an unreadable line is a CALLER BUG that would otherwise
 * commit permanent, unlistable, unreleasable damage to a shared artifact.
 *
 * Callers stamp `at` and `expiresAt` themselves: this module reads no clock, which is what
 * keeps both the write path and the fold deterministic.
 */
export function appendQuarantineEvents(
  knowledgeRoot: string,
  events: readonly QuarantineLedgerEvent[],
): QuarantineAppendOutcome {
  if (events.length === 0) return { kind: 'appended', lines: 0 }

  // The write refuses what the read refuses, on BOTH of the read's legs: the VERSION IDENTITY and
  // the STRUCTURAL predicate. One predicate was never enough on its own —
  // `hasQuarantineEventShape` asserts only that `schemaVersion` is a number, while the read
  // (`guardQuarantineLedgerEvent`) additionally requires it to BE the current version, so `3`, `1`,
  // `2.5`, `NaN` and `Infinity` were all admitted here.
  //
  // AND THE READ REFUSES THEM IN TWO DIFFERENT WAYS — stated per member, because an argument for a
  // gate that misdescribes the failure it prevents will be trusted the next time it is quoted
  // (390-22 / WR-02; this paragraph used to claim a whole-file failure for all five, which is
  // false for two of them):
  //
  //   `3`, `1`, `2.5` are FINITE, so they reach the guard's reject-newer and migration-walk legs
  //     and raise the typed `QuarantineLedgerVersionError`, which `readQuarantineLedger` lets
  //     PROPAGATE. One such line hard-fails the WHOLE file, taking `list`, `add` and `release`
  //     down together.
  //
  //   `NaN` and `Infinity` were never writable in that form at all: `canonicalJson` turns a
  //     non-finite number into `null` before a byte reaches disk, so what the reader meets is a
  //     NULL version, which fails the guard's finite-number leg with a plain `TypeError` and folds
  //     into a LINE-LEVEL refusal — the neighbours still fold and all three verbs keep working.
  //     They are refused here for a genuinely different reason than the reader refuses them for.
  //
  // The pre-check ranges both modes identically, and that is the symmetry argument: whichever way
  // the read would refuse a line, no byte of it is written. Splitting the read side does not split
  // the write side.
  //
  // `===`, not `<=`: two of those five are OLDER-side, and `NaN`/`Infinity` fail every ordering
  // comparison silently. The rule widens only if `QUARANTINE_LEDGER_MIGRATIONS` ever stops being
  // empty, at which point it becomes CURRENT plus every version with a registered migration — the
  // read guard's own rule.
  //
  // Why an explicit comparison rather than simply calling `guardQuarantineLedgerEvent` (the read's
  // whole predicate) here: that guard RETURNS a possibly-migrated value, while this append writes
  // the CALLER'S original object. Routing through it would make the write's refusal type depend on
  // the guard's internal leg order and would commit bytes the guard did not return — a latent
  // divergence the permanently-empty migration registry currently hides. The explicit comparison
  // has no such coupling, and it states the rule where the loop already states its sibling.
  //
  // Both legs run before any filesystem call, so a refused unit leaves no byte. The message names
  // the offending index AND which leg refused,
  // so an operator reading the throw can tell a malformed record from a wrong-version one.
  for (let index = 0; index < events.length; index += 1) {
    const version = events[index]?.schemaVersion
    if (version !== CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION) {
      throw new TypeError(
        `quarantine event at index ${String(index)} would be refused by the ledger read: ` +
          `schemaVersion ${String(version)} is not the current version ` +
          `${String(CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION)} — the committed ledger must never ` +
          'carry a line no checkout can consume',
      )
    }
    if (hasQuarantineEventShape(events[index])) continue
    throw new TypeError(
      `quarantine event at index ${String(index)} would be refused by the ledger read: ` +
        'the committed ledger must never carry a line no checkout can consume',
    )
  }

  const lines = events.map((event) => canonicalJson(event))
  mkdirSync(knowledgeRoot, { recursive: true })
  appendFileSync(quarantineLedgerPath(knowledgeRoot), `${lines.join('\n')}\n`, 'utf8')
  return { kind: 'appended', lines: lines.length }
}
