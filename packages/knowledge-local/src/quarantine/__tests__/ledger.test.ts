// A malformed line is refused as data while its neighbours fold; a newer `schemaVersion` throws.

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
import type { QuarantineLedgerEvent } from '@vostride/agent-qa-schema'

import {
  QUARANTINE_LEDGER_FILENAME,
  appendQuarantineEvents,
  foldQuarantineLedgerState,
  readQuarantineLedger,
} from '../ledger.js'
import { createQuarantineOperations } from '../operations.js'

const PRODUCT = 'example-web'
const FILE_PATH = 'tests/checkout.test.yaml'
const TEST_NAME = 'checkout completes'
const ENTERED_AT = '2026-08-05T10:00:00.000Z'
const EXPIRES_AT = '2026-09-04T10:00:00.000Z'

/** One second either side of the expiry boundary — the two pins the fold must separate. */
const JUST_BEFORE_EXPIRY = '2026-09-04T09:59:59.000Z'
const JUST_AFTER_EXPIRY = '2026-09-04T10:00:01.000Z'

function entered(overrides: Partial<Record<string, unknown>> = {}): QuarantineLedgerEvent {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'entered',
    at: ENTERED_AT,
    product: PRODUCT,
    filePath: FILE_PATH,
    testName: TEST_NAME,
    fingerprint: 'fp-1',
    verdictClass: 'flake',
    owner: QUARANTINE_UNASSIGNED_OWNER,
    expiresAt: EXPIRES_AT,
    ...overrides,
  } as QuarantineLedgerEvent
}

