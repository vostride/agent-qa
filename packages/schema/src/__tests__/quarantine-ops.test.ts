// RED-first pins for the three quarantine verbs' wire contract.
//
// The DTOs are minted in schema so `agent`'s op specs and knowledge-local's port
// implementation consume ONE contract rather than two agreeing spellings. Two claims carry
// most of the weight here:
//
//  1. THE STATE AND CLASS VOCABULARIES ARE IMPORTED, NEVER RESPELLED (388 C13). The entry
//     DTO's `state` enum is built out of the ledger's own const, and its `verdictClass` enum
//     out of the canonical verdict const — so a fourth ledger state could not arrive with the
//     wire contract still admitting only three. The cases below assert that identity, not a
//     hand-written copy of the members.
//  2. RE-ADD AND MISSING-ENTRY ARE RESULT ARMS, NEVER THROWS. `release` on a test that
//     is not quarantined answers `no-entry`; `add` on one that already is answers `renewed`.
//     A caller learns which happened by reading the discriminant, which a rejected promise
//     could not carry.

import { describe, expect, it } from 'vitest'

import {
  QUARANTINE_ENTRY_STATE_NAMES,
  QUARANTINE_UNASSIGNED_OWNER,
} from '../quarantine/quarantine-ledger'
import type { QuarantineEntryState } from '../quarantine/quarantine-ledger'
import {
  QuarantineAddInputSchema,
  QuarantineAddOutputSchema,
  QuarantineEntrySchema,
  QuarantineListInputSchema,
  QuarantineListOutputSchema,
  QuarantineReleaseInputSchema,
  QuarantineReleaseOutputSchema,
} from '../quarantine/quarantine-ops'
import type {
  QuarantineAddOutput,
  QuarantineListOutput,
  QuarantineOperationsPort,
  QuarantineReleaseOutput,
} from '../quarantine/quarantine-ops'
import { VERDICT_CLASSES } from '../verdict/verdict'

// ---- Fixtures ------------------------------------------------------------

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product: 'example-web',
    filePath: 'tests/checkout.test.yaml',
    testName: 'checkout completes',
    fingerprint: 'fp-1',
    verdictClass: 'flake',
    owner: QUARANTINE_UNASSIGNED_OWNER,
    enteredAt: '2026-08-05T10:00:00.000Z',
    expiresAt: '2026-09-04T10:00:00.000Z',
    enteredCount: 1,
    firstEnteredAt: '2026-08-05T10:00:00.000Z',
    state: 'quarantined',
    ...overrides,
  }
}

const IDENTITY = {
  product: 'example-web',
  filePath: 'tests/checkout.test.yaml',
  testName: 'checkout completes',
}

// ---- The entry DTO: one vocabulary, imported ----------------------------

describe('the quarantine entry DTO carries every ledger field in full', () => {
  it('round-trips an entry carrying identity, fingerprint, class, owner, entered, expiry and state', () => {
    const parsed = QuarantineEntrySchema.parse(entry())

    expect(parsed).toEqual(entry())
  })

  it('rejects a state outside the ledger state union', () => {
    expect(QuarantineEntrySchema.safeParse(entry({ state: 'suspended' })).success).toBe(false)
  })

  it('rejects a verdict class outside the closed set', () => {
    expect(QuarantineEntrySchema.safeParse(entry({ verdictClass: 'gremlins' })).success).toBe(false)
  })

  it('rejects an entry missing its expiry — an entry with no deadline is forever-suppression', () => {
    const withoutExpiry = entry()
    delete withoutExpiry['expiresAt']

    expect(QuarantineEntrySchema.safeParse(withoutExpiry).success).toBe(false)
  })

  it('builds its state and class enums out of the ONE exported const, never a second spelling', () => {
    expect(QuarantineEntrySchema.shape.state.options).toEqual([...QUARANTINE_ENTRY_STATE_NAMES])
    expect(QuarantineEntrySchema.shape.verdictClass.options).toEqual([...VERDICT_CLASSES])
  })

  it('agrees with the ledger entry type at compile time', () => {
    type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const shapesAgree: AssertEqual<
      QuarantineListOutput['entries'][number],
      QuarantineEntryState
    > = true

    expect(shapesAgree).toBe(true)
  })
})

// ---- list: enumerate everything -----------------------------------------

