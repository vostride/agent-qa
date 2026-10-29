// `authoring.funnel.get` at the function layer (394-07, D-12/D-13 · WTST-05).
//
// WHAT THESE CASES PIN, AND WHY EACH ONE:
//
//  1. THE TIER IS STATED ON THE SPEC. `readOnly: true` is the claim a reviewer objects to if
//     per-session authoring history read by any caller is the wrong call (T-394-26). A comment
//     saying "this is read-only" is worth nothing; the descriptor is what the classifier reads.
//     2026-10-01 (432-23, D-12): the `['read']` scope that stood beside it is gone with every
//     scope; no caller is checked for one.
//  2. REFUSAL BY NAME, AT BOTH LAYERS. `invokeFunction` refuses on the DECLARATION, and the op
//     body guards too, so a direct in-layer call cannot slip past. An unbound host answering an
//     all-zero funnel would say "this session authored nothing" about a store it has never been
//     able to read — and worse, a zero funnel reads as a loop that filtered EVERYTHING, which is
//     the one wrong answer that flatters the thing this measurement exists to keep honest.
//  3. THE OP DERIVES NOTHING. Its answer must deep-equal `computeAuthoringFunnel` over the same
//     receipts. A second computation anywhere would be a second answer to the question the
//     one-read-op law exists to make singular.

import { computeAuthoringFunnel, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  AuthoringFunnel,
  DraftReceipt,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { DraftReceiptSchema } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { FunctionNotBoundError, invokeFunction } from '../invoke.js'
import { createFunctionRegistry } from '../registry.js'
import {
  AUTHORING_FUNNEL_GET_FUNCTION_ID,
  authoringFunnelGetSpec,
} from '../ops/authoring-funnel-get.js'
import type { AuthoringFunnelPortLike } from '../../authoring/funnel.js'
import type { FunctionDeps } from '../spec.js'

// 2026-10-01 (432-23, D-12): attribution only. It once held every scope; there are none to hold.
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

function receipt(digest: string, sessionRef?: string): DraftReceipt {
  return DraftReceiptSchema.parse({
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: `tests/.agent-qa-drafts/${digest}.yaml`,
      testId: `t_${digest}`,
      testName: `draft ${digest}`,
      contentDigest: digest,
    },
    gates: {
      executesDefinitive: { pass: true, runRefs: ['run-1'], indefinitiveRunRefs: [] },
      stableVerdict: {
        pass: true,
        runRefs: ['run-1'],
        distinctOutcomes: ['passed'],
        earlyStopped: false,
      },
      addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
      falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
    },
    stepTable: [],
    gateRuns: [{ runId: 'run-1', memberOutcome: 'passed', definitive: true, healed: false }],
    addsValueFinding: { novelElements: ['el:button:Save'], comparedTests: [] },
    stabilityRunsRequested: 3,
    stabilityRunsCompleted: 3,
    disposition: 'keep-eligible',
    evaluatedAt: 1_700_000_000_000,
    ...(sessionRef === undefined ? {} : { sessionRef }),
  })
}

/** 12 receipts — above the floor of 10. 2026-10-01 (432-17): no acceptance is recorded for any. */
const RECEIPTS = Array.from({ length: 12 }, (_unused, index) => receipt(`d${index}`, 'sess-alpha'))

function funnelPort(): AuthoringFunnelPortLike {
  return {
    receipts: { async list() { return [...RECEIPTS] } },
  }
}

function deps(authoringFunnel?: AuthoringFunnelPortLike): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    ...(authoringFunnel === undefined ? {} : { authoringFunnel }),
  }
}

function registryWith(authoringFunnel?: AuthoringFunnelPortLike) {
  return createFunctionRegistry({
    deps: deps(authoringFunnel),
  })
}