describe('quarantine ledger read/fold', () => {
  let knowledgeRoot: string

  beforeEach(async () => {
    knowledgeRoot = await mkdtemp(join(tmpdir(), 'quarantine-ledger-'))
  })

  afterEach(async () => {
    await rm(knowledgeRoot, { recursive: true, force: true })
  })

  async function writeLedger(lines: readonly string[]): Promise<void> {
    await writeFile(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), lines.join('\n') + '\n', 'utf8')
  }

  it('names the ledger as its own top-level artifact under the committed knowledge root', () => {
    expect(QUARANTINE_LEDGER_FILENAME).toBe('quarantine.jsonl')
  })

  it('folds a missing ledger to empty state — byte-identical behavior for a store with no ledger', async () => {
    const read = readQuarantineLedger(knowledgeRoot)
    expect(read).toEqual({ events: [], refusedLines: [] })
    expect(foldQuarantineLedgerState(read.events, ENTERED_AT)).toEqual([])
  })

  it('folds an empty ledger file to empty state', async () => {
    await writeFile(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), '', 'utf8')
    const read = readQuarantineLedger(knowledgeRoot)
    expect(read).toEqual({ events: [], refusedLines: [] })
  })

  it('answers the one entered event a fixture ledger carries', async () => {
    await writeLedger([JSON.stringify(entered())])
    const read = readQuarantineLedger(knowledgeRoot)
    expect(read.refusedLines).toEqual([])
    expect(read.events).toEqual([entered()])
  })

  it('folds an unexpired entry to state quarantined, carrying every listed field', async () => {
    await writeLedger([JSON.stringify(entered())])
    const { events } = readQuarantineLedger(knowledgeRoot)
    const state = foldQuarantineLedgerState(events, JUST_BEFORE_EXPIRY)
    expect(state).toEqual([
      {
        product: PRODUCT,
        filePath: FILE_PATH,
        testName: TEST_NAME,
        fingerprint: 'fp-1',
        verdictClass: 'flake',
        owner: QUARANTINE_UNASSIGNED_OWNER,
        enteredAt: ENTERED_AT,
        expiresAt: EXPIRES_AT,
        state: 'quarantined',
        // The two history legs a single entry answers: it has been here once, since this instant.
        enteredCount: 1,
        firstEnteredAt: ENTERED_AT,
      },
    ])
  })

  it('folds a lapsed entry to state expired — never a silent forever-suppression', async () => {
    await writeLedger([JSON.stringify(entered())])
    const { events } = readQuarantineLedger(knowledgeRoot)
    const state = foldQuarantineLedgerState(events, JUST_AFTER_EXPIRY)
    expect(state).toHaveLength(1)
    expect(state[0].state).toBe('expired')
    // The entry stays LISTED with its identity and expiry intact — renewable and releasable.
    expect(state[0].expiresAt).toBe(EXPIRES_AT)
    expect(state[0].testName).toBe(TEST_NAME)
  })

  it('is pure — the same (events, now) pair answers identically on repeat calls', async () => {
    await writeLedger([JSON.stringify(entered())])
    const { events } = readQuarantineLedger(knowledgeRoot)
    expect(foldQuarantineLedgerState(events, JUST_BEFORE_EXPIRY)).toEqual(
      foldQuarantineLedgerState(events, JUST_BEFORE_EXPIRY),
    )
    expect(foldQuarantineLedgerState(events, JUST_BEFORE_EXPIRY)[0].state).not.toBe(
      foldQuarantineLedgerState(events, JUST_AFTER_EXPIRY)[0].state,
    )
  })

  it('keys entries by (product, filePath, testName), never a per-run id', async () => {
    await writeLedger([
      JSON.stringify(entered()),
      JSON.stringify(entered({ product: 'other-web' })),
      JSON.stringify(entered({ testName: 'a different test' })),
    ])
    const { events } = readQuarantineLedger(knowledgeRoot)
    const state = foldQuarantineLedgerState(events, JUST_BEFORE_EXPIRY)
    expect(state).toHaveLength(3)
    expect(state.map((entry) => `${entry.product}::${entry.filePath}::${entry.testName}`).sort()).toEqual(
      [
        `${PRODUCT}::${FILE_PATH}::${TEST_NAME}`,
        `${PRODUCT}::${FILE_PATH}::a different test`,
        `other-web::${FILE_PATH}::${TEST_NAME}`,
      ].sort(),
    )
  })

  it('refuses a malformed line as DATA while its neighbours still fold', async () => {
    await writeLedger([
      JSON.stringify(entered()),
      '{ this is not json',
      JSON.stringify(entered({ testName: 'a second test' })),
    ])
    const read = readQuarantineLedger(knowledgeRoot)
    expect(read.events).toHaveLength(2)
    expect(read.refusedLines).toHaveLength(1)
    expect(read.refusedLines[0].lineNumber).toBe(2)
    expect(read.refusedLines[0].reason).toMatch(/.+/)
    // The refusal never heals to absence: both healthy entries stay quarantined.
    expect(foldQuarantineLedgerState(read.events, JUST_BEFORE_EXPIRY)).toHaveLength(2)
  })

  it('refuses a structurally broken line as DATA, never healing it away', async () => {
    const broken = { ...(entered() as unknown as Record<string, unknown>) }
    delete broken.testName
    await writeLedger([JSON.stringify(broken), JSON.stringify(entered())])
    const read = readQuarantineLedger(knowledgeRoot)
    expect(read.events).toHaveLength(1)
    expect(read.refusedLines).toEqual([
      { lineNumber: 1, reason: expect.stringMatching(/.+/) as unknown as string },
    ])
  })

  it('hard-fails typed when a line declares a NEWER schemaVersion', async () => {
    await writeLedger([
      JSON.stringify(entered({ schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION + 1 })),
    ])
    expect(() => readQuarantineLedger(knowledgeRoot)).toThrow(QuarantineLedgerVersionError)
  })

  it('ignores blank lines without reporting them as refusals', async () => {
    await writeLedger([JSON.stringify(entered()), '', '   '])
    const read = readQuarantineLedger(knowledgeRoot)
    expect(read.events).toHaveLength(1)
    expect(read.refusedLines).toEqual([])
  })
})

// The full lifecycle fold.

const LATER_EXPIRY = '2026-10-04T10:00:00.000Z'
const BETWEEN_EXPIRIES = '2026-09-20T10:00:00.000Z'

function renewed(overrides: Partial<Record<string, unknown>> = {}): QuarantineLedgerEvent {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'renewed',
    at: '2026-08-20T10:00:00.000Z',
    product: PRODUCT,
    filePath: FILE_PATH,
    testName: TEST_NAME,
    expiresAt: LATER_EXPIRY,
    ...overrides,
  } as QuarantineLedgerEvent
}

