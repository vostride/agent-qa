// 2026-10-09 (438-02, D-02, D-05, 436 D-17): the persisted target refusal block, its historical
// reader and the optional-additive grounding fields; 438-06 (D-09) adds the binding block; 438-09
// (D-11) adds the recorded cache miss. Every expected set is spelled by hand, never derived from
// the module under test.
import { readFileSync } from 'node:fs'

import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  BINDING_OUTCOME_KEYS,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardCompletedRunHandoff,
  readBindingOutcomeMeta,
  readTargetRefusalMeta,
  TARGET_IDENTITY_KEYS,
  TARGET_REFUSAL_KEYS,
} from '../index'
import type {
  BindingOutcomeMeta,
  CacheMissReason,
  CompletedRunHandoff,
  GroundingEvidence,
  StepEvidence,
  TargetDescriptor,
  TargetIdentity,
  TargetRefusalMeta,
} from '../index'

const preChangeHandoff = new URL(
  '../../../../test-fixtures/legacy-handoff/handoff.json',
  import.meta.url,
)

function wellFormed(): Record<string, unknown> {
  return {
    kind: 'target-mismatch',
    lane: 'ref',
    path: 'live',
    stated: { role: 'button', name: 'Submit' },
    observed: { role: 'textbox', name: '' },
    reasons: ['role-kind'],
    rowStated: false,
    inputSent: false,
  }
}

const withBlock = (block: unknown) => ({ success: false, metadata: { targetRefusal: block } })

const withBinding = (block: unknown) => ({ success: false, metadata: { binding: block } })

