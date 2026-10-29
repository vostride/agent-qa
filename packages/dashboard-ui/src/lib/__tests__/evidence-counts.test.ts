import { expect, test } from 'vitest'
import type { StepEvidenceEntries } from '@vostride/agent-qa-schema'
import { EVIDENCE_COPY } from '../evidence-state-view'

const modules = import.meta.glob('../evidence-counts.ts')
async function helper() {
  expect(modules['../evidence-counts.ts'], 'the shared count helper exists').toBeTypeOf('function')
  return await modules['../evidence-counts.ts']!() as typeof import('../evidence-counts')
}

function entries(): StepEvidenceEntries {
  return {
    console: { kind: 'console', state: 'absent', reason: 'not-captured' },
    network: { kind: 'network', state: 'absent', reason: 'not-captured' },
    a11y: { kind: 'a11y', state: 'absent', reason: 'not-captured' },
    variables: { kind: 'variables', state: 'present', counts: { count: 6 } },
  }
}

const ref = { id: `console-evidence:${'a'.repeat(64)}` as const, sha: 'a'.repeat(64) }

test('the step signals, in order', async () => {
  expect((await helper()).STEP_SIGNALS).toEqual(['console', 'network', 'a11y'])
})

test('the evidence scopes and their scope lines', async () => {
  const scopes = import.meta.glob('../../components/run-detail/evidence-scope-line.tsx')
  const load = scopes['../../components/run-detail/evidence-scope-line.tsx']
  expect(load, 'the scope line exports its closed vocabulary').toBeTypeOf('function')
  const module = await load!() as typeof import('../../components/run-detail/evidence-scope-line')
  expect(module.EVIDENCE_SCOPES).toEqual(['step', 'sub-action'])
  expect(module.SCOPE_LINE_STEP(2, 3)).toBe('Step 2 of 3 · whole step')
  expect(module.SCOPE_LINE_SUB_ACTION(2, 3, 1)).toBe('Sub-action #2 of 3 · step 1')
})

test('COUNTS-ABSENT-NOT-ZERO', async () => {
  const { stepSignals, tabCounts } = await helper()
  for (const reason of ['empty', 'not-captured', 'unsupported', 'unavailable', 'failed'] as const) {
    const input = entries()
    input.console = { kind: 'console', state: 'absent', reason }
    expect(stepSignals(input).console).toBeUndefined()
    const result = tabCounts(input).console
    expect(result?.kind).toBe('absent')
    expect(result?.count).toBeUndefined()
    expect(result).toMatchObject({ title: reason === 'failed' ? EVIDENCE_COPY.console.failed.capture.title : EVIDENCE_COPY.console[reason].title })
  }
  expect(stepSignals(undefined)).toEqual({ console: undefined, network: undefined, a11y: undefined })
  expect(tabCounts(undefined).console).toMatchObject({ kind: 'absent', title: EVIDENCE_COPY.console.unavailable.title })
  const input = entries()
  input.console = { kind: 'console', state: 'present', ref, counts: { total: 0, errors: 0, warnings: 0 } }
  expect(stepSignals(input).console).toBeUndefined()
  expect(tabCounts(input).console).toEqual({ kind: 'absent', title: EVIDENCE_COPY.console.empty.title })
  input.console.counts.total = 4
  expect(tabCounts(input).console).toEqual({ kind: 'total', count: 4 })
  expect(tabCounts(input).variables).toEqual({ kind: 'total', count: 6 })
  expect(tabCounts(input, { kind: 'aria', state: 'present', ref }).aria).toBeUndefined()
})

test('COUNTS-NETWORK-FAILED-PLUS-ERRORED', async () => {
  const { stepSignals, tabCounts } = await helper()
  const input = entries()
  input.network = { kind: 'network', state: 'present', ref, counts: { total: 8, failed: 2, errored: 1 } }
  expect(stepSignals(input).network).toBe(3)
  expect(tabCounts(input).network).toEqual({ kind: 'problem', count: 3, severity: 'high' })
  input.network.counts = { total: 8, failed: 0, errored: 0 }
  expect(stepSignals(input).network).toBeUndefined()
  expect(tabCounts(input).network).toEqual({ kind: 'total', count: 8 })
})

test('COUNTS-A11Y-SUM-AND-SEVERITY', async () => {
  const { stepSignals, tabCounts } = await helper()
  const input = entries()
  input.a11y = { kind: 'a11y', state: 'present', ref, counts: { minor: 1, moderate: 2, serious: 3, critical: 4 } }
  expect(stepSignals(input).a11y).toBe(10)
  expect(tabCounts(input).a11y).toEqual({ kind: 'problem', count: 10, severity: 'high' })
  input.a11y.counts = { minor: 1, moderate: 2, serious: 0, critical: 0 }
  expect(tabCounts(input).a11y).toEqual({ kind: 'problem', count: 3, severity: 'moderate' })
  input.a11y.counts = { minor: 0, moderate: 0, serious: 0, critical: 0 }
  expect(stepSignals(input).a11y).toBeUndefined()
  expect(tabCounts(input).a11y).toEqual({ kind: 'absent', title: EVIDENCE_COPY.a11y.empty.title })
})

test('COUNTS-SINGULAR-PLURAL', async () => {
  const { countedTriggerName, absentTriggerName, signalBadgeName } = await helper()
  for (const [kind, singular, plural, label, noun] of [
    ['console', 'console error', 'console errors', 'Console', 'errors'],
    ['network', 'failed request', 'failed requests', 'Network', 'failed requests'],
    ['a11y', 'accessibility violation', 'accessibility violations', 'A11y', 'violations'],
  ] as const) {
    expect(signalBadgeName(kind, 1, 2)).toBe(`1 ${singular} on step 2 — open ${label}`)
    expect(signalBadgeName(kind, 2, 2)).toBe(`2 ${plural} on step 2 — open ${label}`)
    expect(countedTriggerName(kind, { kind: 'problem', count: 2, severity: 'high' })).toBe(`${label}, 2 ${noun}`)
  }
  expect(countedTriggerName('console', { kind: 'problem', count: 1, severity: 'high' })).toBe('Console, 1 error')
  expect(countedTriggerName('network', { kind: 'problem', count: 1, severity: 'high' })).toBe('Network, 1 failed request')
  expect(countedTriggerName('a11y', { kind: 'problem', count: 1, severity: 'moderate' })).toBe('A11y, 1 violation')
  expect(countedTriggerName('variables', { kind: 'total', count: 6 })).toBe('Variables, 6')
  expect(countedTriggerName('network', { kind: 'total', count: 1 })).toBe('Network, 1 request')
  expect(countedTriggerName('console', { kind: 'total', count: 2 })).toBe('Console, 2 messages')
  expect(absentTriggerName('aria', 'Empty accessibility tree')).toBe('ARIA Tree — Empty accessibility tree')
})
