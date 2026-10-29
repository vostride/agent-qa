// What a blocked config change answers.
//
import { describe, expect, it } from 'vitest'

import * as construct from '../construct.js'

// RE-SPELLED 2026-10-01. The three `applyablePayload` cells measured the one
// funnel every config apply passed through: a blocked record refused by name, the refusal quoting
// nothing of the record, an applyable payload passed through unchanged. The apply ops, the stored
// payloads and the funnel are deleted with the inbox; a blocked change is answered in its own call
// and kept nowhere (C432-CONFIG-BLOCKED-NO-WRITE below). The claim that survives is the absence.
describe('applyablePayload — the funnel every config apply passes through', () => {
  it('is deleted with the apply ops, and no blocked-record refusal type remains', () => {
    expect('applyablePayload' in construct).toBe(false)
    expect('BlockedConfigProposalError' in construct).toBe(false)
  })
})

// ---- 432-11 D-05: the direct answer is its own contract ---------------------------------------
//
// C432-CONFIG-BLOCKED-NO-WRITE  the blocked arm of the direct answer carries the report and no
//                               record reference; a stored proposal payload is not a direct answer.
// C432-CONFIG-APPLIED-OUTPUT    the applied arm requires the files and fields that were written.

describe('the direct answer names no record', () => {
  it('a blocked answer parses without a proposal id and refuses one', async () => {
    const schema = await import('@vostride/agent-qa-schema') as Record<string, unknown>
    const contract = schema.ConfigChangeOutputSchema as
      | { safeParse(value: unknown): { success: boolean } }
      | undefined
    expect(contract, 'the direct config answer is exported beside the proposal one').toBeDefined()
    if (contract === undefined) return

    const report = {
      outcome: 'blocked',
      summaryLine: 'set use.parallel — blocked: the resulting configuration is not valid',
      blockedReason: 'schema-fail',
      paths: ['agent-qa.config.yaml'],
      validationIssues: ['agent-qa.config.yaml: use.parallel: expected boolean, received string'],
    }
    expect(contract.safeParse(report).success).toBe(true)
    expect(contract.safeParse({ ...report, proposalId: 'prop-1' }).success).toBe(false)
    // A pre-432 stored payload of either arm is not an answer an operation can give.
    const { outcome: _outcome, ...stored } = report
    void _outcome
    expect(contract.safeParse({ ...stored, schemaVersion: 1, payloadKind: 'blocked', action: 'config.field.set' }).success)
      .toBe(false)
    expect(contract.safeParse({ schemaVersion: 1, payloadKind: 'applyable', action: 'config.field.set',
      summaryLine: 'set use.parallel to true', files: [], shownDiffBase64: 'eA==', shownDiffDigest: 'def',
      crossBoundary: false, crossBoundaryReasons: [] }).success).toBe(false)
  })
})

describe('the applied answer names what was written', () => {
  it('files and fields are required and non-empty', async () => {
    const schema = await import('@vostride/agent-qa-schema') as Record<string, unknown>
    const contract = schema.ConfigChangeOutputSchema as
      | { safeParse(value: unknown): { success: boolean } }
      | undefined
    expect(contract, 'the direct config answer is exported beside the proposal one').toBeDefined()
    if (contract === undefined) return

    const applied = {
      outcome: 'applied',
      summaryLine: 'set use.parallel to true',
      files: ['agent-qa.config.yaml'],
      fields: ['use.parallel'],
      crossBoundary: false,
      crossBoundaryReasons: [],
      shownDiff: '--- a/agent-qa.config.yaml\n+++ b/agent-qa.config.yaml\n@@ -1 +1 @@\n-  parallel: false\n+  parallel: true\n',
    }
    expect(contract.safeParse(applied).success).toBe(true)
    expect(contract.safeParse({ ...applied, files: [] }).success).toBe(false)
    expect(contract.safeParse({ ...applied, fields: [] }).success).toBe(false)
    const { files: _files, ...withoutFiles } = applied
    expect(contract.safeParse(withoutFiles).success).toBe(false)
    expect(contract.safeParse({ ...applied, outcome: 'proposed', proposalId: 'prop-1' }).success).toBe(false)
  })
})
