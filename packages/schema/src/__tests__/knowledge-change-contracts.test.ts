// The direct knowledge change contracts: what a change answers, its strict inputs, path-safe change
// ids, the forget and commit receipts, their JSON Schema projections and the strict config change
// file.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import * as schema from '../index'
import { COMMIT_RECEIPT_SCHEMA_VERSION, FORGET_RECEIPT_SCHEMA_VERSION } from '../index'

const record = { grain: 'record' as const, recordId: 'rec-1' }
const OPERATION = '8e7d6c5b-4a39-4281-9706-f5e4d3c2b1a0'

describe('C432-DIRECT-CONTRACTS: the direct change contracts live in knowledge/change.ts', () => {
  it('C432-DIRECT-CONTRACTS: a change answers applied, target-not-found or refused, and nothing else', () => {
    const output = schema.KnowledgeChangeOutputSchema
    // RE-SPELLED 2026-10-03 (quick 261003-cpv, IN-21): a forget now carries its receipt by rule, so
    // the bare applied answer is a reject's.
    expect(output.safeParse({ outcome: 'applied', verb: 'reject', operationId: OPERATION, recordIds: ['rec-1'] }).success)
      .toBe(true)
    expect(output.safeParse({ outcome: 'target-not-found', verb: 'accept', operationId: OPERATION, target: record }).success)
      .toBe(true)
    expect(output.safeParse({ outcome: 'refused', verb: 'accept', operationId: OPERATION,
      reason: 'policy-materialize-refused' }).success).toBe(true)
    expect(output.safeParse({ outcome: 'proposed', verb: 'accept', operationId: OPERATION }).success).toBe(false)
    expect(output.safeParse({ outcome: 'already-applied', verb: 'accept', operationId: OPERATION, recordIds: [] }).success)
      .toBe(false)
  })

  it('C432-DIRECT-CONTRACTS: the change inputs take the verb input plus an optional operation identity, strictly', () => {
    expect(schema.KnowledgeForgetChangeInputSchema.safeParse({ target: record }).success).toBe(true)
    expect(schema.KnowledgeForgetChangeInputSchema.safeParse({ target: record, operationId: OPERATION }).success).toBe(true)
    expect(schema.KnowledgeRejectChangeInputSchema.safeParse({ target: record }).success, 'a reject needs its reason')
      .toBe(false)
    expect(schema.KnowledgeAcceptChangeInputSchema.safeParse({ target: record, proposalId: 'prop_aaaaaaaa-bbbb' }).success)
      .toBe(false)
    expect(schema.KnowledgeChangeOperationIdSchema.safeParse('../escape').success).toBe(false)
  })

  it('refuses a proposal id that could address a path', () => {
    // Carried from proposal-envelope.test.ts: the change id keeps the receipt id shape, and the
    // shape still refuses separators, whitespace and an empty body.
    const ids = schema.KnowledgeChangeIdSchema
    expect(ids, 'the change id schema is exported as KnowledgeChangeIdSchema').toBeDefined()
    expect(ids.safeParse(`prop_${OPERATION}`).success).toBe(true)
    for (const bad of ['prop_../../x', 'prop_a/b', 'prop_ a', 'prop_', 'nope_0123456789']) {
      expect(ids.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('C432-DIRECT-CONTRACTS: the forget receipt and the commit receipt are the change receipts', () => {
    const forget = {
      schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION, proposalId: `prop_${OPERATION}`, tombstonedRecords: [], projectionsScrubbed: ['fts'],
      resultingBundleStatus: 'forgotten', forgottenAt: 1,
    }
    expect(schema.ForgetReceiptV1Schema.safeParse(forget).success).toBe(true)
    expect(schema.KnowledgeChangeOutputSchema.safeParse({
      outcome: 'applied', verb: 'forget', operationId: OPERATION, recordIds: ['rec-1'], forgetReceipt: forget,
    }).success).toBe(true)
    expect(schema.CommitReceiptSchema.safeParse({
      schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION, proposalId: `prop_${OPERATION}`, committedAtOrdinal: 3, recordIds: ['rec-1'],
      gate3: [], promoted: [], held: [],
    }).success).toBe(true)
  })

  it('projects every envelope schema without throwing', () => {
    // Carried from proposal-envelope.test.ts under its name: the envelope is gone, and every direct
    // contract that replaced it projects for the catalogue the same way.
    const schemas: Record<string, z.ZodType> = {
      KnowledgeChangeOutputSchema: schema.KnowledgeChangeOutputSchema,
      KnowledgeAcceptChangeInputSchema: schema.KnowledgeAcceptChangeInputSchema,
      KnowledgeRejectChangeInputSchema: schema.KnowledgeRejectChangeInputSchema,
      KnowledgeForgetChangeInputSchema: schema.KnowledgeForgetChangeInputSchema,
      ForgetReceiptV1Schema: schema.ForgetReceiptV1Schema,
      CommitReceiptSchema: schema.CommitReceiptSchema,
      AuthoringDraftEditOutputSchema: schema.AuthoringDraftEditOutputSchema,
    }
    for (const [name, contract] of Object.entries(schemas)) {
      expect(() => z.toJSONSchema(contract, { io: 'input' }), name).not.toThrow()
    }
  })

  it('C432-DIRECT-CONTRACTS: a config change file is the direct writer\'s and refuses unknown keys', () => {
    const file = { path: 'agent-qa.config.yaml', changeKind: 'modify', baseDigest: 'a'.repeat(64), newContentBase64: 'eDox' }
    expect(schema.ConfigChangeFileSchema.safeParse(file).success).toBe(true)
    expect([...schema.CONFIG_FILE_CHANGE_KINDS]).toEqual(['add', 'modify', 'delete'])
    expect(schema.ConfigChangeFileSchema.safeParse({ ...file, proposalId: 'prop_aaaaaaaa-bbbb' }).success).toBe(false)
  })
})
