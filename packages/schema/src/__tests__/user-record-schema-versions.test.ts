import { describe, expect, it } from 'vitest'

import {
  COMMIT_RECEIPT_SCHEMA_VERSION,
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  ChatSessionEventSchemaError,
  CommitReceiptSchema,
  FORGET_RECEIPT_SCHEMA_VERSION,
  ForgetReceiptV1Schema,
  MARK_RECEIPT_SCHEMA_VERSION,
  MarkReceiptSchema,
  guardChatSessionEvent,
} from '../index'

const userMessage = {
  kind: 'user_message',
  turnId: 'turn-1',
  at: '2026-08-21T09:00:00.000Z',
  text: 'list the runs',
}

const markReceipt = {
  schemaVersion: MARK_RECEIPT_SCHEMA_VERSION,
  markId: 'mark_0123456789ab',
  runId: 'run-user-records',
  testIndex: 0,
  runSlug: 'run-user-records',
  kind: 'false-fail',
  origin: 'user',
  ordinal: 1,
  markedAt: 0,
  disposition: { kind: 'quarantined', class: 'flake' },
  evidence: { confirmed: 0, overturned: 0 },
}

const commitReceipt = {
  schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION,
  proposalId: 'prop_alpha-bravo',
  committedAtOrdinal: 3,
  recordIds: ['rec-1'],
  gate3: [],
  promoted: [],
  held: [],
}

const forgetReceipt = {
  schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION,
  proposalId: 'prop_alpha-bravo',
  tombstonedRecords: [],
  projectionsScrubbed: ['fts'],
  resultingBundleStatus: 'forgotten',
  forgottenAt: 0,
}

const receipts = [
  ['mark', MarkReceiptSchema, markReceipt],
  ['commit', CommitReceiptSchema, commitReceipt],
  ['forget', ForgetReceiptV1Schema, forgetReceipt],
] as const

describe('user records stamps', () => {
  it('reads a chat event from a session stamped 2', () => {
    expect(CURRENT_CHAT_SESSION_SCHEMA_VERSION).toBe(2)
    expect(guardChatSessionEvent(userMessage, 2)).toEqual(userMessage)
  })

  it.each([1, 3])('refuses a chat event from a session stamped %i', (stamp) => {
    expect(() => guardChatSessionEvent(userMessage, stamp)).toThrow(ChatSessionEventSchemaError)
  })

  it.each(receipts)('reads a %s receipt stamped 2', (_name, schema, receipt) => {
    expect(receipt.schemaVersion).toBe(2)
    expect(schema.safeParse(receipt).success).toBe(true)
  })

  it.each(receipts.flatMap(([name, schema, receipt]) => [1, 3].map(
    (stamp) => [name, stamp, schema, receipt] as const,
  )))('refuses a %s receipt stamped %i', (_name, stamp, schema, receipt) => {
    expect(schema.safeParse({ ...receipt, schemaVersion: stamp }).success).toBe(false)
  })
})
