// Unassigned first, then `firstEnteredAt`, then identity bytes; the corpus differs at every level.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  QuarantineLedgerVersionError,
  canonicalJson,
} from '@vostride/agent-qa-schema'
import type { QuarantineEntryState, QuarantineLedgerEvent } from '@vostride/agent-qa-schema'

import {
  EPOCH_FILE,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
  WriterAuthorityLostError,
  acquireWriterLease,
  releaseLease,
} from '../../lease/writer-lease.js'
import { QUARANTINE_LEDGER_FILENAME } from '../ledger.js'
import {
  QUARANTINE_MANUAL_ENTRY_CLASS,
  QUARANTINE_MANUAL_ENTRY_FINGERPRINT,
  QuarantineIdentityRefusedError,
  createQuarantineOperations,
  underWriterLease,
} from '../operations.js'

const PRODUCT = 'example-web'
const NOW = '2026-05-01T00:00:00.000Z'
/** `now` + QUARANTINE_DEFAULT_EXPIRY_DAYS (30), the pinned default lifetime. */
const DEFAULT_EXPIRY = '2026-05-31T00:00:00.000Z'
/** Far enough past `now` that every corpus entry folds to `quarantined`. */
const FAR_FUTURE = '2026-12-01T00:00:00.000Z'

function identity(letter: string, name: string): {
  product: string
  filePath: string
  testName: string
} {
  return { product: PRODUCT, filePath: `tests/${letter}.yaml`, testName: name }
}

const A = identity('a', 'alpha')
const B = identity('b', 'beta')
const C = identity('c', 'gamma')
const D = identity('d', 'delta')
const E = identity('e', 'epsilon')
const F = identity('f', 'zeta')

function entered(
  who: ReturnType<typeof identity>,
  at: string,
  overrides: Partial<Record<string, unknown>> = {},
): QuarantineLedgerEvent {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'entered',
    at,
    ...who,
    fingerprint: 'fp-corpus',
    verdictClass: 'flake',
    owner: QUARANTINE_UNASSIGNED_OWNER,
    expiresAt: FAR_FUTURE,
    ...overrides,
  } as QuarantineLedgerEvent
}

function released(who: ReturnType<typeof identity>, at: string): QuarantineLedgerEvent {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'released-auto',
    at,
    ...who,
  } as QuarantineLedgerEvent
}

// `knowledge-local` cannot import core, so the identity mint arrives pre-bound from the host.

/** The mint a host that speaks the canonical bytes already supplies: unchanged in, unchanged out. */
function passthroughMint(filePath: string): string {
  return filePath
}

/**
 * A mint that REWRITES its input — the `./`-trimming leg of the real recipe, spelled minimally.
 *
 * A pin driven through a passthrough mint cannot tell a threaded mint from an unthreaded one: both
 * store the caller's bytes. Only a mint whose output DIFFERS from its input makes the threading
 * observable in the committed line.
 */
