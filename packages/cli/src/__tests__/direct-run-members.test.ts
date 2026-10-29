import { describe, expect, it } from 'vitest'

import {
  parseTestFile,
  type ParsedTestBinding,
} from '@vostride/agent-qa-core'
import { projectRunOutcomes } from '@vostride/agent-qa-knowledge-local'
import { memberStepText } from '@vostride/agent-qa-runner'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRunId,
  type CompletedRunHandoff,
} from '@vostride/agent-qa-schema'

import { buildDirectRunMembers } from '../commands/direct-run-members.js'

// The parser hands bindings whose `filePath` is the ABSOLUTE resolved path (it reads the file), so
// that is what the fixture supplies. What the descriptor must carry is the workspace-relative
// IDENTITY — the bytes the committed ledger and the projection both key on.
const CONFIG_DIR = '/workspace'
const FILE_A = '/workspace/tests/account.yaml'
const FILE_B = '/workspace/tests/checkout.yaml'
const IDENTITY_A = 'tests/account.yaml'
const IDENTITY_B = 'tests/checkout.yaml'
const LOGIN_ID = 't_brick-cinder-dawn-echo-forest-grove-harvest-isle-jade-kite'
const CHECKOUT_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

const FILE_A_CONTENT = [
  `test-id: ${LOGIN_ID}`,
  'name: login works',
  'target: storefront',
  'steps:',
  '  - Log in',
  '---',
  `test-id: ${CHECKOUT_ID}`,
  'name: checkout succeeds',
  'target: storefront',
  'steps:',
  '  - Complete checkout from the account page',
  '',
].join('\n')

const FILE_B_CONTENT = [
  `test-id: ${CHECKOUT_ID}`,
  'name: checkout succeeds',
  'target: storefront',
  'steps:',
  '  - Complete checkout from the cart page',
  '',
].join('\n')

const MIXED_STEPS_ID = 't_prest-onus-hand-anes-arched-picked-shadow-watch-lias-sho'
const MIXED_STEPS_FILE = '/workspace/tests/profile.yaml'
const MIXED_STEPS_CONTENT = [
  `test-id: ${MIXED_STEPS_ID}`,
  'name: profile saves',
  'target: storefront',
  'steps:',
  '  - Open the profile page',
  '  - step: Type "Ada" into the Name field and save',
  '    timeout: 30s',
  '  - Check the page says "Saved"',
  '',
].join('\n')

function parseBindings(filePath: string, fileContent: string): ParsedTestBinding[] {
  const result = parseTestFile(fileContent, filePath)
  expect(result.errors).toEqual([])
  return result.tests.map((test) => ({ test, filePath, fileContent }))
}

function fixtureBindings(): ParsedTestBinding[] {
  return [
    ...parseBindings(FILE_A, FILE_A_CONTENT),
    ...parseBindings(FILE_B, FILE_B_CONTENT),
  ]
}

describe('buildDirectRunMembers', () => {
  it('keeps each member and digest bound to its parsed source file', () => {
    const result = buildDirectRunMembers(fixtureBindings(), CONFIG_DIR)

    expect(result.members.map(({ filePath }) => filePath)).toEqual([
      IDENTITY_A,
      IDENTITY_A,
      IDENTITY_B,
    ])
    expect(result.members.map(({ testIndex }) => testIndex)).toEqual([0, 1, 2])
    expect(result.members.map(({ name }) => name)).toEqual([
      'login works',
      'checkout succeeds',
      'checkout succeeds',
    ])
    expect(result.digestMembers).toEqual([
      { testFileContent: FILE_A_CONTENT },
      { testFileContent: FILE_A_CONTENT },
      { testFileContent: FILE_B_CONTENT },
    ])
  })

  it('mints an identity no checkout root leaks into', () => {
    // Two different checkout roots, the same workspace layout: the descriptors must be byte-equal.
    const underCi = buildDirectRunMembers(
      fixtureBindings().map((binding) => ({
        ...binding,
        filePath: binding.filePath.replace('/workspace', '/var/ci/build/8123/repo'),
      })),
      '/var/ci/build/8123/repo',
    )
    expect(underCi.members.map(({ filePath }) => filePath))
      .toEqual(buildDirectRunMembers(fixtureBindings(), CONFIG_DIR).members.map(({ filePath }) => filePath))
    for (const { filePath } of underCi.members) {
      expect(filePath.startsWith('/')).toBe(false)
      expect(filePath).not.toContain('/var/ci/build')
    }
  })

  // Owner decision 2026-09-26 (2), G-428-2: the descriptor carries the texts member-runner will
  // announce at stepStarted, derived through the runner's one helper, for plain and object steps.
  it('STEP-TEXTS-FROM-PARSED-STEPS', () => {
    const bindings = parseBindings(MIXED_STEPS_FILE, MIXED_STEPS_CONTENT)
    const { members } = buildDirectRunMembers(bindings, CONFIG_DIR)

    expect(members.map(({ stepTexts }) => stepTexts)).toEqual([
      [
        'Open the profile page',
        'Type "Ada" into the Name field and save',
        'Check the page says "Saved"',
      ],
    ])
    expect(members[0].stepTexts).toEqual(bindings[0].test.steps.map((step) => memberStepText(step)))
    expect(members[0].totalSteps).toBe(members[0].stepTexts?.length)
  })

  it('REFUSES a binding whose source file escapes the config directory', () => {
    expect(() => buildDirectRunMembers(fixtureBindings(), '/workspace/tests/nested'))
      .toThrow(/escapes config directory/)
  })

  it('projects equal-named tests from different files as distinct outcome rows', () => {
    const { members } = buildDirectRunMembers(fixtureBindings(), CONFIG_DIR)
    const checkoutMembers = members.filter(({ name }) => name === 'checkout succeeds')
    const handoff: CompletedRunHandoff = {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId('run-direct-bindings'),
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 1_750_000_000_000,
      endedAt: 1_750_000_001_000,
      tests: checkoutMembers.map((member, testIndex) => ({
        testId: member.testId,
        testName: member.name,
        filePath: member.filePath,
        testIndex,
        outcome: 'passed',
        steps: [],
      })),
    }

    const projection = projectRunOutcomes(handoff, {
      extractAnchors: () => [],
    })

    expect(projection.tests).toEqual([
      expect.objectContaining({ filePath: IDENTITY_A, testName: 'checkout succeeds' }),
      expect.objectContaining({ filePath: IDENTITY_B, testName: 'checkout succeeds' }),
    ])
  })
})
