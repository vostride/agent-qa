import {
  asRunId,
  EvidenceArtifactRefSchema,
  projectStepFinalized,
  RunDetailProjectionSchema,
  RunDetailStepSchema,
  RunDetailSubActionSchema,
  VariableSnapshotSchema,
} from '@vostride/agent-qa-schema'
import type {
  AriaEvidenceEntry,
  RunDetailRows,
  RunDetailStep,
  RunDetailSubAction,
  StepEvidenceEntries,
  VariableSnapshot,
} from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { runsDetailSpec } from '../ops/runs-detail.js'
import type { FunctionDeps } from '../spec.js'

const runId = asRunId('detail-evidence-fixture')
type EvidenceStep = RunDetailStep & {
  evidence?: StepEvidenceEntries
  variableSnapshot?: VariableSnapshot
}
type EvidenceSubAction = RunDetailSubAction & { ariaEvidence?: AriaEvidenceEntry }

function step(testIndex = 0, stepIndex = 0): EvidenceStep {
  return {
    testIndex, stepIndex, cacheStatus: 'hit',
    verifierVerdict: { pass: true, reasoning: 'recorded' },
    selfHealOccurred: false, briefDigest: 'recorded-digest',
  }
}

function child(testIndex = 0, stepIndex = 0, subActionIndex = 0): EvidenceSubAction {
  return {
    testIndex, stepIndex, subActionIndex, plan: 'recorded plan',
    plannedAction: { type: 'navigate', to: 'url', url: 'https://example.invalid' },
    result: { success: true }, screenStateHash: 'recorded-screen-hash',
  }
}

function unavailable(): StepEvidenceEntries {
  return {
    console: { kind: 'console', state: 'absent', reason: 'unavailable' },
    network: { kind: 'network', state: 'absent', reason: 'unavailable' },
    a11y: { kind: 'a11y', state: 'absent', reason: 'unavailable' },
    variables: { kind: 'variables', state: 'absent', reason: 'unavailable' },
  }
}

function ref(prefix: string, digit: string) {
  const sha = digit.repeat(64)
  return EvidenceArtifactRefSchema.parse({ id: `${prefix}:${sha}`, sha })
}

function read(rows: RunDetailRows) {
  const forbidden = vi.fn(() => { throw new Error('No handoff, config or blob content read') })
  const deps = {
    runDetail: { read: vi.fn(async () => rows) },
    runs: { get: forbidden }, config: { get: forbidden },
    evidenceBlobs: { read: forbidden },
  } as unknown as FunctionDeps
  return { result: runsDetailSpec.invoke({ runId }, deps), forbidden }
}

