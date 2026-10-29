import {
  asRecordId,
  BundleOutcomeEventSchema,
  canonicalJson,
  normalizeAnchor,
  serializeProcedureBody,
  type Anchor,
  type BundleOutcomeEvent,
  type BundleProvenance,
  type IndexEntry,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { makeProcedureBodyPayloadFixture } from '../../__tests__/fixtures/bundle-fixture.js'
import {
  assembleAuthoringBrief,
  AUTHORING_EXCERPT_CHAR_BUDGET,
  AUTHORING_EXEMPLAR_CAP,
  AUTHORING_PROCEDURE_CAP,
  type AssembleAuthoringBriefInput,
  type AuthoringEntryCandidate,
  type AuthoringExemplarRow,
} from '../get-authoring-brief.js'

const TARGET_ANCHORS: Anchor[] = [
  { t: 'page', route: '/login' },
  { t: 'flow', name: 'Sign in flow' },
]

const INTENT = 'author a sign in test for the login page'

function anchorKey(anchor: Anchor): string {
  return canonicalJson(normalizeAnchor(anchor))
}

function confirmedEvents(count: number, key: string): BundleOutcomeEvent[] {
  return Array.from({ length: count }, (_, index) =>
    BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: `confirm-${key}-${index}`,
      curationJobId: `job-${key}-${index}`,
      buildOrdinal: 10 + index,
    }))
}

function runLinkedProvenance(): BundleProvenance {
  return {
    schemaVersion: 1,
    mode: 'run-linked',
    originClass: 'agent-verified',
    runId: 'run-authoring',
    testId: 'test-authoring',
    stepIndex: 0,
    authorship: {
      path: 'llm',
      model: { id: 'claude-sonnet-4' },
      executionContext: 'local-interactive',
    },
  }
}

interface EntryOptions {
  id: string
  kind: 'fact' | 'caution' | 'procedure'
  summary?: string
  body?: string
  trust?: number
  anchors?: Anchor[]
  status?: string
}

function entryCandidate(options: EntryOptions): AuthoringEntryCandidate {
  const summary = options.summary ?? `Authoring ${options.id} summary about sign in on login`
  const anchors = (options.anchors ?? TARGET_ANCHORS).map(normalizeAnchor)
  const entry: IndexEntry = {
    id: asRecordId(options.id),
    kind: options.kind,
    title: summary,
    summary,
    trust: options.trust ?? 0.8,
    anchors,
    status: options.status ?? (options.kind === 'procedure' ? 'candidate' : 'active'),
    servedAsCanary: false,
    scope: { tier: 'product', key: 'authoring-store' },
    validity: 'current',
  }
  return {
    entry,
    bundle: {
      summary,
      body: options.body
        ?? (options.kind === 'procedure'
          ? serializeProcedureBody(makeProcedureBodyPayloadFixture())
          : `${summary} body.`),
      events: confirmedEvents(2, options.id),
      provenance: runLinkedProvenance(),
    },
  }
}

interface RowOptions {
  filePath: string
  testName: string
  passes?: number
  failures?: number
  heals?: number
  flakeCount?: number
  quarantined?: boolean
  lastOutcomes?: { buildOrdinal: number; passed: boolean }[]
  anchors?: Anchor[]
}

function projectionRow(options: RowOptions): AuthoringExemplarRow {
  return {
    filePath: options.filePath,
    testName: options.testName,
    passes: options.passes ?? 3,
    failures: options.failures ?? 0,
    heals: options.heals ?? 0,
    flakeCount: options.flakeCount ?? 0,
    quarantined: options.quarantined ?? false,
    lastOutcomes: options.lastOutcomes ?? [
      { buildOrdinal: 1, passed: true },
      { buildOrdinal: 2, passed: true },
      { buildOrdinal: 3, passed: true },
    ],
    anchorKeys: (options.anchors ?? TARGET_ANCHORS).map(anchorKey).sort(),
  }
}

