// Each row is built into a real `CompletedRunHandoff` and checked by `guardCompletedRunHandoff`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { guardCompletedRunHandoff } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  DraftRef,
  MemberTestOutcome,
  VerdictSource,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  ACCEPT_CONTROL_DRAFT,
  LOCAL_FORM_URL,
  limitStopEvidence,
  runDocument,
} from './evidence-fixtures.js'
import type { LimitStopFixture, MemberFixture, SubActionFixture } from './evidence-fixtures.js'

const CORPUS_DIR = join(import.meta.dirname, 'fixtures', 'router-corpus')

interface VerdictSourceSpec {
  readonly stepIndex: number
  readonly source: VerdictSource
}

interface MemberSpec {
  readonly outcome: MemberTestOutcome
  readonly stepCount: number
  readonly failedSteps: readonly number[]
  readonly verdictSourceSteps: readonly VerdictSourceSpec[]
  readonly infeasibleSteps: readonly number[]
  readonly planningFailureSteps: readonly number[]
  readonly cycleSteps: readonly number[]
  readonly stagnationSteps: readonly number[]
}

interface MechanicsSpec {
  readonly stepIndex: number | null
  readonly signal: string
}

interface ExpectedSpec {
  readonly route: 'repair' | 'stop' | 'refuse'
  readonly signalClass: string
  readonly failingStepIndex: number | null
  readonly verdictSource: VerdictSource | null
  readonly mechanics: readonly MechanicsSpec[]
}

interface CorpusRow {
  readonly id: string
  readonly variantOf: string | null
  readonly variesBy: readonly string[] | null
  readonly member: MemberSpec
  readonly expected: ExpectedSpec
  readonly rationale: string
  readonly measured: string
}

interface Expectations {
  readonly $comment: readonly string[]
  readonly schemaVersion: number
  readonly frozenAt: string
  readonly baseRow: string
  readonly memberSpecKeys: readonly string[]
  readonly stopDirectionRows: readonly string[]
  readonly rows: readonly CorpusRow[]
}

const EXPECTATIONS = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'expectations.json'), 'utf8'),
) as Expectations

/**
 * The draft under evaluation, as its durable identity.
 *
 * The shipped accept control, reduced to the four `DraftRef` fields. The router looks the draft's
 * own member up by (`filePath`, `testName`) — the project-wide stable identity, never `testId` —
 * so reusing the shipped constant keeps the corpus keyed on the same pair every other authoring
 * suite is keyed on.
 */
const DRAFT_REF: DraftRef = {
  filePath: ACCEPT_CONTROL_DRAFT.filePath,
  testId: ACCEPT_CONTROL_DRAFT.testId,
  testName: ACCEPT_CONTROL_DRAFT.testName,
  contentDigest: ACCEPT_CONTROL_DRAFT.contentDigest,
}

// Step 1 records `stateAfter` too, so the stop arm's refs exercise all three channels.
const ROUTER_SUBACTIONS: readonly (readonly SubActionFixture[])[] = [
  [{ type: 'fill', ref: 'e1', role: 'textbox', name: 'username' }],
  [
    {
      type: 'assertValue',
      ref: 'e2',
      role: 'heading',
      name: 'local form',
      urlAfter: LOCAL_FORM_URL,
    },
  ],
]

function memberFixture(spec: MemberSpec, identity: DraftRef = DRAFT_REF): MemberFixture {
  return {
    filePath: identity.filePath,
    testName: identity.testName,
    outcome: spec.outcome,
    steps: ROUTER_SUBACTIONS.slice(0, spec.stepCount),
    failedSteps: spec.failedSteps,
    verdictSourceSteps: spec.verdictSourceSteps,
    infeasibleSteps: spec.infeasibleSteps,
    planningFailureSteps: spec.planningFailureSteps,
    cycleSteps: spec.cycleSteps,
    stagnationSteps: spec.stagnationSteps,
  }
}

function handoffFor(row: CorpusRow): CompletedRunHandoff {
  return runDocument(`r_router-${row.id}`, [memberFixture(row.member)])
}

