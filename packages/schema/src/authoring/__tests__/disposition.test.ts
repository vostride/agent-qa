import { describe, expect, it } from 'vitest'

import {
  computeDraftDisposition,
  DRAFT_DISPOSITIONS,
  DRAFT_STABILITY_RUNS_N,
  type DraftDispositionInput,
} from '../disposition'
import {
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DraftReceiptSchema,
  type DraftReceipt,
} from '../draft-receipt'
import * as dispositionModule from '../disposition'
import * as receiptModule from '../draft-receipt'
import { AuthoringVerifyDraftInputSchema } from '../../functions/authoring'

const ALL_TRUE = {
  executesDefinitive: true,
  stableVerdict: true,
  addsValue: true,
  falsifiableAssertion: true,
} as const

function input(overrides: Partial<DraftDispositionInput> = {}): DraftDispositionInput {
  return {
    gates: ALL_TRUE,
    stabilityRunsRequested: DRAFT_STABILITY_RUNS_N,
    stabilityRunsCompleted: DRAFT_STABILITY_RUNS_N,
    ...overrides,
  }
}

/** A fully-populated receipt: every optional field present, so `.strict()` is exercised deeply. */
const FULL_RECEIPT: DraftReceipt = {
  schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  draftRef: {
    filePath: 'fixtures/corpus/accept-control.yaml',
    testId: 't_accept_control',
    testName: 'accept-control',
    contentDigest: 'sha256:0f1e2d3c',
  },
  gates: {
    executesDefinitive: {
      pass: true,
      runRefs: ['r_one', 'r_two', 'r_three'],
      indefinitiveRunRefs: [],
      reason: 'every run reached a final pass or fail',
    },
    stableVerdict: {
      pass: true,
      runRefs: ['r_one', 'r_two', 'r_three'],
      distinctOutcomes: ['healed'],
      earlyStopped: false,
      reason: 'one distinct outcome across the full N',
    },
    addsValue: {
      pass: true,
      novelElementCount: 1,
      comparedTestCount: 3,
      reason: 'one anchor element absent from the suite union',
    },
    falsifiableAssertion: {
      pass: true,
      assertionStepCount: 1,
      falsifiableAssertionCount: 1,
      reason: 'one assertion naming concrete expected content',
    },
  },
  stepTable: [
    {
      stepText: 'Click the "Back to the form" link',
      role: 'action',
      falsifiable: false,
      captureSignatureHits: [],
    },
    {
      stepText: 'Verify the page shows the text "Received!"',
      role: 'assertion',
      falsifiable: true,
      vacuityHit: undefined,
      captureSignatureHits: [],
      tautologyHit: false,
    },
  ],
  gateRuns: [
    { runId: 'r_one', memberOutcome: 'healed', definitive: true, healed: true },
    { runId: 'r_two', memberOutcome: 'healed', definitive: true, healed: true },
    { runId: 'r_three', memberOutcome: 'passed', definitive: true, healed: false },
  ],
  addsValueFinding: {
    novelElements: ['{"anchor":{"name":"back to the form","role":"link","t":"el"}}'],
    comparedTests: [
      {
        filePath: 'tests/local-form.yaml',
        testName: 'local-form',
        lane: 'fingerprint',
        covered: false,
      },
      {
        filePath: 'tests/ladder.yaml',
        testName: 'ladder',
        lane: 'text',
        covered: true,
      },
    ],
  },
  stabilityRunsRequested: 3,
  stabilityRunsCompleted: 3,
  disposition: 'keep-eligible',
  evaluatedAt: 1_754_800_000_000,
}

