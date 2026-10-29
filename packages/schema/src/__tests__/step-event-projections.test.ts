import { expect, test } from 'vitest'
import { projectStepFinalized, projectSubActionRecorded } from '../index'
import type {
  AriaEvidenceEntry, StepEvidence, StepEvidenceEntries, SubActionEvidence, VariableSnapshot,
} from '../index'

const mask = (value: string) => value.replaceAll('SYNTHETIC', '[masked]')
const step: StepEvidence = {
  stepIndex: 0, stepText: 'submit', cacheStatus: 'miss', subActions: [],
  servedBrief: {
    scope: { tier: 'test', key: 'sample' }, asOfBuild: 1, budget: 100, truncation: 'none',
    channel1: [], channel2: [], channel3: [], briefDigest: 'digest',
  },
  verifierVerdict: { pass: true, reasoning: 'done' },
}
const subAction: SubActionEvidence = {
  plan: 'go back', plannedAction: { type: 'pressBack' }, result: { success: true },
  stateBefore: {
    platform: 'web', tree: 'SYNTHETIC tree', elements: [], refMap: {}, timestamp: 1,
    metadata: {
      captureMode: 'textOnly', coordSpace: 'viewport', viewportWidth: 100, viewportHeight: 100,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 100, contentHeight: 100 },
    },
  },
}
const ids = { testIndex: 0, stepIndex: 0, subActionIndex: 0 }
const sha = 'a'.repeat(64)
const aria: AriaEvidenceEntry = {
  kind: 'aria', state: 'present', ref: { id: `aria-state:${sha}`, sha },
}
const evidence: StepEvidenceEntries = {
  console: { kind: 'console', state: 'present', ref: { id: `console-evidence:${sha}`, sha },
    counts: { total: 1, errors: 1, warnings: 0 } },
  network: { kind: 'network', state: 'absent', reason: 'empty' },
  a11y: { kind: 'a11y', state: 'absent', reason: 'not-captured' },
  variables: { kind: 'variables', state: 'present', counts: { count: 1 } },
}
const stepExtra = {
  status: 'passed' as const, tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  evidence, variableSnapshot: { SYNTHETIC_name: { value: 'SYNTHETIC value', source: 'env' as const } },
}
const projectWithAria: (
  input: SubActionEvidence, coords: typeof ids, masker: typeof mask,
  extra?: { ariaEvidence?: AriaEvidenceEntry },
) => ReturnType<typeof projectSubActionRecorded> = projectSubActionRecorded

test('BUS-EVIDENCE-OPTIONAL retains old bytes and omits undefined additions', () => {
  const expected = {
    testIndex: 0, stepIndex: 0, cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'done' }, selfHealOccurred: false, briefDigest: 'digest',
  }
  expect(JSON.stringify(projectStepFinalized(step, ids, mask))).toBe(JSON.stringify(expected))
  const absentExtras = { status: undefined, evidence: undefined, variableSnapshot: undefined }
  expect(projectStepFinalized(step, ids, mask, absentExtras)).toEqual(expected)
  expect(projectWithAria(subAction, ids, mask, { ariaEvidence: undefined }))
    .toEqual(projectSubActionRecorded(subAction, ids, mask))
  expect(projectStepFinalized(step, ids, mask, stepExtra)).toHaveProperty('evidence', evidence)
})

test('BUS-MASK-KEYS masks snapshot names and values without mutating input', () => {
  const input = structuredClone(stepExtra)
  const payload = projectStepFinalized(step, ids, mask, input)
  expect(payload).toHaveProperty('variableSnapshot', {
    '[masked]_name': { value: '[masked] value', source: 'env' },
  })
  expect(JSON.stringify(payload)).not.toContain('SYNTHETIC')
  expect(payload.tokenUsage).toEqual(stepExtra.tokenUsage)
  expect(input).toEqual(stepExtra)
  expect(payload).not.toHaveProperty('records')
  expect(payload).not.toHaveProperty('requestHeaders')
})

test('BUS-MASK-KEYS preserves arbitrary own names including prototype names', () => {
  const variableSnapshot: VariableSnapshot = JSON.parse(
    '{"__proto__":{"value":"SYNTHETIC","source":"capture"}}',
  )
  const extra = { ...stepExtra, variableSnapshot }
  const payload = projectStepFinalized(step, ids, mask, extra)
  expect(payload).toHaveProperty('variableSnapshot', JSON.parse(
    '{"__proto__":{"value":"[masked]","source":"capture"}}',
  ))
})

test('BUS-REFS-APPEND preserves screenshot and prior refs beside ARIA', () => {
  const prior = { id: 'existing-artifact', sha: 'b'.repeat(64) }
  const screenshot = { id: `decision-screenshot:${sha}`, sha }
  const input = { ...subAction, artifactRefs: [prior], decisionScreenshotRef: screenshot }
  const payload = projectWithAria(input, ids, mask, { ariaEvidence: aria })
  expect(payload.artifactRefs).toEqual([prior, screenshot, aria.ref])
  expect(payload).toHaveProperty('ariaEvidence', aria)
  expect(payload).not.toHaveProperty('stateBefore')
  expect(payload).not.toHaveProperty('tree')
  expect(input.artifactRefs).toEqual([prior])
  const absent: AriaEvidenceEntry = { kind: 'aria', state: 'absent', reason: 'failed' }
  const absentPayload = projectWithAria(subAction, ids, mask, { ariaEvidence: absent })
  expect(absentPayload).toHaveProperty('ariaEvidence', absent)
  expect(absentPayload).not.toHaveProperty('artifactRefs')
})