function rowNamed(id: string): CorpusRow {
  const row = EXPECTATIONS.rows.find((candidate) => candidate.id === id)
  if (row === undefined) throw new Error(`no frozen row named ${id}`)
  return row
}

async function loadRouter() {
  return await import('../router.js')
}

describe('the frozen router corpus is intact', () => {
  it('carries the treadmill warning and ten sole-catcher rows', () => {
    expect(EXPECTATIONS.$comment.join(' ')).toContain('MUST NOT mint new members')
    expect(EXPECTATIONS.rows).toHaveLength(10)
    expect(new Set(EXPECTATIONS.rows.map((row) => row.id)).size).toBe(10)
    for (const row of EXPECTATIONS.rows) {
      expect(row.rationale, `${row.id} states the property it is the sole catcher for`)
        .toContain('SOLE CATCHER for')
      expect(row.measured.length, `${row.id} records what was measured`).toBeGreaterThan(40)
      expect(
        Object.keys(row.member).sort(),
        `${row.id} carries the full member-spec key set, so the variant diff is mechanical`,
      ).toEqual([...EXPECTATIONS.memberSpecKeys].sort())
    }
  })

  it('names five stop-direction rows, and they are the rows that route to stop', () => {
    const stopRows = EXPECTATIONS.rows
      .filter((row) => row.expected.route === 'stop')
      .map((row) => row.id)
    expect([...stopRows].sort()).toEqual([...EXPECTATIONS.stopDirectionRows].sort())
    expect(EXPECTATIONS.stopDirectionRows).toHaveLength(5)
  })

  it('every variant declaration is mechanically true against the data', () => {
    // The control-shape check. A row claiming to differ in one field while differing in three is
    // a row whose pair proves nothing, and a declaration nobody recomputes is a comment.
    for (const row of EXPECTATIONS.rows) {
      if (row.id === EXPECTATIONS.baseRow) {
        expect(row.variantOf, 'the base row is a variant of nothing').toBeNull()
        expect(row.variesBy).toBeNull()
        continue
      }
      expect(row.variantOf, `${row.id} declares which row it varies`).not.toBeNull()
      expect(row.variesBy, `${row.id} declares the fields it varies by`).not.toBeNull()

      const base = rowNamed(row.variantOf as string)
      const differing = EXPECTATIONS.memberSpecKeys.filter((key) => {
        const mine = (row.member as unknown as Record<string, unknown>)[key]
        const theirs = (base.member as unknown as Record<string, unknown>)[key]
        return JSON.stringify(mine) !== JSON.stringify(theirs)
      })
      expect(
        [...differing].sort(),
        `${row.id} declares it varies ${row.variantOf} by [${(row.variesBy ?? []).join(', ')}]`,
      ).toEqual([...(row.variesBy ?? [])].sort())
    }
  })

  it('puts a row on BOTH sides of every discriminating signal', () => {
    // Rows on both routes, so a router answering one route regardless of evidence fails.
    const byRoute = (route: string) =>
      EXPECTATIONS.rows.filter((row) => row.expected.route === route)
    expect(byRoute('repair').length).toBeGreaterThanOrEqual(3)
    expect(byRoute('stop').length).toBeGreaterThanOrEqual(3)
    expect(byRoute('refuse').length).toBeGreaterThanOrEqual(1)

    // Each of the two STEP-level mechanics signals has a cross-arm partner differing by the one
    // field that carries it, and that partner is the signature cell.
    for (const [id, field] of [
      ['mechanics-termination', 'infeasibleSteps'],
      ['mechanics-planning-failure', 'planningFailureSteps'],
    ] as const) {
      const row = rowNamed(id)
      expect(row.variantOf, `${id} pairs against the signature cell`).toBe(EXPECTATIONS.baseRow)
      expect(row.variesBy).toEqual([field])
      expect(row.expected.route).toBe('repair')
      expect(rowNamed(EXPECTATIONS.baseRow).expected.route).toBe('stop')
    }

    // Each differs from the signature cell by one field and lands on its arm: these route nothing.
    for (const [id, field] of [
      ['historical-cycle', 'cycleSteps'],
      ['historical-stagnation', 'stagnationSteps'],
    ] as const) {
      const row = rowNamed(id)
      expect(row.variantOf, `${id} pairs against the signature cell`).toBe(EXPECTATIONS.baseRow)
      expect(row.variesBy).toEqual([field])
      expect(row.expected).toEqual(rowNamed(EXPECTATIONS.baseRow).expected)
    }

    // Both MEMBER-level mechanics outcomes pair against the passing run by `outcome` alone.
    for (const id of ['mechanics-member-timeout', 'mechanics-member-cancelled'] as const) {
      const row = rowNamed(id)
      expect(row.variantOf).toBe('passing-run')
      expect(row.variesBy).toEqual(['outcome'])
      expect(row.expected.route).toBe('repair')
    }
    expect(rowNamed('passing-run').expected.route).toBe('refuse')
  })

  it('pins the mechanics scan WIDTH with a pair that differs in one integer', () => {
    // The sharpest cell in the table, and the one no single row can carry. Both rows are the
    // signature cell plus a termination; the only difference is which step it sits on, and they
    // land on opposite arms. A scan narrowed to the failing step gives both the same class.
    const onFailingStep = rowNamed('mechanics-termination')
    const onAnotherStep = rowNamed('mixed-evidence')
    expect(onFailingStep.variesBy).toEqual(['infeasibleSteps'])
    expect(onAnotherStep.variesBy).toEqual(['infeasibleSteps'])
    expect(onFailingStep.member.infeasibleSteps).toEqual([1])
    expect(onAnotherStep.member.infeasibleSteps).toEqual([0])
    expect(onFailingStep.member.failedSteps).toEqual([1])
    expect(onAnotherStep.member.failedSteps).toEqual([1])
    expect(onFailingStep.expected.route).toBe('repair')
    expect(onAnotherStep.expected.route).toBe('stop')
  })
})