function baseInput(
  overrides: Partial<AssembleAuthoringBriefInput> = {},
): AssembleAuthoringBriefInput {
  return {
    entries: [
      entryCandidate({
        id: 'caution-rate-limit',
        kind: 'caution',
        summary: 'Sign in rate limit locks the login account after three attempts',
        trust: 0.9,
      }),
      entryCandidate({
        id: 'fact-sign-in-control',
        kind: 'fact',
        summary: 'Sign in control lives on the login page',
        trust: 0.8,
      }),
      entryCandidate({
        id: 'proc-sign-in',
        kind: 'procedure',
        summary: 'Sign in with recorded credentials',
      }),
    ],
    projectionRows: [
      projectionRow({
        filePath: 'auth/sign-in.spec.ts',
        testName: 'signs in with valid credentials',
      }),
      projectionRow({
        filePath: 'auth/sign-in-sso.spec.ts',
        testName: 'signs in via sso',
        anchors: [{ t: 'page', route: '/login' }],
      }),
    ],
    knownTests: [
      { filePath: 'auth/sign-in.spec.ts', testName: 'signs in with valid credentials' },
      { filePath: 'auth/sign-in-sso.spec.ts', testName: 'signs in via sso' },
      { filePath: 'auth/sign-in-reset.spec.ts', testName: 'resets password then signs in on login' },
    ],
    intent: INTENT,
    scope: { tier: 'product', key: 'authoring-store' },
    targetAnchors: TARGET_ANCHORS,
    budget: 10_000,
    ...overrides,
  }
}

/**
 * 387-04: `assembleAuthoringBrief` returns `{ brief, trace }` as ONE value (D-16 covers the
 * §10.6 4th channel too). These cases pin the BRIEF, which is unchanged; the composite and the
 * authoring channel's per-line leg attribution are pinned in `serve-trace.test.ts`.
 */
function authoringBriefOnly(
  input: Parameters<typeof assembleAuthoringBrief>[0],
): ReturnType<typeof assembleAuthoringBrief>['brief'] {
  return assembleAuthoringBrief(input).brief
}

describe('assembleAuthoringBrief screenless determinism', () => {
  it('produces byte-identical briefs for identical store + projection + inputs on the lexical floor', () => {
    const first = authoringBriefOnly(baseInput())
    const second = authoringBriefOnly(baseInput())

    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.facts.length).toBeGreaterThan(0)
    expect(first.cautions.length).toBeGreaterThan(0)
    expect(first.procedures.length).toBeGreaterThan(0)
    expect(first.exemplars.length).toBeGreaterThan(0)
  })
})

describe('assembleAuthoringBrief tight-budget precedence', () => {
  it('sheds facts first, then exemplars, then procedures, cautions last — and reports the shed', () => {
    const full = authoringBriefOnly(baseInput())
    const stages = {
      factsShedOnly: false,
      exemplarsShed: false,
      proceduresShed: false,
      cautionsOnly: false,
    }

    for (let budget = 10; budget <= 1_000; budget += 5) {
      const brief = authoringBriefOnly(baseInput({ budget }))

      // Locked precedence invariants: nothing lower-precedence may survive a higher shed.
      if (brief.facts.length > 0) {
        expect(brief.exemplars.length).toBe(full.exemplars.length)
        expect(brief.procedures.length).toBe(full.procedures.length)
        expect(brief.cautions.length).toBe(full.cautions.length)
      }
      if (brief.exemplars.length > 0) {
        expect(brief.procedures.length).toBe(full.procedures.length)
        expect(brief.cautions.length).toBe(full.cautions.length)
      }
      if (brief.procedures.length > 0) {
        expect(brief.cautions.length).toBe(full.cautions.length)
      }

      const shedAnything =
        brief.facts.length < full.facts.length
        || brief.exemplars.length < full.exemplars.length
        || brief.procedures.length < full.procedures.length
        || brief.cautions.length < full.cautions.length
      if (shedAnything) expect(brief.truncation).toMatch(/^truncated \d+ of \d+$/)
      else expect(brief.truncation).toBe('')

      if (
        brief.facts.length < full.facts.length
        && brief.exemplars.length === full.exemplars.length
        && brief.procedures.length === full.procedures.length
        && brief.cautions.length === full.cautions.length
      ) {
        stages.factsShedOnly = true
      }
      if (
        brief.exemplars.length < full.exemplars.length
        && brief.procedures.length === full.procedures.length
      ) {
        stages.exemplarsShed = true
      }
      if (brief.procedures.length === 0 && brief.cautions.length === full.cautions.length) {
        stages.proceduresShed = true
      }
      if (
        brief.cautions.length > 0
        && brief.procedures.length === 0
        && brief.exemplars.length === 0
        && brief.facts.length === 0
      ) {
        stages.cautionsOnly = true
      }
    }

    expect(stages).toEqual({
      factsShedOnly: true,
      exemplarsShed: true,
      proceduresShed: true,
      cautionsOnly: true,
    })
  })
})

