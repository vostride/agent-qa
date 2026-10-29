import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  COMMIT_INTENT_SCHEMA_VERSION,
  clearCommitIntent,
  commitIntentSchema,
  JOURNAL_SUBDIR,
  listCommitIntents,
  writeCommitIntent,
  type CommitIntent,
} from '../journal/intent-journal.js'

describe('per-candidate commit intent journal', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-intent-journal-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function intent(
    candidateId: string,
    overrides: Partial<CommitIntent> = {},
  ): CommitIntent {
    return {
      schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
      candidateId,
      bundleId: 'fact-submit-button-0123456789abcdef',
      deltaKind: 'Add',
      epoch: 7,
      ...overrides,
    }
  }

  function intentPath(candidateId: string): string {
    return join(knowledgeRoot, JOURNAL_SUBDIR, `${candidateId}.intent.json`)
  }

  it('durably writes and atomically replaces one strict intent document', () => {
    const candidateId = 'a'.repeat(64)
    const original = intent(candidateId)

    writeCommitIntent(knowledgeRoot, original)

    expect(JSON.parse(readFileSync(intentPath(candidateId), 'utf8'))).toEqual(original)
    expect(listCommitIntents(knowledgeRoot)).toEqual([{ parsed: original }])

    const replacement = intent(candidateId, {
      bundleId: 'fact-checkout-button-fedcba9876543210',
      deltaKind: 'Supersede',
      targetRecordId: 'fact-old-checkout-0011223344556677',
      epoch: 8,
    })
    writeCommitIntent(knowledgeRoot, replacement)

    expect(JSON.parse(readFileSync(intentPath(candidateId), 'utf8'))).toEqual(replacement)
    expect(listCommitIntents(knowledgeRoot)).toEqual([{ parsed: replacement }])
    expect(
      commitIntentSchema.safeParse({ ...replacement, unexpected: true }).success,
    ).toBe(false)
  })

  it('preserves malformed intent presence as a typed recovery signal', () => {
    const parsedId = 'b'.repeat(64)
    const malformedId = 'c'.repeat(64)
    const parsed = intent(parsedId, { deltaKind: 'Confirm', targetRecordId: 'fact-target' })
    writeCommitIntent(knowledgeRoot, parsed)
    const malformedPath = intentPath(malformedId)
    mkdirSync(dirname(malformedPath), { recursive: true })
    writeFileSync(malformedPath, '{torn-json', 'utf8')

    expect(listCommitIntents(knowledgeRoot)).toEqual([
      { parsed },
      { malformed: true, candidateId: malformedId },
    ])
  })

  it('keeps candidates independent and clears exactly one intent idempotently', () => {
    const firstId = 'd'.repeat(64)
    const secondId = 'e'.repeat(64)
    const first = intent(firstId)
    const second = intent(secondId, { deltaKind: 'Noop', bundleId: 'unknown-bundle' })
    writeCommitIntent(knowledgeRoot, first)
    writeCommitIntent(knowledgeRoot, second)

    clearCommitIntent(knowledgeRoot, firstId)
    clearCommitIntent(knowledgeRoot, firstId)

    expect(existsSync(intentPath(firstId))).toBe(false)
    expect(readFileSync(intentPath(secondId), 'utf8')).toContain(second.bundleId)
    expect(listCommitIntents(knowledgeRoot)).toEqual([{ parsed: second }])
  })
})
