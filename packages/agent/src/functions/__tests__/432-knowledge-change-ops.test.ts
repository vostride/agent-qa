// The three knowledge changes apply in the call (432-12, D-02/D-05/D-09).
//
// `knowledge.accept`, `knowledge.reject` and `knowledge.forget` replace the three `*.propose` ops.
// Each validates its input, hands the port ONE direct change request and answers what the port
// applied. Nothing is proposed, and the retired ids are not aliases: they are unknown functions.
//
// The port here is a recording double, so every cell measures the op contract and the dispatch,
// not the writer. The real writer through the local composition is measured in agent-local's
// `review-verbs.test.ts`; the real MCP catalogue, disk and readback in the CLI's
// `mcp-apply-differential.test.ts`.

import * as schema from '@vostride/agent-qa-schema'
import {
  FORGET_RECEIPT_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { ExecutionContext, FunctionCaller } from '@vostride/agent-qa-schema'
import { getActiveExecutionContext, setActiveExecutionContextResolver } from '@vostride/agent-qa-safety'
import { describe, expect, it } from 'vitest'

import { FunctionInputError, UnknownFunctionError, invokeFunction } from '../invoke.js'
import { createFunctionRegistry } from '../registry.js'
import type { FunctionDeps, KnowledgeReviewPort } from '../spec.js'

/** A caller with no credential: the anonymous MCP caller a tokenless host will mint. */
const TOKENLESS_CALLER: FunctionCaller = {
  surface: 'mcp',
  origin: 'agent',
}

const CONTEXTS: readonly ExecutionContext[] = ['local-interactive', 'local-headless', 'ci', 'cloud']

const RECORD = { grain: 'record', recordId: 'rec-direct-1' } as const

// 2026-10-03 (quick 261003-cpv, IN-21): an applied forget carries its forget receipt by rule.
const FORGET_RECEIPT = {
  schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION,
  proposalId: 'prop_alpha-bravo',
  tombstonedRecords: [],
  projectionsScrubbed: ['fts'],
  resultingBundleStatus: 'forgotten',
  forgottenAt: 1,
} as const

const CHANGE_IDS = ['knowledge.accept', 'knowledge.reject', 'knowledge.forget'] as const

const RETIRED_IDS = [
  'knowledge.accept.propose',
  'knowledge.reject.propose',
  'knowledge.forget.propose',
] as const

type ChangeRequest = {
  readonly verb: string
  readonly input: Record<string, unknown>
  readonly operationId?: string
}

interface RecordingPort {
  readonly port: KnowledgeReviewPort
  readonly changes: ChangeRequest[]
  readonly proposes: unknown[]
  readonly applies: unknown[]
}

/**
 * The double answers the receipt the direct writer would: the records it changed, keyed on the
 * identity it was handed, so a retried identity answers the same receipt.
 */
function recordingPort(answer?: (request: ChangeRequest) => unknown): RecordingPort {
  const changes: ChangeRequest[] = []
  const proposes: unknown[] = []
  const applies: unknown[] = []
  const port = {
    propose: (...args: unknown[]) => {
      proposes.push(args)
      return Promise.reject(new Error('a direct change never proposes'))
    },
    apply: (...args: unknown[]) => {
      applies.push(args)
      return Promise.reject(new Error('a direct change never applies a proposal'))
    },
    change: (request: ChangeRequest) => {
      changes.push(request)
      if (answer !== undefined) return Promise.resolve(answer(request))
      return Promise.resolve({
        outcome: 'applied',
        verb: request.verb,
        operationId: request.operationId ?? '4f1c2a8e-0000-4000-8000-00000000c0de',
        recordIds: [(request.input['target'] as { recordId: string }).recordId],
        ...(request.verb === 'forget' ? { forgetReceipt: FORGET_RECEIPT } : {}),
      })
    },
  } as unknown as KnowledgeReviewPort
  return { port, changes, proposes, applies }
}

function deps(knowledgeReview: KnowledgeReviewPort): FunctionDeps {
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
      getMasked: () =>
        Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [],
        }),
    },
    knowledgeReview,
  }
}

// 2026-10-02 (432-39, D-12): the registry takes no context.
// 2026-10-03 (quick-261003-tsr, IN-06): the unread `_context` parameter is dropped; the cell that
// varies the context sets it through the ambient resolver every reader of it uses.
function registry(port: KnowledgeReviewPort) {
  return createFunctionRegistry({
    deps: deps(port),
  })
}

/** Settle a call into a value, so a refusal fails a cell on its own assertion rather than a throw. */
async function settled(call: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await call }
  } catch (error) {
    return { error }
  }
}

