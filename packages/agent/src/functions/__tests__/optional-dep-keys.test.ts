import { describe, expect, it } from 'vitest'

import { runsMarkPreviewSpec } from '../ops/runs-mark-preview'
import { runsMarkSpec } from '../ops/runs-mark'
import { runsMarksHistorySpec } from '../ops/runs-marks-history'
import * as agent from '../../index.js'
import { OPTIONAL_FUNCTION_DEP_KEYS } from '../spec'
import type { FunctionDeps, OptionalFunctionDepKey } from '../spec'

describe('optional function dep keys', () => {
  it('pins every host binding by name and declaration order', () => {
    expect([...OPTIONAL_FUNCTION_DEP_KEYS]).toEqual([
      'liveView',
      'runInvocation',
      'knowledgeReview',
      'postProcessing',
      'runDetail',
      'evidenceBlobs',
      'analysis',
      'recurrence',
      'quarantine',
      'chatTurn',
      'draftEvaluation',
      'authoringRead',
      'authoringScope',
      'draftShelf',
      'authoringFunnel',
      'configFiles',
      'configValidate',
      'scaffoldContent',
      'capabilityCatalog',
      'feedback',
      'feedbackReads',
      'configWrite',
      'secretMask',
    ])
  })

  it('has exactly 23 optional bindings', () => {
    expect(OPTIONAL_FUNCTION_DEP_KEYS).toHaveLength(23)
  })
})

// An independent oracle, spelled by hand rather than shared with the pin above.
const EXPECTED_BINDINGS = [
  'liveView', 'runInvocation', 'knowledgeReview', 'postProcessing', 'runDetail', 'evidenceBlobs',
  'analysis', 'recurrence', 'quarantine', 'chatTurn',
  'draftEvaluation', 'authoringRead', 'authoringScope', 'draftShelf', 'authoringFunnel',
  'configFiles', 'configValidate',
  'scaffoldContent', 'capabilityCatalog', 'feedback', 'feedbackReads',
  'configWrite', 'secretMask',
]

describe('the feedback bindings', () => {
  it('pins the runtime roster exactly, with no missing, extra or repeated binding', () => {
    expect([...OPTIONAL_FUNCTION_DEP_KEYS]).toEqual(EXPECTED_BINDINGS)
    expect(new Set(OPTIONAL_FUNCTION_DEP_KEYS).size).toBe(OPTIONAL_FUNCTION_DEP_KEYS.length)
    expect(OPTIONAL_FUNCTION_DEP_KEYS.filter(key => key.startsWith('feedback'))).toEqual(['feedback', 'feedbackReads'])
  })

  it('binds the mark writer through feedback and both feedback reads through feedbackReads', () => {
    const bindings = [runsMarkSpec, runsMarksHistorySpec, runsMarkPreviewSpec].map(op => [op.id, op.boundThrough])
    expect(bindings).toEqual([
      ['runs.mark', 'feedback'],
      ['runs.marks.history', 'feedbackReads'],
      ['runs.mark.preview', 'feedbackReads'],
    ])
    expect([runsMarksHistorySpec, runsMarkPreviewSpec].map(op => op.risk.readOnly)).toEqual([true, true])
    expect(runsMarksHistorySpec).not.toHaveProperty('requiredScopes')
    expect(runsMarkPreviewSpec).not.toHaveProperty('requiredScopes')
  })
})

// The type half of this claim is the same-named block in port-split.test-d.ts.
describe('no grant binding', () => {
  it('no optional binding names a grant port, and the roster counts 23', () => {
    const roster: readonly string[] = OPTIONAL_FUNCTION_DEP_KEYS
    expect(roster.includes('standingGrants'), 'standingGrants is still an optional binding').toBe(false)
    expect(roster.filter(key => /grant/i.test(key)), 'a grant-shaped binding replaced it').toEqual([])
    expect(roster).toHaveLength(23)
    expect(EXPECTED_BINDINGS).toHaveLength(23)
  })
})

// Roster, `FunctionDeps` and the barrel agree exactly, and no binding is a permission port.
type ExactKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? ([K] extends [keyof T] ? true : false)
  : false
type OptionalKeysOf<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T]
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const REQUIRED_DEP_KEYS = ['runs', 'knowledge', 'config', 'entities'] as const
const DEPS_TYPE_IS_EXACT: ExactKeys<
  FunctionDeps,
  (typeof REQUIRED_DEP_KEYS)[number] | (typeof OPTIONAL_FUNCTION_DEP_KEYS)[number]
> = true
const OPTIONAL_TYPE_IS_ROSTER: Same<OptionalKeysOf<FunctionDeps>, OptionalFunctionDepKey> = true

describe('the optional binding roster', () => {
  it('the roster, the deps type and the agent barrel agree exactly', () => {
    expect([DEPS_TYPE_IS_EXACT, OPTIONAL_TYPE_IS_ROSTER]).toEqual([true, true])
    expect([...OPTIONAL_FUNCTION_DEP_KEYS]).toEqual(EXPECTED_BINDINGS)
    // The barrel publishes the SAME runtime object, not a copy that could drift.
    expect(agent.OPTIONAL_FUNCTION_DEP_KEYS).toBe(OPTIONAL_FUNCTION_DEP_KEYS)
  })

  it('no binding is a permission, proposal, confirm or undo port', () => {
    const roster: readonly string[] = [...REQUIRED_DEP_KEYS, ...OPTIONAL_FUNCTION_DEP_KEYS]
    expect(roster).toHaveLength(27)
    // `authoringScope` is the authored-product scope port, not a permission scope, so the census
    // names the permission words rather than every `scope`.
    expect(roster.filter(key =>
      /grant|requiredScope|credential|approv|proposal|confirm|undo|apply|trust|safeMode/i.test(key)))
      .toEqual([])
  })
})