describe('assembleAuthoringBrief exemplar ranking', () => {
  it('ranks by trust x recent-pass-rate x relevance and holds the exemplar/procedure caps', () => {
    const rows = [
      projectionRow({
        filePath: 'auth/high.spec.ts',
        testName: 'signs in with valid credentials',
      }),
      projectionRow({
        filePath: 'auth/mid.spec.ts',
        testName: 'signs in with expired credentials',
        passes: 2,
        failures: 3,
        lastOutcomes: [
          { buildOrdinal: 1, passed: true },
          { buildOrdinal: 2, passed: false },
          { buildOrdinal: 3, passed: false },
          { buildOrdinal: 4, passed: false },
          { buildOrdinal: 5, passed: true },
        ],
      }),
      projectionRow({
        filePath: 'auth/low.spec.ts',
        testName: 'signs in via magic link',
        anchors: [{ t: 'page', route: '/login' }],
      }),
    ]
    const brief = authoringBriefOnly(baseInput({ projectionRows: rows, knownTests: [] }))

    const order = brief.exemplars.map(({ filePath }) => filePath)
    expect(order.indexOf('auth/high.spec.ts')).toBeLessThan(order.indexOf('auth/low.spec.ts'))
    expect(order.indexOf('auth/low.spec.ts')).toBeLessThan(order.indexOf('auth/mid.spec.ts'))

    const manyRows = Array.from({ length: AUTHORING_EXEMPLAR_CAP + 3 }, (_, index) =>
      projectionRow({
        filePath: `auth/exemplar-${index}.spec.ts`,
        testName: `signs in variant ${index}`,
        anchors: [{ t: 'page', route: '/login' }, { t: 'page', route: `/login/v${index}` }],
      }))
    const capped = authoringBriefOnly(baseInput({ projectionRows: manyRows, knownTests: [] }))
    expect(capped.exemplars).toHaveLength(AUTHORING_EXEMPLAR_CAP)

    const manyProcedures = Array.from({ length: AUTHORING_PROCEDURE_CAP + 2 }, (_, index) =>
      entryCandidate({ id: `proc-variant-${index}`, kind: 'procedure' }))
    const proceduresCapped = authoringBriefOnly(baseInput({
      entries: manyProcedures,
      projectionRows: [],
      knownTests: [],
    }))
    expect(proceduresCapped.procedures).toHaveLength(AUTHORING_PROCEDURE_CAP)
  })
})

