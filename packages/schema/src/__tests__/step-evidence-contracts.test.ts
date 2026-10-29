import { describe, expect, test } from 'vitest'
import * as api from '../index'
import { RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '../run/evidence'

const sha = 'a'.repeat(64)
const ref = (prefix: string) => ({ id: `${prefix}${sha}`, sha })

describe('423 evidence contracts', () => {
  test('C423-CONTENT-TYPES-EXACT', () => {
    expect(api.NETWORK_BODY_CONTENT_TYPES).toEqual(['application/json', 'text/html', 'text/plain',
      'application/xml', 'text/xml', 'application/x-www-form-urlencoded'])
    expect(api.NETWORK_BODY_MAX_BYTES).toBe(32768)
  })
  test('C423-KINDS-EXACT', () => {
    expect(api.EVIDENCE_KINDS).toEqual(['console', 'network', 'a11y', 'aria', 'variables'])
    for (const kind of ['console', 'network', 'a11y', 'aria', 'variables']) {
      expect(api.EvidenceKindSchema.safeParse(kind).success).toBe(true)
    }
    expect(api.EvidenceKindSchema.safeParse('video').success).toBe(false)
  })

  test('C423-ABSENCE-EXACT', () => {
    expect(api.EVIDENCE_ABSENCE_REASONS).toEqual([
      'empty', 'not-captured', 'unsupported', 'unavailable', 'failed',
    ])
    for (const reason of ['empty', 'not-captured', 'unsupported', 'unavailable', 'failed']) {
      expect(api.EvidenceEntrySchema.safeParse({ kind: 'console', state: 'absent', reason }).success).toBe(true)
    }
    expect(api.EvidenceAbsenceReasonSchema.safeParse('unknown').success).toBe(false)
  })

  test('C423-REFS-EXACT', () => {
    expect(api.EVIDENCE_REF_PREFIXES).toEqual([
      'decision-screenshot:', 'console-evidence:', 'network-evidence:', 'a11y-evidence:', 'aria-state:',
    ])
    for (const prefix of ['decision-screenshot:', 'console-evidence:', 'network-evidence:', 'a11y-evidence:', 'aria-state:']) {
      expect(api.EvidenceArtifactRefSchema.safeParse(ref(prefix)).success).toBe(true)
    }
    expect(api.EvidenceArtifactRefSchema.safeParse(ref('variables:')).success).toBe(false)
    expect(api.EvidenceArtifactRefSchema.safeParse({ ...ref('console-evidence:'), sha: 'b'.repeat(64) }).success).toBe(false)
    expect(api.EvidenceArtifactRefSchema.safeParse({ id: 'console-evidence:../x', sha: '../x' }).success).toBe(false)
  })

  test('C423-PRESENCE-EXACT rejects absent counts while valid absence parses', () => {
    const absent = { kind: 'console', state: 'absent', reason: 'empty' }
    expect(api.EvidenceEntrySchema.safeParse(absent).success).toBe(true)
    expect(api.EvidenceEntrySchema.safeParse({ ...absent, counts: { total: 0, errors: 0, warnings: 0 } }).success).toBe(false)
    expect(api.EvidenceEntrySchema.safeParse({ ...absent, ref: ref('console-evidence:') }).success).toBe(false)
    expect(api.EvidenceEntrySchema.safeParse({ ...absent, state: 'pending' }).success).toBe(false)
    expect(api.EvidenceEntrySchema.safeParse({ kind: 'console', state: 'present' }).success).toBe(false)
  })

  test('C423-PRESENCE-EXACT accepts five present arms and rejects crossed refs/counts', () => {
    const entries = [
      { kind: 'console', state: 'present', ref: ref('console-evidence:'), counts: { total: 2, errors: 1, warnings: 1 } },
      { kind: 'network', state: 'present', ref: ref('network-evidence:'), counts: { total: 2, failed: 1, errored: 1 } },
      { kind: 'a11y', state: 'present', ref: ref('a11y-evidence:'), counts: { minor: 0, moderate: 0, serious: 1, critical: 0 } },
      { kind: 'aria', state: 'present', ref: ref('aria-state:') },
      { kind: 'variables', state: 'present', counts: { count: 1 } },
    ]
    for (const entry of entries) expect(api.EvidenceEntrySchema.safeParse(entry).success).toBe(true)
    for (const entry of entries.slice(0, 4)) {
      expect(api.EvidenceEntrySchema.safeParse({
        ...entry, ref: ref('decision-screenshot:'),
      }).success).toBe(false)
    }
    expect(api.EvidenceEntrySchema.safeParse({ ...entries[0], ref: ref('network-evidence:') }).success).toBe(false)
    expect(api.EvidenceEntrySchema.safeParse({ ...entries[0], counts: { total: -1, errors: 0, warnings: 0 } }).success).toBe(false)
    expect(api.EvidenceEntrySchema.safeParse({ ...entries[0], reason: 'empty' }).success).toBe(false)
    expect(api.EvidenceEntrySchema.safeParse({ ...entries[4], ref: ref('console-evidence:') }).success).toBe(false)
  })

  test.each([
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [{ level: 'error', text: 'message', timestamp: 1 }] },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [{ url: 'https://example.test', method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {}, startTime: 1, endTime: 2 }] },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'a11y', records: [{ ruleId: 'label', impact: 'serious', description: 'label missing', help: 'add label', helpUrl: 'https://example.test', nodes: [{ html: '<input>', target: ['input'] }] }] },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: 'button "Submit"' },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records: { account: { value: 'sample', source: 'capture' } } },
  ])('C423-DOCUMENTS parses $kind and rejects wrong version/shape', document => {
    expect(api.EvidenceDocumentSchema.parse(document)).toEqual(document)
    expect(api.EvidenceDocumentSchema.safeParse({ ...document, schemaVersion: 3 }).success).toBe(false)
    expect(api.EvidenceDocumentSchema.safeParse({ ...document, kind: 'video' }).success).toBe(false)
    expect(api.EvidenceDocumentSchema.safeParse({ ...document, records: 42 }).success).toBe(false)
  })

  test('C423-VARIABLES preserves all sources and rejects invented source', () => {
    for (const source of ['env', 'inline', 'suite', 'cli', 'capture', 'hook', 'step']) {
      const snapshot = { name: { value: 'value', source } }
      expect(api.VariableSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    }
    expect(api.VariableSnapshotSchema.safeParse({ name: { value: 'value', source: 'model' } }).success).toBe(false)
  })
})
