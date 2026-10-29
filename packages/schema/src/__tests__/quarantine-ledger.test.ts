// A broken ledger event is refused, never healed to absence: healing would silently un-quarantine.

import { describe, expect, it } from 'vitest'

import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_EVENT_KINDS,
  QUARANTINE_UNASSIGNED_OWNER,
  QUARANTINE_LEDGER_MIGRATIONS,
  QuarantineLedgerVersionError,
  guardQuarantineLedgerEvent,
  hasQuarantineEventShape,
} from '../quarantine/quarantine-ledger'
import type {
  QuarantineAppliedEntry,
  QuarantineEntryState,
  QuarantineLadderState,
  QuarantineLedgerEvent,
} from '../quarantine/quarantine-ledger'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '../handoff/completed-run-handoff'
import type { CompletedRunHandoff } from '../handoff/completed-run-handoff'
import { guardCompletedRunHandoff } from '../handoff/load-completed-run-handoff'
import type { PerTestOutcome } from '../handoff/per-test-outcome'
import { VERDICT_CLASSES, isVerdictClass } from '../verdict/verdict'
import type { Verdict, VerdictClass } from '../verdict/verdict'
import { VersionGuardError } from '../versioning/create-version-guard'

// ---- Fixtures ------------------------------------------------------------

function enteredEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'entered',
    at: '2026-08-05T10:00:00.000Z',
    product: 'example-web',
    filePath: 'tests/checkout.test.yaml',
    testName: 'checkout completes',
    fingerprint: 'fp-1',
    verdictClass: 'flake',
    owner: QUARANTINE_UNASSIGNED_OWNER,
    expiresAt: '2026-09-04T10:00:00.000Z',
    ...overrides,
  }
}

// ---- The closed event vocabulary ----------------

describe('quarantine ledger event vocabulary', () => {
  it('pins the version at 2 with a DELIBERATELY empty migration seam', () => {
    // A version 1 line holds a machine-local absolute path no checkout can map, so it fails typed.
    expect(CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION).toBe(2)
    expect(QUARANTINE_LEDGER_MIGRATIONS).toEqual({})
    expect(QUARANTINE_LEDGER_MIGRATIONS[1]).toBeUndefined()
  })

  it('closes the event-kind union over the four lifecycle actions', () => {
    // `expired` is computed, never an event: the list holds append-only lifecycle actions.
    expect([...QUARANTINE_EVENT_KINDS]).toEqual([
      'entered',
      'renewed',
      'released-manual',
      'released-auto',
    ])
    expect(QUARANTINE_EVENT_KINDS).not.toContain('expired')
  })

  it('spells the typed unassigned owner literal (honest absence)', () => {
    expect(QUARANTINE_UNASSIGNED_OWNER).toBe('unassigned')
  })

  it('mints the state vocabulary once — entry states and the ladder states', () => {
    const quarantined: QuarantineEntryState['state'] = 'quarantined'
    const expired: QuarantineEntryState['state'] = 'expired'
    const released: QuarantineEntryState['state'] = 'released'
    expect([quarantined, expired, released]).toEqual(['quarantined', 'expired', 'released'])

    // `flagged` is detection-layer visibility only and never appears in the ledger.
    const ladder: QuarantineLadderState[] = ['flagged', 'quarantined', 'expired']
    expect(ladder).toHaveLength(3)
  })
})

// ---- The canonical verdict-class vocabulary the ledger keys on -----------

describe('verdict class vocabulary', () => {
  it('agrees with the Verdict union it is derived from', () => {
    type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const unionsAgree: AssertEqual<VerdictClass, Verdict['class']> = true
    expect(unionsAgree).toBe(true)
    expect([...VERDICT_CLASSES].sort()).toEqual(
      [
        'app_bug',
        'config_error',
        'environment',
        'flake',
        'llm_error',
        'test_bug',
        'timeout',
        'unknown',
      ].sort(),
    )
  })

  it('admits only closed-set members', () => {
    expect(isVerdictClass('flake')).toBe(true)
    expect(isVerdictClass('quarantined')).toBe(false)
    expect(isVerdictClass(3)).toBe(false)
  })
})

// ---- guardQuarantineLedgerEvent ------------------------------------------

