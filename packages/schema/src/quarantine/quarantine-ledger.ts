// A workspace-relative `filePath` matches the same test on every checkout; an absolute one cannot.

import {
  createVersionGuard,
  VersionGuardError,
} from '../versioning/create-version-guard'
import type { MigrationRegistry } from '../versioning/create-version-guard'
import { isVerdictClass } from '../verdict/verdict'
import type { VerdictClass } from '../verdict/verdict'

// Version 1 holds a machine-local absolute path that no other checkout can interpret.
export const CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION = 2

// No `expired` member: expiry is computed from `expiresAt`, never recorded as an event.
export const QUARANTINE_EVENT_KINDS = [
  'entered',
  'renewed',
  'released-manual',
  'released-auto',
] as const

export type QuarantineEventKind = (typeof QUARANTINE_EVENT_KINDS)[number]

const QUARANTINE_EVENT_KIND_SET: ReadonlySet<string> = new Set(QUARANTINE_EVENT_KINDS)

/** True for exactly the four closed lifecycle actions. */
export function isQuarantineEventKind(value: unknown): value is QuarantineEventKind {
  return typeof value === 'string' && QUARANTINE_EVENT_KIND_SET.has(value)
}

// Honest absence over invented attribution: no git identity or CODEOWNERS guess fills the owner.
export const QUARANTINE_UNASSIGNED_OWNER = 'unassigned'

/** An entry's owner: the unassigned literal, or whatever name a human claimed it under. */
export type QuarantineOwner = typeof QUARANTINE_UNASSIGNED_OWNER | (string & {})

/**
 * Every event carries the version stamp, its kind, the ISO instant it was authored at, and the
 * three legs of stable test identity. Kind-specific fields hang off the arms below.
 */
interface QuarantineEventBase {
  // A literal, not `number`, so an in-tree author cannot stamp a superseded version.
  schemaVersion: typeof CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION
  kind: QuarantineEventKind
  /** ISO-8601 instant, stamped by the CALLER at write time (this module reads no clock). */
  at: string
  /** The slugged product partition, matching the run-outcome projection's own key. */
  product: string
  // Used only for identity, never for file access; an absolute path is refused.
  filePath: string
  testName: string
}

/** A window opens: the fingerprint that crossed, its resolved class, an owner, and a deadline. */
export interface QuarantineEnteredEvent extends QuarantineEventBase {
  kind: 'entered'
  fingerprint: string
  verdictClass: VerdictClass
  owner: QuarantineOwner
  // ISO-8601 deadline stamped at write time; suppression stops when it lapses.
  expiresAt: string
}

// Extends the window, and may claim the owner out of `unassigned`.
export interface QuarantineRenewedEvent extends QuarantineEventBase {
  kind: 'renewed'
  expiresAt: string
  owner?: QuarantineOwner
}

/** A window closes. Identity only — the reason lives in which of the two kinds it is. */
export interface QuarantineReleasedEvent extends QuarantineEventBase {
  kind: 'released-manual' | 'released-auto'
}

export type QuarantineLedgerEvent =
  | QuarantineEnteredEvent
  | QuarantineRenewedEvent
  | QuarantineReleasedEvent

/**
 * Thrown when a stored ledger line declares a `schemaVersion` this build cannot consume: newer
 * than {@link CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION}, or older with no registered migration.
 *
 * The ledger is COMMITTED truth, so this is a hard failure rather than a skipped line — only
 * derived projections heal. A skipped line would silently un-quarantine a test.
 */
export class QuarantineLedgerVersionError extends VersionGuardError {
  constructor(found: number, supported: number) {
    super('QuarantineLedgerEvent', found, supported)
    this.name = 'QuarantineLedgerVersionError'
  }
}

// Empty: migrating a version 1 path would mean guessing the checkout root it was written under.
export const QUARANTINE_LEDGER_MIGRATIONS: MigrationRegistry = {}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** A POSIX root, a Windows drive root (either slash direction), or a UNC/backslash root. */
const ABSOLUTE_PATH_PREFIX = /^([/\\]|[A-Za-z]:[/\\])/

