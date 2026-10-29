// Each property is pinned two-sided: the step below and the step above every boundary.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  VERDICT_CLASSES,
  canonicalJson,
} from '@vostride/agent-qa-schema'
import type { QuarantineEntryState, VerdictClass } from '@vostride/agent-qa-schema'

import {
  AUTO_QUARANTINE_CLASSES,
  QUARANTINE_AUTO_EXIT_PASSES,
  QUARANTINE_CLASS_DISPOSITIONS,
  QUARANTINE_DEFAULT_EXPIRY_DAYS,
  QUARANTINE_ESCALATE_THRESHOLD,
  QUARANTINE_FLAG_FLOOR,
  QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP,
  QUARANTINE_FLOOR_ELIGIBILITY,
  QUARANTINE_WINDOW_ORDINALS,
  compareQuarantineIdentity,
  evaluateQuarantineDetection,
  hasSameBuildPassAndFail,
} from '../detection.js'
import { quarantineIdentityKey } from '../identity.js'
import type {
  QuarantineDetectionFailure,
  QuarantineDetectionTestWindow,
  QuarantineOrdinalOutcome,
} from '../detection.js'

/** The rule's own source — the purity assertions read it rather than trusting a doc comment. */
const DETECTION_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'detection.ts',
)

const PRODUCT = 'example-web'
const FILE_PATH = 'tests/checkout.test.yaml'
const TEST_NAME = 'checkout completes'
const FINGERPRINT = '{"name":"submit","ordinal":0,"role":"button","t":"el"}::flake'
const NOW = '2026-08-05T12:00:00.000Z'
/** NOW + QUARANTINE_DEFAULT_EXPIRY_DAYS (30 d), computed by hand so the constant is pinned. */
const EXPECTED_EXPIRY = '2026-09-04T12:00:00.000Z'

function failure(
  overrides: Partial<QuarantineDetectionFailure> = {},
): QuarantineDetectionFailure {
  return {
    product: PRODUCT,
    filePath: FILE_PATH,
    testName: TEST_NAME,
    fingerprint: FINGERPRINT,
    verdictClass: 'flake',
    // Authored by default, so these legs vary only the disposition axis.
    producer: 'analyze-run',
    // No signature by default; the signature axis is varied in its own suite.
    sameBuildPassAndFail: false,
    occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
    windowOrdinals: QUARANTINE_WINDOW_ORDINALS,
    ...overrides,
  }
}

/** A test window of `count` DISTINCT ordinals, every one of them passing. */
function passingWindow(
  count: number,
  overrides: Partial<QuarantineDetectionTestWindow> = {},
): QuarantineDetectionTestWindow {
  return {
    product: PRODUCT,
    filePath: FILE_PATH,
    testName: TEST_NAME,
    ordinals: Array.from({ length: count }, (_unused, index) => ({
      buildOrdinal: index + 1,
      passed: true,
    })),
    ...overrides,
  }
}

function activeEntry(overrides: Partial<QuarantineEntryState> = {}): QuarantineEntryState {
  return {
    product: PRODUCT,
    filePath: FILE_PATH,
    testName: TEST_NAME,
    fingerprint: FINGERPRINT,
    verdictClass: 'flake',
    owner: QUARANTINE_UNASSIGNED_OWNER,
    enteredAt: '2026-07-06T12:00:00.000Z',
    expiresAt: '2026-09-01T12:00:00.000Z',
    enteredCount: 1,
    firstEnteredAt: '2026-07-06T12:00:00.000Z',
    state: 'quarantined',
    ...overrides,
  }
}

function evaluate(input: {
  failures?: QuarantineDetectionFailure[]
  testWindows?: QuarantineDetectionTestWindow[]
  entries?: QuarantineEntryState[]
  now?: string
}) {
  return evaluateQuarantineDetection({
    failures: input.failures ?? [],
    testWindows: input.testWindows ?? [],
    entries: input.entries ?? [],
    now: input.now ?? NOW,
  })
}

describe('detection ladder constants', () => {
  it('pins the memory.md §9.5 trigger and the quarantine defaults verbatim', () => {
    expect(QUARANTINE_FLAG_FLOOR).toBe(2)
    expect(QUARANTINE_ESCALATE_THRESHOLD).toBe(3)
    expect(QUARANTINE_WINDOW_ORDINALS).toBe(5)
    expect(QUARANTINE_AUTO_EXIT_PASSES).toBe(5)
    expect(QUARANTINE_DEFAULT_EXPIRY_DAYS).toBe(30)
  })

  it('reads no threshold from the environment', () => {
    const source = readFileSync(DETECTION_SOURCE, 'utf8')
    expect(source).not.toMatch(/process\.env/)
  })

  it('spells the auto-quarantine set exactly once, derived from the disposition table', () => {
    expect([...AUTO_QUARANTINE_CLASSES].sort()).toEqual(['environment', 'flake', 'timeout'])
  })
})

