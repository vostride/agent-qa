// An unbound host refuses by name: a zero funnel would read as a loop that filtered everything.

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

// More receipts than the funnel floor, so the flags can fire.
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