describe('assembleAuthoringBrief hard excludes + degraded posture', () => {
  it('hard-excludes the first observed flake before exemplar scoring', () => {
    const row = projectionRow({
      filePath: 'auth/one-flake.spec.ts',
      testName: 'signs in with one observed flake',
      flakeCount: 1,
      quarantined: false,
      lastOutcomes: Array.from({ length: 10 }, (_, index) => ({
        buildOrdinal: index + 1,
        passed: true,
      })),
    })

    const brief = authoringBriefOnly(baseInput({
      projectionRows: [row],
      knownTests: [{ filePath: row.filePath, testName: row.testName }],
    }))

    expect(brief.exemplars).toEqual([])
  })

  it('hard-excludes a mixed recent window whose latest outcome failed', () => {
    const row = projectionRow({
      filePath: 'auth/current-failure.spec.ts',
      testName: 'signs in until the current failure',
      passes: 9,
      failures: 1,
      flakeCount: 0,
      lastOutcomes: [
        ...Array.from({ length: 9 }, (_, index) => ({
          buildOrdinal: index + 1,
          passed: true,
        })),
        { buildOrdinal: 10, passed: false },
      ],
    })

    const brief = authoringBriefOnly(baseInput({
      projectionRows: [row],
      knownTests: [{ filePath: row.filePath, testName: row.testName }],
    }))

    expect(brief.exemplars).toEqual([])
  })

  it('keeps a zero-flake recovered row whose latest outcome passed', () => {
    const row = projectionRow({
      filePath: 'auth/recovered.spec.ts',
      testName: 'signs in after recovering from a prior failure',
      passes: 9,
      failures: 1,
      flakeCount: 0,
      lastOutcomes: [
        { buildOrdinal: 9, passed: false },
        { buildOrdinal: 10, passed: true },
      ],
    })

    const brief = authoringBriefOnly(baseInput({
      projectionRows: [row],
      knownTests: [{ filePath: row.filePath, testName: row.testName }],
    }))

    expect(brief.exemplars).toHaveLength(1)
    expect(brief.exemplars[0]).toMatchObject({
      filePath: row.filePath,
      testName: row.testName,
      passRate: 0.9,
      recentOutcomes: row.lastOutcomes,
      unverifiedOutcomes: false,
    })
    expect(brief.exemplars[0]?.excerpt).toContain(row.testName)
    expect(brief.exemplars[0]?.excerpt).toContain('outcomes 9 pass / 1 fail')
  })

  it('hard-excludes observed negative signal, keeps never-run tests flagged and discounted', () => {
    const rows = [
      projectionRow({
        filePath: 'auth/verified.spec.ts',
        testName: 'signs in with valid credentials',
      }),
      projectionRow({
        filePath: 'auth/flaky.spec.ts',
        testName: 'signs in flakily',
        flakeCount: 3,
        quarantined: true,
      }),
      projectionRow({
        filePath: 'auth/failing.spec.ts',
        testName: 'signs in but always fails',
        passes: 0,
        failures: 4,
        lastOutcomes: [
          { buildOrdinal: 3, passed: false },
          { buildOrdinal: 4, passed: false },
        ],
      }),
    ]
    const knownTests = [
      { filePath: 'auth/verified.spec.ts', testName: 'signs in with valid credentials' },
      { filePath: 'auth/never-ran.spec.ts', testName: 'signs in after password reset on login' },
    ]
    const brief = authoringBriefOnly(baseInput({ projectionRows: rows, knownTests }))

    const files = brief.exemplars.map(({ filePath }) => filePath)
    expect(files).not.toContain('auth/flaky.spec.ts')
    expect(files).not.toContain('auth/failing.spec.ts')
    expect(files).toContain('auth/never-ran.spec.ts')

    const neverRan = brief.exemplars.find(({ filePath }) => filePath === 'auth/never-ran.spec.ts')
    const verified = brief.exemplars.find(({ filePath }) => filePath === 'auth/verified.spec.ts')
    expect(neverRan?.unverifiedOutcomes).toBe(true)
    expect(neverRan?.passRate).toBeUndefined()
    expect(verified?.unverifiedOutcomes).toBe(false)
    expect(files.indexOf('auth/verified.spec.ts')).toBeLessThan(
      files.indexOf('auth/never-ran.spec.ts'),
    )

    const emptyProjection = authoringBriefOnly(baseInput({
      projectionRows: [],
      knownTests,
    }))
    expect(emptyProjection.exemplars.map(({ filePath }) => filePath)).toEqual(
      expect.arrayContaining(['auth/never-ran.spec.ts']),
    )
    expect(emptyProjection.exemplars.every(({ unverifiedOutcomes }) => unverifiedOutcomes))
      .toBe(true)
    expect(emptyProjection.cautions.length).toBeGreaterThan(0)
    expect(emptyProjection.facts.length).toBeGreaterThan(0)
  })
})

describe('assembleAuthoringBrief refs not copies', () => {
  it('serves exemplar references with bounded excerpts, never full test text', () => {
    const brief = authoringBriefOnly(baseInput())

    expect(brief.exemplars.length).toBeGreaterThan(0)
    for (const exemplar of brief.exemplars) {
      expect(exemplar.filePath.length).toBeGreaterThan(0)
      expect(exemplar.testName.length).toBeGreaterThan(0)
      expect(exemplar.excerpt.length).toBeGreaterThan(0)
      expect(exemplar.excerpt.length).toBeLessThanOrEqual(AUTHORING_EXCERPT_CHAR_BUDGET)
      expect(Object.keys(exemplar).sort()).toEqual(
        expect.arrayContaining(['excerpt', 'filePath', 'matchedAnchors', 'testName',
          'unverifiedOutcomes']),
      )
      for (const value of Object.values(exemplar)) {
        if (typeof value === 'string') {
          expect(value.length).toBeLessThanOrEqual(AUTHORING_EXCERPT_CHAR_BUDGET)
        }
      }
    }
  })
})

