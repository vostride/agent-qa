/**
 * The serve-time retrieval trace at every serving entry (Phase 387-04, KREV-02 · D-13/D-14/D-16).
 *
 * These cases pin what the trace CLAIMS, not merely that a trace object exists. Two failure modes
 * this file is deliberately built against:
 *
 *  - a bound whose input domain never reaches it (the truncation cases feed EXACTLY the pinned
 *    top-K and exactly K+1, never "a lot");
 *  - an attribution nothing could contradict (the authoring cases construct one candidate per leg
 *    so a constant `leg` fails, and the leg-vocabulary case executes the real retrieval legs
 *    rather than reading their source).
 */
import {
  asRecordId,
  canonicalJson,
  normalizeAnchor,
  RETRIEVAL_TRACE_LEGS,
  ServedRetrievalTraceV1Schema,
  serializeProcedureBody,
  TRACE_TRUNCATION_TOP_K,
  type Anchor,
  type BundleProvenance,
  type IndexEntry,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { makeProcedureBodyPayloadFixture } from '../../__tests__/fixtures/bundle-fixture.js'
import {
  assembleAuthoringBrief,
  type AssembleAuthoringBriefInput,
  type AuthoringEntryCandidate,
} from '../get-authoring-brief.js'
import { selectCautions } from '../get-cautions.js'
import { assembleRunBrief } from '../get-run-brief.js'
import type { PolicyLadder } from '../policy-ladder.js'
import { CHANNEL_1_SERVING_LEG, SERVING_TRACE_LEGS, traceLine } from '../serve-trace.js'

const scope = { tier: 'test', key: 'checkout' } as const

type OriginStampedEntry = IndexEntry & {
  origin?: 'app-observed' | 'user'
  originClass?: 'agent-observed' | 'agent-verified' | 'import' | 'user'
}

function candidate(
  id: string,
  overrides: Partial<OriginStampedEntry> = {},
): OriginStampedEntry {
  return {
    id: asRecordId(id),
    kind: 'fact',
    title: id,
    summary: id,
    trust: 1,
    anchors: [{ t: 'el', role: 'button', name: id }],
    status: 'active',
    servedAsCanary: false,
    scope,
    validity: 'current',
    ...overrides,
  }
}

function policy(text = ''): PolicyLadder {
  return {
    text,
    files: text.length === 0 ? [] : ['policies/global.md'],
    oversized: [],
  }
}

/** N learned facts with equal cost, so a budget cuts a predictable number of them. */
function learnedCandidates(count: number): OriginStampedEntry[] {
  return Array.from({ length: count }, (_, index) =>
    candidate(`fact-${String(index).padStart(3, '0')}`))
}

describe('Channel-1 run brief returns brief and trace as one value', () => {
  it('attributes every learned brief line with record id, leg, rank and score', () => {
    const served = assembleRunBrief({
      candidates: [
        candidate('fact-alpha', { trust: 0.9 }),
        candidate('caution-beta', { kind: 'caution', trust: 0.7 }),
      ],
      policy: policy('POLICY: authored bytes.\n'),
      scope,
      budget: 10_000,
      recordCap: 10,
    })

    expect(Object.keys(served).sort()).toEqual(['brief', 'trace'])
    expect(served.brief.lines.map(({ id }) => String(id))).toEqual([
      'caution-beta',
      'fact-alpha',
    ])
    // The leg is asserted as a LITERAL, not as the exported constant: attributing Channel 1 to a
    // different leg is a design change about what actually ranked these lines, and a test written
    // against the constant would agree with any value the constant happened to hold.
    expect(served.trace.servedLines).toEqual([
      { recordId: 'caution-beta', leg: 'anchor', rank: 1, score: 0.7 },
      { recordId: 'fact-alpha', leg: 'anchor', rank: 2, score: 0.9 },
    ])
    expect(CHANNEL_1_SERVING_LEG).toBe('anchor')
    expect(served.trace.truncated).toEqual([])
    // The persisted shape must survive the boundary 387-02 put in front of the handoff loader:
    // a trace that cannot parse would make the whole run handoff unloadable.
    expect(ServedRetrievalTraceV1Schema.safeParse(served.trace).success).toBe(true)
  })

  it('leaves sovereign L0 user facts out of the retrieval trace while still serving them', () => {
    const served = assembleRunBrief({
      candidates: [
        candidate('fact-user', { origin: 'user', summary: 'User-authored fact.' }),
        candidate('fact-learned'),
      ],
      policy: policy(),
      scope,
      budget: 10_000,
      recordCap: 10,
    })

    // Both are SERVED — the control would be vacuous if the sovereign line were simply absent.
    expect(served.brief.lines.map(({ id }) => String(id))).toEqual(['fact-user', 'fact-learned'])
    expect(served.brief.tiers.L0).toContain('User-authored fact.')
    // Only the learned one is ATTRIBUTED: a sovereign fact is served by the sovereignty rule and
    // never enters the ranking, so naming a retrieval leg for it would be fabricated testimony.
    expect(served.trace.servedLines.map(({ recordId }) => recordId)).toEqual(['fact-learned'])
  })

  it('records budget-cut candidates in the truncation ledger with their rank and score', () => {
    const candidates = learnedCandidates(6)
    const budgeted = assembleRunBrief({
      candidates,
      policy: policy(),
      scope,
      budget: 20,
      recordCap: 10,
    })
    const whole = assembleRunBrief({
      candidates,
      policy: policy(),
      scope,
      budget: 10_000,
      recordCap: 10,
    })

    const servedIds = budgeted.trace.servedLines.map(({ recordId }) => recordId)
    const cutIds = budgeted.trace.truncated.map(({ recordId }) => recordId)

    expect(budgeted.brief.truncation).toBe(
      `truncated ${servedIds.length} of ${candidates.length}`,
    )
    expect(servedIds.length).toBeGreaterThan(0)
    expect(cutIds.length).toBeGreaterThan(0)
    // The two ledgers partition the full ranking — nothing appears twice, nothing goes missing.
    expect([...servedIds, ...cutIds].sort()).toEqual(
      whole.trace.servedLines.map(({ recordId }) => recordId).sort(),
    )
    for (const line of budgeted.trace.truncated) {
      expect(line.rank).toBeGreaterThan(0)
      expect(Number.isFinite(line.score)).toBe(true)
      expect(servedIds).not.toContain(line.recordId)
    }
  })

  it('keeps exactly the K highest-ranked cut candidates at the K+1 boundary', () => {
    // recordCap admits exactly one record, so every other candidate is a cut candidate. Feeding
    // EXACTLY K + 1 and EXACTLY K cuts is the point: a corpus of "many" cuts cannot distinguish
    // a correct bound from a bound one too loose.
    const atBound = assembleRunBrief({
      candidates: learnedCandidates(TRACE_TRUNCATION_TOP_K + 1),
      policy: policy(),
      scope,
      budget: 10_000,
      recordCap: 1,
    })
    const overBound = assembleRunBrief({
      candidates: learnedCandidates(TRACE_TRUNCATION_TOP_K + 2),
      policy: policy(),
      scope,
      budget: 10_000,
      recordCap: 1,
    })

    expect(atBound.trace.truncated).toHaveLength(TRACE_TRUNCATION_TOP_K)
    expect(overBound.trace.truncated).toHaveLength(TRACE_TRUNCATION_TOP_K)

    const overBoundRanks = overBound.trace.truncated.map(({ rank }) => rank)
    expect(overBoundRanks).toEqual([...overBoundRanks].sort((a, b) => a - b))

    // Name the K+1th cut candidate explicitly: rank it in the FULL serve-time ranking of the same
    // corpus, subtract the one record that was served, and the remainder is the ordered cut set.
    const wholeOverBound = assembleRunBrief({
      candidates: learnedCandidates(TRACE_TRUNCATION_TOP_K + 2),
      policy: policy(),
      scope,
      budget: 10_000,
      recordCap: TRACE_TRUNCATION_TOP_K + 2,
    })
    const servedId = overBound.trace.servedLines[0]!.recordId
    const orderedCuts = wholeOverBound.trace.servedLines
      .filter(({ recordId }) => recordId !== servedId)
      .map(({ recordId }) => recordId)
    expect(orderedCuts).toHaveLength(TRACE_TRUNCATION_TOP_K + 1)
    expect(overBound.trace.truncated.map(({ recordId }) => recordId))
      .toEqual(orderedCuts.slice(0, TRACE_TRUNCATION_TOP_K))
    expect(overBound.trace.truncated.map(({ recordId }) => recordId))
      .not.toContain(orderedCuts.at(-1))
    expect(ServedRetrievalTraceV1Schema.safeParse(overBound.trace).success).toBe(true)
  })

  it('ranks every served record inside the full serve-time ranking', () => {
    // The assembly's rank fallback exists so a future staging change degrades into a valid rank
    // rather than an invalid one. This asserts the fallback is not reached today: the budgeted
    // pass admits a SUBSET of what the unbounded pass stages, at several budgets.
    // Deliberately UNEQUAL rendered costs. With equal costs the budgeted pass admits a prefix of
    // the ranking, and a rank taken from the served position would agree with the true rank by
    // accident — the input domain would never reach the claim. A cheap low-ranked record admitted
    // after an expensive high-ranked one is skipped is what makes the two disagree.
    const candidates = [
      ...learnedCandidates(6),
      candidate('fact-bulky', { summary: 'b'.repeat(400) }),
      candidate('fact-tiny', { summary: 't' }),
      ...learnedCandidates(4).map((entry, index) => ({
        ...entry,
        id: asRecordId(`fact-late-${index}`),
        summary: 'x'.repeat(60),
      })),
    ]
    for (const budget of [4, 12, 40, 10_000]) {
      const whole = assembleRunBrief({
        candidates,
        policy: policy(),
        scope,
        budget: 10_000,
        recordCap: candidates.length,
      })
      const budgeted = assembleRunBrief({
        candidates,
        policy: policy(),
        scope,
        budget,
        recordCap: candidates.length,
      })
      const fullRanking = new Map(
        whole.trace.servedLines.map(({ recordId, rank, score }) => [recordId, { rank, score }]),
      )
      for (const line of budgeted.trace.servedLines) {
        const ranked = fullRanking.get(line.recordId)
        expect(ranked).toBeDefined()
        expect(line.rank).toBe(ranked!.rank)
        expect(line.score).toBe(ranked!.score)
      }
      if (budget === 40) {
        // The corpus really does produce a non-prefix selection at this budget, so the rank
        // assertion above is distinguishing the full ranking from the served position.
        const positions = budgeted.trace.servedLines.map(({ rank }, index) => rank - (index + 1))
        expect(positions.some((delta) => delta !== 0)).toBe(true)
      }
    }
  })

  it('produces a trace that does not depend on candidate input order', () => {
    const candidates = learnedCandidates(5)
    const forward = assembleRunBrief({
      candidates,
      policy: policy(),
      scope,
      budget: 12,
      recordCap: 10,
    })
    const reverse = assembleRunBrief({
      candidates: [...candidates].reverse(),
      policy: policy(),
      scope,
      budget: 12,
      recordCap: 10,
    })

    expect(JSON.stringify(reverse.trace)).toBe(JSON.stringify(forward.trace))
  })

  it('round-trips byte-identically through serialization and preserves tied ranks', () => {
    // Every candidate here carries the SAME trust and the same anchor shape, so every score ties.
    // A tie that reordered on serialize would silently rewrite the attribution order.
    const served = assembleRunBrief({
      candidates: learnedCandidates(8),
      policy: policy(),
      scope,
      budget: 16,
      recordCap: 10,
    })
    const scores = new Set(served.trace.servedLines.map(({ score }) => score))
    expect(scores.size).toBe(1)

    const once = JSON.stringify(served.trace)
    const twice = JSON.stringify(ServedRetrievalTraceV1Schema.parse(JSON.parse(once)))
    expect(twice).toBe(once)
    expect(served.trace.servedLines.map(({ rank }) => rank))
      .toEqual(served.trace.servedLines.map((_line, index) => index + 1))
  })
})

describe('Channel-3 caution selection returns block and trace as one value', () => {
  function caution(id: string, overrides: Partial<IndexEntry> = {}): IndexEntry {
    return {
      id: asRecordId(id),
      kind: 'caution',
      title: id,
      summary: 'note',
      trust: 1,
      anchors: [{ t: 'page', route: '/checkout' }],
      status: 'active',
      servedAsCanary: false,
      scope,
      validity: 'current',
      ...overrides,
    }
  }

  it('attributes every served caution to the anchor leg with its ranked position', () => {
    const result = selectCautions({
      candidates: [
        caution('c_flow', { anchors: [{ t: 'flow', name: 'Checkout' }], trust: 0.5 }),
        caution('c_element', {
          anchors: [{ t: 'el', role: 'button', name: 'Place order' }],
          trust: 0.9,
        }),
      ],
      anchors: [
        { t: 'el', role: 'button', name: 'Place order' },
        { t: 'flow', name: 'Checkout' },
      ],
      budget: 10_000,
    })

    expect(result.block.cautions.map(({ id }) => String(id))).toEqual(['c_element', 'c_flow'])
    expect(result.trace.servedLines).toEqual([
      { recordId: 'c_element', leg: 'anchor', rank: 1, score: 0.9 },
      { recordId: 'c_flow', leg: 'anchor', rank: 2, score: 0.5 },
    ])
    expect(result.trace.truncated).toEqual([])
  })

  it('records the cut cautions the overflow line only counts', () => {
    const result = selectCautions({
      candidates: [
        caution('c_one', { trust: 0.9 }),
        caution('c_two', { trust: 0.8 }),
        caution('c_three', { trust: 0.7 }),
      ],
      anchors: [{ t: 'page', route: '/checkout' }],
      budget: 1,
    })

    expect(result.overflow).toBeDefined()
    // The reserved overflow line reports only a COUNT; the trace names the records, which is
    // exactly the "why didn't it mention X" gap D-14 exists to close.
    expect(result.trace.truncated.map(({ recordId }) => recordId)).toEqual([
      'c_one',
      'c_two',
      'c_three',
    ])
    expect(result.trace.truncated.map(({ rank }) => rank)).toEqual([1, 2, 3])
    expect(ServedRetrievalTraceV1Schema.safeParse(result.trace).success).toBe(true)
  })
})

describe('§10.6 authoring channel returns brief and trace as one value', () => {
  const TARGET_ANCHORS: Anchor[] = [
    { t: 'page', route: '/login' },
    { t: 'flow', name: 'Sign in flow' },
  ]
  const INTENT = 'author a sign in test for the login page'

  function anchorKey(anchor: Anchor): string {
    return canonicalJson(normalizeAnchor(anchor))
  }

  function runLinkedProvenance(): BundleProvenance {
    return {
      schemaVersion: 1,
      mode: 'run-linked',
      originClass: 'agent-verified',
      runId: 'run-authoring',
      testId: 'test-authoring',
      stepIndex: 0,
    }
  }

  function entryCandidate(options: {
    id: string
    kind: 'fact' | 'caution' | 'procedure'
    summary: string
    anchors?: Anchor[]
  }): AuthoringEntryCandidate {
    const anchors = (options.anchors ?? TARGET_ANCHORS).map(normalizeAnchor)
    return {
      entry: {
        id: asRecordId(options.id),
        kind: options.kind,
        title: options.summary,
        summary: options.summary,
        trust: 0.8,
        anchors,
        status: options.kind === 'procedure' ? 'candidate' : 'active',
        servedAsCanary: false,
        scope: { tier: 'product', key: 'authoring-store' },
        validity: 'current',
      },
      bundle: {
        summary: options.summary,
        body: options.kind === 'procedure'
          ? serializeProcedureBody(makeProcedureBodyPayloadFixture())
          : `${options.summary} body.`,
        events: [],
        provenance: runLinkedProvenance(),
      },
    }
  }

  function authoringInput(
    overrides: Partial<AssembleAuthoringBriefInput> = {},
  ): AssembleAuthoringBriefInput {
    return {
      entries: [
        // Anchor-only: matches both target anchors, shares no intent word beyond the anchors.
        entryCandidate({
          id: 'fact-anchor',
          kind: 'fact',
          summary: 'Zzz qqq wwwx',
        }),
        // Lexical-only: no target anchor at all, but every intent token is in its text.
        entryCandidate({
          id: 'fact-lexical',
          kind: 'fact',
          summary: 'author a sign in test for the login page',
          anchors: [{ t: 'page', route: '/elsewhere' }],
        }),
        // Dense-only: no target anchor, no intent word, a supplied dense score.
        entryCandidate({
          id: 'fact-dense',
          kind: 'fact',
          summary: 'Kkk vvv bbbx',
          anchors: [{ t: 'page', route: '/nowhere' }],
        }),
      ],
      projectionRows: [],
      knownTests: [],
      intent: INTENT,
      scope: { tier: 'product', key: 'authoring-store' },
      targetAnchors: TARGET_ANCHORS,
      budget: 10_000,
      denseScoreByRecordId: new Map([['fact-dense', 1]]),
      ...overrides,
    }
  }

  it('attributes each authoring line to the relevance term that actually carried it', () => {
    const served = assembleAuthoringBrief(authoringInput())

    expect(Object.keys(served).sort()).toEqual(['brief', 'trace'])
    const legByRecord = new Map(
      served.trace.servedLines.map(({ recordId, leg }) => [recordId, leg]),
    )
    // Three candidates, three DIFFERENT legs — a constant attribution cannot pass this.
    expect(legByRecord.get('fact-anchor')).toBe('anchor')
    expect(legByRecord.get('fact-lexical')).toBe('lexical')
    expect(legByRecord.get('fact-dense')).toBe('dense')
    expect(new Set(legByRecord.values()).size).toBe(3)
    expect(ServedRetrievalTraceV1Schema.safeParse(served.trace).success).toBe(true)
  })

  it('breaks an exact anchor/lexical tie toward the anchor leg', () => {
    // One target anchor of two matched -> anchor contributes 0.5. Every intent token present ->
    // the lexical term contributes AUTHORING_LEXICAL_WEIGHT * 1 = 0.5. An exact tie is the ONLY
    // input under which the precedence order is load-bearing, so without this case the order
    // could be reversed with nothing noticing.
    const served = assembleAuthoringBrief(authoringInput({
      entries: [
        entryCandidate({
          id: 'fact-tied',
          kind: 'fact',
          summary: INTENT,
          anchors: [{ t: 'page', route: '/login' }],
        }),
      ],
      denseScoreByRecordId: new Map(),
    }))

    expect(served.trace.servedLines).toHaveLength(1)
    expect(served.trace.servedLines[0]!.leg).toBe('anchor')
  })

  it('records the whole-bucket shed a tight authoring budget produces', () => {
    // The authoring assembly sheds a bucket WHOLE once any earlier bucket shed anything, without
    // consulting the ledger again. Those candidates leave no mark in the brief at all, so a trace
    // that only recorded ledger REFUSALS would be silent about exactly the case D-14 exists for.
    // This corpus forces the caution bucket to shed, which closes the exemplar and fact buckets.
    const corpus = authoringInput({
      entries: [
        entryCandidate({
          id: 'caution-small',
          kind: 'caution',
          summary: 'Login lock',
        }),
        entryCandidate({
          id: 'caution-bulky',
          kind: 'caution',
          summary: `Login lock ${'w'.repeat(400)}`,
        }),
        entryCandidate({ id: 'fact-late', kind: 'fact', summary: 'Login page fact' }),
      ],
      knownTests: [
        { filePath: 'auth/never-run.spec.ts', testName: 'author a sign in test for the login page' },
      ],
      denseScoreByRecordId: new Map(),
      budget: 12,
    })
    const generous = assembleAuthoringBrief(authoringInput({
      ...corpus,
      budget: 10_000,
    }))
    const tight = assembleAuthoringBrief(corpus)

    expect(tight.brief.truncation).not.toBe('')
    expect(tight.trace.servedLines.length).toBeLessThan(generous.trace.servedLines.length)
    const cutIds = tight.trace.truncated.map(({ recordId }) => recordId)
    // The shed caution (a ledger refusal) AND the closed-bucket candidates are both recorded.
    expect(cutIds).toContain('caution-bulky')
    expect(cutIds).toContain('fact-late')
    expect(cutIds.some((id) => id.startsWith('exemplar:'))).toBe(true)
    const ranks = tight.trace.truncated.map(({ rank }) => rank)
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right))
  })

  it('attributes a never-run exemplar to the lexical leg', () => {
    // A never-run test reference carries NO projection anchors at all, so the lexical match
    // against its identity is the entire reason it is served. Without this case the exemplar
    // bucket only ever produces anchor-attributed lines and the branch is unreachable.
    const served = assembleAuthoringBrief(authoringInput({
      entries: [],
      projectionRows: [],
      knownTests: [
        { filePath: 'auth/never-run.spec.ts', testName: 'author a sign in test for the login page' },
      ],
      denseScoreByRecordId: new Map(),
    }))

    expect(served.brief.exemplars.map(({ unverifiedOutcomes }) => unverifiedOutcomes)).toEqual([true])
    expect(served.trace.servedLines).toHaveLength(1)
    expect(served.trace.servedLines[0]!.recordId).toContain('exemplar:')
    expect(served.trace.servedLines[0]!.leg).toBe('lexical')
  })

  it('serves the anchored exemplar bucket with anchor attribution', () => {
    const served = assembleAuthoringBrief(authoringInput({
      projectionRows: [{
        filePath: 'auth/sign-in.spec.ts',
        testName: 'zzz qqq',
        passes: 3,
        failures: 0,
        heals: 0,
        flakeCount: 0,
        quarantined: false,
        lastOutcomes: [{ buildOrdinal: 1, passed: true }],
        anchorKeys: TARGET_ANCHORS.map(anchorKey).sort(),
      }],
    }))

    const exemplarLine = served.trace.servedLines.find(
      ({ recordId }) => recordId.startsWith('exemplar:'),
    )
    expect(exemplarLine).toBeDefined()
    expect(exemplarLine!.leg).toBe('anchor')
  })
})