function inputFor(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return id.startsWith('knowledge.reject')
    ? { target: RECORD, reason: 'the checkout button moved', ...extra }
    : { target: RECORD, ...extra }
}

function verbOf(id: string): string {
  return id.split('.')[1]!
}

describe('C432-KNOWLEDGE-CHANGE-OPS: the three knowledge changes apply in the call', () => {
  it('C432-KNOWLEDGE-CHANGE-OPS: each op hands the port one direct change and answers what it applied', async () => {
    for (const id of CHANGE_IDS) {
      const recording = recordingPort()
      const outcome = await settled(
        invokeFunction(registry(recording.port), id, inputFor(id), TOKENLESS_CALLER),
      )

      expect(outcome.error, `${id} must be registered and applied`).toBeUndefined()
      const { reason, ...verbInput } = inputFor(id) as { reason?: string }
      expect(recording.changes, id).toEqual([{
        verb: verbOf(id),
        input: reason === undefined ? verbInput : { ...verbInput, reason },
      }])
      // Nothing is proposed and no proposal is applied: the change IS the call.
      expect(recording.proposes, id).toEqual([])
      expect(recording.applies, id).toEqual([])
      expect(outcome.value, id).toMatchObject({
        outcome: 'applied',
        verb: verbOf(id),
        recordIds: [RECORD.recordId],
      })
    }
  })

  it('C432-KNOWLEDGE-CHANGE-OPS: the retired propose ids are unknown functions, with no alias', async () => {
    for (const id of RETIRED_IDS) {
      const recording = recordingPort()
      const outcome = await settled(
        invokeFunction(registry(recording.port), id, inputFor(id), TOKENLESS_CALLER),
      )
      expect(outcome.error, `${id} must not dispatch`).toBeInstanceOf(UnknownFunctionError)
      expect(recording.changes).toEqual([])
      expect(recording.proposes).toEqual([])
    }
  })

  it('C432-KNOWLEDGE-CHANGE-OPS: a tokenless caller changes knowledge in every execution context', async () => {
    // This process installs no ambient resolver, so the value read before is what is put back.
    const ambient = getActiveExecutionContext()
    try {
      for (const context of CONTEXTS) {
        setActiveExecutionContextResolver(() => context)
        expect(getActiveExecutionContext()).toBe(context)
        const recording = recordingPort()
        const outcome = await settled(invokeFunction(
          registry(recording.port),
          'knowledge.forget',
          { target: RECORD },
          TOKENLESS_CALLER,
        ))
        expect(outcome.error, `forget in ${context}`).toBeUndefined()
        expect(outcome.value, context).toMatchObject({ outcome: 'applied', verb: 'forget' })
        expect(recording.changes, context).toHaveLength(1)
      }
    } finally {
      setActiveExecutionContextResolver(() => ambient)
    }
  })

  it('C432-KNOWLEDGE-CHANGE-OPS: a caller identity is forwarded unchanged, so a retry repeats one change', async () => {
    const operationId = '7d3f9b1e-5c2a-4e8b-9f61-0a4b2c6d8e10'
    const recording = recordingPort()
    const host = registry(recording.port)

    const first = await settled(invokeFunction(
      host, 'knowledge.accept', { target: RECORD, operationId }, TOKENLESS_CALLER,
    ))
    const retry = await settled(invokeFunction(
      host, 'knowledge.accept', { target: RECORD, operationId }, TOKENLESS_CALLER,
    ))

    expect(first.error).toBeUndefined()
    expect(retry.value).toEqual(first.value)
    expect(recording.changes).toEqual([
      { verb: 'accept', input: { target: RECORD }, operationId },
      { verb: 'accept', input: { target: RECORD }, operationId },
    ])
    expect(first.value).toMatchObject({ outcome: 'applied', operationId })
  })

  it('C432-KNOWLEDGE-CHANGE-OPS: malformed and empty ids are refused at the boundary, before the port', async () => {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['knowledge.accept', { target: { grain: 'record', recordId: '' } }],
      ['knowledge.forget', { target: { grain: 'bundle', shortId: 'TST-001' } }],
      ['knowledge.forget', { target: { grain: 'bundle', shortId: '' } }],
      ['knowledge.reject', { target: RECORD, reason: '' }],
      ['knowledge.reject', { target: RECORD }],
      ['knowledge.accept', { target: RECORD, operationId: '' }],
      ['knowledge.accept', { target: RECORD, operationId: 'has space' }],
      ['knowledge.accept', { target: RECORD, operationId: '../escape' }],
      ['knowledge.accept', { target: RECORD, proposalId: 'prop_0123456789ab' }],
      ['knowledge.accept', { target: RECORD, confirmed: true }],
    ]
    for (const [id, input] of cases) {
      const recording = recordingPort()
      const outcome = await settled(invokeFunction(registry(recording.port), id, input, TOKENLESS_CALLER))
      expect(outcome.error, `${id} ${JSON.stringify(input)}`).toBeInstanceOf(FunctionInputError)
      expect(recording.changes, `${id} ${JSON.stringify(input)}`).toEqual([])
    }
  })

  it('C432-KNOWLEDGE-CHANGE-OPS: absence and refusal are answers; a proposal envelope is not a receipt', async () => {
    const notFound = recordingPort((request) => ({
      outcome: 'target-not-found',
      verb: request.verb,
      operationId: request.operationId ?? '4f1c2a8e-0000-4000-8000-00000000c0de',
      target: request.input['target'],
    }))
    expect(await settled(invokeFunction(
      registry(notFound.port), 'knowledge.accept', { target: RECORD }, TOKENLESS_CALLER,
    ))).toMatchObject({ value: { outcome: 'target-not-found', target: RECORD } })

    const refused = recordingPort((request) => ({
      outcome: 'refused',
      verb: request.verb,
      operationId: request.operationId ?? '4f1c2a8e-0000-4000-8000-00000000c0de',
      reason: 'policy-materialize-refused',
    }))
    expect(await settled(invokeFunction(
      registry(refused.port), 'knowledge.accept', { target: RECORD }, TOKENLESS_CALLER,
    ))).toMatchObject({ value: { outcome: 'refused', reason: 'policy-materialize-refused' } })

    // A port that still answered a proposal would fail the op's own declared output.
    const envelope = recordingPort(() => ({
      kind: 'proposed',
      proposal: {
        schemaVersion: 1, proposalId: 'prop_0123456789ab', verb: 'accept', targetRef: RECORD,
        deltas: [], proposedAt: 1, status: 'pending',
      },
    }))
    const answered = await settled(invokeFunction(
      registry(envelope.port), 'knowledge.accept', { target: RECORD }, TOKENLESS_CALLER,
    ))
    expect(answered.value).toBeUndefined()
    expect(answered.error).toBeInstanceOf(Error)
    expect(envelope.changes).toHaveLength(1)

    const contract = (schema as Record<string, unknown>)['KnowledgeChangeOutputSchema'] as
      | { safeParse(value: unknown): { success: boolean } }
      | undefined
    expect(contract, 'the direct change receipt contract is exported').toBeDefined()
    expect(contract?.safeParse({ kind: 'proposed', proposal: {} }).success).toBe(false)
  })

  // RE-TITLED 2026-10-03 (quick-261003-tsr, IN-06): was '…declares the direct contract, a
  // knowledge-write scope and a local mutation'. Scopes are deleted; the title says what is read.
  it('each op is bound and declares a recognized, non-read-only risk with no origin requirement', () => {
    const declarations = new Map(
      registry(recordingPort().port).list(TOKENLESS_CALLER).map((row) => [row.id, row]),
    )
    for (const id of CHANGE_IDS) {
      const declaration = declarations.get(id)
      expect(declaration, id).toBeDefined()
      expect(declaration?.bindingStatus, id).toBe('bound')
      expect(declaration?.risk, id).toMatchObject({ name: `fn:${id}`, recognized: true, readOnly: false })
      // 432-20 (D-10): declarations carry no origin requirement at all.
      expect(Object.keys(declaration ?? {}), id).not.toContain('requiresHumanOrigin')
      expect(declaration?.summary, id).not.toMatch(/propos|commit(s|ting)? nothing|removing nothing/i)
    }
  })
})

describe('C432-RUNTIME-SETS: the registry carries the direct knowledge ids and not the retired ones', () => {
  // 2026-10-01 (432-17, D-05): the pre-432 apply is deleted with the inbox, and leaves the set.
  it('C432-RUNTIME-SETS: knowledge ids registered are exactly the reads and the three changes', () => {
    const ids = registry(recordingPort().port).list(TOKENLESS_CALLER).map((row) => row.id)
    const knowledge = ids.filter((id) => id.startsWith('knowledge.')).sort()
    expect(knowledge).toEqual([
      'knowledge.accept',
      'knowledge.brief.why',
      'knowledge.bundles.list',
      'knowledge.forget',
      'knowledge.gates.list',
      'knowledge.record.show',
      'knowledge.records.diff',
      'knowledge.records.inspect',
      'knowledge.reject',
    ])
    for (const retired of RETIRED_IDS) expect(ids, retired).not.toContain(retired)
    expect(ids).not.toContain('knowledge.proposal.apply')
  })
})