describe('the class gate is TOTAL over the closed verdict vocabulary', () => {
  it('dispositions every one of the eight VERDICT_CLASSES — no member left unenumerated', () => {
    expect(Object.keys(QUARANTINE_CLASS_DISPOSITIONS).sort())
      .toEqual([...VERDICT_CLASSES].sort())
  })

  it.each(VERDICT_CLASSES)(
    'routes %s the same way at escalation as its disposition declares',
    (verdictClass: VerdictClass) => {
      const result = evaluate({
        failures: [failure({ verdictClass, fingerprint: `fp::${verdictClass}` })],
      })
      const autoQuarantines = QUARANTINE_CLASS_DISPOSITIONS[verdictClass] === 'auto-quarantine'
      expect(result.events).toHaveLength(autoQuarantines ? 1 : 0)
      expect(result.escalatedNotQuarantined).toHaveLength(autoQuarantines ? 0 : 1)
      // Either way the crossing surfaces: an escalation that appends nothing must still be loud.
      const surfaced = autoQuarantines
        ? result.events.map((event) => event.testName)
        : result.escalatedNotQuarantined.map((sighting) => sighting.testName)
      expect(surfaced).toEqual([TEST_NAME])
    },
  )

  it('never auto-quarantines the five classes outside that set, at ANY recurrence', () => {
    const nonA3 = VERDICT_CLASSES.filter((name) => !AUTO_QUARANTINE_CLASSES.includes(name))
    expect(nonA3).toHaveLength(5)
    const result = evaluate({
      failures: nonA3.map((verdictClass) => failure({
        verdictClass,
        fingerprint: `fp::${verdictClass}`,
        testName: `${TEST_NAME} ${verdictClass}`,
        // 5-in-5: the maximum the window can express, so this cannot pass for want of recurrence.
        occurrenceOrdinals: QUARANTINE_WINDOW_ORDINALS,
      })),
    })
    expect(result.events).toEqual([])
    expect(result.escalatedNotQuarantined).toHaveLength(5)
  })
})

// Each conjunct has its own reddening leg, so the suite shows which one is load-bearing.
describe('the floor arm: a floor-eligible class AND a per-test signature', () => {
  // Named from the TABLES rather than from string literals, so a future table edit REDS this
  // corpus instead of drifting past it.
  const FLOOR_ELIGIBLE_AUTO_CLASSES: readonly VerdictClass[] = AUTO_QUARANTINE_CLASSES
    .filter((name) => QUARANTINE_FLOOR_ELIGIBILITY[name] === 'floor-eligible')
  const AUTHORED_REQUIRED_AUTO_CLASSES: readonly VerdictClass[] = AUTO_QUARANTINE_CLASSES
    .filter((name) => QUARANTINE_FLOOR_ELIGIBILITY[name] === 'authored-required')

  it('is TOTAL over the closed vocabulary — no member left un-decided', () => {
    expect(Object.keys(QUARANTINE_FLOOR_ELIGIBILITY).sort()).toEqual([...VERDICT_CLASSES].sort())
  })

  it('states the RE-DECIDED floor-eligible set as DATA — flake and timeout, nothing else', () => {
    expect(
      VERDICT_CLASSES.filter((name) => QUARANTINE_FLOOR_ELIGIBILITY[name] === 'floor-eligible'),
    ).toEqual(['flake', 'timeout'])
    // Escalate-only classes stay authored-required, so a disposition flip cannot license the floor.
    expect([...AUTHORED_REQUIRED_AUTO_CLASSES]).toEqual(['environment'])
    expect([...FLOOR_ELIGIBLE_AUTO_CLASSES].sort()).toEqual(['flake', 'timeout'])
  })

  // No authored verdict anywhere in this input, and an `entered` line is authored anyway.
  it('AUTO-QUARANTINES a floor-produced timeout CARRYING the signature — no analysis budget', () => {
    const result = evaluate({
      failures: [failure({
        verdictClass: 'timeout',
        producer: 'deterministic-classifier',
        sameBuildPassAndFail: true,
        fingerprint: 'fp::timeout',
      })],
    })

    expect(result.escalatedNotQuarantined).toEqual([])
    expect(result.flagged).toEqual([])
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      kind: 'entered',
      verdictClass: 'timeout',
      testName: TEST_NAME,
    })
  })

  // THE SIGNATURE CONJUNCT'S MUTATION TARGET. Deleting `&& failure.sameBuildPassAndFail` from
  // `autoQuarantines` reds this leg and nothing else.
  it('REFUSES the SAME timeout crossing without the signature — loudly, build still failing', () => {
    const result = evaluate({
      failures: [failure({
        verdictClass: 'timeout',
        producer: 'deterministic-classifier',
        sameBuildPassAndFail: false,
        fingerprint: 'fp::timeout',
      })],
    })

    expect(result.events).toEqual([])
    expect(result.flagged).toEqual([])
    // Refused is not dropped: the crossing lands where the curation tail already renders it. A
    // silent third arm would be the anti-silencing defect wearing a hat.
    expect(result.escalatedNotQuarantined).toHaveLength(1)
    expect(result.escalatedNotQuarantined[0]).toMatchObject({
      verdictClass: 'timeout',
      producer: 'deterministic-classifier',
      occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
    })
  })

  // Deleting the class conjunct reds this leg and nothing else.
  it('REFUSES a floor-produced environment crossing EVEN WITH the signature', () => {
    const result = evaluate({
      failures: [failure({
        verdictClass: 'environment',
        producer: 'deterministic-classifier',
        sameBuildPassAndFail: true,
        fingerprint: 'fp::environment',
      })],
    })

    expect(result.events).toEqual([])
    expect(result.escalatedNotQuarantined).toHaveLength(1)
    expect(result.escalatedNotQuarantined[0]).toMatchObject({
      verdictClass: 'environment',
      producer: 'deterministic-classifier',
    })
  })

  it.each([false, true])(
    'ACCEPTS an analyze-run environment crossing with signature=%s — the first disjunct is untouched',
    (sameBuildPassAndFail: boolean) => {
      const result = evaluate({
        failures: [failure({
          verdictClass: 'environment',
          producer: 'analyze-run',
          sameBuildPassAndFail,
          fingerprint: 'fp::environment',
        })],
      })

      expect(result.escalatedNotQuarantined).toEqual([])
      expect(result.events).toHaveLength(1)
      expect(result.events[0]).toMatchObject({ kind: 'entered', verdictClass: 'environment' })
    },
  )

  it.each([false, true])(
    'ACCEPTS an analyze-run timeout crossing with signature=%s — the accept-direction control',
    (sameBuildPassAndFail: boolean) => {
      const result = evaluate({
        failures: [failure({
          verdictClass: 'timeout',
          producer: 'analyze-run',
          sameBuildPassAndFail,
          fingerprint: 'fp::timeout',
        })],
      })

      expect(result.escalatedNotQuarantined).toEqual([])
      expect(result.events).toHaveLength(1)
      expect(result.events[0]).toMatchObject({ kind: 'entered', verdictClass: 'timeout' })
    },
  )

  // The floor mints `flake` only on a passing member, so a buildable `flake` crossing is authored.
  it('auto-quarantines an analyze-run flake — the only flake crossing the pipeline builds', () => {
    const result = evaluate({
      failures: [failure({ verdictClass: 'flake', producer: 'analyze-run' })],
    })

    expect(result.escalatedNotQuarantined).toEqual([])
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ kind: 'entered', verdictClass: 'flake' })
  })

  it('refuses an escalate-only class carrying BOTH a floor producer and the signature', () => {
    const nonA3 = VERDICT_CLASSES.filter((name) => !AUTO_QUARANTINE_CLASSES.includes(name))
    expect(nonA3).toHaveLength(5)
    const result = evaluate({
      failures: nonA3.map((verdictClass) => failure({
        verdictClass,
        producer: 'deterministic-classifier',
        sameBuildPassAndFail: true,
        fingerprint: `fp::${verdictClass}`,
        testName: `${TEST_NAME} ${verdictClass}`,
      })),
    })
    // The DISPOSITION table runs first, so neither floor conjunct ever gets a say.
    expect(result.events).toEqual([])
    expect(result.escalatedNotQuarantined).toHaveLength(5)
  })

  it('leaves the five escalate-only classes untouched on BOTH producer values', () => {
    const nonA3 = VERDICT_CLASSES.filter((name) => !AUTO_QUARANTINE_CLASSES.includes(name))
    for (const producer of ['deterministic-classifier', 'analyze-run'] as const) {
      const result = evaluate({
        failures: nonA3.map((verdictClass) => failure({
          verdictClass,
          producer,
          fingerprint: `fp::${verdictClass}`,
          testName: `${TEST_NAME} ${verdictClass}`,
        })),
      })
      // An authored config_error is still not quarantinable — the point of two tables.
      expect(result.events).toEqual([])
      expect(result.escalatedNotQuarantined).toHaveLength(5)
    }
  })
})