describe('a trace line is always persistable', () => {
  it('normalizes a non-finite score and a sub-1 rank rather than emitting an unloadable trace', () => {
    // 387-02 gave the handoff loader a present-implies-valid clause for the trace, so ONE bad
    // number would make an entire run handoff unloadable instead of degrading one attribution.
    const line = traceLine({
      recordId: 'r',
      leg: 'anchor',
      rank: 0,
      score: Number.NaN,
    })

    expect(line).toEqual({ recordId: 'r', leg: 'anchor', rank: 1, score: 0 })
    expect(ServedRetrievalTraceV1Schema.safeParse({
      schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
      servedLines: [line],
      truncated: [],
    }).success).toBe(true)
    // Without normalization the schema refuses both, which is what makes the guard load-bearing.
    expect(ServedRetrievalTraceV1Schema.safeParse({
      schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
      servedLines: [{ recordId: 'r', leg: 'anchor', rank: 0, score: Number.NaN }],
      truncated: [],
    }).success).toBe(false)
  })
})

describe('the retrieval-leg vocabulary is one vocabulary', () => {
  it('agrees with the schema vocabulary from the knowledge-local side', () => {
    // `schema` declares RETRIEVAL_TRACE_LEGS; `retrieval/legs.ts` declares a module-private
    // CandidateLeg. Only this package can see both, and the runtime half of the check lives in
    // `retrieval/__tests__/leg-vocabulary.test.ts`, which executes the real legs. This half pins
    // that the serving channels never widen the vocabulary they emit into.
    expect([...SERVING_TRACE_LEGS].sort()).toEqual([...RETRIEVAL_TRACE_LEGS].sort())
    expect(RETRIEVAL_TRACE_LEGS).toContain(CHANNEL_1_SERVING_LEG)
  })
})