/**
 * A Windows DRIVE-RELATIVE prefix (`C:foo\bar`) — a per-drive cwd-relative path, which
 * {@link ABSOLUTE_PATH_PREFIX} deliberately misses because it carries no root separator. It is not
 * absolute, and it is not the mint's output either.
 */
const DRIVE_RELATIVE_PREFIX = /^[A-Za-z]:/

// No host path module here, and POSIX `isAbsolute` would call `C:\repo\x.yaml` relative.
function isWorkspaceRelativeIdentity(value: string): boolean {
  if (ABSOLUTE_PATH_PREFIX.test(value)) return false
  if (DRIVE_RELATIVE_PREFIX.test(value)) return false
  if (value.includes('\\')) return false
  return value.split('/').every((segment) => segment !== '.' && segment !== '..')
}

// An `entered` event with no `expiresAt` would fold to a forever suppression, so it is refused.
export function hasQuarantineEventShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  if (typeof value.schemaVersion !== 'number') return false
  if (!isQuarantineEventKind(value.kind)) return false
  if (!isNonEmptyString(value.at)) return false
  if (!isNonEmptyString(value.product)) return false
  if (!isNonEmptyString(value.filePath)) return false
  if (!isWorkspaceRelativeIdentity(value.filePath)) return false
  if (!isNonEmptyString(value.testName)) return false

  switch (value.kind) {
    case 'entered':
      return (
        isNonEmptyString(value.fingerprint) &&
        isVerdictClass(value.verdictClass) &&
        isNonEmptyString(value.owner) &&
        isNonEmptyString(value.expiresAt)
      )
    case 'renewed':
      return (
        isNonEmptyString(value.expiresAt) &&
        (!('owner' in value) || isNonEmptyString(value.owner))
      )
    case 'released-manual':
    case 'released-auto':
      return true
  }
}

/**
 * The read side of the ledger version discipline: parse → reject-newer with a typed
 * {@link QuarantineLedgerVersionError} → migrate-older through
 * {@link QUARANTINE_LEDGER_MIGRATIONS} → structural check. Every ledger consumer routes here.
 */
export const guardQuarantineLedgerEvent = createVersionGuard<QuarantineLedgerEvent>({
  name: 'QuarantineLedgerEvent',
  current: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  migrations: QUARANTINE_LEDGER_MIGRATIONS,
  error: QuarantineLedgerVersionError,
  shape: hasQuarantineEventShape,
})

// `expired` does not suppress but stays listed, renewable and releasable; `released` is closed.
export const QUARANTINE_ENTRY_STATE_NAMES = ['quarantined', 'expired', 'released'] as const

export type QuarantineEntryStateName = (typeof QUARANTINE_ENTRY_STATE_NAMES)[number]

// `enteredAt` opens the current window; `firstEnteredAt` starts the history and orders the queue.
export interface QuarantineEntryState {
  product: string
  filePath: string
  testName: string
  fingerprint: string
  verdictClass: VerdictClass
  owner: QuarantineOwner
  enteredAt: string
  expiresAt: string
  /** How many `entered` events this identity has accumulated. A renewal is not one; minimum 1. */
  enteredCount: number
  /** The `at` of this identity's FIRST `entered` event — when its history began. */
  firstEnteredAt: string
  state: QuarantineEntryStateName
}

// `flagged` is never in the ledger; it is here so the recurrence answer renders all three arms.
export type QuarantineLadderState = 'flagged' | 'quarantined' | 'expired'

// Kept small: the handoff is versioned and every field on it is forever.
export interface QuarantineAppliedEntry {
  product: string
  filePath: string
  testName: string
  expiresAt: string
}

/**
 * The STABLE test identity a snapshot entry is matched against — `(filePath, testName)`, never
 * `testId`, which is a per-run explicit id that does not survive to the next build.
 */
export interface QuarantineSnapshotMatch {
  filePath: string
  testName: string
}

// `product` is not compared: the composition layer already filters the snapshot by product.
export function quarantineAppliesToTest(
  applied: readonly QuarantineAppliedEntry[] | undefined,
  test: QuarantineSnapshotMatch,
): boolean {
  if (applied === undefined) return false
  return applied.some(
    (entry) => entry.filePath === test.filePath && entry.testName === test.testName,
  )
}
