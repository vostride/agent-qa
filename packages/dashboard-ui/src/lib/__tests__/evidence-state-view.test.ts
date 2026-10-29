import { expect, test } from 'vitest'
import {
  asRunId,
  EVIDENCE_ABSENCE_REASONS,
  RunsEvidenceResultSchema,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { EvidenceDocument, EvidenceEntry, RunDetailStep, RunsEvidenceResult } from '@vostride/agent-qa-schema'
import type { RunEvidenceRead } from '../api'
import * as view from '../evidence-state-view'
import { EVIDENCE_INCOMPLETE_LABEL } from '../run-detail-view'

test('the evidence states, and each absence reason maps to the state of the same name', () => {
  expect(view.EVIDENCE_STATES).toEqual([
    'empty', 'not-captured', 'unsupported', 'unavailable', 'failed', 'no-selection',
  ])
  expect(Object.keys(view.EVIDENCE_STATE_OF_REASON).sort()).toEqual([...EVIDENCE_ABSENCE_REASONS].sort())
  for (const reason of EVIDENCE_ABSENCE_REASONS) {
    expect(view.EVIDENCE_STATE_OF_REASON[reason]).toBe(reason)
  }
})

test('the evidence tones and the tone of each state', () => {
  expect(view.EVIDENCE_TONES).toEqual(['positive', 'neutral', 'alert'])
  expect(view.EVIDENCE_TONE_OF_STATE).toEqual({
    empty: 'positive', 'not-captured': 'neutral', unsupported: 'neutral',
    unavailable: 'neutral', failed: 'alert', 'no-selection': 'neutral',
  })
})

test('the evidence failures', () => {
  expect(view.EVIDENCE_FAILURES).toEqual(['capture', 'load'])
})

test('the evidence kind labels', () => {
  expect(view.EVIDENCE_KIND_LABELS).toEqual([
    'variables', 'network', 'console', 'aria', 'a11y', 'video', 'frame',
  ])
})

const tabKinds = ['variables', 'network', 'console', 'aria', 'a11y', 'video'] as const

test('every evidence tab has a title and an explanation for every state', () => {
  for (const kind of tabKinds) {
    const copy = view.EVIDENCE_COPY[kind]
    expect(copy).toBeDefined()
    for (const state of view.EVIDENCE_STATES) {
      const pairs = state === 'failed' ? [copy.failed.capture, copy.failed.load] : [copy[state]]
      for (const pair of pairs) {
        expect(pair.title.length).toBeGreaterThan(0)
        expect(pair.explanation.length).toBeGreaterThan(0)
      }
    }
    expect(copy.failed.capture).not.toEqual(copy.failed.load)
  }
  expect(new Set(tabKinds.map(kind => view.EVIDENCE_COPY[kind]['not-captured'].title)).size).toBe(6)
  const frame = view.EVIDENCE_COPY.frame
  for (const pair of [frame['not-captured']['sub-action'], frame['not-captured'].step, frame.unavailable, frame.failed.load]) {
    expect(pair.title.length).toBeGreaterThan(0)
    expect(pair.explanation.length).toBeGreaterThan(0)
  }
  expect(Object.keys(view.EVIDENCE_RETRY_LABELS).sort()).toEqual([...view.EVIDENCE_KIND_LABELS].sort())
  expect(view.EVIDENCE_INCOMPLETE_EXPLANATION).toBe(`${EVIDENCE_INCOMPLETE_LABEL} — this was recorded, but the saved file is no longer on disk.`)
  expect(frame.unavailable.explanation).toBe(view.EVIDENCE_INCOMPLETE_EXPLANATION)
  expect(view.RECORDED_ELSEWHERE_LABEL(3)).toBe('Recorded on step 3')
  expect(view.GO_TO_STEP_LABEL(3)).toBe('Go to step 3')
  expect(view.EVIDENCE_LOADING_LABEL).toBe('Loading records')
})

test('the evidence copy never says a capture was turned off, and only a load failure can be retried', () => {
  for (const kind of tabKinds) {
    const copy = view.EVIDENCE_COPY[kind]
    expect(copy).toBeDefined()
    expect(`${copy['not-captured'].title} ${copy['not-captured'].explanation}`).not.toMatch(/disabled|turned off|switched off|not scheduled/i)
    expect(copy.unavailable.explanation).toContain('not recorded')
    expect(copy.failed.capture.explanation).toContain('nothing to retry')
    expect(copy.failed.load.explanation).not.toContain('nothing to retry')
  }
})

const present = {
  kind: 'a11y', state: 'present',
  ref: { id: `a11y-evidence:${'a'.repeat(64)}`, sha: 'a'.repeat(64) },
  counts: { minor: 0, moderate: 0, serious: 0, critical: 0 },
} satisfies EvidenceEntry
const entries = {
  a11y: present,
  console: { kind: 'console', state: 'present', ref: { id: `console-evidence:${'a'.repeat(64)}`, sha: 'a'.repeat(64) }, counts: { total: 0, errors: 0, warnings: 0 } },
  network: { kind: 'network', state: 'present', ref: { id: `network-evidence:${'a'.repeat(64)}`, sha: 'a'.repeat(64) }, counts: { total: 0, failed: 0, errored: 0 } },
  aria: { kind: 'aria', state: 'present', ref: { id: `aria-state:${'a'.repeat(64)}`, sha: 'a'.repeat(64) } },
  variables: { kind: 'variables', state: 'present', counts: { count: 0 } },
} satisfies Record<EvidenceDocument['kind'], EvidenceEntry>
const address = { runId: asRunId('fixture-run'), testIndex: 0, stepIndex: 2, kind: 'a11y' as const }
const input = { kind: 'a11y' as const, selection: 'step' as const, entry: present, read: 'idle' as const }
function ready(document: EvidenceDocument): RunEvidenceRead {
  return { kind: 'read', result: RunsEvidenceResultSchema.parse({ address: { ...address, kind: document.kind }, outcome: 'ready', evidence: entries[document.kind], document }) }
}
function step(stepIndex: number, captured = false, testIndex = 0): RunDetailStep {
  return {
    testIndex, stepIndex, cacheStatus: 'miss', verifierVerdict: { pass: true, reasoning: 'ok' },
    selfHealOccurred: false, briefDigest: 'fixture',
    evidence: {
      a11y: captured ? present : { kind: 'a11y', state: 'absent', reason: 'not-captured' },
      console: { kind: 'console', state: 'absent', reason: 'not-captured' },
      network: { kind: 'network', state: 'absent', reason: 'not-captured' },
      variables: { kind: 'variables', state: 'absent', reason: 'not-captured' },
    },
  }
}

test('VIEW-EMPTY-INPUTS', () => {
  expect(view.resolveEvidenceView).toBeTypeOf('function')
  for (const selection of ['none', 'hook', 'execution-log'] as const) {
    expect(view.resolveEvidenceView({ ...input, selection })).toMatchObject({ kind: 'state', state: 'no-selection', ...view.EVIDENCE_COPY.a11y['no-selection'] })
  }
  for (const document of [
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'a11y', records: [] },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [] },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [] },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records: {} },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: '' },
  ] satisfies EvidenceDocument[]) {
    expect(view.resolveEvidenceView({ ...input, kind: document.kind, entry: entries[document.kind], selection: 'sub-action', read: ready(document) })).toMatchObject({ kind: 'state', state: 'empty', ...view.EVIDENCE_COPY[document.kind].empty })
  }
  expect(view.resolveEvidenceView({ ...input, kind: 'aria' })).toMatchObject({ kind: 'state', state: 'no-selection' })
  expect(view.resolveEvidenceView({ ...input, entry: undefined })).toMatchObject({ kind: 'state', state: 'unavailable' })
  for (const read of ['idle', 'loading'] as const) {
    expect(view.resolveEvidenceView({ ...input, read })).toEqual({ kind: 'loading' })
  }
  const document = { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: 'button "Continue"' } as const
  expect(view.resolveEvidenceView({ ...input, kind: 'aria', entry: entries.aria, selection: 'sub-action', read: ready(document) })).toEqual({ kind: 'records', document })
})

