// Races use two OS processes loading source, because the lock under test is cross-process.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ADDRESSING_LEDGER_USER_VERSION,
  AddressingLedgerSchemaVersionError,
  openAddressingLedger,
} from '../ledger.js'
import type { AddressingLedger } from '../ledger.js'

const LEDGER_SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'ledger.ts')

/**
 * How long the race leg lets both children finish loading before releasing them together.
 *
 * It bounds a SETUP step, never the property: the assertion is that both callers agree and
 * that one row exists, and a grace too short would make the two children start apart rather
 * than make a contended mint look uncontended. Retune from observed child startup on slow
 * CI hosts, not from a guess about scheduling.
 */
const CHILD_STARTUP_GRACE_MS = 500

/** Every row in the addresses table, read through a connection this module did not open. */
function rawRows(path: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT * FROM addresses ORDER BY kind, ordinal, machine_id').all()
  } finally {
    db.close()
  }
}

describe('the addressing ledger', () => {
  let root: string
  let path: string
  let ledger: AddressingLedger

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-addressing-'))
    path = join(root, 'entity-addresses.db')
    ledger = openAddressingLedger({ path })
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  // ---- law 1: idempotent mint --------------------------------------------------------------

  it('mints one address per key, however many times it is asked', () => {
    const first = ledger.mint('MEM', 'bundle-alpha')
    const second = ledger.mint('MEM', 'bundle-alpha')

    expect(first.shortId).toBe('MEM-001')
    // The SAME ordinal, not merely a well-formed one: an implementation that minted afresh
    // each time would satisfy every shape assertion and fail exactly here.
    expect(second).toEqual(first)
    expect(rawRows(path).filter((row) => row.machine_id === 'bundle-alpha')).toHaveLength(1)
  })

  // ---- law 2: the lost race re-reads the winner ---------------------------------------------

  /**
   * Race one machine id between two OS processes and report what each of them was told.
   *
   * Both children load the module, then block on a start file, so they collide rather than
   * running one after another. Two IN-PROCESS calls would prove nothing here — a single
   * process cannot contend with itself for sqlite's write lock, which is the mechanism under
   * test.
   *
   * The children load this module's SOURCE with Node's type stripping, never its dist. A
   * cross-process probe against a workspace package's build output is a no-op until that build
   * runs, and this leg has to be exercising the code in the diff.
   */
  async function raceTwoMints(kind: string, machineId: string): Promise<string[]> {
    const gate = join(root, `go-${kind}`)
    const script = join(root, `mint-child-${kind}.mts`)
    writeFileSync(
      script,
      [
        "import { existsSync } from 'node:fs'",
        `const { openAddressingLedger } = await import(${JSON.stringify(LEDGER_SOURCE_PATH)})`,
        `while (!existsSync(${JSON.stringify(gate)})) { /* spin to the shared start instant */ }`,
        `const ledger = openAddressingLedger({ path: ${JSON.stringify(path)} })`,
        `const minted = ledger.mint(${JSON.stringify(kind)}, ${JSON.stringify(machineId)})`,
        'ledger.close()',
        'process.stdout.write(minted.shortId)',
      ].join('\n'),
      'utf8',
    )

    const mintInChild = (): Promise<string> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve(out)
        // A constraint error escaping a child is surfaced with its stderr, not a bare exit code.
        else reject(new Error(`mint child exited ${String(code)}: ${err}`))
      })
    })

    const both = [mintInChild(), mintInChild()]
    await new Promise((resolve) => setTimeout(resolve, CHILD_STARTUP_GRACE_MS))
    writeFileSync(gate, 'go', 'utf8')
    return await Promise.all(both)
  }

  it('gives two CONCURRENT PROCESSES one ordinal and leaves one row', async () => {
    expect(await raceTwoMints('MEM', 'contended-bundle')).toEqual(['MEM-001', 'MEM-001'])
    expect(rawRows(path)).toHaveLength(1)
  })

  it('races a SLUG-addressed mint too — the path with no transaction at all', async () => {
    // The two mint paths are different code, and an ordinal race says nothing about the other
    // one: a slug mint computes no next value, so it takes no `BEGIN IMMEDIATE` and its only
    // protection is the unique index plus the read-back. Racing only the ordinal path would
    // have left the untransacted half of this module's input domain unexercised.
    expect(await raceTwoMints('TGT', 'checkout')).toEqual(['TGT-checkout', 'TGT-checkout'])
    expect(rawRows(path)).toHaveLength(1)
  })

  it('does not consume the ordinal a losing caller computed for itself', async () => {
    await raceTwoMints('MEM', 'contended-bundle')

    // The loser computed a candidate and wrote nothing, so the candidate was never spent. A
    // mint that reserved its number before discovering it had lost would leave a permanent
    // hole in the sequence — harmless in isolation, and a sign that an ordinal can be consumed
    // by something that never became an address.
    expect(ledger.mint('MEM', 'a-later-bundle').shortId).toBe('MEM-002')
  })

  // ---- law 3: never reuse ------------------------------------------------------------------

  it('never hands an ordinal back, and exposes no API that could', () => {
    ledger.mint('MEM', 'bundle-a')
    ledger.mint('MEM', 'bundle-b')
    ledger.mint('MEM', 'bundle-c')

    // EXACT set equality, never a contains check: a contains check passes happily while a
    // `forget` or `reassign` verb grows beside the pinned names, which is the one drift
    // direction this assertion exists to catch.
    expect(Object.keys(ledger).sort()).toEqual([
      'close',
      // Read-only enumeration that the entity index is rebuilt from; it frees no ordinal.
      'listAddresses',
      'lookup',
      'lookupByShortId',
      'lookupTargetRename',
      'mint',
      'recordTargetRename',
    ])

    expect(ledger.mint('MEM', 'bundle-d').shortId).toBe('MEM-004')
  })

  it('enumerates every minted address in a fixed order, and only reads', () => {
    ledger.mint('MEM', 'bundle-b')
    ledger.mint('MEM', 'bundle-a')
    ledger.mint('TGT', 'checkout')

    expect(ledger.listAddresses().map(({ shortId }) => shortId))
      .toEqual(['MEM-001', 'MEM-002', 'TGT-checkout'])
    // Ordinals follow first-mention order and the listing sorts by address, so rebuilds are stable.
    expect(ledger.listAddresses().map(({ machineId }) => machineId))
      .toEqual(['bundle-b', 'bundle-a', 'checkout'])
    expect(ledger.listAddresses()).toEqual(ledger.listAddresses())
  })

  it('refuses a delete or an update through a connection it does not control', () => {
    ledger.mint('MEM', 'bundle-a')

    // The point of a RAW connection: the exported-surface assertion above binds this module's
    // callers, and nothing else. This binds a future call site, an older binary, and someone
    // at a sqlite3 prompt — which is what makes append-only a property of the ledger rather
    // than of the discipline of whoever opens it next.
    const raw = new DatabaseSync(path)
    try {
      expect(() => raw.exec('DELETE FROM addresses')).toThrow(/never deletes an address/)
      expect(() => raw.exec("UPDATE addresses SET ordinal = 99 WHERE kind = 'MEM'"))
        .toThrow(/never changes/)
    } finally {
      raw.close()
    }

    expect(rawRows(path)).toHaveLength(1)
    expect(ledger.lookup('MEM', 'bundle-a')?.shortId).toBe('MEM-001')
  })

  // ---- law 5: the TGT rename chain ---------------------------------------------------------

  it('keeps both slugs addressable and links them only when told', () => {
    const before = ledger.mint('TGT', 'checkout')
    expect(before.shortId).toBe('TGT-checkout')
    // Slug-addressed kinds carry no ordinal, so they can never consume one an ordinal kind
    // would otherwise have been handed.
    expect(before.ordinal).toBeUndefined()

    // Nothing is inferred. Before the rename is RECORDED there is no link, even though both
    // slugs exist and a heuristic would happily have proposed one.
    ledger.mint('TGT', 'payment')
    expect(ledger.lookupTargetRename('checkout')).toBeUndefined()

    const rename = ledger.recordTargetRename('checkout', 'payment')
    expect(rename).toMatchObject({ fromSlug: 'checkout', toSlug: 'payment' })

    // Append-only: the predecessor keeps the address that is already in somebody's logs.
    expect(ledger.lookupByShortId('TGT-checkout')).toEqual(before)
    expect(ledger.lookupByShortId('TGT-payment')?.machineId).toBe('payment')
    expect(ledger.lookupTargetRename('checkout')?.toSlug).toBe('payment')
    expect(ledger.lookupTargetRename('payment')).toBeUndefined()
  })

  it('stamps its schema version and refuses a file another build wrote', () => {
    ledger.mint('MEM', 'bundle-a')
    const stamped = new DatabaseSync(path, { readOnly: true })
    try {
      expect(Number(stamped.prepare('PRAGMA user_version').get()?.user_version))
        .toBe(ADDRESSING_LEDGER_USER_VERSION)
    } finally {
      stamped.close()
    }

    const bumped = new DatabaseSync(path)
    bumped.exec(`PRAGMA user_version=${String(ADDRESSING_LEDGER_USER_VERSION + 1)}`)
    bumped.close()

    expect(() => openAddressingLedger({ path }))
      .toThrow(/AddressingLedgerSchemaVersionError|schema version/)
  })

  it('stamps a new ledger 2', () => {
    const stamped = new DatabaseSync(path, { readOnly: true })
    try {
      expect(Number(stamped.prepare('PRAGMA user_version').get()?.user_version)).toBe(2)
    } finally {
      stamped.close()
    }
  })

  it.each([1, 3])('refuses a ledger stamped %i and leaves it as found', (stamp) => {
    ledger.mint('MEM', 'bundle-a')
    const planted = new DatabaseSync(path)
    planted.exec(`PRAGMA user_version=${String(stamp)}`)
    planted.close()
    const rowsBefore = rawRows(path)

    expect(() => openAddressingLedger({ path })).toThrowError(AddressingLedgerSchemaVersionError)

    const after = new DatabaseSync(path, { readOnly: true })
    try {
      expect(Number(after.prepare('PRAGMA user_version').get()?.user_version)).toBe(stamp)
    } finally {
      after.close()
    }
    expect(rawRows(path)).toEqual(rowsBefore)
  })
})