// Every floor class on a failing member can come from a run-scoped cause, so the gate is a count.
describe('the per-run floor cap RATE-LIMITS fan-out — a budget, not a ceiling', () => {
  const SUITE_SIZE = 6
  const K = QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP

  /** Every member of the suite, by index — the one place the suite's size is spent. */
  const MEMBER_INDICES = Array.from({ length: SUITE_SIZE }, (_unused, index) => index)

  /**
   * A member's identity, spelled ONCE for every fixture in this describe. The crossing fixture and
   * the already-quarantined fixture build the same three fields from the same index, so the two
   * cannot name different tests while looking like they name the same one.
   */
  function member(index: number): Pick<
    QuarantineDetectionFailure,
    'testName' | 'filePath' | 'fingerprint'
  > {
    return {
      testName: `${TEST_NAME} ${String(index)}`,
      filePath: `suite/member-${String(index)}.test.ts`,
      fingerprint: `fp::member-${String(index)}`,
    }
  }

  /** N distinct IDENTITIES crossing in ONE evaluation — the 6-of-6 shape, on the floor arm. */
  function suite(overrides: Partial<QuarantineDetectionFailure>): QuarantineDetectionFailure[] {
    return MEMBER_INDICES.map((index) => failure({ ...member(index), ...overrides }))
  }

  /** The ladder's own identity order, named rather than assumed positionally. */
  const MEMBER_NAMES = MEMBER_INDICES.map((index) => member(index).testName)

  // The index travels as DATA rather than being recovered from the test name: a name-suffix parse
  // is correct only while SUITE_SIZE <= 10, which is the natural edit when retuning the cap.
  function quarantinedEntriesFor(indices: readonly number[]): QuarantineEntryState[] {
    return indices.map((index) => activeEntry({ ...member(index), state: 'quarantined' }))
  }

  // The two bounds below are stated against THIS CORPUS'S OWN FIXTURE, never against a field
  // observation: SUITE_SIZE is the size of the suite these legs build, so `< SUITE_SIZE` says only
  // that the fixture is large enough to overflow the cap and therefore capable of measuring it.
  // Strictly above 1 keeps the mechanism from being a de facto single-shot — two genuinely
  // independent flaky tests can still both land in one run.
  it('pins the cap as its own constant — 2, a per-run budget above 1 and under this suite size', () => {
    expect(QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP).toBe(2)
    expect(QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP).toBeLessThan(SUITE_SIZE)
    expect(QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP).toBeGreaterThan(1)
  })

  // Input is in reverse identity order; counting arrivals would admit members 5 and 4.
  it('admits exactly K of SIX floor-produced crossings in ONE evaluation, by identity — input reversed', () => {
    const result = evaluate({
      failures: [...suite({
        verdictClass: 'timeout',
        producer: 'deterministic-classifier',
        sameBuildPassAndFail: true,
      })].reverse(),
    })

    // The ladder sorts before it counts, so reversed input admits the same two members in order.
    expect(result.events.map((event) => event.testName)).toEqual(MEMBER_NAMES.slice(0, K))
    expect(result.escalatedNotQuarantined.map((s) => s.testName)).toEqual(MEMBER_NAMES.slice(K))
    expect(result.events).toHaveLength(K)
    expect(result.escalatedNotQuarantined).toHaveLength(SUITE_SIZE - K)
  })

  it('routes the overflow LOUDLY — class and producer visible, nothing dropped', () => {
    const result = evaluate({
      failures: suite({
        verdictClass: 'timeout',
        producer: 'deterministic-classifier',
        sameBuildPassAndFail: true,
      }),
    })

    for (const overflow of result.escalatedNotQuarantined) {
      expect(overflow).toMatchObject({
        verdictClass: 'timeout',
        producer: 'deterministic-classifier',
        occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
      })
    }
    // Nothing vanished: every identity is in exactly one bucket.
    expect([
      ...result.events.map((event) => event.testName),
      ...result.escalatedNotQuarantined.map((s) => s.testName),
    ].sort()).toEqual([...MEMBER_NAMES].sort())
  })

  // An authored verdict is per-test evidence, so the run-level hazard the cap guards is absent.
  it('does NOT cap the authored arm — six analyze-run crossings all enter', () => {
    const result = evaluate({
      failures: suite({ verdictClass: 'timeout', producer: 'analyze-run' }),
    })

    expect(result.escalatedNotQuarantined).toEqual([])
    expect(result.events.map((event) => event.testName)).toEqual(MEMBER_NAMES)
  })

  it('did NOT close the path Task 2 opened — one floor crossing still enters', () => {
    const result = evaluate({
      failures: [failure({
        verdictClass: 'timeout',
        producer: 'deterministic-classifier',
        sameBuildPassAndFail: true,
        fingerprint: 'fp::timeout',
      })],
    })

    expect(result.escalatedNotQuarantined).toEqual([])
    expect(result.events).toHaveLength(1)
  })

  // Auto-EXITS are not capped, deliberately: refusing to let a fixed test out is a failure in the
  // opposite direction from the one the cap defends against.
  it('leaves the RELEASE loop uncapped — six fixed tests all leave in one evaluation', () => {
    const entries = quarantinedEntriesFor(MEMBER_INDICES)
    const result = evaluate({
      entries,
      testWindows: entries.map((entry) => passingWindow(QUARANTINE_AUTO_EXIT_PASSES, {
        testName: entry.testName,
        filePath: entry.filePath,
      })),
    })

    expect(result.events).toHaveLength(SUITE_SIZE)
    expect(result.events.map((event) => event.testName)).toEqual(MEMBER_NAMES)
  })

  // A module-scope counter passes every other leg; only this one shows the cap is per call.
  it('is PER CALL and the overflow DRAINS: the next K enter on the next evaluation, by name', () => {
    const failures = suite({
      verdictClass: 'timeout',
      producer: 'deterministic-classifier',
      sameBuildPassAndFail: true,
    })

    const first = evaluate({ failures })
    expect(first.events.map((event) => event.testName)).toEqual(MEMBER_NAMES.slice(0, K))

    const second = evaluate({
      failures,
      entries: quarantinedEntriesFor(MEMBER_INDICES.slice(0, K)),
    })
    expect(second.events.map((event) => event.testName)).toEqual(MEMBER_NAMES.slice(K, K * 2))
    expect(second.escalatedNotQuarantined.map((s) => s.testName))
      .toEqual(MEMBER_NAMES.slice(K * 2))
  })
})

