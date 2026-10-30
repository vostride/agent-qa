// Durable and never rebuilt, because a rebuild would reassign addresses already published.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  formatOrdinalShortId,
  formatSlugShortId,
  isSlugAddressedKind,
} from '@vostride/agent-qa-schema'
import type { EntityKind } from '@vostride/agent-qa-schema'

// Stamped at creation and checked on every open; a mismatch refuses and never migrates.
export const ADDRESSING_LEDGER_USER_VERSION = 2

// Writers wait on the write lock instead of failing, so any process can mint and sqlite arbitrates.
export const ADDRESSING_LEDGER_BUSY_TIMEOUT_MS = 2000

/** The ledger's own file name under the agent-qa root, beside `agent-jobs.db`. */
export const ADDRESSING_LEDGER_DB_FILE = 'entity-addresses.db'

/** A ledger file this build cannot read. Refused before a single schema statement runs. */
export class AddressingLedgerSchemaVersionError extends Error {
  constructor(
    readonly path: string,
    readonly expected: number,
    readonly found: number,
  ) {
    super(
      `The addressing ledger at ${path} is stamped schema version ${String(found)}, but this `
      + `build reads version ${String(expected)}. The ledger is never migrated and never `
      + 'rebuilt; move the file aside if it is a development artifact.',
    )
    this.name = 'AddressingLedgerSchemaVersionError'
  }
}

// No rename is inferred from spelling or order; a wrong link would re-point a published address.
export interface TargetRename {
  readonly fromSlug: string
  readonly toSlug: string
  readonly recordedAt: string
}

/** A minted address: the durable mapping plus the short-ID it renders as. */
export interface EntityAddress {
  readonly kind: EntityKind
  readonly machineId: string
  /** Present for ordinal-addressed kinds; absent for slug-addressed ones. */
  readonly ordinal?: number
  readonly shortId: string
  readonly mintedAt: string
}