function released(kind: 'released-manual' | 'released-auto'): QuarantineLedgerEvent {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind,
    at: '2026-08-25T10:00:00.000Z',
    product: PRODUCT,
    filePath: FILE_PATH,
    testName: TEST_NAME,
  } as QuarantineLedgerEvent
}

describe('quarantine ledger lifecycle fold', () => {
  it('renewal extends the expiry — the later deadline governs', () => {
    const state = foldQuarantineLedgerState([entered(), renewed()], BETWEEN_EXPIRIES)
    expect(state).toHaveLength(1)
    expect(state[0].expiresAt).toBe(LATER_EXPIRY)
    // Between the two deadlines the entry is STILL quarantined — proof the renewal governed.
    expect(state[0].state).toBe('quarantined')
    // Without the renewal, the same `now` reads expired (the control half).
    expect(foldQuarantineLedgerState([entered()], BETWEEN_EXPIRIES)[0].state).toBe('expired')
  })

  it('renewal past the NEW deadline still expires — extension is bounded, not perpetual', () => {
    const state = foldQuarantineLedgerState([entered(), renewed()], '2026-10-04T10:00:01.000Z')
    expect(state[0].state).toBe('expired')
    expect(foldQuarantineLedgerState([entered(), renewed()], '2026-10-04T09:59:59.000Z')[0].state).toBe(
      'quarantined',
    )
  })

  it('renewal with an owner claims the entry out of unassigned', () => {
    const claimed = foldQuarantineLedgerState(
      [entered(), renewed({ owner: 'alice' })],
      BETWEEN_EXPIRIES,
    )
    expect(claimed[0].owner).toBe('alice')

    // A renewal WITHOUT an owner leaves the existing one alone — never resets a claim.
    const stillUnassigned = foldQuarantineLedgerState([entered(), renewed()], BETWEEN_EXPIRIES)
    expect(stillUnassigned[0].owner).toBe(QUARANTINE_UNASSIGNED_OWNER)
    const keepsClaim = foldQuarantineLedgerState(
      [entered(), renewed({ owner: 'alice' }), renewed()],
      BETWEEN_EXPIRIES,
    )
    expect(keepsClaim[0].owner).toBe('alice')
  })

  it('either release kind closes the window', () => {
    for (const kind of ['released-manual', 'released-auto'] as const) {
      const state = foldQuarantineLedgerState([entered(), released(kind)], JUST_BEFORE_EXPIRY)
      expect(state).toHaveLength(1)
      expect(state[0].state).toBe('released')
    }
  })

  it('a released entry RE-ENTERS on a later entered event (no special rule)', () => {
    const state = foldQuarantineLedgerState(
      [
        entered(),
        released('released-auto'),
        entered({ at: '2026-08-30T10:00:00.000Z', expiresAt: LATER_EXPIRY, fingerprint: 'fp-2' }),
      ],
      BETWEEN_EXPIRIES,
    )
    expect(state).toHaveLength(1)
    expect(state[0].state).toBe('quarantined')
    expect(state[0].enteredAt).toBe('2026-08-30T10:00:00.000Z')
    expect(state[0].fingerprint).toBe('fp-2')
  })

  // The ledger is human-editable, so a hand-written `renewed` after a release must not reopen it.
  it('a renewal CANNOT resurrect a released window — the release stands', () => {
    const state = foldQuarantineLedgerState(
      [entered(), released('released-manual'), renewed()],
      BETWEEN_EXPIRIES,
    )
    expect(state).toHaveLength(1)
    expect(state[0].state).toBe('released')
    // The deadline is not extended either — nothing about the closed window moves.
    expect(state[0].expiresAt).toBe(EXPIRES_AT)
  })

  it('a renewal on a LAPSED window still extends and re-suppresses', () => {
    // The guard keys on event state: a lapsed entry is still `quarantined`, so it renews.
    const state = foldQuarantineLedgerState([entered(), renewed()], BETWEEN_EXPIRIES)
    expect(foldQuarantineLedgerState([entered()], BETWEEN_EXPIRIES)[0].state).toBe('expired')
    expect(state[0].state).toBe('quarantined')
    expect(state[0].expiresAt).toBe(LATER_EXPIRY)
  })

  it('never invents an entry from a renewal or release with no window to act on', () => {
    expect(foldQuarantineLedgerState([renewed()], BETWEEN_EXPIRIES)).toEqual([])
    expect(foldQuarantineLedgerState([released('released-manual')], BETWEEN_EXPIRIES)).toEqual([])
  })

  it('treats an unparseable deadline as lapsed — never a silent forever-suppression', () => {
    const state = foldQuarantineLedgerState([entered({ expiresAt: 'whenever' })], ENTERED_AT)
    expect(state[0].state).toBe('expired')
  })
})

