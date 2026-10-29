// Shared by import, so the parent and child processes contend for the same identity and events.

import { CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  QuarantineEntryStateName,
  QuarantineLedgerEvent,
} from '@vostride/agent-qa-schema'

/**
 * The child's whole input surface, as environment variables.
 *
 * Named once here so a parent that forgets one gets a compile error at the object literal rather
 * than a child that reads `undefined` and reports a timeout twenty seconds later.
 */
export const QUARANTINE_CHILD_ENV = {
  /** Gate. Without it the child suite is skipped entirely, so a normal run costs nothing. */
  gate: 'AGENT_QA_QUARANTINE_CHILD',
  role: 'AGENT_QA_QUARANTINE_CHILD_ROLE',
  root: 'AGENT_QA_QUARANTINE_CHILD_ROOT',
  report: 'AGENT_QA_QUARANTINE_CHILD_REPORT',
  ready: 'AGENT_QA_QUARANTINE_CHILD_READY',
  go: 'AGENT_QA_QUARANTINE_CHILD_GO',
  /** Published by the parent from INSIDE its serialized section; see `serialized-add`. */
  inside: 'AGENT_QA_QUARANTINE_CHILD_INSIDE',
  /** Published by the parent when it has left that section and is about to release the lease. */
  insideDone: 'AGENT_QA_QUARANTINE_CHILD_INSIDE_DONE',
  /** Published by the CHILD once it has folded and decided, before it appends anything. */
  folded: 'AGENT_QA_QUARANTINE_CHILD_FOLDED',
  /** Awaited by the child between its fold and its append — the forced interleaving window. */
  resume: 'AGENT_QA_QUARANTINE_CHILD_RESUME',
  rounds: 'AGENT_QA_QUARANTINE_CHILD_ROUNDS',
  burst: 'AGENT_QA_QUARANTINE_CHILD_BURST',
} as const

export type QuarantineChildRole =
  /** The PROTECTED leg: a CLI-shaped writer that acquires the MRSW lease on every verb call. */
  | 'serialized-add'
  /**
   * The CONTROL leg: `operations.add`'s read-fold-decide-append cycle, faithfully replicated with
   * the lease removed and a barrier opened between the fold and the append.
   *
   * A replica rather than the real verb because the real verb has NO seam between its fold and its
   * append — `decide` is straight-line synchronous code (`SynchronousDecision`), `now()` is read
   * BEFORE the ledger, and nothing else is injectable. That absence is itself part of the finding,
   * and it is why a deterministic control cannot be built out of the production call.
   */
  | 'unserialized-cycle'
  /** The tearing leg: raw `appendQuarantineEvents`, no lease anywhere, from both processes. */
  | 'append-burst'

export function parseQuarantineChildRole(value: string | undefined): QuarantineChildRole {
  if (
    value === 'serialized-add'
    || value === 'unserialized-cycle'
    || value === 'append-burst'
  ) {
    return value
  }
  throw new Error(`unsupported ${QUARANTINE_CHILD_ENV.role}: ${String(value)}`)
}

export const PRODUCT = 'example-web'

/** The ONE identity both processes fight over. Shared by import so the key cannot drift. */
export const CONTESTED = {
  product: PRODUCT,
  filePath: 'tests/contested.yaml',
  testName: 'contested case',
} as const

/** The owner each side claims, so a lost update is legible as "whose claim survived". */
export const DAEMON_OWNER = 'daemon-writer'
export const CLI_OWNER = 'cli-writer'

/** Distinct per-writer identities, so leg (a) can assert a SET as well as a count. */
export function writerIdentity(writer: 'parent' | 'child', index: number): {
  product: string
  filePath: string
  testName: string
} {
  return {
    product: PRODUCT,
    filePath: `tests/${writer}.yaml`,
    testName: `${writer}-${String(index)}`,
  }
}

/** Far enough past every stamp below that nothing in the corpus folds to `expired`. */
export const FAR_FUTURE = '2026-12-01T00:00:00.000Z'

/** The instant every assertion folds against — fixed, so no expiry boundary is ever near it. */
export const READ_NOW = '2026-05-01T00:02:00.000Z'

/** A stepping clock in a per-writer minute, so parent and child stamps never collide. */
export function steppingClock(minute: number): () => string {
  let tick = 0
  return () => {
    const stamp = `2026-05-01T00:${String(minute).padStart(2, '0')}:${
      String(tick).padStart(2, '0')
    }.000Z`
    tick += 1
    return stamp
  }
}

export function enteredEvent(
  identity: { product: string; filePath: string; testName: string },
  at: string,
  owner: string,
): QuarantineLedgerEvent {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'entered',
    at,
    product: identity.product,
    filePath: identity.filePath,
    testName: identity.testName,
    fingerprint: 'manual-entry',
    verdictClass: 'unknown',
    owner,
    expiresAt: FAR_FUTURE,
  }
}

export function renewedEvent(
  identity: { product: string; filePath: string; testName: string },
  at: string,
): QuarantineLedgerEvent {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'renewed',
    at,
    product: identity.product,
    filePath: identity.filePath,
    testName: identity.testName,
    expiresAt: FAR_FUTURE,
  }
}

/** One burst line, tagged with the writer that authored it so the file order is attributable. */
export function burstEvent(writer: 'parent' | 'child', index: number): QuarantineLedgerEvent {
  return enteredEvent(
    {
      product: PRODUCT,
      filePath: `tests/burst-${writer}.yaml`,
      testName: `${writer}-burst-${String(index)}`,
    },
    // A distinct stamp per line, padded so a torn line is impossible to mistake for a short one.
    `2026-05-01T00:${writer === 'parent' ? '10' : '11'}:00.${String(index).padStart(3, '0')}Z`,
    writer,
  )
}

// The fold without its release guard, to prove the forced byte sequence really loses an update.
export function foldWithoutReleaseGuard(
  events: readonly QuarantineLedgerEvent[],
): QuarantineEntryStateName | 'absent' {
  let state: QuarantineEntryStateName | 'absent' = 'absent'
  for (const event of events) {
    switch (event.kind) {
      case 'entered':
        state = 'quarantined'
        break
      case 'renewed':
        // THE REMOVED GUARD: the real fold breaks here when the window is already `released`.
        if (state === 'absent') break
        state = 'quarantined'
        break
      case 'released-manual':
      case 'released-auto':
        if (state !== 'absent') state = 'released'
        break
    }
  }
  return state
}