describe('the committed ledger order is decided by BYTES, never by host collation', () => {
  // The module's docstring claims the committed ledger's bytes do not depend on projection
  // iteration order. `localeCompare` with no locale argument resolves against the HOST's default
  // locale and ICU build, so the claim was a property of the machine rather than of the code.
  // These legs pin the answer independent of host: every one of them fails against a collation
  // ordering and passes against a code-unit ordering, and the last one asserts the stated
  // guarantee directly rather than describing it.

  /** Two crossings that differ in exactly ONE axis, both escalating on the authored arm. */
  function crossingPair(
    left: Partial<QuarantineDetectionFailure>,
    right: Partial<QuarantineDetectionFailure>,
  ): QuarantineDetectionFailure[] {
    return [failure(left), failure(right)]
  }

  it('orders a VARIABLE-WEIGHT punctuation pair by code unit — `-` (0x2D) before `_` (0x5F)', () => {
    // Collation treats `-` and `_` as variable-weight and answers +1 here on at least one common
    // ICU build; bytes answer -1. The pair is fed in the collation order so a comparator that
    // kept collation would return the input unchanged and pass by accident.
    const result = evaluate({
      failures: crossingPair(
        { filePath: 'tests/a_b.yaml' },
        { filePath: 'tests/a-b.yaml' },
      ),
    })
    expect(result.events.map((event) => event.filePath)).toEqual([
      'tests/a-b.yaml',
      'tests/a_b.yaml',
    ])
  })

  it('orders a CASE pair by code unit — `A` (0x41) before `a` (0x61)', () => {
    const result = evaluate({
      failures: crossingPair(
        { filePath: 'tests/a.yaml' },
        { filePath: 'tests/A.yaml' },
      ),
    })
    expect(result.events.map((event) => event.filePath)).toEqual([
      'tests/A.yaml',
      'tests/a.yaml',
    ])
  })

  it('answers NON-ZERO for canonically equivalent names in different normalisations', () => {
    // THIS is what forbids the input-order fallback. `Array.prototype.sort` is stable, so a
    // comparator answering 0 for two DISTINCT identities hands the ordering decision back to the
    // caller's iteration order — which is precisely the dependency the docstring denies.
    // Collation answers 0 for an NFC/NFD pair; a code-unit comparison cannot.
    const nfc = { product: PRODUCT, filePath: FILE_PATH, testName: 'café checkout' }
    const nfd = { product: PRODUCT, filePath: FILE_PATH, testName: 'café checkout' }
    expect(nfc.testName).not.toBe(nfd.testName)
    expect(nfc.testName.normalize('NFC')).toBe(nfd.testName.normalize('NFC'))
    expect(compareQuarantineIdentity(nfc, nfd)).not.toBe(0)
    expect(compareQuarantineIdentity(nfd, nfc)).not.toBe(0)
    expect(Math.sign(compareQuarantineIdentity(nfc, nfd)))
      .toBe(-Math.sign(compareQuarantineIdentity(nfd, nfc)))
    expect(compareQuarantineIdentity(nfc, { ...nfc })).toBe(0)
  })

  it('breaks a same-identity tie on fingerprint BYTES too — no leg of the chain is collated', () => {
    // A comparison chain is only as deterministic as its least deterministic leg. Leaving the
    // fingerprint tiebreak collated would reproduce the defect on a narrower input class.
    const result = evaluate({
      failures: crossingPair(
        { fingerprint: 'fp_a::flake' },
        { fingerprint: 'fp-a::flake' },
      ),
    })
    expect(
      result.events
        .filter((event) => event.kind === 'entered')
        .map((event) => event.fingerprint),
    ).toEqual([
      'fp-a::flake',
      'fp_a::flake',
    ])
  })

  it('THE STATED GUARANTEE, ASSERTED: the same crossings in two input orders commit the same bytes', () => {
    // The module says the committed ledger's bytes do not depend on projection iteration order.
    // This feeds one set of crossings TWICE in different orders and compares the canonical bytes
    // of the whole authored event sequence — entered group and released-auto group together.
    const crossings: QuarantineDetectionFailure[] = [
      failure({ filePath: 'tests/a_b.yaml', fingerprint: 'fp_a::flake' }),
      failure({ filePath: 'tests/a-b.yaml', fingerprint: 'fp-a::flake' }),
      failure({ filePath: 'tests/A.yaml', testName: 'café checkout' }),
      failure({ filePath: 'tests/A.yaml', testName: 'café checkout' }),
      failure({ filePath: 'tests/a.yaml', testName: 'Zebra' }),
      failure({ filePath: 'tests/a.yaml', testName: 'apple' }),
    ]
    const releasing: QuarantineEntryState[] = [
      activeEntry({ filePath: 'tests/r_1.yaml', testName: 'café exit' }),
      activeEntry({ filePath: 'tests/r-1.yaml', testName: 'café exit' }),
      activeEntry({ filePath: 'tests/R.yaml', testName: 'Zebra exit' }),
      activeEntry({ filePath: 'tests/r.yaml', testName: 'apple exit' }),
    ]
    const windows = releasing.map((entry) => passingWindow(QUARANTINE_AUTO_EXIT_PASSES, {
      filePath: entry.filePath,
      testName: entry.testName,
    }))

    const forward = evaluate({
      failures: crossings,
      entries: releasing,
      testWindows: windows,
    })
    const reversed = evaluate({
      failures: [...crossings].reverse(),
      entries: [...releasing].reverse(),
      testWindows: [...windows].reverse(),
    })

    expect(forward.events).toHaveLength(crossings.length + releasing.length)
    expect(canonicalJson(reversed.events)).toBe(canonicalJson(forward.events))
    expect(canonicalJson(reversed.escalatedNotQuarantined))
      .toBe(canonicalJson(forward.escalatedNotQuarantined))
  })

  it('exports ONE key builder and ONE comparator, and the comparator agrees with the key', () => {
    // The subsystem carried two byte-identical spellings of the key and two different spellings of
    // the ORDER. One of each now, and the comparator is defined over the key so they cannot drift.
    const left = { product: PRODUCT, filePath: 'tests/A.yaml', testName: 'a' }
    const right = { product: PRODUCT, filePath: 'tests/a.yaml', testName: 'a' }
    expect(quarantineIdentityKey(left)).toBe(
      JSON.stringify([PRODUCT, 'tests/A.yaml', 'a']),
    )
    const byKey = quarantineIdentityKey(left) < quarantineIdentityKey(right) ? -1 : 1
    expect(Math.sign(compareQuarantineIdentity(left, right))).toBe(byKey)
  })
})