// `enteredAt` opens the current window, `firstEnteredAt` the first; every fixture has two entries.

/** A second cycle's events, spelled once — release the first window, then cross again. */
const SECOND_ENTRY_AT = '2026-08-30T10:00:00.000Z'
const SECOND_EXPIRY = '2026-09-29T10:00:00.000Z'
const THIRD_ENTRY_AT = '2026-09-25T10:00:00.000Z'
const THIRD_EXPIRY = '2026-10-25T10:00:00.000Z'

describe('quarantine ledger re-entry history', () => {
  it('answers entered-once, since its own instant, for a single entry', () => {
    const state = foldQuarantineLedgerState([entered()], JUST_BEFORE_EXPIRY)
    expect(state[0].enteredCount).toBe(1)
    expect(state[0].firstEnteredAt).toBe(ENTERED_AT)
    expect(state[0].enteredAt).toBe(ENTERED_AT)
  })

  it('counts a re-entry and keeps the FIRST instant while enteredAt tracks the latest', () => {
    const state = foldQuarantineLedgerState(
      [
        entered(),
        released('released-auto'),
        entered({ at: SECOND_ENTRY_AT, expiresAt: SECOND_EXPIRY, fingerprint: 'fp-2' }),
      ],
      BETWEEN_EXPIRIES,
    )
    expect(state).toHaveLength(1)
    expect(state[0].enteredCount).toBe(2)
    expect(state[0].firstEnteredAt).toBe(ENTERED_AT)
    // Separately pinned beside it, so a reader sees the two answering different questions on the
    // same row rather than having to infer that they can differ.
    expect(state[0].enteredAt).toBe(SECOND_ENTRY_AT)
    expect(state[0].firstEnteredAt).not.toBe(state[0].enteredAt)
  })

  it('keeps counting across a THIRD cycle — the count is of entries, not of a flag', () => {
    const state = foldQuarantineLedgerState(
      [
        entered(),
        released('released-auto'),
        entered({ at: SECOND_ENTRY_AT, expiresAt: SECOND_EXPIRY }),
        released('released-manual'),
        entered({ at: THIRD_ENTRY_AT, expiresAt: THIRD_EXPIRY }),
      ],
      '2026-10-01T10:00:00.000Z',
    )
    expect(state[0].enteredCount).toBe(3)
    expect(state[0].firstEnteredAt).toBe(ENTERED_AT)
    expect(state[0].enteredAt).toBe(THIRD_ENTRY_AT)
  })

  it('a RENEWAL does not increment the count — a renewal extends a window, it does not open one', () => {
    // Without this leg `enteredCount` would silently become a count of WRITE events, which is a
    // different and much less useful number: a test renewed monthly for a year would read as 12
    // entries when it has had exactly one.
    const state = foldQuarantineLedgerState([entered(), renewed(), renewed()], BETWEEN_EXPIRIES)
    expect(state[0].enteredCount).toBe(1)
    expect(state[0].firstEnteredAt).toBe(ENTERED_AT)
  })

  it('a released window still reports the history it accumulated', () => {
    const state = foldQuarantineLedgerState(
      [
        entered(),
        released('released-auto'),
        entered({ at: SECOND_ENTRY_AT, expiresAt: SECOND_EXPIRY }),
        released('released-manual'),
      ],
      BETWEEN_EXPIRIES,
    )
    expect(state[0].state).toBe('released')
    expect(state[0].enteredCount).toBe(2)
    expect(state[0].firstEnteredAt).toBe(ENTERED_AT)
  })

  it('counts per identity key, never across tests', () => {
    const state = foldQuarantineLedgerState(
      [
        entered(),
        released('released-auto'),
        entered({ at: SECOND_ENTRY_AT, expiresAt: SECOND_EXPIRY }),
        entered({ testName: 'a different test' }),
      ],
      BETWEEN_EXPIRIES,
    )
    const byName = new Map(state.map((entry) => [entry.testName, entry] as const))
    expect(byName.get(TEST_NAME)?.enteredCount).toBe(2)
    expect(byName.get('a different test')?.enteredCount).toBe(1)
  })

  it('stays PURE — the same (events, now) pair answers deep-equal, and no clock is read', () => {
    const events = [
      entered(),
      released('released-auto'),
      entered({ at: SECOND_ENTRY_AT, expiresAt: SECOND_EXPIRY }),
    ]
    expect(foldQuarantineLedgerState(events, BETWEEN_EXPIRIES)).toEqual(
      foldQuarantineLedgerState(events, BETWEEN_EXPIRIES),
    )
    // And the derivation is a function of the EVENTS, not of when it was asked: a different `now`
    // moves the computed state and leaves both history legs alone.
    const later = foldQuarantineLedgerState(events, '2026-12-01T10:00:00.000Z')
    expect(later[0].state).toBe('expired')
    expect(later[0].enteredCount).toBe(2)
    expect(later[0].firstEnteredAt).toBe(ENTERED_AT)
  })

  it('answers identically whether the events arrive from the FILE or from an array', async () => {
    const knowledgeRoot = await mkdtemp(join(tmpdir(), 'quarantine-history-'))
    try {
      const events = [
        entered(),
        released('released-auto'),
        entered({ at: SECOND_ENTRY_AT, expiresAt: SECOND_EXPIRY }),
      ]
      await writeFile(
        join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME),
        events.map((event) => JSON.stringify(event)).join('\n') + '\n',
        'utf8',
      )
      const read = readQuarantineLedger(knowledgeRoot)
      expect(foldQuarantineLedgerState(read.events, BETWEEN_EXPIRIES)).toEqual(
        foldQuarantineLedgerState(events, BETWEEN_EXPIRIES),
      )
    } finally {
      await rm(knowledgeRoot, { recursive: true, force: true })
    }
  })

  it('never synthesizes an entry from a leading renewal or release — the new fields cannot resurrect one', () => {
    expect(foldQuarantineLedgerState([renewed()], BETWEEN_EXPIRIES)).toEqual([])
    expect(foldQuarantineLedgerState([released('released-manual')], BETWEEN_EXPIRIES)).toEqual([])
    expect(foldQuarantineLedgerState([renewed(), released('released-auto')], BETWEEN_EXPIRIES)).toEqual([])
  })
})

