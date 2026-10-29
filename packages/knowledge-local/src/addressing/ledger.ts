// The addressing ledger.
//
// The one DURABLE, never-rebuilt store this phase mints. Everything else 387 builds is a
// projection that a rebuild heals; this file is not, and the difference is the whole reason
// it lives in its own database beside `agent-jobs.db` rather than as a table inside the
// knowledge index. Index tables are rebuildable by law, and rebuilding an ordinal ledger
// would REASSIGN published addresses — `MEM-001` in a CI log from last month would start
// pointing at a different memory.
//
// Three laws, and each is enforced by the database rather than by discipline:
//
//   append-only    BEFORE DELETE and BEFORE UPDATE triggers on `addresses` abort. Not a
//                  convention about which functions this module exports — a rule that holds
//                  against a future call site, an older binary, and someone at a sqlite3
//                  prompt. The exported surface is open/mint/lookup, and the triggers are
//                  what make that surface's narrowness a property of the data.
//   never-reuse    ordinals come from `MAX(ordinal) + 1` per kind, and since nothing is ever
//                  deleted that sequence is strictly increasing forever. `UNIQUE(kind,
//                  ordinal)` means a second row could not claim a spent one even if some
//                  future code computed the wrong next value.
//   lost race      mint is one `BEGIN IMMEDIATE` transaction ending in `ON CONFLICT DO
//                  NOTHING` followed by a read-back, so two processes minting the same
//                  (kind, machine-id) simultaneously BOTH return the winner's ordinal and
//                  neither sees a constraint error (the 385 D-02 idiom).
//
// Lease-free, deliberately. Addressing metadata is not learned knowledge, and the CLI
// has to be able to mint with no daemon running. Nothing here reads the writer lease, and
// nothing on a run/test/bundle CREATION path calls it — minting happens only when something
// SIGHTS an entity.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  formatOrdinalShortId,
  formatSlugShortId,
  isSlugAddressedKind,
} from '@vostride/agent-qa-schema'
import type { EntityKind } from '@vostride/agent-qa-schema'

/**
 * Stamped into `PRAGMA user_version` at creation and checked on every open.
 *
 * Stamp and hard-fail, never migrate — the 385 D-04 convention. The milestone ships nothing
 * between its releases, so a ledger written by another build is a development artifact, and
 * migration machinery for it would be code with no user that everything afterwards has to
 * keep working. Note what this does NOT license: the ROWS are permanent regardless. A version
 * refusal tells an operator to move a stale development file aside; it never rewrites one.
 */
export const ADDRESSING_LEDGER_USER_VERSION = 2

/**
 * Busy timeout for every connection.
 *
 * D-02's story is "any process mints, sqlite arbitrates", which only works if a writer
 * waiting on the write lock retries rather than failing immediately. Matched to the job
 * store's window because the transactions are the same shape and size: retune from observed
 * contention, not from a guess about how many hosts there are.
 */
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
      + 'rebuilt (D-02/D-04); move the file aside if it is a development artifact.',
    )
    this.name = 'AddressingLedgerSchemaVersionError'
  }
}

/**
 * An EXPLICITLY recorded target rename.
 *
 * There is no heuristic rename detection in this file and there must not be. Inferring that
 * two target slugs are "the same target" from their spelling, their order of appearance or
 * their contents is a guess, and ENTY-01's never-guess law is not weaker inside the ledger
 * than it is inside the resolver — a wrong link here would silently re-point a published
 * address, which is the exact failure D-02 exists to make impossible.
 */
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
  /**
   * Every address ever minted, in a fixed order (kind, then short-ID).
   *
   * READ-only, and the append-only law is what makes it worth having: this list only grows, so
   * a caller enumerating it is reading a complete history rather than a snapshot that could
   * have lost rows. The entity index is rebuilt FROM this — a projection can only claim
   * to heal if the thing it is rebuilt from can be enumerated in full.
   */
  listAddresses(): EntityAddress[]
  /**
   * Record that a config target was renamed. See {@link TargetRename} for why this is
   * the only way a link between two slugs ever comes to exist.
   *
   * Both slugs are minted, so both keep their own permanent address: the predecessor keeps
   * the one already sitting in somebody's CI log, and the successor gets its own rather than
   * inheriting one. Recording is idempotent — a repeat is the same fact, not a second one.
   */
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
       SELECT RAISE(ABORT, 'the addressing ledger never deletes an address (387 D-04)');
     END`,
  `CREATE TRIGGER IF NOT EXISTS addresses_are_immutable
     BEFORE UPDATE ON addresses
     BEGIN
       SELECT RAISE(ABORT, 'a minted address never changes (387 D-04)');
     END`,
  // Renames live in their OWN table rather than as a nullable column on `addresses`, and the
  // reason is the trigger directly above: a rename is a fact recorded LATER about a row that
  // must never change, so writing it onto the address row would require exactly the statement
  // this ledger forbids. Additive, and the stamped version does not move — nothing between
  // this milestone's releases has written a v1 file, and `IF NOT EXISTS` heals a development
  // one. D-04's never-rebuild law is about ORDINALS, which no statement here touches.
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

  // Every statement is parameterized. No SQL in this file is built by concatenating a caller's
  // string, and the two `PRAGMA` statements above are the only interpolations — both of pinned
  // integer constants declared in this module.
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
