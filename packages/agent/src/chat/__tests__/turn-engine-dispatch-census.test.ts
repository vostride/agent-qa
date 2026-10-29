// Every carried-out clause must cross the `ChatInvokeBinding`: one spy call per receipt, in order.

import { describe, expect, it } from 'vitest'

import { CURRENT_CHAT_SESSION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatSessionEvent,
  ChatSessionHandle,
  ChatSessionHeader,
  FunctionCaller,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import { AUTHORING_DRAFT_WRITE_FUNCTION_ID } from '../../functions/ops/authoring-draft-write.js'
import { CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID } from '../../functions/ops/config-project-scaffold.js'
import { createFunctionRegistry } from '../../functions/registry.js'
import type { FunctionDeps } from '../../functions/spec.js'
import { splitClauses } from '../clause-split.js'
import type { ChatBindingStage, PlannerStageOutcome, PlannerStagePort } from '../ports.js'
import { deterministicOverrideStrategy } from '../reconcile.js'
import { CHAT_RESOLVER_TABLE } from '../resolver-table.js'
import { toToolName } from '../tool-names.js'
import { createTurnEngine } from '../turn-engine.js'
import type { TurnEngineDeps } from '../turn-engine.js'

const HUMAN: FunctionCaller = { surface: 'chat', origin: 'human' }
const AGENT: FunctionCaller = { surface: 'chat', origin: 'agent' }

/** Every op the shipped registry declares; the deps are never dispatched through. */
const REGISTRY_IDS: readonly string[] = createFunctionRegistry({
  deps: {} as unknown as FunctionDeps,
})
  .list(HUMAN)
  .map((declaration) => declaration.id)

/** Statuses a receipt carries for a clause that was ATTEMPTED; `not-run` is the one that was not. */
const ATTEMPTED = new Set(['executed', 'refused', 'failed'])

interface Census {
  readonly invoked: string[]
  readonly events: ChatSessionEvent[]
  run(message: string): Promise<AgentAskResult>
}

function census(options: {
  readonly planned?: (clauses: readonly string[]) => PlannerStageOutcome
  readonly targets?: readonly string[]
} = {}): Census {
  const invoked: string[] = []
  const events: ChatSessionEvent[] = []
  const header: ChatSessionHeader = {
    schemaVersion: CURRENT_CHAT_SESSION_SCHEMA_VERSION,
    sessionId: 'chat-census-session',
    createdAt: '1970-01-01T00:00:00.000Z',
    model: 'unbound',
    toolsetHash: 'hash-0',
  }
  const sessionLog: SessionLogPort = {
    open: (): Promise<ChatSessionHandle> => Promise.resolve({
      header,
      events: [...events],
      refusedLines: [],
      append: (event: ChatSessionEvent) => {
        events.push(event)
        return Promise.resolve()
      },
      turnBoundary: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }),
  }
  const planner: PlannerStagePort | undefined = options.planned === undefined
    ? undefined
    : { plan: ({ clauses }) => Promise.resolve(options.planned!(clauses.map((clause) => clause.text))) }
  let clock = 0
  const deps: TurnEngineDeps = {
    table: CHAT_RESOLVER_TABLE,
    split: splitClauses,
    reconcile: deterministicOverrideStrategy,
    sessionLog,
    mint: { forStage: (stage: ChatBindingStage) => (stage === 'resolver' ? HUMAN : AGENT) },
    invoke: (functionId) => {
      invoked.push(functionId)
      const payload = functionId === CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID
        ? {
          outcome: 'applied',
          summaryLine: 'configure this project for https://booking.com as target booking-com',
          files: ['agent-qa.config.yaml'],
        }
        : { ok: true }
      const verdict = { status: 'executed' as const, outcome: '' }
      return Promise.resolve({ payload, verdict, foldLines: [] })
    },
    ...(planner === undefined ? {} : { planner }),
    ...(options.targets === undefined
      ? {}
      : { configuredTargets: () => Promise.resolve(options.targets as readonly string[]) }),
    now: () => {
      clock += 1
      return new Date(clock * 1000).toISOString()
    },
    mintTurnId: () => 'turn-census',
  }
  const engine = createTurnEngine(deps)
  return { invoked, events, run: (message) => engine.runTurn({ message }) }
}

/** The ops the session log says were carried out, in the order it recorded them. */
function carriedOut(events: readonly ChatSessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === 'clause_receipt' && ATTEMPTED.has(event.status) ? [event.functionId] : [])
}

async function expectOneInvokePerClause(
  target: Census,
  message: string,
  expected: readonly string[],
): Promise<AgentAskResult> {
  const result = await target.run(message)
  expect(result.status, `${message}: ${JSON.stringify(result.unhandled ?? null)}`).toBe('completed')
  expect(carriedOut(target.events), message).toEqual(expected)
  expect(target.invoked, `${message}: a carried-out clause bypassed deps.invoke`).toEqual(expected)
  return result
}

describe('C-HYG-CHAT-DISPATCH-CENSUS — every clause chat carries out crosses deps.invoke', () => {
  it('C-HYG-CHAT-DISPATCH-CENSUS: the registry is the census denominator', () => {
    expect(REGISTRY_IDS.length).toBeGreaterThanOrEqual(40)
    expect(REGISTRY_IDS).toContain('quarantine.list')
    expect(REGISTRY_IDS).toContain('config.get')
  })

  it.each(REGISTRY_IDS)(
    'C-HYG-CHAT-DISPATCH-CENSUS: `/fn %s` reaches deps.invoke exactly once',
    async (functionId) => {
      const target = census()
      const result = await expectOneInvokePerClause(target, `/fn ${functionId}`, [functionId])
      expect(result.receipts.map((receipt) => receipt.functionId)).toEqual([functionId])
    },
  )

  it.each([
    ['run tests/login.yaml', 'runs.start'],
    ['status', 'runs.list'],
    ['test 42', 'entities.resolve'],
    ['digest RUN-1', 'runs.digest'],
  ] as const)(
    'C-HYG-CHAT-DISPATCH-CENSUS: the table alias `%s` reaches deps.invoke exactly once (%s)',
    async (message, functionId) => {
      await expectOneInvokePerClause(census(), message, [functionId])
    },
  )

  it('C-HYG-CHAT-DISPATCH-CENSUS: a compound utterance dispatches each clause once, in order', async () => {
    await expectOneInvokePerClause(
      census(),
      '/fn quarantine.list and status and /fn config.get',
      ['quarantine.list', 'runs.list', 'config.get'],
    )
  })

  it('C-HYG-CHAT-DISPATCH-CENSUS: a planner-bound clause dispatches once beside a table clause', async () => {
    const target = census({
      planned: () => ({ toolCalls: [{ toolName: toToolName('quarantine.list'), input: {} }] }),
    })
    await expectOneInvokePerClause(
      target,
      'status and show me what is quarantined',
      ['runs.list', 'quarantine.list'],
    )
  })

  it('C-HYG-CHAT-DISPATCH-CENSUS: the write_test route scaffolds and authors via deps.invoke', async () => {
    const target = census({
      targets: [],
      planned: (clauses) => ({
        toolCalls: clauses.map((intent) => ({
          toolName: toToolName(AUTHORING_DRAFT_WRITE_FUNCTION_ID),
          input: { intent },
        })),
      }),
    })
    await expectOneInvokePerClause(
      target,
      'write a test for booking.com checkout',
      [CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID, AUTHORING_DRAFT_WRITE_FUNCTION_ID],
    )
  })
})