describe('every corpus row builds a run document the load boundary accepts', () => {
  // The producer check. `guardCompletedRunHandoff` is the SHIPPED structural validation a stored
  // handoff must survive to be read back, so a row that cannot pass it describes a run the system
  // could never have written — and the router's whole claim is about real run evidence.
  it.each(EXPECTATIONS.rows.map((row) => row.id))('%s', (id) => {
    const handoff = handoffFor(rowNamed(id))
    expect(() => guardCompletedRunHandoff(handoff)).not.toThrow()
    expect(handoff.tests).toHaveLength(1)
    expect(handoff.tests[0]?.filePath).toBe(DRAFT_REF.filePath)
    expect(handoff.tests[0]?.testName).toBe(DRAFT_REF.testName)
    expect(handoff.tests[0]?.steps).toHaveLength(rowNamed(id).member.stepCount)
  })
})

describe('the router routes every frozen row to its arm, on the signal the row names', () => {
  it.each(EXPECTATIONS.rows.map((row) => row.id))('row %s reproduces its frozen route', async (id) => {
    const { routeRepairOrStop, classifyFailureEvidence, AuthoringRouterUnroutableError }
      = await loadRouter()
    const row = rowNamed(id)
    const handoff = handoffFor(row)

    // The CLASS is asserted for every row including the refusing one, so a refusal is pinned to
    // the reason it refused rather than merely to the fact that it did.
    expect(classifyFailureEvidence(DRAFT_REF, handoff), row.rationale)
      .toBe(row.expected.signalClass)

    if (row.expected.route === 'refuse') {
      expect(() => routeRepairOrStop(DRAFT_REF, handoff), row.rationale)
        .toThrow(AuthoringRouterUnroutableError)
      return
    }

    const route = routeRepairOrStop(DRAFT_REF, handoff)
    expect(route.kind, row.rationale).toBe(row.expected.route)
    expect(route.signalClass, row.rationale).toBe(row.expected.signalClass)

    if (route.kind === 'repair') {
      // The DECIDING SIGNAL, not merely the discriminant: which signal was found and where.
      expect(route.mechanics, row.rationale).toEqual(row.expected.mechanics)
      expect(route.failingStepIndex).toBe(row.expected.failingStepIndex)
      return
    }

    expect(route.failurePoint?.stepIndex ?? null).toBe(row.expected.failingStepIndex)
    expect(route.failurePoint?.verdictSource ?? null).toBe(row.expected.verdictSource)
    // The stop carries REFS into the run's own durable records, never copies of them.
    expect(route.evidenceRefs.length).toBeGreaterThan(0)
    for (const ref of route.evidenceRefs) {
      expect(ref.runId).toBe(handoff.runId)
      expect(ref.filePath).toBe(DRAFT_REF.filePath)
      expect(ref.testName).toBe(DRAFT_REF.testName)
      expect(ref.stepIndex).toBe(row.expected.failingStepIndex)
    }
  })
})