test('VIEW-LOAD-FAILURE-NEVER-EMPTY', () => {
  expect(view.resolveEvidenceView).toBeTypeOf('function')
  const codes = ['address-not-found', 'ambiguous-address', 'invalid-entry', 'ref-not-owned', 'sha-mismatch', 'invalid-document', 'storage-read-failed', 'snapshot-missing', 'masking-unavailable'] as const
  const reads: RunEvidenceRead[] = [
    { kind: 'failed', error: 'private diagnostic' },
    ...codes.map(code => ({ kind: 'read' as const, result: { address, outcome: 'read-error' as const, code } })),
    ready({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [] }),
  ]
  for (const read of reads) {
    const result = view.resolveEvidenceView({ ...input, read })
    expect(result).toMatchObject({ kind: 'state', state: 'failed', failure: 'load', ...view.EVIDENCE_COPY.a11y.failed.load, action: { type: 'retry', label: view.EVIDENCE_RETRY_LABELS.a11y } })
    expect(JSON.stringify(result)).not.toContain('private diagnostic')
  }
  const failed: EvidenceEntry = { kind: 'a11y', state: 'absent', reason: 'failed' }
  for (const result of [
    view.resolveEvidenceView({ ...input, entry: failed }),
    view.resolveEvidenceView({ ...input, read: { kind: 'read', result: { address, outcome: 'absent', evidence: failed } } }),
  ]) {
    expect(result).toMatchObject({ kind: 'state', state: 'failed', failure: 'capture', ...view.EVIDENCE_COPY.a11y.failed.capture })
    expect(result).not.toHaveProperty('action')
  }
})