function trimmingMint(filePath: string): string {
  return filePath.replace(/^\.\//, '')
}

/**
 * A mint that THROWS — the escape arm of the real recipe (`workspaceRelativeIdentityPath` raises
 * `Workspace file path escapes config directory` for a path outside the config directory).
 */
function refusingMint(filePath: string): string {
  if (filePath.startsWith('../') || filePath.startsWith('/')) {
    throw new Error(`Workspace file path escapes config directory: ${filePath}`)
  }
  return filePath
}

describe('createQuarantineOperations', () => {
  let knowledgeRoot: string
  let clockReads: number

  function operations(
    now: string = NOW,
    resolveWriterAuthority?: () => { leaseId: string; epoch: number } | undefined,
    mintIdentityPath: (filePath: string) => string = passthroughMint,
  ) {
    return createQuarantineOperations({
      resolveKnowledgeRoot: () => knowledgeRoot,
      now: () => {
        clockReads += 1
        return now
      },
      mintIdentityPath,
      ...(resolveWriterAuthority === undefined ? {} : { resolveWriterAuthority }),
    })
  }

  async function plant(events: readonly QuarantineLedgerEvent[]): Promise<void> {
    await writeFile(
      join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME),
      `${events.map((event) => canonicalJson(event)).join('\n')}\n`,
      'utf8',
    )
  }

  function ledgerLines(): Record<string, unknown>[] {
    const path = join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  function shape(entries: readonly QuarantineEntryState[]): string[] {
    return entries.map((entry) => `${entry.filePath}:${entry.owner}:${entry.enteredAt}`)
  }

  beforeEach(async () => {
    knowledgeRoot = await mkdtemp(join(tmpdir(), 'quarantine-ops-'))
    clockReads = 0
  })

  afterEach(async () => {
    await rm(knowledgeRoot, { recursive: true, force: true })
  })

  // ---- list -------------------------------------------------------------------------------

  it('lists [] for a ledger that was never created — the empty edge', async () => {
    expect(await operations().list()).toEqual([])
  })

  it('lists [] for an empty ledger file, identically to an absent one', async () => {
    await writeFile(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), '', 'utf8')

    expect(await operations().list()).toEqual([])
  })

  it('orders unassigned first, then firstEnteredAt ascending, ties on identity bytes', async () => {
    // File order — and therefore the fold's Map iteration order — is C, A, E, D, B, F.
    await plant([
      entered(C, '2026-03-01T00:00:00.000Z', { owner: 'alice' }),
      entered(A, '2026-01-01T00:00:00.000Z'),
      entered(E, '2026-02-01T00:00:00.000Z'),
      entered(D, '2026-02-01T00:00:00.000Z'),
      // B is released and crosses again; it is the only row where the two instants disagree.
      entered(B, '2025-12-01T00:00:00.000Z'),
      released(B, '2025-12-15T00:00:00.000Z'),
      entered(B, '2026-04-01T00:00:00.000Z'),
      entered(F, '2025-12-01T00:00:00.000Z', { owner: 'bob' }),
    ])

    const entries = await operations().list()

    expect(shape(entries)).toEqual([
      // b FIRST among the unassigned, carrying the LATEST enteredAt of any of them: its history
      // began in December and that is what the queue is about. Under the old sort this row was
      // last of the four — the longest-suffering test presented as the newest.
      `tests/b.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-04-01T00:00:00.000Z`,
      // Unassigned first — the triage queue. F is the earliest-STARTED entry of all and still
      // sorts after them, which is what makes the owner partition load-bearing.
      `tests/a.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-01-01T00:00:00.000Z`,
      // d before e at an IDENTICAL instant, though the file lists e first: the identity
      // tie-break, and the only level of the rule this pair exercises.
      `tests/d.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-02-01T00:00:00.000Z`,
      `tests/e.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-02-01T00:00:00.000Z`,
      'tests/f.yaml:bob:2025-12-01T00:00:00.000Z',
      'tests/c.yaml:alice:2026-03-01T00:00:00.000Z',
    ])
    // The fold's own order, stated, so the pin above is visibly not the identity function.
    expect(shape(entries)).not.toEqual([
      'tests/c.yaml:alice:2026-03-01T00:00:00.000Z',
      `tests/a.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-01-01T00:00:00.000Z`,
      `tests/e.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-02-01T00:00:00.000Z`,
      `tests/d.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-02-01T00:00:00.000Z`,
      `tests/b.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-04-01T00:00:00.000Z`,
      'tests/f.yaml:bob:2025-12-01T00:00:00.000Z',
    ])
    // And it is not the OLD answer either — the one that read the current window's instant.
    expect(shape(entries)).not.toEqual([
      `tests/a.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-01-01T00:00:00.000Z`,
      `tests/d.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-02-01T00:00:00.000Z`,
      `tests/e.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-02-01T00:00:00.000Z`,
      `tests/b.yaml:${QUARANTINE_UNASSIGNED_OWNER}:2026-04-01T00:00:00.000Z`,
      'tests/f.yaml:bob:2025-12-01T00:00:00.000Z',
      'tests/c.yaml:alice:2026-03-01T00:00:00.000Z',
    ])
  })

  // Both rows unassigned, distinct identities: only the instant the sort reads decides.
  it('puts a test on its FOURTH entry ahead of one on its first, though its window is newer', async () => {
    await plant([
      // A: entered once, recently. One window, no history behind it.
      entered(A, '2026-04-01T00:00:00.000Z'),
      // B: entered in January and back three more times since. Its CURRENT window is the newest
      // in the corpus; its history is the oldest.
      entered(B, '2026-01-01T00:00:00.000Z'),
      released(B, '2026-01-20T00:00:00.000Z'),
      entered(B, '2026-02-01T00:00:00.000Z'),
      released(B, '2026-02-20T00:00:00.000Z'),
      entered(B, '2026-03-01T00:00:00.000Z'),
      released(B, '2026-03-20T00:00:00.000Z'),
      entered(B, '2026-04-15T00:00:00.000Z'),
    ])

    const entries = await operations().list()

    expect(entries.map((entry) => entry.filePath)).toEqual(['tests/b.yaml', 'tests/a.yaml'])
    const b = entries[0]
    expect(b.enteredCount).toBe(4)
    expect(b.firstEnteredAt).toBe('2026-01-01T00:00:00.000Z')
    // Stated beside it: B sorts first while carrying the LATER enteredAt of the two. Without this
    // line the ordering above is satisfiable by an implementation that simply reversed the sort.
    expect(b.enteredAt).toBe('2026-04-15T00:00:00.000Z')
    expect(entries[1].enteredAt).toBe('2026-04-01T00:00:00.000Z')
    expect(entries[1].enteredCount).toBe(1)
  })

  it('still puts an OWNED entry after an unassigned one, whatever their histories say', async () => {
    // The primary key is unchanged and must be proven so, not assumed: here the owned row has the
    // older history AND the older window, and still sorts second.
    await plant([
      entered(F, '2025-01-01T00:00:00.000Z', { owner: 'bob' }),
      entered(A, '2026-04-01T00:00:00.000Z'),
    ])

    const entries = await operations().list()

    expect(entries.map((entry) => entry.filePath)).toEqual(['tests/a.yaml', 'tests/f.yaml'])
  })

  it('breaks a firstEnteredAt tie on identity bytes, never on append order', async () => {
    // The tie-break is unchanged too. E is appended first and D sorts first, so the answer is a
    // function of ledger CONTENT rather than of the order lines happened to be written in.
    await plant([
      entered(E, '2026-02-01T00:00:00.000Z'),
      entered(D, '2026-02-01T00:00:00.000Z'),
    ])

    const entries = await operations().list()

    expect(entries.map((entry) => entry.filePath)).toEqual(['tests/d.yaml', 'tests/e.yaml'])
  })

  it('carries the re-entry history onto every listed entry', async () => {
    await plant([
      entered(A, '2026-01-01T00:00:00.000Z'),
      released(A, '2026-01-20T00:00:00.000Z'),
      entered(A, '2026-03-01T00:00:00.000Z'),
      entered(C, '2026-02-01T00:00:00.000Z'),
    ])

    const entries = await operations().list()

    expect(entries.map((entry) => [entry.filePath, entry.enteredCount, entry.firstEnteredAt])).toEqual([
      ['tests/a.yaml', 2, '2026-01-01T00:00:00.000Z'],
      ['tests/c.yaml', 1, '2026-02-01T00:00:00.000Z'],
    ])
  })

  it('enumerates every state — released and expired entries are listed, never filtered', async () => {
    await plant([
      entered(A, '2026-01-01T00:00:00.000Z'),
      released(A, '2026-01-02T00:00:00.000Z'),
      entered(B, '2026-01-01T00:00:00.000Z', { expiresAt: '2026-02-01T00:00:00.000Z' }),
      entered(C, '2026-01-01T00:00:00.000Z'),
    ])

    const entries = await operations().list()

    expect(entries.map((entry) => [entry.filePath, entry.state])).toEqual([
      ['tests/a.yaml', 'released'],
      ['tests/b.yaml', 'expired'],
      ['tests/c.yaml', 'quarantined'],
    ])
  })

  it('reads the injected clock exactly ONCE per call — two reads could straddle a deadline', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z')])

    await operations().list()

    expect(clockReads).toBe(1)
  })

  // ---- add --------------------------------------------------------------------------------

  it('enters a new identity with the unassigned owner and the pinned default lifetime', async () => {
    const answer = await operations().add(A)

    expect(answer).toEqual({
      kind: 'entered',
      entry: {
        ...A,
        fingerprint: QUARANTINE_MANUAL_ENTRY_FINGERPRINT,
        verdictClass: QUARANTINE_MANUAL_ENTRY_CLASS,
        owner: QUARANTINE_UNASSIGNED_OWNER,
        enteredAt: NOW,
        expiresAt: DEFAULT_EXPIRY,
        // A first entry: one crossing, and the history begins with it.
        enteredCount: 1,
        firstEnteredAt: NOW,
        state: 'quarantined',
      },
    })
    expect(ledgerLines()).toEqual([{
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'entered',
      at: NOW,
      ...A,
      fingerprint: QUARANTINE_MANUAL_ENTRY_FINGERPRINT,
      verdictClass: QUARANTINE_MANUAL_ENTRY_CLASS,
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: DEFAULT_EXPIRY,
    }])
  })

  it('honours an explicit owner and expiry rather than stamping the defaults over them', async () => {
    const answer = await operations().add({
      ...A,
      owner: 'alice',
      expiresAt: '2026-07-04T00:00:00.000Z',
    })

    expect(answer.entry).toMatchObject({
      owner: 'alice',
      expiresAt: '2026-07-04T00:00:00.000Z',
    })
  })

  it('renews an already-quarantined identity and claims the owner, carrying the new entry', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z', { expiresAt: FAR_FUTURE })])

    const answer = await operations().add({ ...A, owner: 'alice' })

    expect(answer.kind).toBe('renewed')
    expect(answer.entry).toMatchObject({
      owner: 'alice',
      expiresAt: DEFAULT_EXPIRY,
      // The window it renewed — never a fresh one, so the history the event log keeps is intact.
      enteredAt: '2026-01-01T00:00:00.000Z',
      fingerprint: 'fp-corpus',
      state: 'quarantined',
    })
    expect(ledgerLines()[1]).toEqual({
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'renewed',
      at: NOW,
      ...A,
      owner: 'alice',
      expiresAt: DEFAULT_EXPIRY,
    })
  })

  it('renews WITHOUT an owner and leaves the existing claim alone — no silent unassignment', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z', { owner: 'alice' })])

    const answer = await operations().add(A)

    expect(answer.kind).toBe('renewed')
    expect(answer.entry.owner).toBe('alice')
    expect(ledgerLines()[1]).not.toHaveProperty('owner')
  })

  it('renews an EXPIRED entry back into suppression (an expired entry stays renewable)', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z', { expiresAt: '2026-02-01T00:00:00.000Z' })])

    const answer = await operations().add(A)

    expect(answer.kind).toBe('renewed')
    expect(answer.entry).toMatchObject({ state: 'quarantined', expiresAt: DEFAULT_EXPIRY })
  })

  it('opens a FRESH window on a released identity — re-entry needs no special rule', async () => {
    await plant([
      entered(A, '2026-01-01T00:00:00.000Z'),
      released(A, '2026-01-02T00:00:00.000Z'),
    ])

    const answer = await operations().add(A)

    expect(answer.kind).toBe('entered')
    expect(answer.entry).toMatchObject({ enteredAt: NOW, state: 'quarantined' })
    expect(ledgerLines()).toHaveLength(3)
  })

  it('reads the injected clock exactly ONCE per add', async () => {
    await operations().add(A)

    expect(clockReads).toBe(1)
  })

  // ---- release ----------------------------------------------------------------------------

  it('releases an open window and answers the entry it closed', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z')])

    const answer = await operations().release(A)

    expect(answer).toEqual({
      kind: 'released',
      entry: {
        ...A,
        fingerprint: 'fp-corpus',
        verdictClass: 'flake',
        owner: QUARANTINE_UNASSIGNED_OWNER,
        enteredAt: '2026-01-01T00:00:00.000Z',
        expiresAt: FAR_FUTURE,
        // A closed window still reports the history it accumulated.
        enteredCount: 1,
        firstEnteredAt: '2026-01-01T00:00:00.000Z',
        state: 'released',
      },
    })
    expect(ledgerLines()[1]).toEqual({
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'released-manual',
      at: NOW,
      ...A,
    })
  })

  it('releases an EXPIRED entry — its window is still open, it just stopped suppressing', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z', { expiresAt: '2026-02-01T00:00:00.000Z' })])

    const answer = await operations().release(A)

    expect(answer.kind).toBe('released')
    expect(await operations().list()).toEqual([expect.objectContaining({ state: 'released' })])
  })

  it('answers no-entry for a test nothing ever quarantined, appending NO event', async () => {
    await plant([entered(B, '2026-01-01T00:00:00.000Z')])
    const before = readFileSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), 'utf8')

    expect(await operations().release(A)).toEqual({ kind: 'no-entry' })
    expect(readFileSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), 'utf8')).toBe(before)
  })

  it('answers no-entry for an ALREADY-released window — the auto-exit that beat the human', async () => {
    await plant([
      entered(A, '2026-01-01T00:00:00.000Z'),
      released(A, '2026-01-02T00:00:00.000Z'),
    ])

    expect(await operations().release(A)).toEqual({ kind: 'no-entry' })
    expect(ledgerLines()).toHaveLength(2)
  })

  it('answers no-entry against an absent ledger without creating the file', async () => {
    expect(await operations().release(A)).toEqual({ kind: 'no-entry' })
    expect(existsSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME))).toBe(false)
  })

  /** A product spelling a human types and every reader re-partitions: `slugBranch` rewrites it. */
  const RAW_PRODUCT = 'My Product'
  const SLUGGED_PRODUCT = 'My-Product'

  /** The identity spelling every reader compares — what the mint EMITS. */
  const CANONICAL_FILE = 'tests/checkout.yaml'
  /** The same file as a human types it from a shell. Folds and lists; matches nothing unminted. */
  const NON_CANONICAL_FILE = './tests/checkout.yaml'
  /** A path outside the config directory — the input the real mint refuses rather than rewrites. */
  const ESCAPING_FILE = '../outside.yaml'

  // The `filePath` leg is rangeable, so a fixture can red on an unminted path.
  function human(fields: { product: string; filePath?: string }): {
    product: string
    filePath: string
    testName: string
  } {
    return {
      product: fields.product,
      filePath: fields.filePath ?? CANONICAL_FILE,
      testName: 'checkout completes',
    }
  }

  it('records the SLUGGED product in the entered line — the partition every reader compares', async () => {
    await operations().add(human({ product: RAW_PRODUCT }))

    // Asserted verbatim rather than against `slugBranch(RAW_PRODUCT)`: a pin written as a relation
    // among the code's own functions cannot see both halves agreeing on the wrong bytes.
    expect(ledgerLines()[0]).toMatchObject({ kind: 'entered', product: SLUGGED_PRODUCT })
    expect(JSON.stringify(ledgerLines()[0])).not.toContain(RAW_PRODUCT)
  })

  it('answers the caller with the normalized identity it actually stored, not the spelling it was given', async () => {
    const answer = await operations().add(human({ product: RAW_PRODUCT }))

    expect(answer.entry).toMatchObject({ product: SLUGGED_PRODUCT, state: 'quarantined' })
  })

  it('RENEWS a second add under the same unslugged spelling — the lookup joins through the slug', async () => {
    await operations().add(human({ product: RAW_PRODUCT }))

    const answer = await operations().add(human({ product: RAW_PRODUCT }))

    // Reds when only the WRITE half slugs: `entryFor` would look for `My Product`, miss the
    // `My-Product` row it just wrote, and open a second window over the same test.
    expect(answer.kind).toBe('renewed')
    expect(ledgerLines().map((line) => line.kind)).toEqual(['entered', 'renewed'])
  })

  it('RELEASES the window an unslugged add opened — both write verbs join on the same bytes', async () => {
    await operations().add(human({ product: RAW_PRODUCT }))

    const answer = await operations().release(human({ product: RAW_PRODUCT }))

    expect(answer.kind).toBe('released')
    expect(ledgerLines()[1]).toMatchObject({
      kind: 'released-manual',
      product: SLUGGED_PRODUCT,
    })
    expect(await operations().list()).toEqual([expect.objectContaining({ state: 'released' })])
  })

  it('round-trips an ALREADY-slugged product byte-identically — the idempotence control', async () => {
    // A product already in slug form must stay as it is.
    await operations().add(human({ product: PRODUCT }))

    expect(ledgerLines()[0]).toMatchObject({ product: PRODUCT })
    expect((await operations().list())[0]).toMatchObject({ product: PRODUCT })
  })

  // The ledger compares `filePath` with `===`, so the verb must store the mint's output.

  it('stores the MINT\'S OUTPUT on the committed line, never the caller\'s spelling', async () => {
    const answer = await operations(NOW, undefined, trimmingMint)
      .add(human({ product: PRODUCT, filePath: NON_CANONICAL_FILE }))

    // Anchored as the exact fixture string rather than as `trimmingMint(NON_CANONICAL_FILE)`: a pin
    // written as a relation among the code's own functions cannot see both halves agreeing on the
    // wrong bytes (this repository's recorded closure law).
    expect(ledgerLines()[0]).toMatchObject({ kind: 'entered', filePath: 'tests/checkout.yaml' })
    expect(JSON.stringify(ledgerLines()[0])).not.toContain(NON_CANONICAL_FILE)
    // And the ANSWER names what was stored — an answer carrying the raw spelling would tell an
    // operator an entry exists under bytes no reader will ever compare against.
    expect(answer.entry).toMatchObject({ filePath: 'tests/checkout.yaml', state: 'quarantined' })
  })

  it('REFUSES an add whose filePath cannot mint — typed, no ledger, and no lease was ever taken', async () => {
    const rejected = operations(NOW, undefined, refusingMint)
      .add(human({ product: PRODUCT, filePath: ESCAPING_FILE }))

    await expect(rejected).rejects.toBeInstanceOf(QuarantineIdentityRefusedError)
    // The name literal is asserted BESIDE the instance check on purpose: it is anchored outside the
    // code's own vocabulary, so it survives an `instanceof` that starts agreeing for the wrong
    // reason, and it is what the RED baseline for this pin was written against.
    await expect(rejected).rejects.toMatchObject({
      name: 'QuarantineIdentityRefusedError',
      filePath: ESCAPING_FILE,
    })
    // The mint's own message is carried, not swallowed: the operator's next question is "why".
    await expect(rejected).rejects.toThrow(/escapes config directory/)
    expect(existsSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME))).toBe(false)
    // No residue AND no acquisition: nothing in this fixture writes the monotonic epoch except an
    // acquisition, so an absent `.epoch` says the refusal happened before the lease, not inside it.
    expect(existsSync(leaseFile())).toBe(false)
    expect(existsSync(join(knowledgeRoot, EPOCH_FILE))).toBe(false)
  })

  it('a RETRIED refused add still leaves the ledger at ZERO lines — not one refused line per attempt', async () => {
    const verbs = operations(NOW, undefined, refusingMint)
    const input = human({ product: PRODUCT, filePath: ESCAPING_FILE })

    await expect(verbs.add(input)).rejects.toMatchObject({ name: 'QuarantineIdentityRefusedError' })
    await expect(verbs.add(input)).rejects.toMatchObject({ name: 'QuarantineIdentityRefusedError' })

    // A refused write leaves nothing for a retry to duplicate.
    expect(ledgerLines()).toHaveLength(0)
    expect(existsSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME))).toBe(false)
  })

  it('refuses the UNMINTABLE input BEFORE the lease — an input tripping both gates answers identity', async () => {
    // Tripping both gates shows the order: the lease refuses first (`QuarantineLeaseHeldError`).
    const holder = foreignHolder()

    await expect(
      operations(NOW, undefined, refusingMint).add(human({ product: PRODUCT, filePath: ESCAPING_FILE })),
    ).rejects.toMatchObject({ name: 'QuarantineIdentityRefusedError' })

    expect(currentLeaseId()).toBe(holder.leaseId)
    releaseLease({ knowledgeRoot, leaseId: holder.leaseId })
  })

  it('RELEASES through the mint — a non-canonical spelling closes the window a canonical add opened', async () => {
    const verbs = operations(NOW, undefined, trimmingMint)
    await verbs.add(human({ product: PRODUCT }))

    const answer = await verbs.release(human({ product: PRODUCT, filePath: NON_CANONICAL_FILE }))

    // Sibling-input corpus law: `release` is the other half of the exit path and joins on the same
    // leg. A mint threaded into `add` only would leave this answering `no-entry`.
    expect(answer.kind).toBe('released')
    expect(ledgerLines()[1]).toMatchObject({
      kind: 'released-manual',
      filePath: 'tests/checkout.yaml',
    })
    expect(await operations().list()).toEqual([expect.objectContaining({ state: 'released' })])
  })

  it('REFUSES a release whose filePath cannot mint — typed, and the ledger is byte-unchanged', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z')])
    const before = ledgerBytes()

    const rejected = operations(NOW, undefined, refusingMint)
      .release(human({ product: PRODUCT, filePath: ESCAPING_FILE }))
    await expect(rejected).rejects.toBeInstanceOf(QuarantineIdentityRefusedError)
    await expect(rejected).rejects.toMatchObject({ name: 'QuarantineIdentityRefusedError' })

    expect(ledgerBytes()).toBe(before)
    expect(existsSync(leaseFile())).toBe(false)
  })

  it('round-trips the CANONICAL spelling untouched — the accept direction the refusals need', async () => {
    // Without this, the byte-unchanged assertions above are absences rather than measurements: they
    // must have an input domain that DOES write through the very same refusing mint.
    const verbs = operations(NOW, undefined, refusingMint)

    expect((await verbs.add(human({ product: PRODUCT }))).kind).toBe('entered')
    expect((await verbs.release(human({ product: PRODUCT }))).kind).toBe('released')

    expect(ledgerLines()).toHaveLength(2)
    for (const line of ledgerLines()) expect(line.filePath).toBe(CANONICAL_FILE)
  })

  it('RENEWS across two filePath SPELLINGS — the lookup joins through the mint, not only the write', async () => {
    // Over the `filePath` domain: reds when only the write half mints, opening a second window.
    const verbs = operations(NOW, undefined, trimmingMint)
    await verbs.add(human({ product: RAW_PRODUCT, filePath: NON_CANONICAL_FILE }))

    const answer = await verbs.add(human({ product: RAW_PRODUCT, filePath: CANONICAL_FILE }))

    expect(answer.kind).toBe('renewed')
    expect(ledgerLines().map((line) => line.kind)).toEqual(['entered', 'renewed'])
    for (const line of ledgerLines()) expect(line.filePath).toBe(CANONICAL_FILE)
  })

  // Writer-lease serialization.

  function leaseFile(): string {
    return join(knowledgeRoot, LEASE_FILE)
  }

  function ledgerBytes(): string {
    return readFileSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), 'utf8')
  }

  /** The fixture takes the lease FIRST, so the verb under test meets a writer that is not it. */
  function foreignHolder(): { leaseId: string; epoch: number } {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') {
      throw new Error(`the fixture could not take the lease it needs: ${acquired.kind}`)
    }
    return { leaseId: acquired.leaseId, epoch: acquired.epoch }
  }

  function currentLeaseId(): string | undefined {
    if (!existsSync(leaseFile())) return undefined
    return (JSON.parse(readFileSync(leaseFile(), 'utf8')) as { leaseId: string }).leaseId
  }

  it('ACQUIRES the writer lease for an add and gives back exactly what it took', async () => {
    // Nothing in this fixture writes the monotonic epoch except an acquisition, so the epoch is
    // the acquisition's own footprint — this is the leg that reds for a verb holding no lock.
    expect(existsSync(join(knowledgeRoot, EPOCH_FILE))).toBe(false)

    await operations().add(A)

    expect(ledgerLines()).toHaveLength(1)
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8')).toBe('1\n')
    // And no residue: a verb that returned must not leave the next writer locked out.
    expect(existsSync(leaseFile())).toBe(false)
  })

  it('ACQUIRES the writer lease for a release and gives back exactly what it took', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z')])

    await operations().release(A)

    expect(ledgerLines()).toHaveLength(2)
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8')).toBe('1\n')
    expect(existsSync(leaseFile())).toBe(false)
  })

  it('REFUSES an add while another writer holds the lease — typed, and the ledger is byte-unchanged', async () => {
    await plant([entered(B, '2026-01-01T00:00:00.000Z')])
    const before = ledgerBytes()
    const holder = foreignHolder()

    await expect(operations().add(A)).rejects.toMatchObject({
      name: 'QuarantineLeaseHeldError',
      holder: { leaseId: holder.leaseId, epoch: holder.epoch },
    })

    // Load-bearing BECAUSE the same call writes: `add(A)` against a ledger holding only B appends
    // an `entered` line in the accept-direction test above. Zero appended bytes is a measurement.
    expect(ledgerBytes()).toBe(before)
    // The refusal took nothing from the holder either — no reclaim, no silent steal.
    expect(currentLeaseId()).toBe(holder.leaseId)

    releaseLease({ knowledgeRoot, leaseId: holder.leaseId })
  })

  it('REFUSES a release while another writer holds the lease — typed, and the ledger is byte-unchanged', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z')])
    const before = ledgerBytes()
    const holder = foreignHolder()

    await expect(operations().release(A)).rejects.toMatchObject({
      name: 'QuarantineLeaseHeldError',
      holder: { leaseId: holder.leaseId, epoch: holder.epoch },
    })

    // Same shape, same reason: `release(A)` on this exact ledger appends `released-manual` when the
    // lease is free (the release test above), so an unchanged file is the guard's own doing.
    expect(ledgerBytes()).toBe(before)
    expect(currentLeaseId()).toBe(holder.leaseId)

    releaseLease({ knowledgeRoot, leaseId: holder.leaseId })
  })

  it('rides a HANDED-IN writer authority — the daemon arm: it appends while the lease is held, and never releases it', async () => {
    // The daemon acquires at startup and holds for its lifetime (cli/src/daemon/host.ts:642), then
    // hands the same two fields to the composition (host.ts:1839). A holder that called
    // `acquireWriterLease` would be told `held` by itself, so this arm must not acquire at all.
    const authority = foreignHolder()

    const answer = await operations(NOW, () => authority).add(A)

    expect(answer.kind).toBe('entered')
    expect(ledgerLines()).toHaveLength(1)
    // Still the SAME lease, still present: the verb neither took a second one nor released an
    // authority it does not own — releasing it would unlock the daemon's whole process.
    expect(currentLeaseId()).toBe(authority.leaseId)

    releaseLease({ knowledgeRoot, leaseId: authority.leaseId })
  })

  it('leaves the READ verb acquisition-free — list answers while a foreign writer holds the lease', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z')])
    const holder = foreignHolder()

    const entries = await operations().list()

    expect(entries).toHaveLength(1)
    // A reader that took the lease would serialize enumeration behind every drain in progress.
    expect(currentLeaseId()).toBe(holder.leaseId)

    releaseLease({ knowledgeRoot, leaseId: holder.leaseId })
  })

  // Type-checked, never called: without the sync constraint its expect-error goes unused.
  async function anAsyncDecideMustNotCompile(root: string): Promise<void> {
    // @ts-expect-error — a PromiseLike-returning `decide` cannot satisfy the synchronous signature
    await underWriterLease(root, undefined, async () => 'never runs')
  }
  void anAsyncDecideMustNotCompile

  it('runs a SYNCHRONOUS decide under the lease, so the compile pin is about the promise', async () => {
    // Non-vacuity for the compile pin above: the same call with a synchronous closure compiles AND
    // executes, so the `@ts-expect-error` is about the promise, not about a broken signature.
    expect(await underWriterLease(knowledgeRoot, undefined, () => 'decided')).toBe('decided')
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8')).toBe('1\n')
    expect(existsSync(leaseFile())).toBe(false)
  })

  it('RECLAIMS a STALE lease and writes — the arm the fresh-holder fixture can never produce', async () => {
    // `foreignHolder()` acquires microseconds before the assertion, so every refusal pin above
    // meets a FRESH holder and the reclaim arm was unreachable from this corpus — the recorded
    // precondition-guarded rule corpus law. Planting an aged heartbeat is what produces it.
    // Own `process.pid` rides along in the spread, so the escalation/kill path stays unreachable.
    const planted = foreignHolder()
    const staleLease = {
      ...(JSON.parse(readFileSync(leaseFile(), 'utf8')) as Record<string, unknown>),
      heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
    }
    writeFileSync(leaseFile(), `${JSON.stringify(staleLease)}\n`, 'utf8')
    const startedAtMs = Date.now()

    await operations().add(A)

    // The append landed: a reclaim that refused would have thrown before this line existed.
    expect(ledgerLines()).toHaveLength(1)
    // Epoch 2, not 1 — the reclaim's own footprint, and the leg that separates it from a clean
    // acquisition on an empty root (which the accept-direction pin above measures at 1).
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8')).toBe('2\n')
    // The prior lease is gone, and so is the one that replaced it: the verb gave back what it took.
    expect(currentLeaseId()).not.toBe(planted.leaseId)
    expect(existsSync(leaseFile())).toBe(false)
    // Prompt: the stale arm reclaims rather than waiting out the acquisition deadline.
    expect(Date.now() - startedAtMs).toBeLessThan(5_000)
  })

  // A daemon whose lease is reclaimed must be refused, not keep writing beside the new holder.

  /**
   * A REAL reclaim, forced with no clock and no waiting: acquire, release, acquire again.
   *
   * `releaseLease` removes the lease file and deliberately RETAINS the monotonic epoch, so the
   * second acquisition writes `epoch + 1` over a root the first holder's captured authority still
   * names. That captured value is therefore provably behind disk — precisely the state a daemon
   * reclaimed under arrives in — reproduced without ageing a heartbeat or manipulating a clock.
   *
   * The `+ 1` assertion is load-bearing rather than decorative: it is what makes this fixture a
   * reproduction of a RECLAIM instead of a mismatch somebody typed. If the lease module ever
   * stopped bumping the epoch on acquisition, this fixture would stop reproducing the state under
   * test, and it would say so here rather than degrading quietly into a hand-written number.
   */
  function reclaimed(): {
    stale: { leaseId: string; epoch: number }
    current: { leaseId: string; epoch: number }
  } {
    const stale = foreignHolder()
    expect(releaseLease({ knowledgeRoot, leaseId: stale.leaseId }).kind).toBe('released')
    const current = foreignHolder()
    expect(current.epoch).toBe(stale.epoch + 1)
    expect(current.leaseId).not.toBe(stale.leaseId)
    return { stale, current }
  }

  /**
   * The refusal a verb produced, or a legible failure naming what it answered instead.
   *
   * A bare `rejects` matcher reports "promise resolved" and drops the value, which is exactly the
   * evidence the RED direction needs: these three legs must first be observed with the verb
   * RETURNING a success kind, not merely failing to throw.
   */
  async function refusalFrom(work: Promise<unknown>): Promise<unknown> {
    return await work.then(
      (value) => {
        throw new Error(`expected a typed refusal, the verb answered ${JSON.stringify(value)}`)
      },
      (error: unknown) => error,
    )
  }

  it('REFUSES an add from a RECLAIMED authority — typed, ledger byte-unchanged, reclaimer untouched', async () => {
    await plant([entered(B, '2026-01-01T00:00:00.000Z')])
    const before = ledgerBytes()
    const { stale, current } = reclaimed()

    const refusal = await refusalFrom(operations(NOW, () => stale).add(A))

    expect(refusal).toBeInstanceOf(WriterAuthorityLostError)
    expect(refusal).toMatchObject({
      name: 'WriterAuthorityLostError',
      reason: 'stale-epoch',
      observedEpoch: current.epoch,
      authority: { knowledgeRoot, leaseId: stale.leaseId, epoch: stale.epoch },
    })

    // Load-bearing BECAUSE the same call writes: the accept control below plants this exact ledger
    // and `add(A)` appends an `entered` line through it. Zero appended bytes is a measurement.
    expect(ledgerBytes()).toBe(before)
    // The refusal took nothing from the writer that reclaimed — no second lease, no silent steal.
    expect(currentLeaseId()).toBe(current.leaseId)

    releaseLease({ knowledgeRoot, leaseId: current.leaseId })
  })

  it('REFUSES a release from a RECLAIMED authority — same fence, the other write verb', async () => {
    await plant([entered(A, '2026-01-01T00:00:00.000Z')])
    const before = ledgerBytes()
    const { stale, current } = reclaimed()

    const refusal = await refusalFrom(operations(NOW, () => stale).release(A))

    expect(refusal).toBeInstanceOf(WriterAuthorityLostError)
    expect(refusal).toMatchObject({ reason: 'stale-epoch', observedEpoch: current.epoch })

    // Same reasoning: `release(A)` over this open window appends `released-manual` when the
    // authority is current (the accept control below), so an unchanged file is the fence's doing.
    expect(ledgerBytes()).toBe(before)
    expect(currentLeaseId()).toBe(current.leaseId)

    releaseLease({ knowledgeRoot, leaseId: current.leaseId })
  })

  it('REFUSES an authority whose LEASE is gone while the epoch still matches — the leg the epoch cannot cover', async () => {
    // The release-without-reclaim shape. `releaseLease` retains the monotonic epoch forever, so a
    // holder that released (or was released by a supervisor) still carries an epoch that matches
    // disk exactly — and is nonetheless no longer the holder. An epoch-only fence admits it.
    await plant([entered(B, '2026-01-01T00:00:00.000Z')])
    const before = ledgerBytes()
    const departed = foreignHolder()
    expect(releaseLease({ knowledgeRoot, leaseId: departed.leaseId }).kind).toBe('released')
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8')).toBe(`${String(departed.epoch)}\n`)
    expect(existsSync(leaseFile())).toBe(false)

    const refusal = await refusalFrom(operations(NOW, () => departed).add(A))

    expect(refusal).toBeInstanceOf(WriterAuthorityLostError)
    expect(refusal).toMatchObject({ reason: 'lease-missing', observedEpoch: departed.epoch })

    expect(ledgerBytes()).toBe(before)
    // Nothing was minted on the way out either: a refused verb does not leave a lease behind.
    expect(existsSync(leaseFile())).toBe(false)
  })

  it('ACCEPTS a CURRENT authority unchanged — acquires nothing, releases nothing, and writes', async () => {
    // The accept direction on the SAME fixture shape as the three refusals above, without which
    // each of them is satisfiable by a fence that refuses everything. It is also the assertion
    // that the daemon's normal path is untouched: a live acquisition, held across both verbs.
    await plant([entered(B, '2026-01-01T00:00:00.000Z')])
    const authority = foreignHolder()
    const verbs = operations(NOW, () => authority)

    expect((await verbs.add(A)).kind).toBe('entered')
    expect((await verbs.release(A)).kind).toBe('released')

    expect(ledgerLines().map((line) => line.kind)).toEqual([
      'entered',
      'entered',
      'released-manual',
    ])
    // Zero acquisitions BY THE VERB: the epoch is still the holder's own, and the holder's lease
    // is still on disk. Releasing it would have unlocked the daemon's whole process.
    expect(readFileSync(join(knowledgeRoot, EPOCH_FILE), 'utf8')).toBe(`${String(authority.epoch)}\n`)
    expect(currentLeaseId()).toBe(authority.leaseId)

    releaseLease({ knowledgeRoot, leaseId: authority.leaseId })
  })

  // ---- committed-truth read posture -------------------------------------------------------

  it('PROPAGATES an unreadable ledger from every verb — never heals to "nothing is quarantined"', async () => {
    await writeFile(
      join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME),
      `${JSON.stringify({
        ...entered(A, '2026-01-01T00:00:00.000Z'),
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION + 1,
      })}\n`,
      'utf8',
    )

    await expect(operations().list()).rejects.toBeInstanceOf(QuarantineLedgerVersionError)
    await expect(operations().release(A)).rejects.toBeInstanceOf(QuarantineLedgerVersionError)
    await expect(operations().add(A)).rejects.toBeInstanceOf(QuarantineLedgerVersionError)
    // And the refusal cost the file nothing: a verb that could not read did not write either.
    expect(readFileSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), 'utf8'))
      .toContain(`"schemaVersion":${CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION + 1}`)
  })

  it('reads NO clock of its own — wall-clock purity by argument, asserted on the source', () => {
    const source = readFileSync(new URL('../operations.ts', import.meta.url), 'utf8')
      // Comments may legitimately discuss the clock; only executable bytes are scanned.
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/\/\/.*$/gm, '')

    expect(source).not.toContain('Date.now')
    expect(source).not.toContain('new Date()')
  })
})