describe('ladder boundaries, pinned one step either side', () => {
  it('answers nothing at ONE occurrence ordinal — below the flag floor', () => {
    const result = evaluate({
      failures: [failure({ occurrenceOrdinals: QUARANTINE_FLAG_FLOOR - 1 })],
    })
    expect(result).toEqual({ events: [], flagged: [], escalatedNotQuarantined: [] })
  })

  it('FLAGS at exactly two — visibility only, zero ledger bytes', () => {
    const result = evaluate({
      failures: [failure({ occurrenceOrdinals: QUARANTINE_FLAG_FLOOR })],
    })
    expect(result.events).toEqual([])
    expect(result.escalatedNotQuarantined).toEqual([])
    expect(result.flagged).toEqual([
      {
        product: PRODUCT,
        filePath: FILE_PATH,
        testName: TEST_NAME,
        fingerprint: FINGERPRINT,
        verdictClass: 'flake',
        // The sighting mirrors the failure, producer included.
        producer: 'analyze-run',
        occurrenceOrdinals: 2,
        windowOrdinals: QUARANTINE_WINDOW_ORDINALS,
      },
    ])
  })

  it('ESCALATES at exactly three, and stops flagging it', () => {
    const result = evaluate({
      failures: [failure({ occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD })],
    })
    expect(result.flagged).toEqual([])
    expect(result.events).toHaveLength(1)
  })
})

