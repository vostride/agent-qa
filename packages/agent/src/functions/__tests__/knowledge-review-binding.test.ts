// With no write port, the mutating verbs list as `unbound` and are refused by name.

import {
  FORGET_RECEIPT_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { FunctionNotBoundError, invokeFunction } from '../invoke.js'
import { createFunctionRegistry, createRegistryFromSpecs, resolveBindingStatus } from '../registry.js'
import type { FunctionDeps, FunctionSpec, KnowledgeReviewPort } from '../spec.js'
import { knowledgeAcceptSpec } from '../ops/knowledge-accept-propose.js'

it('a policy materialization refusal is classified as refused rather than executed', () => {
  const verdict = knowledgeAcceptSpec.classify({ outcome: 'refused', verb: 'accept',
    operationId: 'policy-fixture-op', reason: 'policy-materialize-refused' })
  expect(verdict.status).toBe('refused')
  expect(verdict.outcome).toContain('policy-materialize-refused')
  expect(verdict.outcome).toContain('nothing was changed')
})

const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

const FIXTURE_ID = 'fixture.knowledge.review-binding'

/**
 * A spec that dispatches through the write port and nothing else.
 *
 * `boundThrough` is the whole subject: a spec states what its implementation NEEDS, and the
 * composition's answer to that need is what the declaration reports. The body reads the dep it
 * declared so an implementation that forgot to name `boundThrough` would crash rather than
 * silently list as bound — the failure mode a static `'bound'` literal on a spec produces.
 */
const reviewBoundSpec: FunctionSpec<Record<string, never>, string> = {
  id: FIXTURE_ID,
  summary: 'Fixture: a capability that can only run where knowledge review is bound.',
  resultKind: 'unary',
  boundThrough: 'knowledgeReview',
  input: z.object({}).strict(),
  output: z.string(),
  risk: { name: `fn:${FIXTURE_ID}`, recognized: true, readOnly: false },
  // A single-arm shape leaves the fold nothing to discriminate.
  classify: () => ({ status: 'executed' as const, outcome: '' }),
  invoke(_input, deps) {
    const proposalId = deps.knowledgeReview === undefined ? 'no-port' : 'reached-the-port'
    return Promise.resolve(proposalId)
  },
}

/** A review port that answers, so a bound composition is distinguishable from an absent one. */
const reviewPort = {
  propose: () => Promise.reject(new Error('the fixture never proposes')),
  apply: () => Promise.reject(new Error('the fixture never applies')),
} as unknown as KnowledgeReviewPort

function deps(overrides: Partial<FunctionDeps> = {}): FunctionDeps {
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
      showRecord: ({ recordId }) => Promise.resolve({
        kind: 'not-found',
        schemaVersion: 2,
        recordId,
      } as const),
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
    ...overrides,
  }
}

function registryOver(functionDeps: FunctionDeps) {
  // Registration freezes what it is handed, so each registry gets a fresh copy of the one spec.
  return createRegistryFromSpecs([reviewBoundSpec as FunctionSpec], {
    deps: functionDeps,
  })
}

describe('the knowledgeReview optional dep', () => {
  it('lists the capability as unbound in a composition that supplies no write port', () => {
    const declarations = registryOver(deps()).list(CALLER)

    expect(declarations.map((declaration) => declaration.id)).toEqual([FIXTURE_ID])
    expect(declarations[0]!.bindingStatus).toBe('unbound')
  })

  it('lists the SAME spec as bound in a composition that supplies one', () => {
    const declarations = registryOver(deps({ knowledgeReview: reviewPort })).list(CALLER)

    expect(declarations[0]!.bindingStatus).toBe('bound')
  })

  it('refuses an unbound invocation BY NAME rather than failing inside the op', async () => {
    const registry = registryOver(deps())

    const error = await invokeFunction(registry, FIXTURE_ID, {}, CALLER).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(FunctionNotBoundError)
    expect((error as FunctionNotBoundError).functionId).toBe(FIXTURE_ID)
    // The distinction that matters: this is NOT `UnknownFunctionError`. The contract exists,
    // is listed, and projects into a catalog — what is absent is the binding.
    expect((error as Error).message).toContain(FIXTURE_ID)
  })

  it('dispatches to the op once the port is supplied, reaching the dep it declared', async () => {
    const registry = registryOver(deps({ knowledgeReview: reviewPort }))

    // `reached-the-port` is only producible by an invoke that was handed the port. An op that
    // listed bound and then found `undefined` would answer `no-port` here, which is the exact
    // disagreement between a listing and a dispatch that one shared `resolveBindingStatus`
    // exists to make impossible.
    expect(await invokeFunction(registry, FIXTURE_ID, {}, CALLER)).toBe('reached-the-port')
  })

  it('the three changes are unbound without the port and reach its direct change with it', async () => {
    const reached: unknown[] = []
    const directPort = {
      // Excess `propose` and `apply` members, so "a direct change never reaches them" is measured.
      propose: () => Promise.reject(new Error('a direct change never proposes')),
      apply: () => Promise.reject(new Error('a direct change never applies a proposal')),
      change: (request: { verb: string }) => {
        reached.push(request)
        return Promise.resolve({
          outcome: 'applied', verb: request.verb,
          operationId: '1e2d3c4b-5a69-4786-9504-a3b2c1d0e9f8', recordIds: ['rec-1'],
          // An applied forget carries its receipt.
          ...(request.verb === 'forget'
            ? {
              forgetReceipt: {
                schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION, proposalId: 'prop_alpha-bravo', tombstonedRecords: [],
                projectionsScrubbed: ['fts'], resultingBundleStatus: 'forgotten', forgottenAt: 1,
              },
            }
            : {}),
        })
      },
    } as unknown as KnowledgeReviewPort
    const writer: FunctionCaller = CALLER
    const readOnly = createFunctionRegistry({ deps: deps() })
    const bound = createFunctionRegistry({
      deps: deps({ knowledgeReview: directPort }),
    })
    const inputs = {
      'knowledge.accept': { target: { grain: 'record', recordId: 'rec-1' } },
      'knowledge.reject': { target: { grain: 'record', recordId: 'rec-1' }, reason: 'wrong' },
      'knowledge.forget': { target: { grain: 'record', recordId: 'rec-1' } },
    } as const

    for (const [id, input] of Object.entries(inputs)) {
      const listedReadOnly = readOnly.list(writer).find((row) => row.id === id)
      const listedBound = bound.list(writer).find((row) => row.id === id)
      expect(listedReadOnly?.bindingStatus, `${id} without a port`).toBe('unbound')
      expect(listedBound?.bindingStatus, `${id} with a port`).toBe('bound')

      const refused = await invokeFunction(readOnly, id, input, writer).then(
        () => undefined, (thrown: unknown) => thrown,
      )
      expect(refused, id).toBeInstanceOf(FunctionNotBoundError)
      const answered = await invokeFunction(bound, id, input, writer).then(
        (value) => value, (thrown: unknown) => thrown,
      )
      expect(answered, id).toMatchObject({ outcome: 'applied', verb: id.split('.')[1] })
    }
    expect(reached.map((request) => (request as { verb: string }).verb)).toEqual(['accept', 'reject', 'forget'])
  })

  it('answers the binding question the same way for a listing and for a dispatch', () => {
    expect(resolveBindingStatus(reviewBoundSpec as FunctionSpec, deps())).toBe('unbound')
    expect(
      resolveBindingStatus(reviewBoundSpec as FunctionSpec, deps({ knowledgeReview: reviewPort })),
    ).toBe('bound')
  })
})
