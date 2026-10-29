// Three output invariants the doc comments stated and nothing enforced (432 review IN-21, quick
// 261003-cpv). Each schema below is parsed by its producer only (the op's output validation, the
// daemon answer the host re-parses, the MCP projection), and none is read back from a stored
// record, so each invariant is a refinement rather than softened wording. What reds each cell: the
// schema without its refinement admits the incoherent value.

import { describe, expect, it } from 'vitest'

import * as schema from '../index'
import { CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION, FORGET_RECEIPT_SCHEMA_VERSION } from '../index'

const OPERATION = '0123456789abcdef0123456789abcdef'

const FORGET_RECEIPT = {
  schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION,
  proposalId: `prop_${OPERATION}`,
  tombstonedRecords: [],
  projectionsScrubbed: ['fts'],
  resultingBundleStatus: 'forgotten',
  forgottenAt: 1,
}

function draftReceipt(disposition: 'keep-eligible' | 'rejected') {
  const pass = disposition === 'keep-eligible'
  return schema.DraftReceiptSchema.parse({
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: 'tests/.agent-qa-drafts/d1.yaml',
      testId: 't_d1',
      testName: 'draft d1',
      contentDigest: 'd1',
    },
    gates: {
      executesDefinitive: { pass: true, runRefs: ['run-1'], indefinitiveRunRefs: [] },
      stableVerdict: { pass: true, runRefs: ['run-1'], distinctOutcomes: ['passed'], earlyStopped: false },
      addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
      falsifiableAssertion: { pass, assertionStepCount: 1, falsifiableAssertionCount: pass ? 1 : 0 },
    },
    stepTable: [],
    gateRuns: [{ runId: 'run-1', memberOutcome: 'passed', definitive: true, healed: false }],
    addsValueFinding: { novelElements: ['el:button:Save'], comparedTests: [] },
    stabilityRunsRequested: 3,
    stabilityRunsCompleted: 3,
    disposition,
    evaluatedAt: 1_700_000_000_000,
  })
}

const GATES = { executesDefinitive: true, stableVerdict: true, addsValue: true, falsifiableAssertion: true }
const WRITTEN = {
  file: { kind: 'written', filePath: 'tests/d1.yaml', contentDigest: 'd1' },
  disposition: 'keep-eligible',
  gates: GATES,
} as const

function writeOutput(overrides: Record<string, unknown>) {
  const receipt = draftReceipt('keep-eligible')
  return {
    outcome: 'drafted',
    draftRef: receipt.draftRef,
    receipt,
    fanOut: schema.buildFanOutReport({ previewed: schema.NO_RUNS_FAN_OUT_BOUND, runs: [] }),
    written: WRITTEN,
    ...overrides,
  }
}

describe('output schemas tie each optional field to the arm that owns it', () => {
  it('authoring.draft.write: written is present exactly on drafted and repaired', () => {
    const output = schema.AuthoringDraftWriteOutputSchema
    expect(output.safeParse(writeOutput({})).success).toBe(true)
    expect(output.safeParse(writeOutput({ outcome: 'repaired' })).success).toBe(true)
    expect(output.safeParse(writeOutput({ written: undefined })).success, 'drafted without written')
      .toBe(false)
    expect(output.safeParse(writeOutput({ outcome: 'stopped' })).success, 'stopped with written')
      .toBe(false)
  })

  it('authoring.draft.write: written carries the disposition of the receipt beside it', () => {
    const output = schema.AuthoringDraftWriteOutputSchema
    expect(output.safeParse(writeOutput({ receipt: draftReceipt('rejected') })).success).toBe(false)
  })

  it('knowledge change: a forget carries its receipt, and nothing else does', () => {
    const output = schema.KnowledgeChangeOutputSchema
    const applied = { outcome: 'applied', operationId: OPERATION, recordIds: ['rec-1'] }
    expect(output.safeParse({ ...applied, verb: 'forget', forgetReceipt: FORGET_RECEIPT }).success)
      .toBe(true)
    expect(output.safeParse({ ...applied, verb: 'reject' }).success).toBe(true)
    expect(output.safeParse({ ...applied, verb: 'forget' }).success, 'a forget without its receipt')
      .toBe(false)
    expect(output.safeParse({ ...applied, verb: 'accept', forgetReceipt: FORGET_RECEIPT }).success,
      'an accept with a forget receipt').toBe(false)
  })

  it('run digest: a mark change pairs test-edit with a test file and every other fix with knowledge', () => {
    const change = schema.RunDigestMarkChangeSchema
    const testFile = { kind: 'test-file', filePath: 'tests/a.yaml', contentDigest: 'abc' }
    const knowledge = { kind: 'knowledge', changeId: `prop_${OPERATION}`, recordIds: ['rec-1'] }
    expect(change.safeParse({ markId: 'm1', ordinal: 1, fix: 'test-edit', change: testFile }).success)
      .toBe(true)
    expect(change.safeParse({ markId: 'm1', ordinal: 1, fix: 'fact', change: knowledge }).success)
      .toBe(true)
    expect(change.safeParse({ markId: 'm1', ordinal: 1, fix: 'fact', change: testFile }).success)
      .toBe(false)
    expect(change.safeParse({ markId: 'm1', ordinal: 1, fix: 'test-edit', change: knowledge }).success)
      .toBe(false)
  })
})
