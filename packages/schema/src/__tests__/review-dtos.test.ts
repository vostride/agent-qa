// The knowledge review-verb DTO family (Phase 387 plan 02, KREV-01 · D-15/D-17/D-19).
//
// These contracts are minted BEFORE the verbs that use them (384 D-16: DTOs live in schema),
// so the only thing that can hold them honest is a rejection corpus. Every closed vocabulary
// below is therefore probed with the arm a future author would plausibly reach for — `purge`
// beside accept/reject/forget, `re-run` beside answered/no-trace, `exemplar-rank` beside the
// §7.7 scrub set — rather than with a nonsense string that any check at all would refuse.
//
// Schema module-discipline law: extension-less relative import specifiers, no node builtins.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  BRIEF_WHY_NO_TRACE_REASONS,
  BRIEF_WHY_RESULT_KINDS,
  BriefWhyInputSchema,
  BriefWhyResultSchema,
  KnowledgeMarkInputSchema,
  KnowledgeRecordShowOutputSchema,
  KnowledgeRecordsDiffOutputSchema,
  KnowledgeRecordsInspectOutputSchema,
} from '../knowledge/review-verbs'
import {
  DeltaSchema,
  ForgetReceiptV1Schema,
  ForgetTargetRefSchema,
  KNOWLEDGE_PROJECTIONS,
  KNOWLEDGE_REVIEW_VERBS,
  KnowledgeAcceptInputSchema,
  KnowledgeChangeIdSchema,
  KnowledgeChangeOutputSchema,
  KnowledgeForgetInputSchema,
  KnowledgeRejectInputSchema,
  KnowledgeTargetRefSchema,
  MarkChangeStampSchema,
} from '../knowledge/change'
import { DELTA_KINDS } from '../delta/delta'
import { DELTA_ORIGINS } from '../delta/envelope'
import { RETRIEVAL_TRACE_SCHEMA_VERSION } from '../brief/retrieval-trace'
import {
  COMMIT_RECEIPT_SCHEMA_VERSION,
  FORGET_RECEIPT_SCHEMA_VERSION,
  IMPROVEMENT_PLAN_SCHEMA_VERSION,
  INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
} from '../index'

const scope = { tier: 'suite', key: 'checkout' } as const

const markStamp = {
  markId: 'mark_0123456789ab', runId: 'run-1', testIndex: 0,
  kind: 'false-fail', fix: 'fact',
}

const confirmDelta = {
  origin: 'user',
  scope,
  citedIds: ['rec-checkout-1'],
  kind: 'Confirm',
  targetId: 'rec-checkout-1',
  evidenceToken: 'ev-1',
}

const provenance = {
  schemaVersion: 1,
  mode: 'run-linked',
  originClass: 'agent-verified',
  runId: 'run-1',
  testId: 't_checkout',
  stepIndex: 2,
} as const

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION,
    proposalId: 'prop_alpha-bravo-charlie',
    tombstonedRecords: [{ recordId: 'rec-checkout-1', provenance }],
    projectionsScrubbed: ['fts', 'vec', 'graph', 'exemplar'],
    resultingBundleStatus: 'forgotten',
    forgottenAt: 1_700_000_100_000,
    ...overrides,
  }
}

// Each claim below is checked on the direct knowledge change contract it belongs to. The change
// outputs, inputs and receipts themselves are covered by `knowledge-change-contracts.test.ts`.
const changeDeltas = z.array(DeltaSchema)