describe('appendQuarantineEvents', () => {
  let knowledgeRoot: string

  beforeEach(async () => {
    knowledgeRoot = await mkdtemp(join(tmpdir(), 'quarantine-append-'))
  })

  afterEach(async () => {
    await rm(knowledgeRoot, { recursive: true, force: true })
  })

  function ledgerText(): string {
    return readFileSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), 'utf8')
  }

  it('round-trips: append then read then fold reproduces the events identically', () => {
    const events = [entered(), renewed()]
    const outcome = appendQuarantineEvents(knowledgeRoot, events)
    expect(outcome).toEqual({ kind: 'appended', lines: 2 })

    const read = readQuarantineLedger(knowledgeRoot)
    expect(read.refusedLines).toEqual([])
    expect(read.events).toEqual(events)
    expect(foldQuarantineLedgerState(read.events, BETWEEN_EXPIRIES)).toEqual(
      foldQuarantineLedgerState(events, BETWEEN_EXPIRIES),
    )
  })

  it('writes canonical JSON, one event per line, newline-terminated', () => {
    appendQuarantineEvents(knowledgeRoot, [entered()])
    const text = ledgerText()
    expect(text).toBe(`${canonicalJson(entered())}\n`)
  })

  it('APPENDS — an existing ledger keeps every prior line', () => {
    appendQuarantineEvents(knowledgeRoot, [entered()])
    appendQuarantineEvents(knowledgeRoot, [renewed()])
    expect(readQuarantineLedger(knowledgeRoot).events).toEqual([entered(), renewed()])
    expect(ledgerText().trimEnd().split('\n')).toHaveLength(2)
  })

  it('creates the knowledge root when the first append lands', () => {
    const freshRoot = join(knowledgeRoot, 'nested', 'root')
    expect(existsSync(freshRoot)).toBe(false)
    expect(appendQuarantineEvents(freshRoot, [entered()])).toEqual({
      kind: 'appended',
      lines: 1,
    })
    expect(readQuarantineLedger(freshRoot).events).toEqual([entered()])
  })

  it('an empty event list is a no-op that writes no file', () => {
    expect(appendQuarantineEvents(knowledgeRoot, [])).toEqual({
      kind: 'appended',
      lines: 0,
    })
    expect(existsSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME))).toBe(false)
  })

  // The write applies the reader's predicate: a line the reader refuses corrupts the ledger.
  const UNMATCHABLE_IDENTITY = './tests/a.yaml'

  it('refuses an event the READ would refuse — throws, writes nothing', () => {
    expect(() =>
      appendQuarantineEvents(knowledgeRoot, [entered({ filePath: UNMATCHABLE_IDENTITY })]),
    ).toThrow(TypeError)

    // Named by INDEX, so a caller appending a batch knows which event it authored badly.
    expect(() =>
      appendQuarantineEvents(knowledgeRoot, [entered({ filePath: UNMATCHABLE_IDENTITY })]),
    ).toThrow(/index 0/)

    expect(existsSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME))).toBe(false)
  })

  it('a malformed SECOND event withholds the clean first one — all-or-nothing holds', () => {
    appendQuarantineEvents(knowledgeRoot, [entered()])
    const before = ledgerText()

    expect(() =>
      appendQuarantineEvents(
        knowledgeRoot,
        [renewed(), entered({ testName: 'second test', filePath: UNMATCHABLE_IDENTITY })],
      ),
    ).toThrow(/index 1/)

    expect(ledgerText()).toBe(before)
  })

  it('the SAME append with the canonical identity writes — the refusal has a reddening domain', () => {
    // Control: identical fixture, differing only in the filePath leg. Without it, "byte-unchanged"
    // above would be an absence rather than a measurement.
    const outcome = appendQuarantineEvents(
      knowledgeRoot,
      [renewed(), entered({ testName: 'second test', filePath: 'tests/a.yaml' })],
    )
    expect(outcome).toEqual({ kind: 'appended', lines: 2 })
    expect(ledgerText().trimEnd().split('\n')).toHaveLength(2)
    expect(readQuarantineLedger(knowledgeRoot).refusedLines).toEqual([])
  })

  // Finite versions refuse the whole file; `NaN` and `Infinity` become `null` and refuse one line.
  const WHOLE_FILE_REFUSED_VERSIONS: readonly (readonly [string, number])[] = [
    ['newer than this build', 3],
    ['older with no registered migration', 1],
    ['non-integer', 2.5],
  ]

  const LINE_REFUSED_VERSIONS: readonly (readonly [string, number])[] = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ]

  /** The WRITE ranges both modes identically — it refuses everything the read refuses, either way. */
  const READ_REFUSED_VERSIONS: readonly (readonly [string, number])[] = [
    ...WHOLE_FILE_REFUSED_VERSIONS,
    ...LINE_REFUSED_VERSIONS,
  ]

  for (const [label, schemaVersion] of READ_REFUSED_VERSIONS) {
    it(`refuses a schemaVersion the READ refuses — ${label} (${String(schemaVersion)})`, () => {
      expect(() =>
        appendQuarantineEvents(knowledgeRoot, [entered({ schemaVersion })]),
      ).toThrow(TypeError)

      // The throw names the offending index AND the leg that refused, so an operator reading it
      // can tell a malformed record from a wrong-version one.
      expect(() =>
        appendQuarantineEvents(knowledgeRoot, [entered({ schemaVersion })]),
      ).toThrow(/index 0[\s\S]*schemaVersion/)

      expect(existsSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME))).toBe(false)
    })
  }

  // The human path: hand-write the line past the gate and watch what the read does with it.
  function handWrite(lines: readonly string[]): void {
    writeFileSync(
      join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME),
      `${lines.join('\n')}\n`,
      'utf8',
    )
  }

  const NEIGHBOUR = entered({ testName: 'the neighbour on the same file' })

  for (const [label, schemaVersion] of WHOLE_FILE_REFUSED_VERSIONS) {
    it(`and the READ hard-fails the WHOLE FILE on it — ${label} (${String(schemaVersion)})`, () => {
      // The VALID line goes FIRST, so this asserts the sharp half of the mode: the reader had
      // already folded a good event when it met the bad one, and it hands back neither. There is
      // no partial read to salvage, which is why `list`, `add` and `release` all go down together.
      handWrite([canonicalJson(NEIGHBOUR), canonicalJson(entered({ schemaVersion }))])

      // The ERROR TYPE, asserted directly. Not a catch-all and not a disjunction: a
      // `QuarantineLedgerVersionError` is what distinguishes this mode from the other one, and a
      // test that accepts any throw cannot tell them apart.
      expect(() => readQuarantineLedger(knowledgeRoot)).toThrow(QuarantineLedgerVersionError)
    })
  }

  for (const [label, schemaVersion] of LINE_REFUSED_VERSIONS) {
    it(`and the READ refuses only that LINE — ${label} (${String(schemaVersion)})`, () => {
      // This member was never writable in the form its label claims. `canonicalJson` turns a
      // non-finite number into `null` before a byte reaches disk, so what the reader actually
      // meets is a NULL version — the guard's finite-number leg, a plain `TypeError`, a line-level
      // refusal. Asserted on the bytes rather than assumed.
      const offending = canonicalJson(entered({ schemaVersion }))
      expect(offending).toContain('"schemaVersion":null')

      handWrite([offending, canonicalJson(NEIGHBOUR)])

      // The read RETURNS. Asserted by using its value — a `toThrow` wrapper would pass here for
      // the wrong reason.
      const read = readQuarantineLedger(knowledgeRoot)
      expect(read.refusedLines).toEqual([
        { lineNumber: 1, reason: 'QuarantineLedgerEvent requires a numeric schemaVersion' },
      ])
      // THE SURVIVING NEIGHBOUR — the observable difference between the two modes, and the reason
      // the split matters operationally. A whole-file refusal loses this line; this mode keeps it,
      // so the ledger stays listable and both other verbs keep working.
      expect(read.events).toEqual([NEIGHBOUR])
    })
  }

  it('the two modes are NOT interchangeable — the old disjunction was satisfied by both', () => {
    // The control this replaced read: `refusedLines.length > 0 && events.length === 0`, OR a
    // `catch` setting the same flag. A whole-file member satisfies it through the catch; a
    // line-level member satisfies it through the refusedLines half — so a member could move
    // between the groups and the corpus would not notice. This leg asserts the two directions the
    // disjunction merged, so moving a member reds exactly one group.
    handWrite([canonicalJson(entered({ schemaVersion: 3 }))])
    expect(() => readQuarantineLedger(knowledgeRoot)).toThrow(QuarantineLedgerVersionError)

    handWrite([canonicalJson(entered({ schemaVersion: Number.NaN }))])
    const read = readQuarantineLedger(knowledgeRoot)
    expect(read.refusedLines).toHaveLength(1)
    expect(read.events).toEqual([])

    // And the write side does NOT split: it refuses both, on the same `=== CURRENT` comparison.
    for (const [, schemaVersion] of READ_REFUSED_VERSIONS) {
      expect(() =>
        appendQuarantineEvents(knowledgeRoot, [entered({ schemaVersion })]),
      ).toThrow(TypeError)
    }
  })

  it('the SAME append at the CURRENT version writes — the version refusal has a reddening domain', () => {
    // Accept-direction control on the identical fixture shape. Without it the five refusals above
    // are satisfiable by a `throw` on everything.
    const event = entered({ schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION })
    expect(appendQuarantineEvents(knowledgeRoot, [event])).toEqual({
      kind: 'appended',
      lines: 1,
    })
    const read = readQuarantineLedger(knowledgeRoot)
    expect(read.refusedLines).toEqual([])
    expect(read.events).toEqual([event])
  })

  it('a wrong-version SECOND event withholds the clean first one — all-or-nothing holds', () => {
    appendQuarantineEvents(knowledgeRoot, [entered()])
    const before = ledgerText()

    expect(() =>
      appendQuarantineEvents(
        knowledgeRoot,
        [renewed(), entered({ testName: 'second test', schemaVersion: 3 })],
      ),
    ).toThrow(/index 1/)

    expect(ledgerText()).toBe(before)
  })

  it('reads no clock — the caller stamps every instant', () => {
    appendQuarantineEvents(knowledgeRoot, [entered()])
    const [event] = readQuarantineLedger(knowledgeRoot).events
    expect(event.at).toBe(ENTERED_AT)
    if (event.kind !== 'entered') throw new Error('expected an entered event')
    expect(event.expiresAt).toBe(EXPIRES_AT)
  })
})