describe(`${AUTHORING_FUNNEL_GET_FUNCTION_ID} — the honesty funnel's one read`, () => {
  // RE-SPELLED 2026-10-01 (432-23, D-12) from 'declares `read` alone and a read-only risk
  // descriptor': the op-spec owner removed the retired scope, so the spec now declares none.
  it('declares no scope and a read-only risk descriptor', () => {
    expect(authoringFunnelGetSpec.id).toBe('authoring.funnel.get')
    expect(authoringFunnelGetSpec).not.toHaveProperty('requiredScopes')
    expect(authoringFunnelGetSpec.risk.readOnly).toBe(true)
    expect(authoringFunnelGetSpec.risk.recognized).toBe(true)
    expect(authoringFunnelGetSpec.boundThrough).toBe('authoringFunnel')
  })

  it('refuses BY NAME from an unbound composition — never an all-zero funnel', async () => {
    await expect(invokeFunction(
      registryWith(),
      AUTHORING_FUNNEL_GET_FUNCTION_ID,
      { window: { scope: 'all-time' } },
      CALLER,
    )).rejects.toThrow(FunctionNotBoundError)

    await expect(invokeFunction(
      registryWith(),
      AUTHORING_FUNNEL_GET_FUNCTION_ID,
      { window: { scope: 'all-time' } },
      CALLER,
    )).rejects.toThrow(AUTHORING_FUNNEL_GET_FUNCTION_ID)
  })

  it('refuses BY NAME on a DIRECT in-layer call too, past the declaration check', async () => {
    await expect(authoringFunnelGetSpec.invoke(
      { window: { scope: 'all-time' } },
      deps(),
    )).rejects.toThrow(FunctionNotBoundError)
  })

  it('answers exactly `computeAuthoringFunnel` over the same receipts — it derives nothing', async () => {
    const answered = await invokeFunction(
      registryWith(funnelPort()),
      AUTHORING_FUNNEL_GET_FUNCTION_ID,
      { window: { scope: 'all-time' } },
      CALLER,
    ) as AuthoringFunnel

    const expected = computeAuthoringFunnel({ receipts: RECEIPTS, sideCounters: {} })

    expect(answered).toEqual(expected)
  })

  // RE-SPELLED 2026-10-02 (quick 261002-ctr): was 'answers no acceptance and no ACCEPTANCE FAILURE
  // through the op, since nothing records one'. The terminal stage reads each receipt's stored
  // disposition, so twelve keep-eligible receipts are twelve write-eligible drafts, above the floor
  // and above the ceiling: the flag fires through the op again.
  it('raises ACCEPTANCE FAILURE through the op over twelve write-eligible receipts', async () => {
    const answered = await invokeFunction(
      registryWith(funnelPort()),
      AUTHORING_FUNNEL_GET_FUNCTION_ID,
      { window: { scope: 'all-time' } },
      CALLER,
    ) as AuthoringFunnel

    expect(answered.stages).toEqual({
      built: 12,
      passedStably: 12,
      addedValue: 12,
      writeEligible: 12,
    })
    expect(answered.acceptanceFailure).toBe(true)
    expect(answered.line).toContain('ACCEPTANCE FAILURE')
  })

  it('scopes by session through the op, excluding a receipt with no ref', async () => {
    const port: AuthoringFunnelPortLike = {
      receipts: {
        async list() {
          return [receipt('with', 'sess-alpha'), receipt('without'), receipt('other', 'sess-beta')]
        },
      },
    }

    const answered = await invokeFunction(
      registryWith(port),
      AUTHORING_FUNNEL_GET_FUNCTION_ID,
      { window: { scope: 'session', sessionRef: 'sess-alpha' } },
      CALLER,
    ) as AuthoringFunnel

    expect(answered.stages.built).toBe(1)
  })

  it('refuses an input carrying anything but the window', async () => {
    await expect(invokeFunction(
      registryWith(funnelPort()),
      AUTHORING_FUNNEL_GET_FUNCTION_ID,
      { window: { scope: 'all-time' }, product: 'shop' },
      CALLER,
    )).rejects.toThrow()
  })
})