describe('the mark change stamp and the mark review input (419 D-01)', () => {
  const plan = {
    schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION, kind: 'knowledge', markId: markStamp.markId,
    feedbackSource: { runId: 'run-1', testIndex: 0, kind: 'false-fail' },
    runTraceRef: { runId: 'run-1', runSlug: 'run-1' },
    fix: 'fact', target: { grain: 'record', recordId: 'rec-checkout-1' },
    deltas: [confirmDelta], wording: 'floor',
  }

  it('admits a mark stamp exactly when it names a mark', () => {
    expect(MarkChangeStampSchema.parse(markStamp)).toEqual(markStamp)
    for (const invalid of [{ ...markStamp, markId: 'mark-1' }, { ...markStamp, verb: 'mark' }, { ...markStamp, fix: 'test-edit' }]) {
      expect(MarkChangeStampSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
    }
  })

  it('carries floor/model wording on the mark plan and refuses an invented one', () => {
    for (const wording of ['floor', 'model'] as const) {
      const input = { target: plan.target, mark: markStamp, plan: { ...plan, wording } }
      expect(KnowledgeMarkInputSchema.parse(input)).toEqual(input)
    }
    expect(KnowledgeMarkInputSchema.safeParse({ target: plan.target, mark: markStamp,
      plan: { ...plan, wording: 'invented' } }).success).toBe(false)
  })

  it('accepts only a non-empty knowledge plan for the mark review input', () => {
    const input = { target: plan.target, mark: markStamp, plan }
    expect(KnowledgeMarkInputSchema.parse(input)).toEqual(input)
    expect(KnowledgeMarkInputSchema.safeParse({ ...input, plan: { ...plan, deltas: [] } }).success).toBe(false)
    expect(KnowledgeMarkInputSchema.safeParse({ ...input, plan: { ...plan, kind: 'test-edit' } }).success).toBe(false)
    expect(() => z.toJSONSchema(KnowledgeMarkInputSchema)).not.toThrow()
  })

  it('round-trips the change outcome with a commit receipt', () => {
    const outcome = {
      outcome: 'applied', verb: 'accept', operationId: 'alpha-bravo-charlie', recordIds: ['rec-checkout-1'],
      commitReceipt: {
        schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION, proposalId: 'prop_alpha-bravo-charlie', markId: markStamp.markId,
        committedAtOrdinal: 1, recordIds: ['rec-checkout-1'], gate3: [], promoted: [], held: [],
      },
    }
    expect(KnowledgeChangeOutputSchema.parse(outcome)).toEqual(outcome)
    expect(() => z.toJSONSchema(KnowledgeChangeOutputSchema)).not.toThrow()
  })
})

describe('the review vocabulary and the change id (D-17)', () => {
  it('pins the verb vocabulary as an exact closed set', () => {
    expect(KNOWLEDGE_REVIEW_VERBS).toEqual(['accept', 'reject', 'forget', 'mark'])
  })

  it('admits every change verb and refuses one outside the union', () => {
    // RE-SPELLED 2026-10-03 (quick 261003-cpv, IN-21): a forget carries its forget receipt by rule.
    const forgetReceipt = {
      schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION, proposalId: 'prop_alpha-bravo', tombstonedRecords: [], projectionsScrubbed: ['fts'],
      resultingBundleStatus: 'forgotten', forgottenAt: 1,
    }
    for (const verb of ['accept', 'reject', 'forget'] as const) {
      expect(KnowledgeChangeOutputSchema.parse({ outcome: 'applied', verb, operationId: 'op-1x',
        recordIds: [], ...(verb === 'forget' ? { forgetReceipt } : {}) }).verb).toBe(verb)
    }
    // `purge` is a real verb elsewhere in this store, which is exactly why it must be refused HERE;
    // a mark is applied through `runs.mark`, never as a direct change.
    for (const verb of ['purge', 'mark']) {
      expect(KnowledgeChangeOutputSchema.safeParse({ outcome: 'applied', verb, operationId: 'op-1x',
        recordIds: [] }).success, verb).toBe(false)
    }
  })

  it('refuses a malformed change id', () => {
    const bad = ['', 'prop_', 'abc', 'prop_Has Space', 'prop_../etc/passwd', 'PROP_alpha-bravo']
    for (const changeId of bad) {
      expect(KnowledgeChangeIdSchema.safeParse(changeId).success, changeId).toBe(false)
    }
    expect(KnowledgeChangeIdSchema.parse('prop_alpha-bravo-charlie')).toBe('prop_alpha-bravo-charlie')
  })

  it('refuses an unknown key and any schemaVersion but its own', () => {
    expect(() => ForgetReceiptV1Schema.parse(receipt({ inbox: 'default' }))).toThrow()
    expect(() => ForgetReceiptV1Schema.parse(receipt({ schemaVersion: 1 }))).toThrow()
  })
})

describe('change deltas (§7.3 vocabulary, imported not re-minted)', () => {
  it('pins the delta kind and origin vocabularies against the type union', () => {
    expect([...DELTA_KINDS]).toEqual([
      'Add',
      'Confirm',
      'Supersede',
      'Deprecate',
      'MintUnknown',
      'Noop',
    ])
    expect([...DELTA_ORIGINS]).toEqual(['agent', 'user', 'import', 'system'])
  })

  it('admits a delta of every declared kind', () => {
    for (const kind of DELTA_KINDS) {
      const parsed = changeDeltas.parse([{ ...confirmDelta, kind }])
      expect(parsed[0]?.kind).toBe(kind)
    }
  })

  it('refuses a delta whose kind is outside the §7.3 vocabulary', () => {
    // `Forget` is the obvious invention for the forget verb — and it is NOT a §7.3 kind.
    // Forgetting is expressed as Deprecate/Supersede through commit().
    expect(() => changeDeltas.parse([{ ...confirmDelta, kind: 'Forget' }])).toThrow()
  })

  it('refuses a delta missing the envelope every arm carries', () => {
    const { origin: _o, ...noOrigin } = confirmDelta
    const { scope: _s, ...noScope } = confirmDelta
    const { citedIds: _c, ...noCited } = confirmDelta
    void _o
    void _s
    void _c

    for (const delta of [noOrigin, noScope, noCited, { ...confirmDelta, origin: 'daemon' }]) {
      expect(() => changeDeltas.parse([delta])).toThrow()
    }
  })
})

describe('ForgetReceiptV1 (D-19 + D-04)', () => {
  it('accepts a full receipt enumerating every tombstoned record with provenance', () => {
    const parsed = ForgetReceiptV1Schema.parse(receipt())

    expect(parsed.tombstonedRecords[0].recordId).toBe('rec-checkout-1')
    expect(parsed.tombstonedRecords[0].provenance.mode).toBe('run-linked')
    expect(parsed.resultingBundleStatus).toBe('forgotten')
  })

  it('pins the §7.7 scrub set as an exact closed vocabulary', () => {
    expect([...KNOWLEDGE_PROJECTIONS]).toEqual(['fts', 'vec', 'graph', 'exemplar'])
  })

  it('refuses a projection outside the scrub set', () => {
    expect(() =>
      ForgetReceiptV1Schema.parse(receipt({ projectionsScrubbed: ['fts', 'exemplar-rank'] })),
    ).toThrow()
  })

  it('refuses a repeated projection — the field is a SUBSET, not a log', () => {
    expect(() =>
      ForgetReceiptV1Schema.parse(receipt({ projectionsScrubbed: ['fts', 'fts'] })),
    ).toThrow()
  })

  it('admits an empty scrub set on a non-empty tombstone set', () => {
    // Whether that combination is SEMANTICALLY right is 387-08's job; the shape is closed
    // here and must not pre-judge it.
    const parsed = ForgetReceiptV1Schema.parse(receipt({ projectionsScrubbed: [] }))

    expect(parsed.projectionsScrubbed).toEqual([])
    expect(parsed.tombstonedRecords).toHaveLength(1)
  })

  it('refuses a tombstoned record with no provenance — nothing silently partial', () => {
    expect(() =>
      ForgetReceiptV1Schema.parse(
        receipt({ tombstonedRecords: [{ recordId: 'rec-checkout-1' }] }),
      ),
    ).toThrow()
  })

  it('refuses a resulting status outside the MEM card vocabulary', () => {
    for (const status of ['forgotten', 'tombstoned', 'active']) {
      expect(
        ForgetReceiptV1Schema.parse(receipt({ resultingBundleStatus: status }))
          .resultingBundleStatus,
      ).toBe(status)
    }
    // `deprecated` is a real BUNDLE status — and it is not a status a MEM card can render,
    // which is exactly what "designed once for both uses" has to mean (D-04 + D-19).
    expect(() =>
      ForgetReceiptV1Schema.parse(receipt({ resultingBundleStatus: 'deprecated' })),
    ).toThrow()
  })
})

describe('ForgetTargetRef (D-19 record-or-bundle grain)', () => {
  it('accepts an individual record id', () => {
    const parsed = ForgetTargetRefSchema.parse({ grain: 'record', recordId: 'rec-checkout-1' })

    expect(parsed).toEqual({ grain: 'record', recordId: 'rec-checkout-1' })
  })

  it('accepts a MEM short-ID at either digit width — one address, two spellings', () => {
    expect(ForgetTargetRefSchema.parse({ grain: 'bundle', shortId: 'MEM-001' })).toEqual({
      grain: 'bundle',
      shortId: 'MEM-001',
    })
    expect(ForgetTargetRefSchema.parse({ grain: 'bundle', shortId: 'MEM-1' })).toEqual({
      grain: 'bundle',
      shortId: 'MEM-1',
    })
  })

  it('refuses a well-formed short-ID of the WRONG kind', () => {
    // The narrowest interesting rejection: `TST-001` parses as a short-ID and resolves to a
    // real entity. It is simply not a thing forgetting applies to.
    expect(() => ForgetTargetRefSchema.parse({ grain: 'bundle', shortId: 'TST-001' })).toThrow()
    expect(() => ForgetTargetRefSchema.parse({ grain: 'bundle', shortId: 'POL-002' })).toThrow()
  })

  it('refuses a malformed address and anything outside the two grains', () => {
    expect(() => ForgetTargetRefSchema.parse({ grain: 'bundle', shortId: 'MEM-0' })).toThrow()
    expect(() => ForgetTargetRefSchema.parse({ grain: 'bundle', shortId: 'the checkout one' })).toThrow()
    expect(() => ForgetTargetRefSchema.parse({ grain: 'product', product: 'shop' })).toThrow()
    expect(() => ForgetTargetRefSchema.parse({ recordId: 'rec-1' })).toThrow()
    expect(() =>
      ForgetTargetRefSchema.parse({ grain: 'record', recordId: 'rec-1', shortId: 'MEM-001' }),
    ).toThrow()
  })

  it('is the SAME union a change addresses its target with', () => {
    const value = { grain: 'bundle', shortId: 'MEM-001' }

    expect(KnowledgeTargetRefSchema.parse(value)).toEqual(ForgetTargetRefSchema.parse(value))
  })
})

describe('BriefWhyResult (D-15 typed honest absence)', () => {
  const trace = {
    schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
    servedLines: [{ recordId: 'rec-1', leg: 'dense', rank: 1, score: 0.7 }],
    truncated: [],
  }

  it('answers with the persisted trace', () => {
    const parsed = BriefWhyResultSchema.parse({ kind: 'answered', trace })

    expect(parsed.kind).toBe('answered')
    expect(parsed.kind === 'answered' && parsed.trace.servedLines[0].leg).toBe('dense')
  })

  it('carries a closed reason on the no-trace arm', () => {
    for (const reason of BRIEF_WHY_NO_TRACE_REASONS) {
      expect(BriefWhyResultSchema.parse({ kind: 'no-trace', reason }).kind).toBe('no-trace')
    }
    expect([...BRIEF_WHY_NO_TRACE_REASONS]).toEqual([
      'pre-trace-run',
      'artifact-missing',
      'step-not-found',
    ])
    expect(() =>
      BriefWhyResultSchema.parse({ kind: 'no-trace', reason: 'retrieval-changed' }),
    ).toThrow()
  })

  it('offers the ServedBrief content on the no-trace arm when one survives', () => {
    const parsed = BriefWhyResultSchema.parse({
      kind: 'no-trace',
      reason: 'pre-trace-run',
      servedBrief: {
        scope,
        asOfBuild: 3,
        budget: 900,
        truncation: 'none',
        channel1: [],
        channel2: [],
        channel3: [],
        briefDigest: 'b'.repeat(64),
      },
    })

    expect(parsed.kind).toBe('no-trace')
  })

  it('refuses an offering that is not a ServedBrief at the three-channel depth', () => {
    // The corpus this assertion could not reject until it existed: the offering was only
    // ever fed a well-formed brief, so every leg of the predicate was unpinned.
    const whole = {
      scope,
      asOfBuild: 3,
      budget: 900,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'b'.repeat(64),
    }
    const { channel1: _c1, ...noChannel1 } = whole
    const { channel2: _c2, ...noChannel2 } = whole
    const { channel3: _c3, ...noChannel3 } = whole
    const { briefDigest: _d, ...noDigest } = whole
    void _c1
    void _c2
    void _c3
    void _d

    const offerings: unknown[] = [
      noChannel1,
      noChannel2,
      noChannel3,
      noDigest,
      { ...whole, briefDigest: 42 },
      { ...whole, channel1: {} },
      'the brief',
      [],
      null,
      // An ARRAY carrying every channel as a named property. Contrived, and that is the
      // point: a probe measured the predicate's array leg unpinned by any other case in
      // this corpus, because a plain `[]` is already refused for having no channel1.
      Object.assign([], whole),
    ]

    for (const servedBrief of offerings) {
      expect(() =>
        BriefWhyResultSchema.parse({ kind: 'no-trace', reason: 'artifact-missing', servedBrief }),
      ).toThrow()
    }
  })

  it('has exactly two arms — there is NO re-run arm', () => {
    // Asserted structurally. "No test exercises a re-run arm" is a claim about this file;
    // an exact member set is a claim about the contract.
    expect([...BRIEF_WHY_RESULT_KINDS]).toEqual(['answered', 'no-trace'])
    expect(() => BriefWhyResultSchema.parse({ kind: 're-run', trace })).toThrow()
    expect(() => BriefWhyResultSchema.parse({ kind: 'answered', reason: 'pre-trace-run' })).toThrow()
    // The two arms cannot be blended: a re-run would arrive as a trace on the ABSENCE arm.
    expect(() =>
      BriefWhyResultSchema.parse({ kind: 'no-trace', reason: 'pre-trace-run', trace }),
    ).toThrow()
  })

  it('addresses a step by run and step index, filtering by record within it', () => {
    expect(BriefWhyInputSchema.parse({ runId: 'run-1', stepIndex: 0 }).stepIndex).toBe(0)
    expect(
      BriefWhyInputSchema.parse({ runId: 'run-1', stepIndex: 2, recordId: 'rec-1' }).recordId,
    ).toBe('rec-1')
    expect(
      BriefWhyInputSchema.parse({ runId: 'run-1', testId: 't_checkout', stepIndex: 2 }).testId,
    ).toBe('t_checkout')
    expect(() => BriefWhyInputSchema.parse({ runId: '', stepIndex: 0 })).toThrow()
    expect(() => BriefWhyInputSchema.parse({ runId: 'run-1', stepIndex: -1 })).toThrow()
    expect(() => BriefWhyInputSchema.parse({ runId: 'run-1' })).toThrow()
  })
})

describe('review-verb input and output DTOs (KREV-01 wiring contracts)', () => {
  it('accept and reject address a target; reject additionally carries a reason', () => {
    const target = { grain: 'record', recordId: 'rec-checkout-1' }

    expect(KnowledgeAcceptInputSchema.parse({ target }).target).toEqual(target)
    expect(KnowledgeRejectInputSchema.parse({ target, reason: 'contradicted' }).reason).toBe(
      'contradicted',
    )
    // A Deprecate delta REQUIRES a reason string, so a reject with no reason could not
    // produce a valid delta — the DTO refuses it rather than letting the verb invent one.
    expect(() => KnowledgeRejectInputSchema.parse({ target })).toThrow()
    expect(() => KnowledgeRejectInputSchema.parse({ target, reason: '' })).toThrow()
  })

  it('forget addresses either grain', () => {
    // RE-SPELLED 2026-10-01 (432-17): the proposal apply input is deleted; a change applies in the call.
    expect(
      KnowledgeForgetInputSchema.parse({ target: { grain: 'bundle', shortId: 'MEM-001' } })
        .target.grain,
    ).toBe('bundle')
  })

  it('projects the reader return shapes faithfully rather than re-minting them', () => {
    const record = {
      schemaVersion: INSPECT_RECORD_VIEW_SCHEMA_VERSION,
      recordId: 'rec-checkout-1',
      product: 'shop',
      scope: 'suite:checkout',
      kind: 'fact',
      status: 'active',
      confirmations: 2,
      contradictions: 0,
      evidenceTokens: ['ev-1'],
      lastEventOrdinal: 9,
      openedAtOrdinal: 4,
      anchors: ['{"t":"page","route":"/cart"}'],
    }

    expect(
      KnowledgeRecordsInspectOutputSchema.parse({ schemaVersion: 2, records: [record] }).records,
    ).toHaveLength(1)
    expect(
      KnowledgeRecordsDiffOutputSchema.parse({
        schemaVersion: 2,
        sinceOrdinal: 3,
        changes: [
          { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'rec-checkout-1', change: 'confirmed', atOrdinal: 9 },
        ],
      }).changes[0].change,
    ).toBe('confirmed')
    expect(
      KnowledgeRecordShowOutputSchema.parse({
        schemaVersion: 2,
        record,
        provenance,
        summary: 'checkout button lives in the header',
        body: 'the body',
      }).record.recordId,
    ).toBe('rec-checkout-1')

    // The projections are the reader's own view schemas, so a member that the reader
    // could never emit is refused here too rather than being waved through as `unknown`.
    expect(() =>
      KnowledgeRecordsInspectOutputSchema.parse({
        schemaVersion: 2,
        records: [{ ...record, status: 'forgotten' }],
      }),
    ).toThrow()
    expect(() =>
      KnowledgeRecordsDiffOutputSchema.parse({
        schemaVersion: 2,
        sinceOrdinal: 3,
        changes: [
          { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'r', change: 'forgotten', atOrdinal: 9 },
        ],
      }),
    ).toThrow()
  })
})