describe('the entered event an escalation authors', () => {
  it('carries unassigned ownership and an expiry stamped from the SUPPLIED now', () => {
    const result = evaluate({ failures: [failure()] })
    expect(result.events).toEqual([
      {
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
        kind: 'entered',
        at: NOW,
        product: PRODUCT,
        filePath: FILE_PATH,
        testName: TEST_NAME,
        fingerprint: FINGERPRINT,
        verdictClass: 'flake',
        owner: QUARANTINE_UNASSIGNED_OWNER,
        expiresAt: EXPECTED_EXPIRY,
      },
    ])
  })

  it('moves the expiry with `now` — the deadline is derived, never a stored default', () => {
    const [event] = evaluate({
      failures: [failure()],
      now: '2026-08-06T12:00:00.000Z',
    }).events
    expect(event).toMatchObject({ expiresAt: '2026-09-05T12:00:00.000Z' })
  })
})

describe('re-entry suppression while a window is OPEN', () => {
  it('appends no second entered for a fingerprint already quarantined', () => {
    const result = evaluate({ failures: [failure()], entries: [activeEntry()] })
    expect(result.events).toEqual([])
    expect(result.flagged).toEqual([])
    expect(result.escalatedNotQuarantined).toEqual([])
  })

  it('CONTROL: an entry for a DIFFERENT test does not suppress this one', () => {
    const result = evaluate({
      failures: [failure()],
      entries: [activeEntry({ testName: 'some other test' })],
    })
    expect(result.events).toHaveLength(1)
  })

  it('re-enters a test whose entry has EXPIRED — suppression already stopped', () => {
    const result = evaluate({
      failures: [failure()],
      entries: [activeEntry({ state: 'expired' })],
    })
    expect(result.events).toHaveLength(1)
  })

  it('re-enters a RELEASED test that crosses again (re-entry needs no special rule)', () => {
    const result = evaluate({
      failures: [failure()],
      entries: [activeEntry({ state: 'released' })],
    })
    expect(result.events).toHaveLength(1)
  })
})

// A lapsed window keeps its owner; a released one reopens as `unassigned`.