// Committed ledger text is not scanned for secrets.

describe('quarantine rows with credential-shaped text', () => {
  const CARD_TEST_NAME = 'checkout pays with 4242 4242 4242 4242'
  const BEARER_OWNER = 'oncall Bearer abc123def456ghi789'
  let knowledgeRoot: string

  beforeEach(async () => {
    knowledgeRoot = await mkdtemp(join(tmpdir(), 'quarantine-c441-committed-'))
  })

  afterEach(async () => {
    await rm(knowledgeRoot, { recursive: true, force: true })
  })

  it('a quarantine ledger row with credential-shaped text is appended as written', () => {
    const event = entered({ testName: CARD_TEST_NAME, owner: BEARER_OWNER })

    expect(appendQuarantineEvents(knowledgeRoot, [event])).toEqual({ kind: 'appended', lines: 1 })

    const text = readFileSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), 'utf8')
    expect(text).toBe(`${canonicalJson(event)}\n`)
    expect(text).toContain('4242 4242 4242 4242')
    expect(text).toContain('Bearer abc123def456ghi789')
    expect(readQuarantineLedger(knowledgeRoot)).toEqual({ events: [event], refusedLines: [] })
  })

  it('quarantine.add with the same text answers entered and the row reads back as written', async () => {
    const operations = createQuarantineOperations({
      resolveKnowledgeRoot: () => knowledgeRoot,
      now: () => ENTERED_AT,
      mintIdentityPath: (filePath) => filePath,
    })

    expect(await operations.add({
      product: PRODUCT, filePath: FILE_PATH, testName: CARD_TEST_NAME, owner: BEARER_OWNER,
    })).toMatchObject({ kind: 'entered' })

    const [row] = readQuarantineLedger(knowledgeRoot).events
    expect(row).toMatchObject({ kind: 'entered', testName: CARD_TEST_NAME, owner: BEARER_OWNER })
    expect(readFileSync(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), 'utf8'))
      .toBe(`${canonicalJson(row)}\n`)
  })
})

// ---- The committed-root placement claim -----

describe('the ledger is genuinely committed at the knowledge root', () => {
  it('is not swallowed by any knowledge-root ignore rule', () => {
    // Checked against the shipped root's ignore file, so a rule matching the ledger reds here.
    const ignoreRules = [
      'memory/index/',
      'memory/queue/',
      '.lease',
      '.epoch',
      '**/artifacts/',
      'skills/.staging/',
    ]

    for (const rule of ignoreRules) {
      const bare = rule.replace(/^\*\*\//, '').replace(/\/$/, '')
      expect(QUARANTINE_LEDGER_FILENAME).not.toBe(bare)
      expect(QUARANTINE_LEDGER_FILENAME.startsWith(`${bare}/`)).toBe(false)
    }

    // It is a top-level FILE, not nested under any shelf — the property those rules key on.
    expect(QUARANTINE_LEDGER_FILENAME).not.toContain('/')
    expect(QUARANTINE_LEDGER_FILENAME.startsWith('.')).toBe(false)
  })
})