describe('computeDraftDisposition — the behavior table', () => {
  it('returns keep-eligible when all four gates pass across the full pinned N', () => {
    expect(
      computeDraftDisposition(
        input({ stabilityRunsRequested: 3, stabilityRunsCompleted: 3 }),
      ),
    ).toBe('keep-eligible')
  })

  it('forces unverified in draft mode (N=1) even with all four gates true', () => {
    expect(
      computeDraftDisposition(
        input({ stabilityRunsRequested: 1, stabilityRunsCompleted: 1 }),
      ),
    ).toBe('unverified')
  })

  it('reads unverified in draft mode whatever the run counts, while gates 1, 3 and 4 pass', () => {
    for (const overrides of [
      { stabilityRunsCompleted: 0 },
      { stabilityRunsCompleted: 9 },
      { gates: { ...ALL_TRUE, stableVerdict: false }, stabilityRunsCompleted: 0 },
    ] satisfies readonly Partial<DraftDispositionInput>[]) {
      expect(
        computeDraftDisposition(input({ ...overrides, stabilityRunsRequested: 1 })),
      ).toBe('unverified')
    }
  })

  it('returns rejected when any single gate boolean is false', () => {
    for (const gate of [
      'executesDefinitive',
      'stableVerdict',
      'addsValue',
      'falsifiableAssertion',
    ] as const) {
      expect(
        computeDraftDisposition(input({ gates: { ...ALL_TRUE, [gate]: false } })),
      ).toBe('rejected')
    }
  })

  it('returns rejected on a false gate even when runs stopped early', () => {
    // Early-stop on the first verdict flip leaves completed < N. The flip already proved
    // instability, so the short count must NOT downgrade the answer to proposal-only.
    expect(
      computeDraftDisposition(
        input({
          gates: { ...ALL_TRUE, stableVerdict: false },
          stabilityRunsRequested: 3,
          stabilityRunsCompleted: 2,
        }),
      ),
    ).toBe('rejected')
  })

  it('returns proposal-only when all four pass but fewer than N runs completed', () => {
    expect(
      computeDraftDisposition(
        input({ stabilityRunsRequested: 3, stabilityRunsCompleted: 2 }),
      ),
    ).toBe('proposal-only')
  })

  it('never auto-keeps below the pinned N for any completed count under it', () => {
    for (let completed = 0; completed < DRAFT_STABILITY_RUNS_N; completed += 1) {
      expect(
        computeDraftDisposition(
          input({ stabilityRunsRequested: 3, stabilityRunsCompleted: completed }),
        ),
      ).toBe('proposal-only')
    }
  })

  it('only ever returns a member of DRAFT_DISPOSITIONS', () => {
    expect(DRAFT_DISPOSITIONS).toEqual([
      'keep-eligible',
      'proposal-only',
      'rejected',
      'unverified',
    ])
    expect(DRAFT_DISPOSITIONS).toContain(computeDraftDisposition(input()))
  })

  it('pins the stability constant at 3', () => {
    expect(DRAFT_STABILITY_RUNS_N).toBe(3)
  })
})

describe('DraftReceiptSchema', () => {
  it('round-trips a fully-populated receipt', () => {
    expect(DraftReceiptSchema.parse(FULL_RECEIPT)).toEqual(FULL_RECEIPT)
  })

  it('refuses an unknown top-level key (.strict())', () => {
    expect(() =>
      DraftReceiptSchema.parse({ ...FULL_RECEIPT, runPayload: { steps: [] } }),
    ).toThrow()
  })

  it('refuses an unknown key nested inside a gate run record', () => {
    // Strict, so a run payload cannot be smuggled into the receipt.
    expect(() =>
      DraftReceiptSchema.parse({
        ...FULL_RECEIPT,
        gateRuns: [{ ...FULL_RECEIPT.gateRuns[0], handoff: { tests: [] } }],
      }),
    ).toThrow()
  })

  it('reports the four gate booleans separately, never as one collapsed verdict', () => {
    const parsed = DraftReceiptSchema.parse(FULL_RECEIPT)
    expect(Object.keys(parsed.gates).sort()).toEqual([
      'addsValue',
      'executesDefinitive',
      'falsifiableAssertion',
      'stableVerdict',
    ])
  })

  it('records the heal on a gate run beside its definitiveness', () => {
    const parsed = DraftReceiptSchema.parse(FULL_RECEIPT)
    const healed = parsed.gateRuns.find((record) => record.healed)
    expect(healed).toBeDefined()
    expect(healed?.definitive).toBe(true)
  })

  it('refuses a disposition outside the vocabulary', () => {
    expect(() => DraftReceiptSchema.parse({ ...FULL_RECEIPT, disposition: 'keep' })).toThrow()
  })
})

type WritesTarget = (disposition: string) => boolean
type ParseSchema = { safeParse(value: unknown): { success: boolean } }

function writesTarget(): WritesTarget {
  const predicate = (dispositionModule as Record<string, unknown>)['draftDispositionWritesTarget']
  expect(typeof predicate).toBe('function')
  return predicate as WritesTarget
}