describe("the auto-entry's owner over the prior entry's state", () => {
  function enteredOwner(entries: QuarantineEntryState[]): unknown {
    const result = evaluate({ failures: [failure()], entries })
    expect(result.events).toHaveLength(1)
    return (result.events[0] as unknown as Record<string, unknown>).owner
  }

  it('carries a claimed owner forward across a LAPSE — the same window continuing', () => {
    expect(enteredOwner([activeEntry({ state: 'expired', owner: 'alice' })])).toBe('alice')
  })

  it('does NOT carry an owner across a deliberate RELEASE — a human closed that window', () => {
    expect(enteredOwner([activeEntry({ state: 'released', owner: 'alice' })]))
      .toBe(QUARANTINE_UNASSIGNED_OWNER)
  })

  it('carries the unassigned literal across a lapse when there was nothing to carry', () => {
    expect(enteredOwner([activeEntry({ state: 'expired' })])).toBe(QUARANTINE_UNASSIGNED_OWNER)
  })

  it('stamps unassigned when there is no prior entry at all — unchanged', () => {
    expect(enteredOwner([])).toBe(QUARANTINE_UNASSIGNED_OWNER)
  })

  it('reads the prior entry for THIS identity only, never another test\'s owner', () => {
    expect(enteredOwner([
      activeEntry({ testName: 'some other test', state: 'expired', owner: 'alice' }),
    ])).toBe(QUARANTINE_UNASSIGNED_OWNER)
  })

  // The third member of the state union, asserted rather than assumed. A `quarantined` prior entry
  // never reaches the authoring branch at all — the ladder skips an already-suppressed identity
  // before it — so there is no owner decision to make for it, and this leg is what says so.
  it("a 'quarantined' prior entry never reaches the owner rule — the ladder skipped it", () => {
    const result = evaluate({
      failures: [failure()],
      entries: [activeEntry({ state: 'quarantined', owner: 'alice' })],
    })
    expect(result.events).toEqual([])
    expect(result.flagged).toEqual([])
    expect(result.escalatedNotQuarantined).toEqual([])
  })

  it('decides per identity across a batch — one carries, one does not', () => {
    const other = { testName: 'a second test' }
    const result = evaluate({
      failures: [failure(), failure({ ...other })],
      entries: [
        activeEntry({ state: 'expired', owner: 'alice' }),
        activeEntry({ ...other, state: 'released', owner: 'bob' }),
      ],
    })
    expect(result.events).toHaveLength(2)
    const byName = new Map(
      result.events.map((event) => {
        const line = event as unknown as Record<string, unknown>
        return [line.testName as string, line.owner] as const
      }),
    )
    expect(byName.get(TEST_NAME)).toBe('alice')
    expect(byName.get('a second test')).toBe(QUARANTINE_UNASSIGNED_OWNER)
  })
})

// A mixed ordinal never buys a release, and is the per-test evidence the floor arm requires.
describe('the same-build pass∧fail signature', () => {
  function ordinals(...entries: readonly [number, boolean][]): QuarantineOrdinalOutcome[] {
    return entries.map(([buildOrdinal, passed]) => ({ buildOrdinal, passed }))
  }

  it('HOLDS when ONE build ordinal carries both a pass and a fail', () => {
    expect(hasSameBuildPassAndFail(ordinals([5, true], [5, false]))).toBe(true)
  })

  it('does NOT hold when one build ordinal carries one answer', () => {
    expect(hasSameBuildPassAndFail(ordinals([5, false], [5, false]))).toBe(false)
    expect(hasSameBuildPassAndFail(ordinals([5, true], [5, true]))).toBe(false)
  })

  // The leg a "some pass and some fail anywhere in the window" relaxation reds. Two builds is a
  // test that broke and was fixed, which is the ordinary shape of software, not a flake.
  it('does NOT hold across TWO builds — a later fix is not a flake signature', () => {
    expect(hasSameBuildPassAndFail(ordinals([5, false], [6, true]))).toBe(false)
    expect(hasSameBuildPassAndFail(ordinals([5, true], [6, false]))).toBe(false)
  })

  it('does not hold on an empty window, nor on a single entry either way', () => {
    expect(hasSameBuildPassAndFail([])).toBe(false)
    expect(hasSameBuildPassAndFail(ordinals([5, true]))).toBe(false)
    expect(hasSameBuildPassAndFail(ordinals([5, false]))).toBe(false)
  })

  it('answers identically for the same entries SHUFFLED — no projection read-order dependence', () => {
    const withSignature = ordinals([4, true], [5, false], [5, true], [6, false])
    expect(hasSameBuildPassAndFail(withSignature)).toBe(true)
    expect(hasSameBuildPassAndFail([...withSignature].reverse())).toBe(true)

    const withoutSignature = ordinals([4, true], [5, false], [6, false], [7, true])
    expect(hasSameBuildPassAndFail(withoutSignature)).toBe(false)
    expect(hasSameBuildPassAndFail([...withoutSignature].reverse())).toBe(false)
  })

  // AGREEMENT WITH THE SIBLING LAW, on ONE shared fixture. This is a cheap GUARD, not the
  // mechanism: both `hasSameBuildPassAndFail` and `distinctOrdinalOutcomes` call the one
  // `groupByBuildOrdinal` helper in detection.ts, so "two runs in one build are one ordinal" has a
  // single spelling in CODE. If this leg were the only thing holding them together, the two would
  // be free to drift the moment somebody edited one.
  it('agrees with the exit path: a signature ordinal collapses to NOT-passed, buying no release', () => {
    const window = passingWindow(QUARANTINE_AUTO_EXIT_PASSES)
    // Ordinal 3 carries a pass (from `passingWindow`) and a fail — the signature, inside a window
    // whose distinct-ordinal COUNT is still QUARANTINE_AUTO_EXIT_PASSES.
    const mixed = [...window.ordinals, { buildOrdinal: 3, passed: false }]

    expect(hasSameBuildPassAndFail(mixed)).toBe(true)
    expect(
      evaluate({
        entries: [activeEntry()],
        testWindows: [{ ...window, ordinals: mixed }],
      }).events,
    ).toEqual([])
  })
})