describe('C438-KEY-SETS', () => {
  it('the target refusal block carries exactly its eight members', () => {
    expect([...TARGET_REFUSAL_KEYS].sort()).toEqual([
      'inputSent',
      'kind',
      'lane',
      'observed',
      'path',
      'reasons',
      'rowStated',
      'stated',
    ])
    expectTypeOf<keyof TargetRefusalMeta>().toEqualTypeOf<(typeof TARGET_REFUSAL_KEYS)[number]>()
  })

  it('a target identity carries exactly role, name and row', () => {
    expect([...TARGET_IDENTITY_KEYS].sort()).toEqual(['name', 'role', 'row'])
    expectTypeOf<keyof TargetIdentity>().toEqualTypeOf<(typeof TARGET_IDENTITY_KEYS)[number]>()
  })

  it('the handoff schema version is 2', () => {
    expect(CURRENT_HANDOFF_SCHEMA_VERSION).toBe(2)
    const handoff = JSON.parse(readFileSync(preChangeHandoff, 'utf8')) as CompletedRunHandoff
    expect(handoff.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
    expect(guardCompletedRunHandoff(handoff)).toBe(handoff)
  })

  it('reads a well-formed refusal block back', () => {
    expect(readTargetRefusalMeta(withBlock(wellFormed()))).toEqual(wellFormed())
  })

  it('reads a heal refusal with a stated row', () => {
    const block = {
      ...wellFormed(),
      lane: 'toRef',
      path: 'heal',
      stated: { role: 'button', name: 'Edit label', row: '7 Elm Street' },
      observed: { role: 'button', name: 'Edit label', row: '9 Oak Road' },
      reasons: ['row'],
      rowStated: true,
    }
    expect(readTargetRefusalMeta(withBlock(block))).toEqual(block)
  })

  it('returns undefined for a result with no metadata', () => {
    expect(readTargetRefusalMeta({})).toBeUndefined()
    expect(readTargetRefusalMeta(undefined)).toBeUndefined()
  })

  it('returns undefined for an idempotentNoop result', () => {
    const noop = {
      success: true,
      metadata: { idempotentNoop: { currentState: 'checked', inputSent: false } },
    }
    expect(readTargetRefusalMeta(noop)).toBeUndefined()
  })

  it('returns undefined for a block missing stated', () => {
    const { stated: _stated, ...block } = wellFormed()
    expect(readTargetRefusalMeta(withBlock(block))).toBeUndefined()
  })

  it('returns undefined for a block with inputSent true', () => {
    expect(readTargetRefusalMeta(withBlock({ ...wellFormed(), inputSent: true }))).toBeUndefined()
  })

  it("returns undefined for a block whose kind is not 'target-mismatch'", () => {
    expect(readTargetRefusalMeta(withBlock({ ...wellFormed(), kind: 'refused' }))).toBeUndefined()
  })

  it('returns undefined for a block whose reasons hold an unknown string', () => {
    const block = { ...wellFormed(), reasons: ['role-kind', 'ordinal'] }
    expect(readTargetRefusalMeta(withBlock(block))).toBeUndefined()
  })

  it('grounding evidence gains an optional stated identity', () => {
    expectTypeOf<Pick<GroundingEvidence, 'stated'>>().toEqualTypeOf<{
      stated?: { role?: string; name: string; row?: string }
    }>()
  })

  it('a target descriptor gains an optional row', () => {
    expectTypeOf<Pick<TargetDescriptor, 'row'>>().toEqualTypeOf<{ row?: string }>()
  })

  it('a handoff whose grounding carries stated still loads', () => {
    const handoff = JSON.parse(readFileSync(preChangeHandoff, 'utf8')) as CompletedRunHandoff
    const subAction = handoff.tests[0].steps[0].subActions[0]
    const grounding: GroundingEvidence = {
      descriptor: { role: 'link', name: 'Settings' },
      attempts: [{ stage: 'ref', outcome: 'resolved' }],
      stated: { role: 'link', name: 'Settings' },
    }
    subAction.grounding = grounding
    const loaded = guardCompletedRunHandoff(JSON.parse(JSON.stringify(handoff)))
    expect(loaded.tests[0].steps[0].subActions[0].grounding).toEqual(grounding)
  })

  it('the binding block carries exactly outcome, ref, inputSent and an optional heal', () => {
    expect([...BINDING_OUTCOME_KEYS].sort()).toEqual(['heal', 'inputSent', 'outcome', 'ref'])
    expectTypeOf<keyof BindingOutcomeMeta>().toEqualTypeOf<(typeof BINDING_OUTCOME_KEYS)[number]>()
  })

  it('reads a binding block back, with and without heal', () => {
    const block = { outcome: 'stale-observation', ref: 'e7', inputSent: false }
    expect(readBindingOutcomeMeta(withBinding(block))).toEqual(block)
    const healed = { outcome: 'binding-lost', ref: 'e7', inputSent: false, heal: 'not-unique' }
    expect(readBindingOutcomeMeta(withBinding(healed))).toEqual(healed)
  })

  it('returns undefined for a missing binding block', () => {
    expect(readBindingOutcomeMeta({ metadata: {} })).toBeUndefined()
    expect(readBindingOutcomeMeta({})).toBeUndefined()
    expect(readBindingOutcomeMeta(undefined)).toBeUndefined()
  })

  it('returns undefined for an unknown binding outcome', () => {
    const block = { outcome: 'ordinal-moved', ref: 'e7', inputSent: false }
    expect(readBindingOutcomeMeta(withBinding(block))).toBeUndefined()
  })

  it('returns undefined for a binding block with inputSent true', () => {
    const block = { outcome: 'frame-detached', ref: 'e7', inputSent: true }
    expect(readBindingOutcomeMeta(withBinding(block))).toBeUndefined()
  })

  it("returns undefined for a heal outside 'absent' and 'not-unique'", () => {
    const block = { outcome: 'binding-changed', ref: 'e7', inputSent: false, heal: 'resolved' }
    expect(readBindingOutcomeMeta(withBinding(block))).toBeUndefined()
  })

  it('a cache miss reason is exactly strict-absent, strict-not-unique or non-replayable', () => {
    const reasons = ['strict-absent', 'strict-not-unique', 'non-replayable'] as const
    expectTypeOf<CacheMissReason>().toEqualTypeOf<(typeof reasons)[number]>()
  })

  it('step evidence carries an optional cache miss', () => {
    expectTypeOf<Pick<StepEvidence, 'cacheMiss'>>().toEqualTypeOf<{
      cacheMiss?: { reason: CacheMissReason }
    }>()
  })

  it('a handoff whose step carries a cache miss still loads', () => {
    const handoff = JSON.parse(readFileSync(preChangeHandoff, 'utf8')) as CompletedRunHandoff
    const step = handoff.tests[0].steps[0]
    step.cacheStatus = 'miss'
    step.cacheMiss = { reason: 'strict-not-unique' }
    const loaded = guardCompletedRunHandoff(JSON.parse(JSON.stringify(handoff)))
    expect(loaded.tests[0].steps[0].cacheStatus).toBe('miss')
    expect(loaded.tests[0].steps[0].cacheMiss).toEqual({ reason: 'strict-not-unique' })
  })
})