export interface AddressingLedger {
  /**
   * Assign this machine id its permanent address, or return the one it already has.
   *
   * Idempotent by construction rather than by a caller-side check: the unique index decides,
   * so two processes calling this at the same instant agree, and a caller that forgot to look
   * first cannot create a second address.
   */
  mint(kind: EntityKind, machineId: string): EntityAddress
  /** The address for a machine id, or `undefined` when it has never been sighted. */
  lookup(kind: EntityKind, machineId: string): EntityAddress | undefined
  /** The address a published short-ID names, or `undefined`. Tier (a)'s whole job. */
  lookupByShortId(shortId: string): EntityAddress | undefined
  // Append-only, so this enumeration is complete history; the entity index is rebuilt from it.
  listAddresses(): EntityAddress[]
  // Both slugs keep their own permanent address; recording the same rename again is idempotent.
  recordTargetRename(fromSlug: string, toSlug: string): TargetRename
  /** The rename recorded FOR this slug, if any. Never the reverse direction. */
  lookupTargetRename(fromSlug: string): TargetRename | undefined
  close(): void
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS addresses (
     kind        TEXT    NOT NULL,
     machine_id  TEXT    NOT NULL,
     -- NULL exactly for slug-addressed kinds. sqlite treats NULLs as distinct in a unique
     -- index, so the (kind, ordinal) constraint below still holds for every ordinal kind
     -- while imposing nothing on TGT rows.
     ordinal     INTEGER,
     short_id    TEXT    NOT NULL,
     minted_at   TEXT    NOT NULL,
     UNIQUE (kind, machine_id),
     UNIQUE (kind, ordinal),
     UNIQUE (short_id)
   )`,
  // The append-only law, as a database rule rather than as an exported-surface convention.
  // A source assertion about which functions this module exports is only as strong as the
  // next module that opens the same file; these two are not.
  `CREATE TRIGGER IF NOT EXISTS addresses_are_append_only
     BEFORE DELETE ON addresses
     BEGIN
       SELECT RAISE(ABORT, 'the addressing ledger never deletes an address');
     END`,
  `CREATE TRIGGER IF NOT EXISTS addresses_are_immutable
     BEFORE UPDATE ON addresses
     BEGIN
       SELECT RAISE(ABORT, 'a minted address never changes');
     END`,
  // Renames get their own table: writing one onto an immutable address row would need an update.
  `CREATE TABLE IF NOT EXISTS target_renames (
     from_slug   TEXT NOT NULL PRIMARY KEY,
     to_slug     TEXT NOT NULL,
     recorded_at TEXT NOT NULL
   )`,
] as const

export interface OpenAddressingLedgerOptions {
  /** Absolute path to the ledger file, typically `<agentQaRoot>/entity-addresses.db`. */
  readonly path: string
  /** ISO-8601 stamp source. Injected so mint times are deterministic under test. */
  readonly now?: () => string
  readonly timeoutMs?: number
}

function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function rowToAddress(row: Record<string, unknown>): EntityAddress {
  const ordinal = row.ordinal
  return {
    kind: String(row.kind) as EntityKind,
    machineId: String(row.machine_id),
    ...(ordinal === null || ordinal === undefined ? {} : { ordinal: toNumber(ordinal) }),
    shortId: String(row.short_id),
    mintedAt: String(row.minted_at),
  }
}

export function openAddressingLedger(options: OpenAddressingLedgerOptions): AddressingLedger {
  const now = options.now ?? (() => new Date().toISOString())

  mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path, {
    timeout: options.timeoutMs ?? ADDRESSING_LEDGER_BUSY_TIMEOUT_MS,
  })
  db.exec('PRAGMA journal_mode=WAL')

  // Read BEFORE any schema statement runs, so a file this build cannot read is not touched on
  // its way to being refused. A hard fail that had already created a table would be a
  // migration nobody wrote — against the one store in the system that must never be rewritten.
  const stamped = toNumber(db.prepare('PRAGMA user_version').get()?.user_version)
  if (stamped !== 0 && stamped !== ADDRESSING_LEDGER_USER_VERSION) {
    db.close()
    throw new AddressingLedgerSchemaVersionError(
      options.path,
      ADDRESSING_LEDGER_USER_VERSION,
      stamped,
    )
  }
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
  if (stamped === 0) {
    db.exec(`PRAGMA user_version=${String(ADDRESSING_LEDGER_USER_VERSION)}`)
  }

  // Parameterized throughout; the only interpolations are the pinned integer `PRAGMA` values.
  const insertAddress = db.prepare(
    `INSERT INTO addresses (kind, machine_id, ordinal, short_id, minted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, machine_id) DO NOTHING`,
  )
  const selectByKey = db.prepare(
    'SELECT * FROM addresses WHERE kind = ? AND machine_id = ?',
  )
  const selectByShortId = db.prepare('SELECT * FROM addresses WHERE short_id = ?')
  const selectAll = db.prepare('SELECT * FROM addresses ORDER BY kind, short_id')
  const selectNextOrdinal = db.prepare(
    'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM addresses WHERE kind = ?',
  )
  const insertRename = db.prepare(
    `INSERT INTO target_renames (from_slug, to_slug, recorded_at)
     VALUES (?, ?, ?)
     ON CONFLICT (from_slug) DO NOTHING`,
  )
  const selectRename = db.prepare('SELECT * FROM target_renames WHERE from_slug = ?')

  function inTransaction<T>(body: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  function readBack(kind: EntityKind, machineId: string): EntityAddress {
    const row = selectByKey.get(kind, machineId)
    if (row === undefined) {
      // Unreachable through the insert-then-read sequence below, and stated as a refusal
      // rather than a non-null assertion because the alternative is a silent `undefined`
      // travelling out as an address.
      throw new Error(`the addressing ledger lost the row it just wrote: ${kind} ${machineId}`)
    }
    return rowToAddress(row)
  }

  function readRename(fromSlug: string): TargetRename | undefined {
    const row = selectRename.get(fromSlug)
    return row === undefined
      ? undefined
      : {
          fromSlug: String(row.from_slug),
          toSlug: String(row.to_slug),
          recordedAt: String(row.recorded_at),
        }
  }

  function mintAddress(kind: EntityKind, machineId: string): EntityAddress {
    if (machineId.trim() === '') {
      throw new TypeError(`an empty machine id has no ${kind} address`)
    }

    if (isSlugAddressedKind(kind)) {
      // No ordinal to compute, so no read-modify-write and nothing to serialise: the unique
      // index alone makes this idempotent and race-safe.
      insertAddress.run(kind, machineId, null, formatSlugShortId(kind, machineId), now())
      return readBack(kind, machineId)
    }

    return inTransaction(() => {
      // `BEGIN IMMEDIATE` rather than a deferred begin: the next ordinal is read and then
      // written, and a second writer allowed in between would compute the same number. The
      // write lock is taken at BEGIN, so it cannot be.
      //
      // ONE mechanism decides the outcome, deliberately. An earlier draft also short-circuited
      // on an in-transaction pre-read of the existing row, and mutation probes found the pair
      // MUTUALLY MASKING: removing either one alone left every case green, so neither was
      // pinned by anything and a later edit could have deleted the one that mattered without a
      // single test noticing. What is left is the insert itself — a conflict on
      // `(kind, machine_id)` writes nothing — followed by an unconditional read-back.
      const next = toNumber(selectNextOrdinal.get(kind)?.next)
      insertAddress.run(kind, machineId, next, formatOrdinalShortId(kind, next), now())
      // Read back rather than returning what was computed. On the losing side of a race — and
      // on a plain second call in this process — the insert affected no rows, so the answer is
      // the WINNER's ordinal and never this caller's candidate. The candidate is simply
      // discarded: nothing consumed it, so the next distinct machine id still receives it.
      return readBack(kind, machineId)
    })
  }

  return {
    close() {
      db.close()
    },

    mint: mintAddress,

    lookup(kind, machineId) {
      const row = selectByKey.get(kind, machineId)
      return row === undefined ? undefined : rowToAddress(row)
    },

    lookupByShortId(shortId) {
      const row = selectByShortId.get(shortId)
      return row === undefined ? undefined : rowToAddress(row)
    },

    listAddresses() {
      return selectAll.all().map(rowToAddress)
    },

    recordTargetRename(fromSlug, toSlug) {
      if (fromSlug === toSlug) {
        throw new TypeError('a target rename names two different slugs')
      }
      // Both ends minted BEFORE the link is written, so a recorded rename can never point at
      // a slug that has no address of its own.
      mintAddress('TGT', fromSlug)
      mintAddress('TGT', toSlug)
      insertRename.run(fromSlug, toSlug, now())
      const recorded = readRename(fromSlug)
      if (recorded === undefined) {
        throw new Error(`the addressing ledger lost the rename it just wrote: ${fromSlug}`)
      }
      return recorded
    },

    lookupTargetRename: readRename,
  }
}