describe('DETAIL-HISTORICAL-UNAVAILABLE', () => {
  it('rejects malformed null additions instead of treating them as historical absence', async () => {
    const rows = {
      runId, members: [], steps: [{ ...step(), evidence: null, variableSnapshot: null }],
      subActions: [{ ...child(), ariaEvidence: null }],
    } as unknown as RunDetailRows
    const output = await read(rows).result
    expect(output.steps[0]).toHaveProperty('evidence', null)
    expect(output.subActions[0]).toHaveProperty('ariaEvidence', null)
    expect(RunDetailProjectionSchema.safeParse(output).success).toBe(false)
    expect(RunDetailStepSchema.safeParse({ ...step(), variableSnapshot: null }).success).toBe(false)
  })

  it('maps truly absent v2 fields to unavailable for all five kinds without values or counts', async () => {
    const rows: RunDetailRows = {
      runId, members: [{ testIndex: 0, attempts: 1 }], steps: [step()], subActions: [child()],
    }
    const before = JSON.stringify(rows)
    const { result, forbidden } = read(rows)
    const output = await result
    expect(output.steps[0]).toMatchObject({ evidence: unavailable() })
    expect(output.subActions[0]).toMatchObject({
      ariaEvidence: { kind: 'aria', state: 'absent', reason: 'unavailable' },
    })
    expect(output.steps[0]).not.toHaveProperty('variableSnapshot')
    expect(output.tokens).toEqual({ measuredSteps: 0, unmeasuredSteps: 1 })
    expect(RunDetailProjectionSchema.safeParse(output).success).toBe(true)
    expect(JSON.stringify(rows)).toBe(before)
    expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('DETAIL-ENTRY-OWNERSHIP', () => {
  it('ARIA-SIDE-BEFORE: missing ARIA bytes annotate only the owned ref and never select another child', async () => {
    const firstRef = ref('aria-state', 'a')
    const secondRef = ref('aria-state', 'b')
    const image = ref('decision-screenshot', 'c')
    const children: EvidenceSubAction[] = [firstRef, secondRef].map((ariaRef, index) => ({
      ...child(0, 0, index), screenStateHash: `before-${index}`, screenStateHashAfter: `after-${index}`,
      artifactRefs: [image, ariaRef], ariaEvidence: { kind: 'aria', state: 'present', ref: ariaRef },
    }))
    const contentRead = vi.fn(() => { throw new Error('No blob or historical tree content read') })
    const output = await runsDetailSpec.invoke({ runId }, {
      runDetail: { read: async () => ({ runId, members: [], steps: [step()], subActions: children }) },
      evidenceBlobs: { read: contentRead, has: async (_id: unknown, sha: string) => sha === firstRef.sha ? 'blob_absent' : 'found' },
      runs: { get: contentRead },
    } as unknown as FunctionDeps)
    expect(output.subActions.map(item => item.ariaEvidence)).toEqual(children.map(item => item.ariaEvidence))
    expect(output.subActions[0]?.artifactRefs).toEqual([{ ...image, present: true }, { ...firstRef, present: false }])
    expect(output.subActions[1]?.artifactRefs).toEqual([{ ...image, present: true }, { ...secondRef, present: true }])
    expect(output.subActions.map(item => item.screenStateHash)).toEqual(['before-0', 'before-1'])
    expect(contentRead).not.toHaveBeenCalled()
    expect(RunDetailProjectionSchema.safeParse(output).success).toBe(true)
  })
  it('preserves a valid captured __proto__ own name through strict parsing', async () => {
    const variableSnapshot = JSON.parse('{"__proto__":{"value":"[secret]","source":"capture"}}') as VariableSnapshot
    const recorded: EvidenceStep = {
      ...step(), variableSnapshot,
      evidence: { ...unavailable(), variables: { kind: 'variables', state: 'present', counts: { count: 1 } } },
    }
    const output = await read({ runId, members: [], steps: [recorded], subActions: [] }).result
    const parsed = RunDetailProjectionSchema.parse(output)
    expect(parsed.steps[0]?.variableSnapshot).toEqual(variableSnapshot)
    expect(Object.hasOwn(parsed.steps[0]?.variableSnapshot ?? {}, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(parsed.steps[0]?.variableSnapshot)).toBe(Object.prototype)
  })

  it('rejects malformed captured __proto__ values instead of silently skipping validation', () => {
    for (const value of [
      { value: 3, source: 'capture' },
      { value: 'masked', source: 'invented' },
      { value: 'masked', source: 'capture', unknown: true },
    ]) {
      for (const name of ['__proto__', 'ordinary']) {
        expect(VariableSnapshotSchema.safeParse(Object.fromEntries([[name, value]])).success).toBe(false)
      }
    }
  })

  it('retains the public name-keyed strict value/source JSON-schema input contract', () => {
    const projected = z.toJSONSchema(VariableSnapshotSchema, { io: 'input' })
    expect(projected.allOf).toEqual([{
      type: 'object', propertyNames: { type: 'string' },
      additionalProperties: {
        type: 'object', properties: {
          value: { type: 'string' },
          source: { type: 'string', enum: ['env', 'inline', 'suite', 'cli', 'capture', 'hook', 'step'] },
        },
        required: ['value', 'source'], additionalProperties: false,
      },
    }, {}])
  })

  it('carries the capture-time masked names and values without restoring or remasking identities', async () => {
    const payload = projectStepFinalized({
      stepIndex: 0, stepText: 'capture', cacheStatus: 'miss', subActions: [],
      servedBrief: {
        scope: { tier: 'test', key: 'fixture' }, asOfBuild: 1, budget: 100,
        truncation: 'none', channel1: [], channel2: [], channel3: [], briefDigest: 'digest',
      },
      verifierVerdict: { pass: true, reasoning: 'done' },
    }, { testIndex: 0, stepIndex: 0 }, value => value.replaceAll('SYNTHETIC', '[secret]'), {
      evidence: { ...unavailable(), variables: { kind: 'variables', state: 'present', counts: { count: 1 } } },
      variableSnapshot: { SYNTHETIC_name: { value: 'SYNTHETIC value', source: 'capture' } },
    })
    const output = await read({ runId, members: [], steps: [payload], subActions: [] }).result
    const parsed = RunDetailProjectionSchema.parse(output)
    expect(parsed.steps[0]?.variableSnapshot).toEqual({
      '[secret]_name': { value: '[secret] value', source: 'capture' },
    })
    expect(JSON.stringify(parsed)).not.toContain('SYNTHETIC')
    expect(payload.variableSnapshot).toEqual(parsed.steps[0]?.variableSnapshot)
  })

  it('retains recorded kinds, counts, refs, row order and masked snapshots through the strict output', async () => {
    const first: EvidenceStep = {
      ...step(1, 0), evidence: {
        console: { kind: 'console', state: 'present', ref: ref('console-evidence', 'a'), counts: { total: 7, errors: 2, warnings: 3 } },
        network: { kind: 'network', state: 'present', ref: ref('network-evidence', 'b'), counts: { total: 5, failed: 2, errored: 1 } },
        a11y: { kind: 'a11y', state: 'present', ref: ref('a11y-evidence', 'c'), counts: { minor: 1, moderate: 2, serious: 3, critical: 4 } },
        variables: { kind: 'variables', state: 'present', counts: { count: 2 } },
      },
      variableSnapshot: { '[secret]': { value: '[secret]', source: 'capture' }, public: { value: 'retained', source: 'inline' } },
      tokenUsage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    }
    const second: EvidenceStep = { ...step(), evidence: unavailable() }
    const aria: AriaEvidenceEntry = { kind: 'aria', state: 'present', ref: ref('aria-state', 'd') }
    const subActions: EvidenceSubAction[] = [
      { ...child(0, 0, 2), ariaEvidence: { kind: 'aria', state: 'absent', reason: 'failed' } },
      { ...child(1, 0, 1), ariaEvidence: aria, artifactRefs: [ref('decision-screenshot', 'e'), aria.ref] },
    ]
    const rows = { runId, members: [], steps: [first, second], subActions }
    const before = JSON.stringify(rows)
    const { result, forbidden } = read(rows)
    const output = await result
    expect(RunDetailProjectionSchema.safeParse(output).success).toBe(true)
    expect(output.steps).toEqual(rows.steps)
    expect(output.subActions).toEqual(subActions)
    expect(output.tokens).toEqual({ measuredSteps: 1, unmeasuredSteps: 1, promptTokens: 3, completionTokens: 4, totalTokens: 7 })
    expect(JSON.stringify(rows)).toBe(before)
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('preserves capture reasons without inventing a child for a step with no sub-actions', async () => {
    const evidence: StepEvidenceEntries = {
      console: { kind: 'console', state: 'absent', reason: 'empty' },
      network: { kind: 'network', state: 'absent', reason: 'not-captured' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'absent', reason: 'failed' },
    }
    const recorded: EvidenceStep = { ...step(), evidence }
    const output = await read({ runId, members: [], steps: [recorded], subActions: [] }).result
    expect(RunDetailProjectionSchema.safeParse(output).success).toBe(true)
    expect(output.steps[0]).toMatchObject({ evidence })
    expect(output.subActions).toEqual([])
    expect(output.steps[0]).not.toHaveProperty('ariaEvidence')
    expect(output.steps[0]).not.toHaveProperty('variableSnapshot')
  })

  it('accepts omitted additions but refuses crossed kinds, invalid refs, counts on absences and unknown fields', () => {
    expect(RunDetailStepSchema.safeParse(step()).success).toBe(true)
    expect(RunDetailSubActionSchema.safeParse(child()).success).toBe(true)
    expect(RunDetailStepSchema.safeParse({ ...step(), evidence: unavailable() }).success).toBe(true)
    for (const evidence of [
      { ...unavailable(), console: { kind: 'network', state: 'absent', reason: 'empty' } },
      { ...unavailable(), console: { kind: 'console', state: 'absent', reason: 'empty', counts: { total: 0 } } },
      { ...unavailable(), console: { kind: 'console', state: 'present', ref: ref('aria-state', 'a'), counts: { total: 1, errors: 0, warnings: 0 } } },
      { ...unavailable(), console: { kind: 'console', state: 'present', ref: ref('console-evidence', 'a'), counts: { total: 1, errors: 0, warnings: 0 }, extra: true } },
      { ...unavailable(), aria: { kind: 'aria', state: 'absent', reason: 'empty' } },
    ]) expect(RunDetailStepSchema.safeParse({ ...step(), evidence }).success).toBe(false)
    expect(RunDetailSubActionSchema.safeParse({ ...child(), ariaEvidence: { kind: 'console', state: 'absent', reason: 'empty' } }).success).toBe(false)
    expect(RunDetailSubActionSchema.safeParse({ ...child(), ariaEvidence: { kind: 'aria', state: 'present', ref: { id: 'aria-state:bad', sha: 'bad' } } }).success).toBe(false)
    expect(RunDetailStepSchema.safeParse({ ...step(), variableSnapshot: { name: { value: 'value', source: 'invented' } } }).success).toBe(false)
  })
})