describe('the stop arm carries the trace and a11y evidence refs', () => {
  it('refs the exact trace and both a11y snapshots at the failure point', async () => {
    const { routeRepairOrStop } = await loadRouter()
    const route = routeRepairOrStop(DRAFT_REF, handoffFor(rowNamed(EXPECTATIONS.baseRow)))
    if (route.kind !== 'stop') throw new Error('the signature cell must route to a stop')

    const channels = route.evidenceRefs.map((ref) => ref.channel)
    expect(new Set(channels)).toEqual(new Set(['step-trace', 'state-before', 'state-after']))
    // A ref is a coordinate, never a payload: no screen state, no element tree, no step text
    // beyond the one line the failure point names.
    for (const ref of route.evidenceRefs) {
      expect(Object.keys(ref).sort()).toEqual(
        [...new Set([
          'channel', 'filePath', 'runId', 'stepIndex', 'testName',
          ...(ref.subActionIndex === undefined ? [] : ['subActionIndex']),
        ])].sort(),
      )
    }
    expect(route.failurePoint?.reasoning.length ?? 0).toBeGreaterThan(0)
  })
})

describe('the router is total where it can be and refuses by name where it cannot', () => {
  it('refuses when there is no run evidence at all', async () => {
    const { classifyFailureEvidence, routeRepairOrStop, AuthoringRouterUnroutableError }
      = await loadRouter()
    // An unreadable run is a broken precondition, not ambiguity, so it reports no app failure.
    expect(classifyFailureEvidence(DRAFT_REF, undefined)).toBe('no-run-evidence')
    expect(() => routeRepairOrStop(DRAFT_REF, undefined))
      .toThrow(AuthoringRouterUnroutableError)
  })

  it('refuses when the run holds no member with the draft identity', async () => {
    const { classifyFailureEvidence } = await loadRouter()
    const stranger = runDocument('r_router-stranger', [
      memberFixture(rowNamed(EXPECTATIONS.baseRow).member, {
        ...DRAFT_REF,
        filePath: 'tests/somebody-elses-test.yaml',
        testName: 'Somebody else',
      }),
    ])
    expect(classifyFailureEvidence(DRAFT_REF, stranger)).toBe('no-run-evidence')
  })

  it('keys on the DRAFT identity, never on whichever member happened to fail', async () => {
    const { classifyFailureEvidence } = await loadRouter()
    const signature = rowNamed(EXPECTATIONS.baseRow)
    const passing = rowNamed('passing-run')
    const strangerIdentity: DraftRef = {
      ...DRAFT_REF,
      filePath: 'tests/somebody-elses-test.yaml',
      testName: 'Somebody else',
    }

    // The draft passed; a neighbour in the same run failed cleanly. Reading the run rather than
    // the draft's own member would report a stop about the neighbour's application behaviour.
    const draftPassed = runDocument('r_router-neighbour-failed', [
      memberFixture(passing.member),
      memberFixture(signature.member, strangerIdentity),
    ])
    expect(classifyFailureEvidence(DRAFT_REF, draftPassed)).toBe('no-failure')

    // And the mirror: the draft failed cleanly while a neighbour passed.
    const draftFailed = runDocument('r_router-neighbour-passed', [
      memberFixture(passing.member, strangerIdentity),
      memberFixture(signature.member),
    ])
    expect(classifyFailureEvidence(DRAFT_REF, draftFailed))
      .toBe('clean-definitive-assertion-fail')
  })

  it('is pure: two calls agree and the run document is not mutated', async () => {
    const { routeRepairOrStop } = await loadRouter()
    const handoff = handoffFor(rowNamed(EXPECTATIONS.baseRow))
    const before = JSON.stringify(handoff)
    const first = routeRepairOrStop(DRAFT_REF, handoff)
    const second = routeRepairOrStop(DRAFT_REF, handoff)
    expect(first).toEqual(second)
    expect(JSON.stringify(handoff)).toBe(before)
  })

  it('answers exactly one member of the closed signal vocabulary for every row', async () => {
    const { ROUTER_SIGNAL_CLASSES, classifyFailureEvidence } = await loadRouter()
    const vocabulary = new Set<string>(ROUTER_SIGNAL_CLASSES)
    expect(vocabulary.size).toBe(ROUTER_SIGNAL_CLASSES.length)
    for (const row of EXPECTATIONS.rows) {
      expect(vocabulary.has(classifyFailureEvidence(DRAFT_REF, handoffFor(row)))).toBe(true)
    }
    expect(vocabulary.has(classifyFailureEvidence(DRAFT_REF, undefined))).toBe(true)
  })
})

