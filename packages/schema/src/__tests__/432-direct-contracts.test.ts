// 432-17 (D-02 / D-05 / D-06 / D-09 / D-22): the direct change contracts, and the envelope that is
// gone.
//
// C432-DIRECT-CONTRACTS. 432-12 introduced the direct knowledge request and result contracts beside
// the proposal they replaced (`knowledge/proposal.ts`, `knowledge/review-verbs.ts`), because the
// envelope still had readers. With the inbox deleted they live in one neutral module,
// `knowledge/change.ts`, and the root barrel re-exports them by identity. The cells pin the module's
// exact runtime key set beside the behaviour each contract owes: a change answers what it changed, a
// typed absence or a typed refusal, and never a proposal.
//
// C432-NO-ENVELOPE-EXPORTS. The kind-discriminated envelope, its inbox DTOs and verbs, the knowledge
// and config proposal payloads, the apply contracts and the test-draft arm are deleted. A returning
// runtime member reds the exported-key cell by name, and a returning type reds `pnpm typecheck` at
// the matching `@ts-expect-error` below. Old proposal files on disk are never parsed (D-22), so no
// reader schema survives for them either.
//
// CARRIED CLAIMS (2026-10-01). `proposal-envelope.test.ts` and knowledge-local's
// `authoring-proposals-store.test.ts` are deleted with their subject. What either asserted that is
// still true is carried here under its name: the change id that could address a path is refused,
// every surviving contract projects to JSON Schema, an applied change receipt carries no proposal
// field and no envelope parses as one.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import * as schema from '../index'
import { COMMIT_RECEIPT_SCHEMA_VERSION, FORGET_RECEIPT_SCHEMA_VERSION } from '../index'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Loaded through a computed specifier, so a missing module is this cell's red, not a load error. */
async function loadChangeModule(): Promise<Record<string, unknown> | undefined> {
  const specifier = ['..', 'knowledge', 'change'].join('/')
  try {
    return await import(/* @vite-ignore */ specifier) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Every runtime member `knowledge/change.ts` owns. Exact, so neither a gain nor a loss is silent. */
const CHANGE_RUNTIME_KEYS = [
  'COMMIT_RECEIPT_SCHEMA_VERSION',
  'CommitReceiptSchema',
  'DeltaSchema',
  'FORGET_RECEIPT_SCHEMA_VERSION',
  'ForgetReceiptV1Schema',
  'ForgetTargetRefSchema',
  'KNOWLEDGE_CHANGE_REFUSAL_REASONS',
  'KNOWLEDGE_CHANGE_VERBS',
  'KNOWLEDGE_PROJECTIONS',
  'KNOWLEDGE_REVIEW_VERBS',
  'KnowledgeAcceptChangeInputSchema',
  'KnowledgeAcceptInputSchema',
  'KnowledgeChangeIdSchema',
  'KnowledgeChangeOperationIdSchema',
  'KnowledgeChangeOutputSchema',
  'KnowledgeForgetChangeInputSchema',
  'KnowledgeForgetInputSchema',
  'KnowledgeRejectChangeInputSchema',
  'KnowledgeRejectInputSchema',
  'KnowledgeTargetRefSchema',
  'MarkChangeStampSchema',
  'TombstonedRecordSchema',
] as const

/** The deleted runtime members, each named so a returning one reds by name. */
const RETIRED_RUNTIME_EXPORTS = [
  // the envelope and its lifecycle (schema/src/proposal/envelope.ts)
  'CURRENT_PROPOSAL_RECORD_SCHEMA_VERSION',
  'PROPOSAL_DECISIONS',
  'PROPOSAL_DURABLE_STATES',
  'PROPOSAL_ENVELOPE_STATUSES',
  'PROPOSAL_EVIDENCE_GRAINS',
  'PROPOSAL_EXPIRY_MS',
  'PROPOSAL_KINDS',
  'ProposalDecisionRecordSchema',
  'ProposalEvidenceRefSchema',
  'ProposalOriginSchema',
  'ProposalRecordSchema',
  'computeProposalEnvelopeStatus',
  'isProposalKind',
  // the inbox verbs and their wire DTOs (schema/src/proposal/inbox-ops.ts)
  'ProposalEnvelopeSchema',
  'ProposalInboxEntrySchema',
  'ProposalsAcceptAppliedSchema',
  'ProposalsAcceptGrantOutcomeSchema',
  'ProposalsAcceptInputSchema',
  'ProposalsAcceptOutcomeSchema',
  'ProposalsAcceptOutputSchema',
  'ProposalsListInputSchema',
  'ProposalsListOutputSchema',
  'ProposalsRejectInputSchema',
  'ProposalsRejectOutputSchema',
  'ProposalsShowInputSchema',
  'ProposalsShowOutputSchema',
  // the knowledge proposal payload and its apply contracts
  'ForgetPreviewSchema',
  'KNOWLEDGE_APPLY_OUTCOMES',
  'KNOWLEDGE_PROPOSAL_STATUSES',
  'KnowledgeApplyOutcomeSchema',
  'KnowledgeProposalApplyInputSchema',
  'KnowledgeProposalV1Schema',
  'MarkProposalStampSchema',
  'ProposalIdSchema',
  // the config proposal payloads, the propose union and the apply/undo inputs
  'CONFIG_REFUSAL_REASONS',
  'CURRENT_CONFIG_PROPOSAL_SCHEMA_VERSION',
  'ConfigApplyCommitSchema',
  'ConfigApplyOutcomeSchema',
  'ConfigApplyReceiptsSchema',
  'ConfigProposalApplyInputSchema',
  'ConfigProposalApplyableV1Schema',
  'ConfigProposalBlockedV1Schema',
  'ConfigProposalFileSchema',
  'ConfigProposalV1Schema',
  'ConfigProposeOutputSchema',
  'ConfigUndoProposeInputSchema',
  // the test-draft arm
  'CURRENT_AUTHORING_PROPOSAL_SCHEMA_VERSION',
  'TestDraftProposalV1Schema',
] as const

/** The deleted envelope modules. */
const RETIRED_MODULES = [
  'proposal/envelope.ts',
  'proposal/inbox-ops.ts',
  'proposal/index.ts',
  'knowledge/proposal.ts',
  'config-mutation/proposal.ts',
] as const

// C432-NO-ENVELOPE-EXPORTS, type level: each line fails `pnpm typecheck` the moment the type returns.
// @ts-expect-error the proposal envelope is deleted
export type RetiredProposalEnvelope = import('../index').ProposalEnvelope
// @ts-expect-error the durable proposal record is deleted
export type RetiredProposalRecord = import('../index').ProposalRecord
// @ts-expect-error the proposal origin is deleted
export type RetiredProposalOrigin = import('../index').ProposalOrigin
// @ts-expect-error the inbox port is deleted
export type RetiredProposalsInboxPort = import('../index').ProposalsInboxPort
// @ts-expect-error the inbox entry DTO is deleted
export type RetiredProposalInboxEntryDto = import('../index').ProposalInboxEntryDto
// @ts-expect-error the accept output is deleted
export type RetiredProposalsAcceptOutput = import('../index').ProposalsAcceptOutput
// @ts-expect-error the knowledge proposal payload is deleted
export type RetiredKnowledgeProposalV1 = import('../index').KnowledgeProposalV1
// @ts-expect-error the knowledge apply outcome is deleted
export type RetiredKnowledgeApplyOutcomeDto = import('../index').KnowledgeApplyOutcomeDto
// @ts-expect-error the config proposal payload is deleted
export type RetiredConfigProposalV1 = import('../index').ConfigProposalV1
// @ts-expect-error the config propose union is deleted
export type RetiredConfigProposeOutput = import('../index').ConfigProposeOutput
// @ts-expect-error the config apply input is deleted
export type RetiredConfigProposalApplyInput = import('../index').ConfigProposalApplyInput
// @ts-expect-error the config undo input is deleted
export type RetiredConfigUndoProposeInput = import('../index').ConfigUndoProposeInput
// @ts-expect-error the test-draft arm is deleted
export type RetiredTestDraftProposalV1 = import('../index').TestDraftProposalV1
// @ts-expect-error the mark stamp is now the change's, under its own name
export type RetiredMarkProposalStamp = import('../index').MarkProposalStamp

const record = { grain: 'record' as const, recordId: 'rec-1' }
const OPERATION = '8e7d6c5b-4a39-4281-9706-f5e4d3c2b1a0'

describe('C432-DIRECT-CONTRACTS: the direct change contracts live in knowledge/change.ts', () => {
  it('C432-DIRECT-CONTRACTS: knowledge/change.ts exports exactly the direct contract set', async () => {
    const change = await loadChangeModule()
    expect(change, 'knowledge/change.ts is missing').toBeDefined()
    expect(Object.keys(change ?? {}).sort()).toEqual([...CHANGE_RUNTIME_KEYS].sort())
  })

  it('C432-DIRECT-CONTRACTS: the root barrel re-exports every direct contract by identity', async () => {
    const change = await loadChangeModule()
    const barrel = schema as unknown as Record<string, unknown>
    const mismatched = CHANGE_RUNTIME_KEYS.filter((name) => change === undefined || barrel[name] !== change[name])
    expect(mismatched, 'a direct contract is missing from the root barrel or is a second copy').toEqual([])
  })

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

  it('C432-KNOWLEDGE-CHANGE-OPS: an applied change receipt carries no proposal fields and no envelope parses as one', () => {
    // Carried from proposal-envelope.test.ts (432-12), re-spelled without the deleted payload schema.
    // RE-SPELLED 2026-10-03 (quick 261003-cpv, IN-21): `reject`, since a forget carries its receipt.
    const receipt = { outcome: 'applied', verb: 'reject', operationId: OPERATION, recordIds: ['rec-1'] }
    const output = schema.KnowledgeChangeOutputSchema
    expect(output.safeParse(receipt).success).toBe(true)
    for (const extra of [{ proposalId: 'prop_aaaaaaaa-bbbb' }, { status: 'pending' }, { deltas: [] }, { proposal: {} }]) {
      expect(output.safeParse({ ...receipt, ...extra }).success, JSON.stringify(extra)).toBe(false)
    }
    const oldEnvelope = {
      schemaVersion: 1, id: 'prop_aaaaaaaa-bbbb', kind: 'knowledge',
      origin: { emittedBy: 'knowledge.accept.propose', runId: 'run-7', at: 1_000_000 },
      payload: { schemaVersion: 1, proposalId: 'prop_aaaaaaaa-bbbb', verb: 'accept', targetRef: record,
        deltas: [], proposedAt: 1_000_000, status: 'pending' },
    }
    expect(output.safeParse(oldEnvelope).success).toBe(false)
    expect(output.safeParse(oldEnvelope.payload).success).toBe(false)
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

  it('C432-DIRECT-CONTRACTS: a config change file is the direct writer\'s, and a pre-432 config payload parses as no change', () => {
    // `ConfigProposalFile` moved into config-mutation/actions.ts as `ConfigChangeFile`; the shape is
    // the direct writer's file set, and nothing that reads old proposal bytes remains.
    const file = { path: 'agent-qa.config.yaml', changeKind: 'modify', baseDigest: 'a'.repeat(64), newContentBase64: 'eDox' }
    expect(schema.ConfigChangeFileSchema.safeParse(file).success).toBe(true)
    expect([...schema.CONFIG_FILE_CHANGE_KINDS]).toEqual(['add', 'modify', 'delete'])
    expect(schema.ConfigChangeFileSchema.safeParse({ ...file, proposalId: 'prop_aaaaaaaa-bbbb' }).success).toBe(false)
    const oldConfigPayload = {
      schemaVersion: 1, action: 'config.field.set', summaryLine: 'set use.timeout.step', baseDigest: 'a'.repeat(64),
      files: [file], fields: ['use.timeout.step'], crossBoundary: false, crossBoundaryReasons: [], shownDiff: '-a\n+b',
    }
    expect(schema.ConfigChangeOutputSchema.safeParse(oldConfigPayload).success).toBe(false)
    expect(schema.ConfigChangeOutputSchema.safeParse({ outcome: 'filed', proposalId: 'prop_aaaaaaaa-bbbb' }).success)
      .toBe(false)
  })

  it('C432-DIRECT-CONTRACTS: an authored test edit answers the file it wrote, with no test-draft arm', () => {
    const keys = Object.keys(schema.AuthoringDraftEditOutputSchema.shape).sort()
    expect(keys).toContain('written')
    expect(keys, 'the edit output still carries the retired test-draft proposal arm').not.toContain('proposal')
  })
})

describe('C432-NO-ENVELOPE-EXPORTS: no envelope, inbox, proposal payload or apply contract is exported', () => {
  it('C432-NO-ENVELOPE-EXPORTS: the root barrel exports none of the retired runtime members', () => {
    const exported = new Set(Object.keys(schema))
    expect(RETIRED_RUNTIME_EXPORTS.filter((name) => exported.has(name))).toEqual([])
  })

  it('C432-NO-ENVELOPE-EXPORTS: the envelope modules are deleted', () => {
    expect(RETIRED_MODULES.filter((path) => existsSync(join(SRC, path)))).toEqual([])
  })

  it('C432-NO-ENVELOPE-EXPORTS: the retired census is not vacuous — it sees a member that IS exported', () => {
    const exported = new Set(Object.keys(schema))
    expect(['KnowledgeChangeOutputSchema', 'ConfigChangeOutputSchema'].filter((name) => exported.has(name)))
      .toEqual(['KnowledgeChangeOutputSchema', 'ConfigChangeOutputSchema'])
  })
})