// ---- the source assertion, with its own positive controls ------------------------------------

/**
 * Statements that would mutate or destroy an `addresses` row.
 *
 * Case- and whitespace-normalised before matching, and applied to the source with line
 * comments stripped, so neither prose nor formatting can hide a real statement or invent a
 * fake one. The trigger DDL's own `BEFORE DELETE ON addresses` is deliberately not one of
 * these shapes — the triggers are what ENFORCE the law, and a checker that flagged them would
 * be forbidding the guard along with the thing it guards.
 */
const FORBIDDEN_ADDRESS_STATEMENTS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'delete', pattern: /DELETE\s+FROM\s+ADDRESSES/u },
  { name: 'update', pattern: /UPDATE\s+ADDRESSES\s+SET/u },
  { name: 'drop', pattern: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?ADDRESSES/u },
  { name: 'alter', pattern: /ALTER\s+TABLE\s+ADDRESSES/u },
  { name: 'replace', pattern: /REPLACE\s+INTO\s+ADDRESSES/u },
  { name: 'upsert-overwrite', pattern: /ON\s+CONFLICT[^;]*DO\s+UPDATE/u },
]

function mutatingAddressStatements(source: string): string[] {
  const stripped = source
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/u, ''))
    .join('\n')
  const normalised = stripped.replaceAll(/\s+/gu, ' ').toUpperCase()
  return FORBIDDEN_ADDRESS_STATEMENTS
    .filter((candidate) => candidate.pattern.test(normalised))
    .map((candidate) => candidate.name)
}