// ---- a limit stop is indefinitive and stops; cycle and stagnation route nothing ----

const AGENT_QA_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')
const PRE_CHANGE_HANDOFF_PATH = join(AGENT_QA_ROOT, 'test-fixtures', 'legacy-handoff', 'handoff.json')

const ACTION_LIMIT_ON_STEP_1: LimitStopFixture = {
  stepIndex: 1,
  limit: 'actions',
  configured: 30,
  used: 30,
}

function limitMember(overrides: Partial<MemberFixture> = {}): MemberFixture {
  return {
    filePath: DRAFT_REF.filePath,
    testName: DRAFT_REF.testName,
    outcome: 'failed',
    steps: ROUTER_SUBACTIONS,
    limitStopSteps: [ACTION_LIMIT_ON_STEP_1],
    ...overrides,
  }
}

describe('a limit-stopped draft routes to stop, never repair', () => {
  it('ROUTER_MECHANICS_SIGNALS equals the four remaining members, in order', async () => {
    // From the module itself: the agent barrel does not export the constant.
    const { ROUTER_MECHANICS_SIGNALS } = await loadRouter()
    expect(ROUTER_MECHANICS_SIGNALS).toEqual([
      'termination',
      'planning-failure',
      'member-timeout',
      'member-cancelled',
    ])
  })

  it(
    'a failed member with a limit-stopped step is indefinitive-failure and routes to stop',
    async () => {
      const { classifyFailureEvidence, routeRepairOrStop } = await loadRouter()
      const handoff = runDocument('r_router-limit', [limitMember()])
      expect(() => guardCompletedRunHandoff(handoff)).not.toThrow()

      expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('indefinitive-failure')
      const route = routeRepairOrStop(DRAFT_REF, handoff)
      expect(route.kind).toBe('stop')
      if (route.kind !== 'stop') return
      expect(route.signalClass).toBe('indefinitive-failure')
      expect(route.failurePoint?.stepIndex).toBe(1)
      expect(route.failurePoint?.reasoning).toBe(limitStopEvidence(ACTION_LIMIT_ON_STEP_1).reason)
      expect(route.failurePoint?.verdictSource).toBeUndefined()
      expect(route.evidenceRefs.length).toBeGreaterThan(0)
    },
  )

  it('a planning-turn limit stop routes the same way', async () => {
    const { classifyFailureEvidence } = await loadRouter()
    const handoff = runDocument('r_router-planning-limit', [
      limitMember({
        limitStopSteps: [{ stepIndex: 1, limit: 'planning-turns', configured: 30, used: 30 }],
      }),
    ])
    expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('indefinitive-failure')
  })

  it('a limit stop beats a recorded verdictSource on another step', async () => {
    const { classifyFailureEvidence, routeRepairOrStop } = await loadRouter()
    // Step 0 is a clean definitive assertion-fail on its own; without the limit rule this member
    // is clean-definitive-assertion-fail, and with a termination beside it, mixed-evidence.
    const cleanElsewhere = limitMember({
      failedSteps: [0],
      verdictSourceSteps: [{ stepIndex: 0, source: 'assert-value' }],
    })
    const withoutLimit = runDocument('r_router-no-limit', [
      { ...cleanElsewhere, limitStopSteps: [] },
    ])
    expect(classifyFailureEvidence(DRAFT_REF, withoutLimit)).toBe('clean-definitive-assertion-fail')
    const mixedWithoutLimit = runDocument('r_router-mixed-no-limit', [
      { ...cleanElsewhere, infeasibleSteps: [1], limitStopSteps: [] },
    ])
    expect(classifyFailureEvidence(DRAFT_REF, mixedWithoutLimit)).toBe('mixed-evidence')

    for (const member of [
      cleanElsewhere,
      { ...cleanElsewhere, infeasibleSteps: [1] },
      // The limit-stopped step itself recording a verdictSource is still not definitive.
      limitMember({ verdictSourceSteps: [{ stepIndex: 1, source: 'assert-value' }] }),
    ]) {
      const handoff = runDocument('r_router-limit-beats-source', [member])
      expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('indefinitive-failure')
      const route = routeRepairOrStop(DRAFT_REF, handoff)
      expect(route.kind).toBe('stop')
      expect(route.signalClass).toBe('indefinitive-failure')
      if (route.kind === 'stop') expect(route.failurePoint?.stepIndex).toBe(1)
    }
  })

  it(
    'a limit stop beats a mechanics signal on another step, so it never reaches repair',
    async () => {
      const { classifyFailureEvidence, routeRepairOrStop } = await loadRouter()
      const mechanicsElsewhere = limitMember({ planningFailureSteps: [0] })
      const withoutLimit = runDocument('r_router-mechanics-only', [
        { ...mechanicsElsewhere, limitStopSteps: [] },
      ])
      expect(classifyFailureEvidence(DRAFT_REF, withoutLimit)).toBe('execution-mechanics')

      const handoff = runDocument('r_router-limit-beats-mechanics', [mechanicsElsewhere])
      expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('indefinitive-failure')
      expect(routeRepairOrStop(DRAFT_REF, handoff).kind).toBe('stop')
    },
  )

  it(
    'a step that only carries a historical stagnation or cycle block is not a mechanics signal',
    async () => {
      const { classifyFailureEvidence, routeRepairOrStop } = await loadRouter()
      for (const historical of [{ cycleSteps: [1] }, { stagnationSteps: [1] }]) {
        const handoff = runDocument('r_router-historical', [
          limitMember({ limitStopSteps: [], failedSteps: [1], ...historical }),
        ])
        expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('indefinitive-failure')
        const route = routeRepairOrStop(DRAFT_REF, handoff)
        expect(route.kind).toBe('stop')
      }
    },
  )

  it('an older handoff that still carries stagnation and cycle fields classifies and routes without throwing', async () => {
    const { classifyFailureEvidence, routeRepairOrStop } = await loadRouter()
    const handoff = guardCompletedRunHandoff(
      JSON.parse(readFileSync(PRE_CHANGE_HANDOFF_PATH, 'utf8')),
    )
    const member = handoff.tests[0]
    if (member === undefined) throw new Error('the pre-change handoff carries one member')
    expect(member.steps.some((step) => step.stagnation !== undefined)).toBe(true)
    expect(member.steps.some((step) => step.cycle !== undefined)).toBe(true)
    const draftRef: DraftRef = {
      filePath: member.filePath,
      testId: member.testId,
      testName: member.testName,
      contentDigest: 'pre-change',
    }

    expect(classifyFailureEvidence(draftRef, handoff)).toBe('indefinitive-failure')
    const route = routeRepairOrStop(draftRef, handoff)
    expect(route.kind).toBe('stop')
    if (route.kind !== 'stop') return
    const firstRejected = member.steps.find((step) => !step.verifierVerdict.pass)
    expect(route.failurePoint?.stepIndex).toBe(firstRejected?.stepIndex)
  })
})
