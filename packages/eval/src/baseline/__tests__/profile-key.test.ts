import { committedFileText, sha256hex } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { canonicalJson } from '../../canonical-json'
import {
  BASELINE_POINTER_SCHEMA_VERSION,
  SEED_POLICIES,
  composeBaselineProfileKey,
  computeReplayProfileFingerprint,
  guardBaselinePointer,
  projectBaselinePointer,
  type ReplayProfileFingerprintInput,
} from '../profile-key'

const pointerInput = {
  plannerModelId: 'gpt-5.6-terra',
  fingerprint: 'abc',
  matcherVersion: 1,
  batchKey: 'batch-fixture',
  corpusDigest: 'digest-fixture',
}

function currentPointer(): Record<string, unknown> {
  return { ...projectBaselinePointer(pointerInput) }
}

function withoutField(field: string): Record<string, unknown> {
  const pointer = currentPointer()
  delete pointer[field]
  return pointer
}

describe('baseline pointer v2 (415 D-11)', () => {
  it('includes the fingerprint as the second profile-key segment', () => {
    expect(composeBaselineProfileKey(pointerInput)).toBe(
      'planner=gpt-5.6-terra|fingerprint=abc|matcher=1|judge=none|judgeVersion=none',
    )
  })

  it('projects byte-stable v2 pointers with required fingerprint and corpus digest', () => {
    const pointer = projectBaselinePointer(pointerInput)
    expect(BASELINE_POINTER_SCHEMA_VERSION).toBe(2)
    expect(pointer).toEqual({
      ...pointerInput,
      schemaVersion: 2,
      profileKey: composeBaselineProfileKey(pointerInput),
    })
    expect(committedFileText(pointer)).toBe(
      committedFileText(projectBaselinePointer(pointerInput)),
    )
    expect(guardBaselinePointer(pointer)).toEqual({ kind: 'current', pointer })
  })

  it.each([1, 3])('a pointer stamped %i loads as rejected', stamp => {
    expect(
      guardBaselinePointer({ ...projectBaselinePointer(pointerInput), schemaVersion: stamp }),
    ).toEqual({ kind: 'rejected', reason: expect.stringContaining('schemaVersion') })
  })

  it.each([
    ['missing batch key', { ...currentPointer(), batchKey: undefined }],
    ['an unknown field', { ...currentPointer(), extra: true }],
    ['missing fingerprint', withoutField('fingerprint')],
    ['missing corpus digest', withoutField('corpusDigest')],
    ['null body', null],
  ])('rejects %s with a typed reason', (_name, value) => {
    expect(guardBaselinePointer(value)).toEqual({
      kind: 'rejected',
      reason: expect.any(String),
    })
  })
})

describe('resolved replay profile fingerprint (415 D-11)', () => {
  const input: ReplayProfileFingerprintInput = {
    provider: 'openai',
    modelId: 'gpt-5.6-terra',
    temperature: 0,
    seedPolicy: 'declared',
    capabilities: { vision: true, maxOutputTokens: 4096 },
    modelOverrideKeys: [],
  }

  it('uses the canonical SHA-256 recipe deterministically', () => {
    const digest = computeReplayProfileFingerprint(input)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).toBe(sha256hex(canonicalJson(input)))
    expect(computeReplayProfileFingerprint(input)).toBe(digest)
  })

  it.each<Partial<ReplayProfileFingerprintInput>>([
    { provider: 'anthropic' },
    { modelId: 'other-model' },
    { temperature: 1 },
    { seedPolicy: 'none' },
    { capabilities: { vision: false, maxOutputTokens: 4096 } },
    { capabilities: { vision: true, maxOutputTokens: 8192 } },
    { capabilities: { vision: true } },
    { modelOverrideKeys: ['stub-model'] },
  ])('changes when a resolved input changes: %j', change => {
    expect(computeReplayProfileFingerprint({ ...input, ...change })).not.toBe(
      computeReplayProfileFingerprint(input),
    )
  })

  it('ignores object-key insertion order, including capabilities', () => {
    expect(
      computeReplayProfileFingerprint({
        modelOverrideKeys: [],
        capabilities: { maxOutputTokens: 4096, vision: true },
        seedPolicy: 'declared',
        temperature: 0,
        modelId: 'gpt-5.6-terra',
        provider: 'openai',
      }),
    ).toBe(computeReplayProfileFingerprint(input))
  })

  it('publishes exactly the two seed policies', () => {
    expect(SEED_POLICIES).toEqual(['none', 'declared'])
  })
})