describe('auto-exit at M passing ordinals', () => {
  it('releases after exactly QUARANTINE_AUTO_EXIT_PASSES distinct passing ordinals', () => {
    const result = evaluate({
      entries: [activeEntry()],
      testWindows: [passingWindow(QUARANTINE_AUTO_EXIT_PASSES)],
    })
    expect(result.events).toEqual([
      {
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
        kind: 'released-auto',
        at: NOW,
        product: PRODUCT,
        filePath: FILE_PATH,
        testName: TEST_NAME,
      },
    ])
  })

  it('does NOT release at one ordinal short of the threshold', () => {
    const result = evaluate({
      entries: [activeEntry()],
      testWindows: [passingWindow(QUARANTINE_AUTO_EXIT_PASSES - 1)],
    })
    expect(result.events).toEqual([])
  })

  it('does not release when the most recent distinct ordinals include a failure', () => {
    const window = passingWindow(QUARANTINE_AUTO_EXIT_PASSES)
    const ordinals = [...window.ordinals]
    ordinals[ordinals.length - 1] = { buildOrdinal: QUARANTINE_AUTO_EXIT_PASSES, passed: false }
    expect(evaluate({ entries: [activeEntry()], testWindows: [{ ...window, ordinals }] }).events)
      .toEqual([])
  })

  it('counts an ordinal as passing only when EVERY run at that ordinal passed', () => {
    const window = passingWindow(QUARANTINE_AUTO_EXIT_PASSES)
    // Two runs inside one build: the distinct-ordinal count is still 5, but ordinal 3 is mixed.
    const ordinals = [...window.ordinals, { buildOrdinal: 3, passed: false }]
    expect(evaluate({ entries: [activeEntry()], testWindows: [{ ...window, ordinals }] }).events)
      .toEqual([])
  })

  it('ignores ordinals older than the most recent M when they failed', () => {
    const ordinals = [
      { buildOrdinal: 1, passed: false },
      ...Array.from({ length: QUARANTINE_AUTO_EXIT_PASSES }, (_unused, index) => ({
        buildOrdinal: index + 2,
        passed: true,
      })),
    ]
    expect(
      evaluate({ entries: [activeEntry()], testWindows: [{
        product: PRODUCT,
        filePath: FILE_PATH,
        testName: TEST_NAME,
        ordinals,
      }] }).events,
    ).toHaveLength(1)
  })

  // A lapsed entry is still listed, so a fixed test leaves it; a closed window stays closed.
  it('auto-releases an entry whose deadline has LAPSED — a fixed test leaves on the same terms', () => {
    const result = evaluate({
      entries: [activeEntry({ state: 'expired' })],
      testWindows: [passingWindow(QUARANTINE_AUTO_EXIT_PASSES)],
    })
    expect(result.events).toEqual([
      {
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
        kind: 'released-auto',
        at: NOW,
        product: PRODUCT,
        filePath: FILE_PATH,
        testName: TEST_NAME,
      },
    ])
  })

  it('COMPLEMENT: does NOT re-release an already released entry — a closed window stays closed', () => {
    const result = evaluate({
      entries: [activeEntry({ state: 'released' })],
      testWindows: [passingWindow(QUARANTINE_AUTO_EXIT_PASSES)],
    })
    expect(result.events).toEqual([])
  })

  // The exit PREDICATE is unchanged by the widening: a lapsed entry earns its release on exactly
  // the same evidence a suppressing one does, one step either side of both boundaries.
  it('a LAPSED entry ONE ordinal short of the threshold still authors nothing', () => {
    const result = evaluate({
      entries: [activeEntry({ state: 'expired' })],
      testWindows: [passingWindow(QUARANTINE_AUTO_EXIT_PASSES - 1)],
    })
    expect(result.events).toEqual([])
  })

  it('a LAPSED entry with a mixed-outcome ordinal inside the window authors nothing', () => {
    const window = passingWindow(QUARANTINE_AUTO_EXIT_PASSES)
    const ordinals = [...window.ordinals, { buildOrdinal: 3, passed: false }]
    expect(
      evaluate({
        entries: [activeEntry({ state: 'expired' })],
        testWindows: [{ ...window, ordinals }],
      }).events,
    ).toEqual([])
  })

  it('releases only the test whose window passed, in a multi-entry product', () => {
    const result = evaluate({
      entries: [activeEntry(), activeEntry({ testName: 'still flaky' })],
      testWindows: [
        passingWindow(QUARANTINE_AUTO_EXIT_PASSES),
        passingWindow(QUARANTINE_AUTO_EXIT_PASSES - 1, { testName: 'still flaky' }),
      ],
    })
    expect(result.events.map((event) => event.testName)).toEqual([TEST_NAME])
  })
})

describe('purity — no clock, no fs, no database', () => {
  it('answers identically for identical (input, now) pairs', () => {
    const input = {
      failures: [failure()],
      testWindows: [passingWindow(QUARANTINE_AUTO_EXIT_PASSES, { testName: 'released one' })],
      entries: [activeEntry({ testName: 'released one' })],
    }
    expect(canonicalJson(evaluate(input))).toBe(canonicalJson(evaluate(input)))
  })

  it('reads no wall clock and opens no store — asserted on the source', () => {
    const source = readFileSync(DETECTION_SOURCE, 'utf8')
    expect(source).not.toMatch(/Date\.now/)
    expect(source).not.toMatch(/new Date\(\)/)
    expect(source).not.toMatch(/node:fs/)
    expect(source).not.toMatch(/node:sqlite/)
    expect(source).not.toMatch(/db\.prepare/)
  })
})