function writtenReceiptSchema(): ParseSchema {
  const schema = (receiptModule as Record<string, unknown>)['WrittenTestReceiptSchema']
  expect(schema).toBeDefined()
  return schema as ParseSchema
}

const WRITTEN_FILE = {
  kind: 'written',
  filePath: 'tests/accept-control.yaml',
  contentDigest: 'sha256:0f1e2d3c',
} as const

const MIXED_GATES = {
  executesDefinitive: true,
  stableVerdict: false,
  addsValue: true,
  falsifiableAssertion: false,
} as const

describe('exactly keep-eligible, proposal-only and unverified final drafts are written', () => {
  it('writes a target for exactly keep-eligible, proposal-only and unverified; never for rejected', () => {
    const predicate = writesTarget()
    expect(DRAFT_DISPOSITIONS.filter((disposition) => predicate(disposition)))
      .toEqual(['keep-eligible', 'proposal-only', 'unverified'])
    expect(predicate('rejected')).toBe(false)
    expect((dispositionModule as Record<string, unknown>)['DRAFT_WRITTEN_DISPOSITIONS'])
      .toEqual(['keep-eligible', 'proposal-only', 'unverified'])
  })

  it('writes every evaluation the table does not reject, over every gate combination and run count', () => {
    const predicate = writesTarget()
    const flags = [true, false] as const
    let cases = 0
    for (const executesDefinitive of flags) {
      for (const stableVerdict of flags) {
        for (const addsValue of flags) {
          for (const falsifiableAssertion of flags) {
            const gates = { executesDefinitive, stableVerdict, addsValue, falsifiableAssertion }
            const allPass = executesDefinitive && stableVerdict && addsValue && falsifiableAssertion
            for (const requested of [1, DRAFT_STABILITY_RUNS_N]) {
              for (let completed = 0; completed <= requested; completed += 1) {
                const disposition = computeDraftDisposition({
                  gates,
                  stabilityRunsRequested: requested,
                  stabilityRunsCompleted: completed,
                })
                // Draft mode writes only if gates 1, 3 and 4 passed; gate 2 needs several runs.
                const singleRunPass = executesDefinitive && addsValue && falsifiableAssertion
                expect(predicate(disposition)).toBe(allPass || (requested === 1 && singleRunPass))
                cases += 1
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(16 * (2 + DRAFT_STABILITY_RUNS_N + 1))
  })

  it('keeps the disposition and all four gate booleans on a written-test receipt', () => {
    const schema = writtenReceiptSchema()
    for (const disposition of ['keep-eligible', 'proposal-only', 'unverified'] as const) {
      expect(schema.safeParse({ file: WRITTEN_FILE, disposition, gates: ALL_TRUE }).success)
        .toBe(true)
    }
    expect(schema.safeParse({
      file: WRITTEN_FILE,
      disposition: 'unverified',
      gates: { ...ALL_TRUE, stableVerdict: false },
    }).success).toBe(true)
    expect(schema.safeParse({ file: WRITTEN_FILE, disposition: 'unverified', gates: MIXED_GATES })
      .success).toBe(false)
    const { falsifiableAssertion: _dropped, ...threeGates } = ALL_TRUE
    expect(schema.safeParse({ file: WRITTEN_FILE, disposition: 'keep-eligible', gates: threeGates })
      .success).toBe(false)
    expect(schema.safeParse({
      file: WRITTEN_FILE,
      disposition: 'keep-eligible',
      gates: { ...ALL_TRUE, verdict: true },
    }).success).toBe(false)
  })

  it('cannot say a rejected draft was written, nor call a written draft rejected', () => {
    const schema = writtenReceiptSchema()
    expect(schema.safeParse({ file: WRITTEN_FILE, disposition: 'rejected', gates: MIXED_GATES })
      .success).toBe(false)
    expect(schema.safeParse({
      file: { kind: 'not-written', targetPath: WRITTEN_FILE.filePath, reason: 'rejected' },
      disposition: 'rejected',
      gates: MIXED_GATES,
    }).success).toBe(true)
    expect(schema.safeParse({
      file: { kind: 'not-written', targetPath: WRITTEN_FILE.filePath, reason: 'rejected' },
      disposition: 'keep-eligible',
      gates: ALL_TRUE,
    }).success).toBe(false)
  })

  it('reports a write that did not land as not written, with its reason', () => {
    const schema = writtenReceiptSchema()
    for (const reason of ['outside-workspace', 'target-changed', 'write-failed'] as const) {
      expect(schema.safeParse({
        file: { kind: 'not-written', targetPath: WRITTEN_FILE.filePath, reason, detail: 'EACCES' },
        disposition: 'keep-eligible',
        gates: ALL_TRUE,
      }).success).toBe(true)
    }
    expect(schema.safeParse({
      file: { kind: 'not-written', targetPath: WRITTEN_FILE.filePath, reason: 'accepted' },
      disposition: 'keep-eligible',
      gates: ALL_TRUE,
    }).success).toBe(false)
  })

  it('projects the four gate booleans off a receipt, one per gate, without collapsing them', () => {
    const project = (receiptModule as Record<string, unknown>)['draftGateBooleans']
    expect(typeof project).toBe('function')
    const parsed = DraftReceiptSchema.parse(FULL_RECEIPT)
    const failed = {
      ...parsed.gates,
      stableVerdict: { ...parsed.gates.stableVerdict, pass: false },
      falsifiableAssertion: { ...parsed.gates.falsifiableAssertion, pass: false },
    }
    expect((project as (gates: unknown) => unknown)(failed)).toEqual(MIXED_GATES)
  })
})

describe('AuthoringVerifyDraftInputSchema', () => {
  it('refuses an empty call — draftPath is required', () => {
    expect(() => AuthoringVerifyDraftInputSchema.parse({})).toThrow()
  })

  it('refuses an empty draftPath', () => {
    expect(() => AuthoringVerifyDraftInputSchema.parse({ draftPath: '' })).toThrow()
  })

  it('accepts a draft path with the draft-mode marker', () => {
    expect(
      AuthoringVerifyDraftInputSchema.parse({ draftPath: 'x.yaml', draftMode: true }),
    ).toEqual({ draftPath: 'x.yaml', draftMode: true })
  })

  it('accepts only the literal true marker, matching the handoff carrier idiom', () => {
    expect(() =>
      AuthoringVerifyDraftInputSchema.parse({ draftPath: 'x.yaml', draftMode: false }),
    ).toThrow()
  })

  it('refuses an unknown key (.strict())', () => {
    expect(() =>
      AuthoringVerifyDraftInputSchema.parse({ draftPath: 'x.yaml', stabilityRuns: 1 }),
    ).toThrow()
  })
})

describe('a draft-mode keep-gate that said no rejects the draft', () => {
  it('rejects a draft-mode evaluation whose gate 1, 3 or 4 is false', () => {
    for (const gate of ['executesDefinitive', 'addsValue', 'falsifiableAssertion'] as const) {
      for (const completed of [0, 1]) {
        expect(computeDraftDisposition(input({
          gates: { ...ALL_TRUE, [gate]: false },
          stabilityRunsRequested: 1,
          stabilityRunsCompleted: completed,
        })), `${gate} completed=${completed}`).toBe('rejected')
      }
    }
  })

  it('leaves a draft-mode evaluation unverified when only stability could not be decided', () => {
    expect(computeDraftDisposition(input({
      stabilityRunsRequested: 1,
      stabilityRunsCompleted: 1,
    }))).toBe('unverified')
    expect(computeDraftDisposition(input({
      gates: { ...ALL_TRUE, stableVerdict: false },
      stabilityRunsRequested: 1,
      stabilityRunsCompleted: 1,
    }))).toBe('unverified')
  })

  it('the written-test receipt refuses an unverified draft whose single-run gates said no', () => {
    const schema = writtenReceiptSchema()
    for (const gate of ['executesDefinitive', 'addsValue', 'falsifiableAssertion'] as const) {
      expect(schema.safeParse({
        file: WRITTEN_FILE,
        disposition: 'unverified',
        gates: { ...ALL_TRUE, [gate]: false },
      }).success, gate).toBe(false)
    }
    expect(schema.safeParse({
      file: WRITTEN_FILE,
      disposition: 'unverified',
      gates: { ...ALL_TRUE, stableVerdict: false },
    }).success).toBe(true)
  })
})