describe('guardQuarantineLedgerEvent', () => {
  it('admits a well-formed current-version entered event BY IDENTITY', () => {
    const stored = enteredEvent()
    const admitted = guardQuarantineLedgerEvent(stored)
    expect(admitted).toBe(stored as unknown as QuarantineLedgerEvent)
    expect(admitted.kind).toBe('entered')
    if (admitted.kind !== 'entered') throw new Error('expected an entered event')
    expect(admitted.owner).toBe(QUARANTINE_UNASSIGNED_OWNER)
    expect(admitted.expiresAt).toBe('2026-09-04T10:00:00.000Z')
  })

  it('admits renewed and both released kinds', () => {
    const renewed = guardQuarantineLedgerEvent({
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'renewed',
      at: '2026-08-06T10:00:00.000Z',
      product: 'example-web',
      filePath: 'tests/checkout.test.yaml',
      testName: 'checkout completes',
      expiresAt: '2026-10-04T10:00:00.000Z',
      owner: 'alice',
    })
    expect(renewed.kind).toBe('renewed')

    for (const kind of ['released-manual', 'released-auto'] as const) {
      const released = guardQuarantineLedgerEvent({
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
        kind,
        at: '2026-08-07T10:00:00.000Z',
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
      })
      expect(released.kind).toBe(kind)
    }
  })

  it('refuses a value whose kind is outside the closed union', () => {
    expect(() => guardQuarantineLedgerEvent(enteredEvent({ kind: 'evicted' }))).toThrow(TypeError)
    expect(() => guardQuarantineLedgerEvent(enteredEvent({ kind: 'expired' }))).toThrow(TypeError)
  })

  it('refuses a value missing any leg of the stable identity', () => {
    for (const missing of ['product', 'filePath', 'testName'] as const) {
      const broken = enteredEvent()
      delete broken[missing]
      expect(() => guardQuarantineLedgerEvent(broken)).toThrow(TypeError)
    }
    // Empty identity strings are refused too — they would key a phantom entry.
    expect(() => guardQuarantineLedgerEvent(enteredEvent({ testName: '' }))).toThrow(TypeError)
  })

  it('refuses an entered event missing its own required lifecycle fields', () => {
    for (const missing of ['fingerprint', 'verdictClass', 'owner', 'expiresAt'] as const) {
      const broken = enteredEvent()
      delete broken[missing]
      expect(() => guardQuarantineLedgerEvent(broken)).toThrow(TypeError)
    }
    expect(() => guardQuarantineLedgerEvent(enteredEvent({ verdictClass: 'quarantined' }))).toThrow(
      TypeError,
    )
  })

  it('hard-fails a NEWER schemaVersion with the typed ledger version error', () => {
    const newer = CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION + 1
    let thrown: unknown
    try {
      guardQuarantineLedgerEvent(enteredEvent({ schemaVersion: newer }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(QuarantineLedgerVersionError)
    expect(thrown).toBeInstanceOf(VersionGuardError)
    const versionError = thrown as QuarantineLedgerVersionError
    expect(versionError.name).toBe('QuarantineLedgerVersionError')
    expect(versionError.documentName).toBe('QuarantineLedgerEvent')
    expect(versionError.foundVersion).toBe(newer)
    expect(versionError.supportedVersion).toBe(CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION)
  })

  it('hard-fails a stored VERSION-1 line — the unmigratable-older arm', () => {
    let thrown: unknown
    try {
      guardQuarantineLedgerEvent(enteredEvent({
        schemaVersion: 1,
        filePath: '/Users/someone/repo/tests/checkout.yaml',
      }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(QuarantineLedgerVersionError)
    const versionError = thrown as QuarantineLedgerVersionError
    expect(versionError.foundVersion).toBe(1)
    expect(versionError.supportedVersion).toBe(CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION)

    // The version-2 line carrying the workspace-relative identity is the shape that DOES pass —
    // otherwise the refusal above would prove nothing about which contract is current.
    expect(guardQuarantineLedgerEvent(enteredEvent({ schemaVersion: 2 })).kind).toBe('entered')
  })

  it('refuses a line with no numeric schemaVersion at all', () => {
    const broken = enteredEvent()
    delete broken.schemaVersion
    expect(() => guardQuarantineLedgerEvent(broken)).toThrow(TypeError)
  })

  it('exposes the structural check the read path uses ahead of the guard', () => {
    expect(hasQuarantineEventShape(enteredEvent())).toBe(true)
    expect(hasQuarantineEventShape(enteredEvent({ kind: 'evicted' }))).toBe(false)
    expect(hasQuarantineEventShape(null)).toBe(false)
    expect(hasQuarantineEventShape([enteredEvent()])).toBe(false)
  })
})

// ---- The identity leg is CHECKOUT-INDEPENDENT -----

describe('quarantine identity leg portability', () => {
  // The ledger is COMMITTED and travels between machines. An absolute filePath is bytes only one
  // machine can produce, so `quarantineAppliesToTest`'s `===` could never match on a fresh CI
  // checkout — the ledger would be committed FOR an inheritance it structurally cannot deliver.
  // Refusing the absolute form at the shape guard makes that unrepresentable rather than asserted.

  it('refuses a POSIX absolute identity leg', () => {
    expect(hasQuarantineEventShape(
      enteredEvent({ filePath: '/Users/someone/repo/tests/checkout.yaml' }),
    )).toBe(false)
    expect(() => guardQuarantineLedgerEvent(
      enteredEvent({ filePath: '/Users/someone/repo/tests/checkout.yaml' }),
    )).toThrow(TypeError)
  })

  it('refuses a Windows-drive identity leg in either slash direction', () => {
    for (const absolute of [
      'C:\\repo\\tests\\checkout.yaml',
      'C:/repo/tests/checkout.yaml',
      'd:/repo/tests/checkout.yaml',
      '\\\\server\\share\\tests\\checkout.yaml',
    ]) {
      expect(hasQuarantineEventShape(enteredEvent({ filePath: absolute }))).toBe(false)
    }
  })

  it('refuses the absolute form on EVERY event kind, not just entered', () => {
    const absolute = '/Users/someone/repo/tests/checkout.yaml'
    for (const kind of QUARANTINE_EVENT_KINDS) {
      const event = enteredEvent({ kind, filePath: absolute, expiresAt: '2026-09-04T10:00:00.000Z' })
      expect(hasQuarantineEventShape(event)).toBe(false)
    }
  })

  it('admits the workspace-relative identity the CLI now mints', () => {
    for (const relative of [
      'tests/checkout.yaml',
      'tests/nested/deep/checkout.yaml',
      'checkout.yaml',
      'suites/checkout/flow.yaml',
    ]) {
      expect(hasQuarantineEventShape(enteredEvent({ filePath: relative }))).toBe(true)
    }
  })

  // `./x`, `x\y` and `../x` pass a not-absolute guard yet never match the mint's form.

  const REJECTED_SIBLINGS: readonly (readonly [string, string])[] = [
    ['./tests/a.yaml', 'a leading current-dir prefix the mint trims'],
    ['tests\\a.yaml', 'a backslash separator the mint never emits'],
    ['../outside.yaml', 'a leading parent segment — outside the config directory'],
    ['tests/../../outside.yaml', 'an embedded parent segment that escapes'],
    ['C:foo/bar', 'a Windows DRIVE-RELATIVE prefix (no root slash)'],
    ['C:foo\\bar', 'a Windows drive-relative prefix with backslashes'],
  ]

  // One `it` per input class on purpose: a single loop short-circuits on the first sibling, so a
  // RED baseline taken over it could not say which of the classes are actually admitted today.
  it.each(REJECTED_SIBLINGS)('refuses %s — %s', (filePath) => {
    expect(hasQuarantineEventShape(enteredEvent({ filePath }))).toBe(false)
    expect(() => guardQuarantineLedgerEvent(enteredEvent({ filePath }))).toThrow(TypeError)
  })

  it.each(REJECTED_SIBLINGS)(
    'refuses %s on EVERY event kind, not just entered — %s',
    (filePath) => {
      for (const kind of QUARANTINE_EVENT_KINDS) {
        const event = enteredEvent({
          kind,
          filePath,
          expiresAt: '2026-09-04T10:00:00.000Z',
        })
        expect(hasQuarantineEventShape(event), kind).toBe(false)
      }
    },
  )
})

// ---- The handoff disposition contract ----------------------

describe('handoff quarantine disposition', () => {
  function handoffFixture(tests: PerTestOutcome[], applied?: QuarantineAppliedEntry[]): unknown {
    return {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: 'run-1',
      scope: { tier: 'product', key: 'example-web' },
      buildOrdinal: 7,
      executionContext: 'local-headless',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'a', testConfigDigest: 'b' },
      startedAt: 1,
      endedAt: 2,
      tests,
      ...(applied === undefined ? {} : { quarantineApplied: applied }),
    }
  }

  function memberFixture(overrides: Partial<PerTestOutcome> = {}): PerTestOutcome {
    return {
      testId: 't1',
      testName: 'checkout completes',
      filePath: 'tests/checkout.test.yaml',
      testIndex: 0,
      outcome: 'failed',
      steps: [],
      ...overrides,
    }
  }

  it('carries the disposition BESIDE a truthful failed outcome', () => {
    const member = memberFixture({ quarantined: true })
    expect(member.outcome).toBe('failed')
    const handoff = guardCompletedRunHandoff(
      handoffFixture([member], [
        {
          product: 'example-web',
          filePath: 'tests/checkout.test.yaml',
          testName: 'checkout completes',
          expiresAt: '2026-09-04T10:00:00.000Z',
        },
      ]),
    ) as CompletedRunHandoff
    expect(handoff.tests[0].quarantined).toBe(true)
    expect(handoff.quarantineApplied).toEqual([
      {
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: '2026-09-04T10:00:00.000Z',
      },
    ])
  })

  it('keeps absence absent — an unquarantined member has no disposition key', () => {
    const handoff = guardCompletedRunHandoff(handoffFixture([memberFixture()])) as CompletedRunHandoff
    expect('quarantined' in handoff.tests[0]).toBe(false)
    expect('quarantineApplied' in handoff).toBe(false)
  })

  it('refuses a non-literal-true disposition (the excludedFromOutcomes idiom)', () => {
    expect(() =>
      guardCompletedRunHandoff(handoffFixture([memberFixture({ quarantined: false as never })])),
    ).toThrow(TypeError)
  })

  it('refuses a structurally broken applied-entry list', () => {
    expect(() =>
      guardCompletedRunHandoff(
        handoffFixture([memberFixture()], [{ product: 'example-web' } as never]),
      ),
    ).toThrow(TypeError)
    expect(() =>
      guardCompletedRunHandoff(handoffFixture([memberFixture()], {} as never)),
    ).toThrow(TypeError)
  })
})
