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

  // 2026-09-30, 432-07: configWrite, the direct config writer, is the thirtieth binding.
  // 2026-10-01, 432-17 (D-05/D-07/D-09): proposalsInbox, draftApply, authoringProposals,
  // configApply, configProposals and configUndoSource leave with the inbox, the apply ops and the
  // undo, so 30 - 6 = 24.
  // 2026-10-01, 432-18 (D-03/D-15): standingGrants leaves with the grant ops and the ledger, so
  // 24 - 1 = 23.
  // RE-SPELLED 2026-10-14 (441-16, D-06) from 'has exactly 23 optional bindings': secretMask joins.
  // RE-SPELLED 2026-10-14 (441-39, D-15) from 'has exactly 24 optional bindings': the construction
  // scan's binding leaves with the scan, so 24 - 1 = 23.
  it('has exactly 23 optional bindings', () => {
    expect(OPTIONAL_FUNCTION_DEP_KEYS).toHaveLength(23)
  })
})

// 2026-09-15, 423-37: an independent oracle for plan 423-23's mutation, spelled by hand again
// rather than shared with the pin above.
// 2026-10-01, 432-17: the six proposal, apply and undo bindings leave the hand-spelled roster too.
// 2026-10-01, 432-18: standingGrants leaves it with the grant ops.
// 2026-10-14, 441-39 (D-15): the construction scan's binding leaves it with the scan.
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
    // RE-SPELLED 2026-10-01 (432-24, D-12): runs.mark.preview declares no scope now; both reads
    // keep their read-only risk. 2026-10-01 (432-25, D-12): runs.marks.history's ['read'] goes too.
    expect([runsMarksHistorySpec, runsMarkPreviewSpec].map(op => op.risk.readOnly)).toEqual([true, true])
    expect(runsMarksHistorySpec).not.toHaveProperty('requiredScopes')
    expect(runsMarkPreviewSpec).not.toHaveProperty('requiredScopes')
  })
})

// 2026-10-01, 432-18 (D-03/D-15): the standing-grant port leaves FunctionDeps with both rosters. The
// type half of this claim is the same-named block in port-split.test-d.ts; this is the runtime half.
describe('no grant binding', () => {
  // RE-SPELLED 2026-10-14 (441-16, D-06) from '… and the roster counts 23': secretMask joins.
  // RE-SPELLED 2026-10-14 (441-39, D-15) from '… and the roster counts 24': the scan binding leaves.
  it('no optional binding names a grant port, and the roster counts 23', () => {
    const roster: readonly string[] = OPTIONAL_FUNCTION_DEP_KEYS
    expect(roster.includes('standingGrants'), 'standingGrants is still an optional binding').toBe(false)
    expect(roster.filter(key => /grant/i.test(key)), 'a grant-shaped binding replaced it').toEqual([])
    expect(roster).toHaveLength(23)
    expect(EXPECTED_BINDINGS).toHaveLength(23)
  })
})

// 2026-10-02, 432-39 (D-03/D-10/D-12/D-15): C432-OPTIONAL-DEPS-EXACT. The optional roster, the
// `FunctionDeps` interface and the agent barrel agree EXACTLY — compile-checked against the type and
// measured against the real runtime object — and no binding is a permission, proposal, confirm or
// undo port. The four required ports are spelled by hand beside the 23 optional ones (441-39: was 24).
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