describe('assembleAuthoringBrief adversarial delimiter collisions', () => {
  it('serves both the projected exemplar and the distinct never-run test under old-colliding names', () => {
    const brief = authoringBriefOnly(baseInput({
      projectionRows: [projectionRow({ filePath: 'a::b', testName: 'c' })],
      knownTests: [
        { filePath: 'a::b', testName: 'c' },
        { filePath: 'a', testName: 'b::c' },
      ],
      intent: 'a b c',
    }))

    const identities = brief.exemplars.map(({ filePath, testName }) => ({ filePath, testName }))
    expect(identities).toContainEqual({ filePath: 'a::b', testName: 'c' })
    expect(identities).toContainEqual({ filePath: 'a', testName: 'b::c' })
    expect(brief.exemplars).toHaveLength(2)

    const projected = brief.exemplars.find(({ filePath }) => filePath === 'a::b')
    expect(projected).toMatchObject({ testName: 'c', unverifiedOutcomes: false, passRate: 1 })
    expect(projected?.recentOutcomes).toHaveLength(3)

    const neverRun = brief.exemplars.find(({ filePath }) => filePath === 'a')
    expect(neverRun).toMatchObject({ testName: 'b::c', unverifiedOutcomes: true })
    expect(neverRun).not.toHaveProperty('passRate')
  })

  it('admits two exemplars whose old record ids collided as two distinct admissions', () => {
    const brief = authoringBriefOnly(baseInput({
      entries: [],
      projectionRows: [
        projectionRow({
          filePath: 'a::b',
          testName: 'c',
          anchors: [{ t: 'page', route: '/login' }],
        }),
        projectionRow({
          filePath: 'a',
          testName: 'b::c',
          anchors: [{ t: 'page', route: '/login' }],
        }),
      ],
      knownTests: [],
      intent: 'a b c',
    }))

    expect(brief.exemplars).toHaveLength(2)
    const exemplarAdmissionIds = brief.admissions
      .map(({ id }) => String(id))
      .filter((id) => id.startsWith('exemplar:'))
    expect(exemplarAdmissionIds).toHaveLength(2)
    expect(new Set(exemplarAdmissionIds).size).toBe(2)
  })

  it('keeps an empty-testName never-run test beside a formerly-colliding projected row', () => {
    const brief = authoringBriefOnly(baseInput({
      projectionRows: [projectionRow({ filePath: 'a', testName: 'b::' })],
      knownTests: [
        { filePath: 'a', testName: 'b::' },
        { filePath: 'a::b', testName: '' },
      ],
      intent: 'a b',
    }))

    const identities = brief.exemplars.map(({ filePath, testName }) => ({ filePath, testName }))
    expect(identities).toContainEqual({ filePath: 'a', testName: 'b::' })
    expect(identities).toContainEqual({ filePath: 'a::b', testName: '' })
    expect(brief.exemplars).toHaveLength(2)

    const emptyName = brief.exemplars.find(({ filePath }) => filePath === 'a::b')
    expect(emptyName).toMatchObject({ testName: '', unverifiedOutcomes: true })
  })
})

describe('assembleAuthoringBrief typed-empty coverage', () => {
  it('carries a present, empty coverage map on every result', () => {
    const full = authoringBriefOnly(baseInput())
    const empty = authoringBriefOnly(baseInput({
      entries: [],
      projectionRows: [],
      knownTests: [],
    }))

    expect(full.coverage).toEqual({})
    expect(empty.coverage).toEqual({})
    expect(Object.keys(empty)).toContain('coverage')
    expect(empty.exemplars).toEqual([])
    expect(empty.procedures).toEqual([])
    expect(empty.facts).toEqual([])
    expect(empty.cautions).toEqual([])
    expect(empty.truncation).toBe('')
    expect(empty.admissions).toEqual([])
  })
})
