// Logical state, not bytes: tables come from the catalogue and every SELECT orders by all columns.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import { canonicalJson, sha256hex } from '@vostride/agent-qa-schema'

/** Identifiers that are safe to interpolate; sqlite has no placeholders for them. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface LogicalDumpTable {
  readonly table: string
  readonly orderBy: readonly string[]
  readonly rows: readonly Record<string, unknown>[]
}

export interface LogicalDumpCheckpoint {
  /** Relative to the checkpoint root, so two runs under different temp roots compare. */
  readonly path: string
  readonly digest: string
}

export interface LogicalDump {
  readonly schemaVersion: number
  readonly tables: readonly LogicalDumpTable[]
  readonly checkpoints: readonly LogicalDumpCheckpoint[]
}

function requireIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new TypeError(`unusable sqlite identifier in a logical dump: ${JSON.stringify(value)}`)
  }
  return value
}

/** The full-table SELECT for one table. Exported so a test can read the ORDER BY itself. */
export function orderedSelectSql(table: string, columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new TypeError(`table ${table} reports no columns, so no order can be stated`)
  }
  const order = columns.map((column) => `"${requireIdentifier(column)}" ASC`).join(', ')
  return `SELECT * FROM "${requireIdentifier(table)}" ORDER BY ${order}`
}

export function listStoreTables(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`,
    )
    .all()
    .map((row) => String(row.name))
}

export function tableColumns(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info("${requireIdentifier(table)}")`)
    .all()
    .map((row) => String(row.name))
}

/**
 * Values sqlite hands back, in a form the canonical serializer accepts.
 *
 * Integer columns arrive as bigints on this binding, and a bigint cannot be serialized at
 * all — so this is a correctness step rather than a cosmetic one.
 */
function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Uint8Array) return { base16: Buffer.from(value).toString('hex') }
  return value
}

export function selectOrderedRows(db: DatabaseSync, table: string): LogicalDumpTable {
  const columns = tableColumns(db, table)
  const rows = db
    .prepare(orderedSelectSql(table, columns))
    .all()
    .map((row) => {
      const normalized: Record<string, unknown> = {}
      for (const column of columns) normalized[column] = normalize(row[column])
      return normalized
    })
  return { table, orderBy: columns, rows }
}

/**
 * Every checkpoint file under the root, sorted, with a digest of its bytes.
 *
 * Digests rather than contents: the comparison only ever asks whether the bytes are the same,
 * and a dump that inlined every authored payload would be dominated by the thing it is least
 * interested in. Only the checkpoint directory is walked — the database and its sidecars live
 * elsewhere, and a filesystem-wide listing would make the sidecars part of the comparison.
 */
export function checkpointDigests(checkpointsRoot: string): LogicalDumpCheckpoint[] {
  const found: LogicalDumpCheckpoint[] = []

  function walk(dir: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      found.push({
        path: relative(checkpointsRoot, path).split(sep).join('/'),
        digest: sha256hex(readFileSync(path, 'utf8')),
      })
    }
  }

  walk(checkpointsRoot)
  return found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

export interface CreateLogicalDumpInput {
  readonly db: DatabaseSync
  readonly schemaVersion: number
  readonly checkpointsRoot: string
}

export function createLogicalDump(input: CreateLogicalDumpInput): LogicalDump {
  return {
    schemaVersion: input.schemaVersion,
    tables: listStoreTables(input.db).map((table) => selectOrderedRows(input.db, table)),
    checkpoints: checkpointDigests(input.checkpointsRoot),
  }
}

/** The comparable form. Two dumps of the same logical state are the same string. */
export function canonicalLogicalDump(dump: LogicalDump): string {
  return canonicalJson(dump)
}
