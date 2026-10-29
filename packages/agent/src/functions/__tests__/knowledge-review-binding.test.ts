// The `knowledgeReview` optional dep reports as `unbound` BY NAME (Phase 387 plan 06, Pitfall 2).
//
// 387 ships the read half of the review-verb family; 387-08 ships the mutating half. The claim
// this file pins belongs to the read half all the same, because it is a claim about the
// CONTRACT: a composition that supplies no write capability must list the mutating verbs as a
// visible `unbound` rather than as a hole in the catalog, and a caller must be refused by name
// rather than by a failure somewhere far from the composition that forgot.
//
// WHY A LOCALLY-CONSTRUCTED REGISTRY. The obvious way to prove this is to register a
// placeholder spec in the built-in set and assert its status. That would have been wrong twice
// over: a stub in the default catalog joins all five exact-equality growth seams this workspace
// maintains (`EXPECTED_BINDING_STATUS`, `INVOCATION_SAMPLES`, `CONTRACTS_BY_ID`,
// `ALL_FUNCTION_IDS`, and the CLI's `fn --list` map), and then has to be removed from all five
// again when the real verbs land — so the seams would have recorded a capability that never
// shipped. `createRegistryFromSpecs` builds a registry over an explicit spec set, so the
// MECHANISM is exercised end to end with the catalog untouched. When 387-08 registers the real
// specs, they inherit exactly this behaviour and the growth seams grow once, for real ops.
//
// The spec below is deliberately a fixture and not a draft of a real verb: it is named in a
// domain nothing ships under, so nobody can mistake it for a capability under construction.

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

// RE-SPELLED 2026-10-01 (432-17, D-05): this cell classified `knowledge.proposal.apply`'s policy
// refusal, and that op is deleted with the inbox. The same refusal reaches a caller through the
// direct accept's `refused` arm, and is still a refusal rather than an execution.
it('a policy materialization refusal is classified as refused rather than executed', () => {
  const verdict = knowledgeAcceptSpec.classify({ outcome: 'refused', verb: 'accept',
    operationId: 'policy-fixture-op', reason: 'policy-materialize-refused' })
  expect(verdict.status).toBe('refused')
  expect(verdict.outcome).toContain('policy-materialize-refused')
  expect(verdict.outcome).toContain('nothing was changed')
})

// 2026-10-01 (432-29, D-12): the retired `grantedScopes` and `safeMode` caller fields, the
// fixture spec's `requiredScopes` and the retired `resolveExecutionContext` registry option are
// dropped; nothing read them.
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
  // 399.1-04: `classify` is a REQUIRED member now. A synthetic op's fold is the smallest honest
  // one — the shape has a single arm, so there is nothing to discriminate.
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
  // A FRESH spec object per registry: registration freezes what it is handed (WR-03), and two
  // registries sharing one frozen singleton would still be the same object — which is fine, and
  // is exactly why the copy is worth stating. The point of this file is that ONE spec reports
  // two different statuses in two compositions, so the spec must genuinely be the same contract.
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

  // 432-12 (D-05): the three knowledge changes bind through the SAME optional dep, and reach its
  // direct member. A host with no write port lists them unbound by name and refuses them by name.
  it('the three changes are unbound without the port and reach its direct change with it', async () => {
    const reached: unknown[] = []
    const directPort = {
      // 2026-10-01 (432-17): `propose` and `apply` are deleted from the port; kept here as excess
      // members so "a direct change never reaches them" stays measured.
      propose: () => Promise.reject(new Error('a direct change never proposes')),
      apply: () => Promise.reject(new Error('a direct change never applies a proposal')),
      change: (request: { verb: string }) => {
        reached.push(request)
        return Promise.resolve({
          outcome: 'applied', verb: request.verb,
          operationId: '1e2d3c4b-5a69-4786-9504-a3b2c1d0e9f8', recordIds: ['rec-1'],
          // 2026-10-03 (quick 261003-cpv, IN-21): an applied forget carries its receipt by rule.
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