describe('the ledger module exposes no way to unwrite an address', () => {
  const source = readFileSync(LEDGER_SOURCE_PATH, 'utf8')

  it('holds no mutating statement against the addresses table', () => {
    expect(mutatingAddressStatements(source)).toEqual([])
  })

  it.each(FORBIDDEN_ADDRESS_STATEMENTS.map((candidate) => candidate.name))(
    'catches a planted %s — the check is not vacuous',
    (name) => {
      // The positive control the acceptance criterion needs: a source assertion whose only
      // evidence is its own green is evidence of nothing. Each pattern is planted into a
      // SCRATCH copy of the real file and the checker is required to find it.
      const planted: Readonly<Record<string, string>> = {
        delete: "db.exec('DELETE FROM addresses WHERE kind = ?')",
        update: "db.exec('UPDATE addresses SET ordinal = 1')",
        drop: "db.exec('DROP TABLE addresses')",
        alter: "db.exec('ALTER TABLE addresses RENAME TO old_addresses')",
        replace: "db.exec('REPLACE INTO addresses VALUES (1)')",
        'upsert-overwrite': "db.exec('INSERT INTO addresses VALUES (1) ON CONFLICT DO UPDATE SET ordinal = 2')",
      }
      const mutated = `${source}\n${planted[name]!}\n`

      expect(mutatingAddressStatements(mutated)).toContain(name)
    },
  )

  it('is not fooled by prose, and does not read a comment as a statement', () => {
    // The inverse control. Every real gate in this repo has at some point been invalidated by
    // a doc comment, so the checker is shown one that says every forbidden word.
    const commented = `${source}\n// DELETE FROM addresses and UPDATE addresses SET ordinal = 1\n`

    expect(mutatingAddressStatements(commented)).toEqual([])
  })
})