describe('quarantine.list contracts', () => {
  it('takes the empty query — enumeration is the verb, filtering is a reader concern', () => {
    expect(QuarantineListInputSchema.parse({})).toEqual({})
  })

  it('refuses an unknown filter key rather than silently ignoring it', () => {
    expect(QuarantineListInputSchema.safeParse({ owner: 'unassigned' }).success).toBe(false)
  })

  it('round-trips a populated listing and an empty one alike', () => {
    expect(QuarantineListOutputSchema.parse({ entries: [entry()] })).toEqual({ entries: [entry()] })
    expect(QuarantineListOutputSchema.parse({ entries: [] })).toEqual({ entries: [] })
  })
})

// ---- release: the human half of the exit path ---------------------------

describe('quarantine.release contracts', () => {
  it('addresses one test by the three legs of stable identity', () => {
    expect(QuarantineReleaseInputSchema.parse({ ...IDENTITY })).toEqual(IDENTITY)
  })

  it('refuses an input missing an identity leg — a partial address matches nothing precisely', () => {
    expect(QuarantineReleaseInputSchema.safeParse({
      product: 'example-web',
      filePath: 'tests/checkout.test.yaml',
    }).success).toBe(false)
  })

  it('answers a released ARM carrying the entry that closed', () => {
    const released: QuarantineReleaseOutput = QuarantineReleaseOutputSchema.parse({
      kind: 'released',
      entry: entry({ state: 'released' }),
    })

    expect(released.kind).toBe('released')
  })

  it('answers a typed no-entry ARM rather than a throw for a test that is not quarantined', () => {
    const missing: QuarantineReleaseOutput = QuarantineReleaseOutputSchema.parse({
      kind: 'no-entry',
    })

    expect(missing).toEqual({ kind: 'no-entry' })
  })

  it('refuses an outcome kind outside the two arms', () => {
    expect(QuarantineReleaseOutputSchema.safeParse({ kind: 'ignored' }).success).toBe(false)
  })
})

// ---- add: manual entry, renewal and the owner claim ---------------------

describe('quarantine.add contracts', () => {
  it('takes identity alone — the default lifetime and the unassigned owner belong to the implementation', () => {
    expect(QuarantineAddInputSchema.parse({ ...IDENTITY })).toEqual(IDENTITY)
  })

  it('accepts an owner claim and an explicit deadline', () => {
    const claimed = QuarantineAddInputSchema.parse({
      ...IDENTITY,
      owner: 'ada',
      expiresAt: '2026-10-01T00:00:00.000Z',
    })

    expect(claimed.owner).toBe('ada')
    expect(claimed.expiresAt).toBe('2026-10-01T00:00:00.000Z')
  })

  it('answers an entered ARM for a fresh quarantine', () => {
    const entered: QuarantineAddOutput = QuarantineAddOutputSchema.parse({
      kind: 'entered',
      entry: entry(),
    })

    expect(entered.kind).toBe('entered')
  })

  it('answers a renewed ARM for an already-quarantined identity — never a throw', () => {
    const renewed: QuarantineAddOutput = QuarantineAddOutputSchema.parse({
      kind: 'renewed',
      entry: entry({ owner: 'ada' }),
    })

    expect(renewed.kind).toBe('renewed')
    expect(renewed.entry.owner).toBe('ada')
  })

  it('refuses an outcome kind outside the two arms', () => {
    expect(QuarantineAddOutputSchema.safeParse({ kind: 'released', entry: entry() }).success)
      .toBe(false)
  })
})

// ---- The port contract the ops bind through -----------------------------

describe('QuarantineOperationsPort', () => {
  it('carries exactly three verbs — a fourth power would be one no host declared', () => {
    type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const verbsAgree: AssertEqual<keyof QuarantineOperationsPort, 'list' | 'release' | 'add'> = true

    expect(verbsAgree).toBe(true)
  })

  it('is implementable as plain data with no clock and no store', async () => {
    const stub: QuarantineOperationsPort = {
      list: () => Promise.resolve([QuarantineEntrySchema.parse(entry()) as QuarantineEntryState]),
      release: () => Promise.resolve({ kind: 'no-entry' }),
      add: (input) => Promise.resolve({
        kind: 'entered',
        entry: QuarantineEntrySchema.parse(entry({ testName: input.testName })) as QuarantineEntryState,
      }),
    }

    expect(QuarantineListOutputSchema.parse({ entries: [...await stub.list()] }).entries)
      .toHaveLength(1)
    expect(QuarantineReleaseOutputSchema.parse(await stub.release({ ...IDENTITY })))
      .toEqual({ kind: 'no-entry' })
    expect(QuarantineAddOutputSchema.parse(await stub.add({ ...IDENTITY })).kind).toBe('entered')
  })
})