test('VIEW-ABSENCE-REASONS preserves every recorded reason and bytes-gone explanation', () => {
  expect(view.resolveEvidenceView).toBeTypeOf('function')
  for (const reason of EVIDENCE_ABSENCE_REASONS) {
    expect(view.resolveEvidenceView({ ...input, entry: { kind: 'a11y', state: 'absent', reason } })).toMatchObject({ kind: 'state', state: reason })
  }
  const evidence: Extract<RunsEvidenceResult, { outcome: 'absent' }>['evidence'] = { kind: 'a11y', state: 'absent', reason: 'unavailable', evidenceIncomplete: true }
  for (const result of [
    view.resolveEvidenceView({ ...input, entry: evidence }),
    view.resolveEvidenceView({ ...input, read: { kind: 'read', result: { address, outcome: 'absent', evidence } } }),
    view.resolveEvidenceView({ ...input, kind: 'video', entry: { state: 'absent', reason: 'unavailable', evidenceIncomplete: true } }),
  ]) {
    expect(result).toMatchObject({ kind: 'state', state: 'unavailable', incomplete: true, explanation: view.EVIDENCE_INCOMPLETE_EXPLANATION })
    expect(result).not.toHaveProperty('action')
  }
})

test('RECORDED-ELSEWHERE-NEAREST', () => {
  expect(view.recordedElsewhere).toBeTypeOf('function')
  const steps = [step(8, true), step(2), step(0, true), step(3, true), step(1)]
  expect(view.recordedElsewhere(steps, 2, 'a11y')).toBe(steps[3])
  expect(view.recordedElsewhere(steps, 2, 'network')).toBeUndefined()
  expect(view.recordedElsewhere([], 2, 'a11y')).toBeUndefined()
  expect(view.recordedElsewhere([step(2, true)], 2, 'a11y')).toBeUndefined()
  const elsewhere = { steps, currentStepIndex: 2 }
  const result = view.resolveEvidenceView({ ...input, entry: steps[1]?.evidence?.a11y, elsewhere })
  expect(result).toMatchObject({ kind: 'state', state: 'not-captured', action: { type: 'step', stepIndex: 3, label: view.GO_TO_STEP_LABEL(4), description: view.RECORDED_ELSEWHERE_LABEL(4) } })
  for (const reason of ['empty', 'unsupported', 'unavailable', 'failed'] as const) {
    expect(view.resolveEvidenceView({ ...input, entry: { kind: 'a11y', state: 'absent', reason }, elsewhere })).not.toHaveProperty('action')
  }
})

test('RECORDED-ELSEWHERE-TIE-LATER', () => {
  expect(view.recordedElsewhere).toBeTypeOf('function')
  const before = step(1, true)
  const after = step(3, true)
  expect(view.recordedElsewhere([before, step(2), after], 2, 'a11y')).toBe(after)
  expect(view.recordedElsewhere([after, step(2), before], 2, 'a11y')).toBe(after)
})
