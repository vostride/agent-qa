// The planner and dispatch seats are doubles so effects can be counted; the routing is real.

import { describe, expect, it } from 'vitest'

import type {
  AgentAskInput,
  AgentAskResult,
  AuthoringDraftWriteOutput,
  ChatSessionEvent,
  ChatSessionHandle,
  ChatSessionHeader,
  FunctionCaller,
  QuarantineListOutput,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import {
  AuthoringDraftWriteOutputSchema,
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  FAN_OUT_PHRASES,
  QuarantineListOutputSchema,
  buildFanOutReport,
  computeFanOutBound,
  renderFanOutReport,
} from '@vostride/agent-qa-schema'

import {
  AUTHORING_DRAFT_WRITE_FUNCTION_ID,
  authoringDraftWriteSpec,
} from '../../functions/ops/authoring-draft-write.js'
import { AUTHORING_DRAFT_VERIFY_FUNCTION_ID } from '../../functions/ops/authoring-verify-draft.js'
import { AUTHORING_FUNNEL_GET_FUNCTION_ID } from '../../functions/ops/authoring-funnel-get.js'
import { foldFunctionResult } from '../../functions/classify.js'
import { quarantineListSpec } from '../../functions/ops/quarantine-list.js'
import { createRegistryFromSpecs } from '../../functions/registry.js'
import type { FunctionDeps, FunctionSpec } from '../../functions/spec.js'
import { CHAT_RESOLVER_TABLE } from '../resolver-table.js'
import { deterministicOverrideStrategy } from '../reconcile.js'
import { splitClauses } from '../clause-split.js'
import { createTurnEngine } from '../turn-engine.js'
import type { TurnEngineDeps } from '../turn-engine.js'
import { toToolName } from '../tool-names.js'
import type {
  ChatBindingStage,
  ChatDirectiveHandlers,
  ChatModelDirectiveOutcome,
  PlannerStageOutcome,
  PlannerStagePort,
  ReconcileStrategy,
} from '../ports.js'
import type { ChatConfigState } from '../config-drift.js'

// A read op with an `output.entries.length` classifier over an `{ entries }` shape.
const PROPOSALS_LIST = 'quarantine.list'
const RUNS_LIST = 'runs.list'
const RUNS_DIGEST = 'runs.digest'

const RESOLVER_CALLER: FunctionCaller = {
  surface: 'chat',
  origin: 'human',
}

const PLANNER_CALLER: FunctionCaller = {
  surface: 'chat',
  origin: 'agent',
}

// A refusal shape `invokeFunction` publishes, as a scripted stand-in with the same name.
class FunctionInputError extends Error {
  override readonly name = 'FunctionInputError'
}

interface MemoryLog extends SessionLogPort {
  readonly events: ChatSessionEvent[]
  boundaries: number
  /** How many handles this log handed out, and how many came back. */
  opens: number
  closes: number
}

function memoryLog(): MemoryLog {
  const events: ChatSessionEvent[] = []
  const header: ChatSessionHeader = {
    schemaVersion: CURRENT_CHAT_SESSION_SCHEMA_VERSION,
    sessionId: 'chat-test-session',
    createdAt: '1970-01-01T00:00:00.000Z',
    model: 'unbound',
    toolsetHash: 'hash-0',
  }
  // Write verbs come from `open()` scoped to the session, so a turn has no log-level append.
  const log: MemoryLog = {
    events,
    boundaries: 0,
    opens: 0,
    closes: 0,
    open(): Promise<ChatSessionHandle> {
      log.opens += 1
      return Promise.resolve({
        header,
        events: [...events],
        refusedLines: [],
        append(event: ChatSessionEvent): Promise<void> {
          events.push(event)
          return Promise.resolve()
        },
        turnBoundary(): Promise<void> {
          log.boundaries += 1
          return Promise.resolve()
        },
        close(): Promise<void> {
          log.closes += 1
          return Promise.resolve()
        },
      })
    },
  }
  return log
}

interface Invocation {
  readonly functionId: string
  readonly input: unknown
  readonly caller: FunctionCaller
}

interface Harness {
  readonly log: MemoryLog
  readonly invocations: Invocation[]
  readonly ordering: string[]
  readonly plannerCalls: number
  // What `/model` was asked to switch to; empty means the refused turn ran no directive.
  readonly modelCalls: string[]
  runTurn(input: AgentAskInput): Promise<AgentAskResult>
}

interface HarnessOptions {
  readonly planned?: PlannerStageOutcome
  readonly failOn?: string
  readonly reconcile?: ReconcileStrategy
  readonly compaction?: boolean
  // A directive never travels the function layer, so its effects need their own seat.
  readonly directives?: boolean
  // The `/model` argument the spy refuses in pre-flight, so a batch can hold a directive saying no.
  readonly unresolvableModel?: string
  // The fan-out report is the one result that reaches a rendered line, so the seat can answer it.
  readonly results?: Readonly<Record<string, unknown>>
  // One timestamp for every event, so order must come from the utterance, not a clock.
  readonly fixedClock?: boolean
}

// The real specs, not stand-ins: a copied disclosure would agree with itself as the fold drifts.
const FOLD_REGISTRY = createRegistryFromSpecs(
  [authoringDraftWriteSpec as FunctionSpec, quarantineListSpec as FunctionSpec],
  {
    // Never dispatched through: this harness calls the ops itself and hands the registry only the
    // RETURN path, which is where folds run.
    deps: {} as unknown as FunctionDeps,
  },
)

const FOLD_IDS: ReadonlySet<string> = new Set(
  [AUTHORING_DRAFT_WRITE_FUNCTION_ID, PROPOSALS_LIST],
)

// Parsed through the output contract, so a fixture the classifier cannot produce fails here.
const PROPOSALS_LIST_RESULT: QuarantineListOutput = QuarantineListOutputSchema.parse({ entries: [] })

/**
 * What the invoke seat answers when a cell did not say — per op, because ops now read their results.
 *
 * `{ ok: true }` remains the answer for every op OUTSIDE `FOLD_IDS`: nothing folds those here, so
 * the value is never read and a produced fixture for each would be ceremony. The ops that ARE
 * folded get a real one.
 */
function defaultResultFor(functionId: string): unknown {
  return functionId === PROPOSALS_LIST ? PROPOSALS_LIST_RESULT : { ok: true }
}

function harness(options: HarnessOptions = {}): Harness {
  const log = memoryLog()
  const invocations: Invocation[] = []
  const ordering: string[] = []
  const modelCalls: string[] = []
  let plannerCalls = 0
  // The model the session is under RIGHT NOW. The `/model` handler moves it and the config thunk
  // reads it back, which is the shape production has: the handler applies the override and the
  // re-read is what the diff calls `to`. A fixed value here would emit no `model_change` at all and
  // the zero-event assertions below would be vacuous.
  let activeModel = 'unbound'

  const planner: PlannerStagePort | undefined =
    options.planned === undefined
      ? undefined
      : {
          plan: (): Promise<PlannerStageOutcome> => {
            plannerCalls += 1
            ordering.push('planner')
            return Promise.resolve(options.planned as PlannerStageOutcome)
          },
        }

  let clock = 0
  const deps: TurnEngineDeps = {
    table: CHAT_RESOLVER_TABLE,
    split: splitClauses,
    reconcile: options.reconcile ?? deterministicOverrideStrategy,
    sessionLog: log,
    mint: {
      forStage: (stage: ChatBindingStage): FunctionCaller =>
        stage === 'resolver' ? RESOLVER_CALLER : PLANNER_CALLER,
    },
    invoke: (functionId, input, caller) => {
      ordering.push(`invoke:${functionId}`)
      invocations.push({ functionId, input, caller })
      if (functionId === options.failOn) return Promise.reject(new FunctionInputError('refused'))
      // `FOLD_REGISTRY` runs `foldFunctionResult`; other ops keep the unclassified envelope.
      const payload = options.results?.[functionId] ?? defaultResultFor(functionId)
      if (!FOLD_IDS.has(functionId)) {
        return Promise.resolve({
          payload,
          verdict: { status: 'executed' as const, outcome: '' },
          foldLines: [],
        })
      }
      return Promise.resolve({ payload, ...foldFunctionResult(FOLD_REGISTRY, functionId, payload) })
    },
    ...(planner === undefined ? {} : { planner }),
    ...(options.directives === true
      ? {
          config: (): ChatConfigState => ({ model: activeModel, toolset: { hash: 'hash-0' } }),
          // A factory, as the engine asks; this harness runs one session, so it ignores the id.
          directives: (): ChatDirectiveHandlers => ({
            // THE BATCH PRE-FLIGHT, mirroring the composition: it asks the same question `model`
            // answers and records NOTHING, so a turn whose second directive is unresolvable is
            // refused before the first one is applied. A fixture whose validate accepted
            // everything would leave the engine's new pass unexercised on the arm it exists for.
            validate: (directive, argument): void => {
              ordering.push('directive:validate')
              if (directive === 'model' && argument === options.unresolvableModel) {
                throw new Error(`Cannot switch to "${argument ?? ''}": this host cannot resolve it`)
              }
            },
            model: (name: string): ChatModelDirectiveOutcome => {
              ordering.push('directive:model')
              modelCalls.push(name)
              const from = activeModel
              activeModel = name
              return { from, to: name, line: `model: ${name}` }
            },
          }),
        }
      : {}),
    ...(options.compaction === true
      ? {
          compaction: (): void => {
            ordering.push('compaction')
          },
        }
      : {}),
    now: () => {
      if (options.fixedClock === true) return '1970-01-01T00:00:00.000Z'
      clock += 1
      return `1970-01-01T00:00:0${String(clock)}.000Z`
    },
    mintTurnId: () => 'turn-fixed',
  }

  const engine = createTurnEngine(deps)
  return {
    log,
    invocations,
    ordering,
    modelCalls,
    get plannerCalls() {
      return plannerCalls
    },
    runTurn: (input) => engine.runTurn(input),
  }
}

function kindsOf(events: readonly ChatSessionEvent[]): string[] {
  return events.map((event) => event.kind)
}

describe('turn engine stage 3/4: atomicity, ordered execution, receipts, per-stage origins', () => {
  describe('a fail-closed verdict costs the turn everything and executes nothing', () => {
    it('performs ZERO invocations when a clause is unroutable', async () => {
      const run = harness()
      const result = await run.runTurn({ message: '/fn quarantine.list and write a test for two factor auth' })

      expect(result.status).toBe('fail_closed')
      // The clause that could have run did not, because the verdict precedes every effect.
      expect(run.invocations).toHaveLength(0)
      expect(result.receipts).toHaveLength(0)
      expect(result.unhandled?.clause).toBe('write a test for two factor auth')
    })

    it('appends a mark_unhandled event naming the clause', async () => {
      const run = harness()
      await run.runTurn({ message: '/fn quarantine.list and write a test for two factor auth' })

      const unhandled = run.log.events.find((event) => event.kind === 'mark_unhandled')
      expect(unhandled).toBeDefined()
      expect(unhandled).toMatchObject({
        kind: 'mark_unhandled',
        turnId: 'turn-fixed',
        clause: 'write a test for two factor auth',
      })
      // The log is the triage report: the refusal's REASON is on the line, not only in the
      // return value a caller may never persist.
      expect(unhandled?.kind === 'mark_unhandled' ? unhandled.reason : '').toContain(
        'write a test for two factor auth',
      )
    })

    it('appends a mark_unhandled event for a directive with no handler bound', async () => {
      const run = harness()
      const result = await run.runTurn({ message: '/model claude-fixture' })

      expect(result.status).toBe('fail_closed')
      expect(run.invocations).toHaveLength(0)
      const unhandled = run.log.events.find((event) => event.kind === 'mark_unhandled')
      expect(unhandled).toMatchObject({ kind: 'mark_unhandled', clause: '/model claude-fixture' })
    })

    it('refuses whole when the MODEL marked a clause unhandled, even mid-plan', async () => {
      const run = harness({
        planned: {
          toolCalls: [
            {
              toolName: 'mark_unhandled',
              input: { clause: 'file an issue for it', reason: 'no issue capability has shipped.' },
            },
          ],
        },
      })
      const result = await run.runTurn({ message: '/fn quarantine.list and file an issue for it' })

      expect(result.status).toBe('fail_closed')
      expect(run.invocations).toHaveLength(0)
      expect(run.log.events.filter((event) => event.kind === 'mark_unhandled')).toHaveLength(1)
    })
  })

  // A directive never travels the function layer, so these cases measure the directive seat.
  describe('no directive side effect precedes the reconciliation verdict', () => {
    it('records NO approval row when a turn naming the retired /pin is refused', async () => {
      const run = harness({ directives: true })
      const result = await run.runTurn({
        message: '/pin fn:runs.start and write a test for 2FA',
      })

      // ONE assertion over three facts, deliberately: the STATUS was already right before this fix
      // and the effects were already wrong, so a suite that asserted them in sequence would report
      // the defect one line at a time and hide how the facts read together.
      expect({
        status: result.status,
        invoked: run.invocations.length,
        approvalDecisions: run.log.events.filter((event) => event.kind === 'approval_decision')
          .length,
      }).toEqual({ status: 'fail_closed', invoked: 0, approvalDecisions: 0 })
      expect(result.unhandled?.clause).toBe('/pin fn:runs.start')
    })

    it('applies NO model override when the turn is refused', async () => {
      const run = harness({ directives: true })
      const result = await run.runTurn({
        message: '/model claude-fast and write a test for 2FA',
      })

      expect({
        status: result.status,
        switched: run.modelCalls,
        verbModelChanges: run.log.events.filter(
          (event) => event.kind === 'model_change' && event.source === 'verb',
        ).length,
      }).toEqual({ status: 'fail_closed', switched: [], verbModelChanges: 0 })
    })

    it('still carries the directive out on the execute arm, and its line still leads', async () => {
      const run = harness({ directives: true })
      const result = await run.runTurn({ message: '/model claude-fast and /fn quarantine.list' })

      expect(result.status).toBe('completed')
      expect(run.modelCalls).toEqual(['claude-fast'])
      expect(run.log.events.filter((event) => event.kind === 'approval_decision')).toHaveLength(0)
      expect(run.invocations.map((call) => call.functionId)).toEqual([PROPOSALS_LIST])
      // Directive lines lead the answer, because the person asked for the model switch first.
      expect(result.answer?.split('\n')[0]).toContain('model: claude-fast')
    })

    it('completes a turn that is ENTIRELY directives, emitting the verb-sourced event', async () => {
      const run = harness({ directives: true })
      const result = await run.runTurn({ message: '/model claude-fast' })

      expect(result.status).toBe('completed')
      expect(run.modelCalls).toEqual(['claude-fast'])
      // The control for the zero-event assertion above: this path DOES write the row, so the
      // refused turn's zero is a fact about the refusal rather than about an unbound seam.
      expect(
        run.log.events.filter(
          (event) => event.kind === 'model_change' && event.source === 'verb',
        ),
      ).toHaveLength(1)
      expect(result.answer).toContain('model: claude-fast')
    })

    it('refuses an UNBOUND directive by name before the planner is ever consulted', async () => {
      // The binding check mutates nothing, so an unbound `/model` is reported before stage 2.
      const run = harness({ planned: { toolCalls: [] } })
      const result = await run.runTurn({
        message: '/model claude-fixture and write a test for 2FA',
      })

      expect(result.status).toBe('fail_closed')
      expect(run.plannerCalls).toBe(0)
      expect(result.unhandled?.reason).toContain('no handler')
      expect(result.unhandled?.clause).toBe('/model claude-fixture')
    })
  })

  // A later directive's refusal must leave no earlier directive's effect or row behind.
  describe('the directive BATCH is refused whole: no earlier directive survives a later one', () => {
    it('applies NO earlier directive when a LATER directive in the same turn refuses', async () => {
      const run = harness({ directives: true, unresolvableModel: 'nonsense-model' })
      const result = await run.runTurn({
        message: '/model claude-fast and /model nonsense-model',
      })

      expect({
        status: result.status,
        switched: run.modelCalls,
        approvalDecisions: run.log.events.filter((event) => event.kind === 'approval_decision')
          .length,
      }).toEqual({ status: 'fail_closed', switched: [], approvalDecisions: 0 })
      expect(result.unhandled?.clause).toBe('/model nonsense-model')
    })

    it('applies NO model override when a LATER clause in the same turn refuses', async () => {
      const run = harness({ directives: true, unresolvableModel: 'nonsense-model' })
      const result = await run.runTurn({
        message: '/model claude-fast and /pin nonsense.notacapability',
      })

      expect({
        status: result.status,
        switched: run.modelCalls,
        verbModelChanges: run.log.events.filter(
          (event) => event.kind === 'model_change' && event.source === 'verb',
        ).length,
      }).toEqual({ status: 'fail_closed', switched: [], verbModelChanges: 0 })
    })
  })

  describe('no pin directive and no approval writer', () => {
    it('`/pin` is an unroutable clause, and nothing is pinned or recorded as an approval', async () => {
      const run = harness({ directives: true })
      const result = await run.runTurn({ message: '/pin fn:runs.start' })

      expect({
        status: result.status,
        approvalDecisions: run.log.events.filter((event) => event.kind === 'approval_decision')
          .length,
        unhandled: result.unhandled?.clause,
      }).toEqual({
        status: 'fail_closed',
        approvalDecisions: 0,
        unhandled: '/pin fn:runs.start',
      })
      expect(run.log.events.map((event) => event.kind)).toContain('mark_unhandled')
      expect(run.invocations).toEqual([])
    })

    it('direct change ops dispatch once each through /fn, with no approval row', async () => {
      const run = harness()
      const result = await run.runTurn({
        message: '/fn knowledge.forget {"recordId":"mem_1"} and /fn config.field.set {"path":"use.timeout","value":45000}',
      })

      expect(result.status).toBe('completed')
      expect(run.invocations.map((call) => call.functionId)).toEqual([
        'knowledge.forget',
        'config.field.set',
      ])
      expect(run.log.events.filter((event) => event.kind === 'approval_decision')).toEqual([])
    })
  })

  describe('declared order survives tied timestamps', () => {
    it('three explicit operations under one frozen clock keep their declared execution and receipt order', async () => {
      const run = harness({ fixedClock: true })
      const result = await run.runTurn({
        message: 'digest RUN-9 and /fn config.field.set {"path":"use.timeout","value":45000} and status',
      })

      expect(result.status).toBe('completed')
      const declared = [RUNS_DIGEST, 'config.field.set', RUNS_LIST]
      expect(run.invocations.map((call) => call.functionId)).toEqual(declared)
      expect(result.receipts.map((receipt) => receipt.functionId)).toEqual(declared)
      const logged = run.log.events.filter((event) => event.kind === 'clause_receipt')
      expect(logged.map((event) => event.functionId)).toEqual(declared)
      // Non-vacuity: every logged receipt really does carry the same instant.
      expect(new Set(logged.map((event) => event.at)).size).toBe(1)
    })
  })

  describe('utterance order, stop on failure, receipts for every clause', () => {
    it('executes table-bound clauses in utterance order', async () => {
      const run = harness()
      const result = await run.runTurn({ message: '/fn quarantine.list and status' })

      expect(result.status).toBe('completed')
      expect(run.invocations.map((call) => call.functionId)).toEqual([PROPOSALS_LIST, RUNS_LIST])
      expect(result.receipts.map((receipt) => receipt.clause)).toEqual(['/fn quarantine.list', 'status'])
    })

    it('stops the chain on a runtime failure and reports executed/failed/not-run', async () => {
      const run = harness({
        failOn: RUNS_LIST,
        planned: { toolCalls: [{ toolName: toToolName(RUNS_DIGEST), input: { runId: 'RUN-1' } }] },
      })
      const result = await run.runTurn({
        message: '/fn quarantine.list and status and summarise the last failure',
      })

      expect(result.status).toBe('failed')
      expect(result.receipts.map((receipt) => receipt.status)).toEqual([
        'executed',
        'failed',
        'not-run',
      ])
      // The clause after the failure was never attempted — a fact, not an absence.
      expect(run.invocations.map((call) => call.functionId)).toEqual([PROPOSALS_LIST, RUNS_LIST])
    })

    it('carries the function layer refusal NAME verbatim on the failed receipt', async () => {
      const run = harness({ failOn: RUNS_LIST })
      const result = await run.runTurn({ message: '/fn quarantine.list and status' })

      expect(result.receipts[1]).toMatchObject({
        status: 'failed',
        functionId: RUNS_LIST,
        outcome: 'FunctionInputError',
      })
    })

    it('logs a clause_receipt per clause, not only for the ones that ran', async () => {
      const run = harness({ failOn: PROPOSALS_LIST })
      await run.runTurn({ message: '/fn quarantine.list and status' })

      const receipts = run.log.events.filter((event) => event.kind === 'clause_receipt')
      expect(receipts.map((event) => event.status)).toEqual(['failed', 'not-run'])
    })

    // A typed refusal returns rather than throws, so the stop gate reads the receipt.

    it('stops the chain and fails the turn on a RETURNED failed verdict', async () => {
      // Without `entries` the classifier cannot read the result, so the fold returns `failed`.
      const run = harness({ results: { [PROPOSALS_LIST]: { inbox: 'not the contract' } } })
      const result = await run.runTurn({ message: '/fn quarantine.list and status' })

      // NON-VACUITY: the first clause really did come back with the fail-closed verdict rather than
      // dying on the way, so the three assertions below are about the STOP GATE and not about a
      // harness that never reached the fold.
      expect(result.receipts[0]).toMatchObject({
        functionId: PROPOSALS_LIST,
        status: 'failed',
        outcome: 'unclassifiable-result',
      })

      // One `toEqual` over aggregate, receipts and invocations, so every wrong fact is reported.
      expect({
        status: result.status,
        receipts: result.receipts.map((receipt) => receipt.status),
        invoked: run.invocations.map((call) => call.functionId),
      }).toEqual({
        status: 'failed',
        receipts: ['failed', 'not-run'],
        invoked: [PROPOSALS_LIST],
      })
    })

    it('does NOT stop the chain on a RETURNED refused verdict (the posture control)', async () => {
      // A refusal is not a failure: the op ran and came back, so the chain does not stop.
      const run = harness({
        planned: {
          toolCalls: [{
            toolName: AUTHORING_TOOL,
            input: { intent: 'two factor auth', scope: { tier: 'product', key: 'app' } },
          }],
        },
        results: { [AUTHORING_DRAFT_WRITE_FUNCTION_ID]: AUTHORING_REFUSED_RESULT },
      })
      const result = await run.runTurn({ message: `${AUTHORING_UTTERANCE} and /fn quarantine.list` })

      // NON-VACUITY: the refusal arm really was reached, through the op's own declared classifier.
      expect(result.receipts[0]).toMatchObject({
        functionId: AUTHORING_DRAFT_WRITE_FUNCTION_ID,
        status: 'refused',
      })

      expect(result.receipts.map((receipt) => receipt.status)).toEqual(['refused', 'executed'])
      expect(result.status).toBe('completed')
      expect(run.invocations.map((call) => call.functionId))
        .toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID, PROPOSALS_LIST])
    })
  })

  describe('the turn\'s results[] reaches the log as MASKED clause_result events', () => {
    // `results[]` carries the masked payload, and nothing unmasks it on the way here.

    it('appends ONE clause_result per clause that RAN, carrying the payload verbatim', async () => {
      const run = harness()
      const result = await run.runTurn({ message: '/fn quarantine.list and status' })

      expect(result.status).toBe('completed')
      const persisted = run.log.events.filter((event) => event.kind === 'clause_result')

      // THE COUNT IS THE EXECUTION'S, read off the turn's own `results[]` rather than from a
      // literal — so a turn that executed a different number of clauses cannot agree with this.
      expect(persisted).toHaveLength(result.results.length)
      expect(persisted.map((event) => (event as { functionId: string }).functionId))
        .toEqual(result.results.map((entry) => entry.functionId))

      // VERBATIM, NOT A SUMMARY. The receipt already carries the one-line map; this kind's whole
      // reason for existing is that the territory rides with it.
      expect(persisted.map((event) => (event as { payload: unknown }).payload))
        .toEqual(result.results.map((entry) => entry.payload))
    })

    it('appends NONE for a clause that never ran — not-run is not a result', async () => {
      // The chain stops on failure, so the third clause is never attempted. A `clause_result` for
      // it would be this log asserting an op returned something it was never asked for.
      const run = harness({
        failOn: RUNS_LIST,
        planned: { toolCalls: [{ toolName: toToolName(RUNS_DIGEST), input: { runId: 'RUN-1' } }] },
      })
      const result = await run.runTurn({
        message: '/fn quarantine.list and status and summarise the last failure',
      })

      expect(result.receipts.map((receipt) => receipt.status))
        .toEqual(['executed', 'failed', 'not-run'])
      const persisted = run.log.events.filter((event) => event.kind === 'clause_result')
      expect(persisted).toHaveLength(1)
      expect((persisted[0] as { functionId: string } | undefined)?.functionId).toBe(PROPOSALS_LIST)
    })

    it('leaves the clause_receipt line untouched — the map is still a map', async () => {
      // A receipt carries refs and a sentence; the payload travels beside it, never on it.
      const run = harness()
      await run.runTurn({ message: '/fn quarantine.list and status' })

      for (const event of run.log.events.filter((row) => row.kind === 'clause_receipt')) {
        expect(Object.keys(event).sort()).toEqual([
          'at', 'clause', 'functionId', 'kind', 'origin', 'outcome', 'status', 'turnId',
        ])
      }
    })
  })

  describe('the origin comes from the stage that PROVED the binding', () => {
    it('mints human for table-bound clauses and agent for planner-bound ones', async () => {
      const run = harness({
        planned: { toolCalls: [{ toolName: toToolName(RUNS_DIGEST), input: { runId: 'RUN-1' } }] },
      })
      const result = await run.runTurn({ message: '/fn quarantine.list and summarise the last failure' })

      expect(result.status).toBe('completed')
      expect(run.invocations.map((call) => call.caller.origin)).toEqual(['human', 'agent'])
      expect(result.receipts.map((receipt) => receipt.origin)).toEqual(['human', 'agent'])
    })

    it('records the minted origin on the clause_receipt event', async () => {
      const run = harness({
        planned: { toolCalls: [{ toolName: toToolName(RUNS_DIGEST), input: { runId: 'RUN-1' } }] },
      })
      await run.runTurn({ message: '/fn quarantine.list and summarise the last failure' })

      const origins = run.log.events
        .filter((event) => event.kind === 'clause_receipt')
        .map((event) => event.origin)
      expect(origins).toEqual(['human', 'agent'])
    })

    it('mints agent when a strategy binds a TABLE-resolvable clause through the planner', async () => {
      // `source` is carried, not re-derived: matching back would mark a model-made call as `human`.
      const smuggling: ReconcileStrategy = (input) => ({
        kind: 'execute',
        plan: input.mapped.map((resolved) => ({ ...resolved, source: 'planner' as const })),
      })
      const run = harness({ reconcile: smuggling })
      await run.runTurn({ message: '/fn quarantine.list' })

      expect(run.invocations.map((call) => call.caller.origin)).toEqual(['agent'])
    })
  })

  describe('an answered turn completes without acting', () => {
    it('performs zero invocations and returns the prose', async () => {
      const run = harness({
        planned: {
          toolCalls: [
            { toolName: 'answer_only', input: { clause: 'what is a flake', text: 'a flake is…' } },
          ],
        },
      })
      const result = await run.runTurn({ message: 'what is a flake' })

      expect(result.status).toBe('completed')
      expect(run.invocations).toHaveLength(0)
      expect(result.receipts).toHaveLength(0)
      expect(result.answer).toBe('a flake is…')
    })
  })

  describe('a style modifier is not a clause the model has to claim', () => {
    it('completes the turn the live lane saw refused, with no mark_unhandled row', async () => {
      const run = harness({
        planned: {
          toolCalls: [
            {
              toolName: 'answer_only',
              input: {
                clause: 'what does it mean to call a test flaky?',
                text: 'a flaky test is…',
              },
            },
          ],
        },
      })
      const result = await run.runTurn({
        message: 'in one sentence, what does it mean to call a test flaky?',
      })

      // The four facts read together: a refusal shows up in whichever of them the defect moved.
      expect({
        status: result.status,
        invocations: run.invocations.length,
        receipts: result.receipts.length,
        markUnhandled: run.log.events.filter((event) => event.kind === 'mark_unhandled').length,
      }).toEqual({ status: 'completed', invocations: 0, receipts: 0, markUnhandled: 0 })
      expect(result.answer).toBe('a flaky test is…')
    })
  })

  describe('wiring — the hook and the ledger', () => {
    it('runs the compaction pass BEFORE the planner is consulted', async () => {
      const run = harness({
        compaction: true,
        planned: { toolCalls: [{ toolName: toToolName(RUNS_DIGEST), input: {} }] },
      })
      await run.runTurn({ message: 'summarise the last failure' })

      expect(run.ordering.indexOf('compaction')).toBeGreaterThanOrEqual(0)
      expect(run.ordering.indexOf('compaction')).toBeLessThan(run.ordering.indexOf('planner'))
    })

    it('never consults the planner when stage 1 resolved every clause', async () => {
      const run = harness({ planned: { toolCalls: [] } })
      await run.runTurn({ message: '/fn quarantine.list and status' })

      expect(run.plannerCalls).toBe(0)
    })

    it('opens with the user message, closes with the boundary, and fsyncs once', async () => {
      const run = harness()
      await run.runTurn({ message: '/fn quarantine.list and status' })

      const kinds = kindsOf(run.log.events)
      expect(kinds[0]).toBe('user_message')
      expect(kinds[kinds.length - 1]).toBe('turn_complete')
      expect(run.log.boundaries).toBe(1)
    })

    it('closes the turn at the boundary even on the fail-closed arm', async () => {
      const run = harness()
      await run.runTurn({ message: 'write a test for two factor auth' })

      expect(kindsOf(run.log.events).at(-1)).toBe('turn_complete')
      expect(run.log.boundaries).toBe(1)
    })
  })
})

// Fixtures come from `buildFanOutReport`, expectations from `renderFanOutReport`.

/** The report a nine-run preview and a three-run happy path produce. Built, never typed. */
const HAPPY_REPORT = buildFanOutReport({
  previewed: computeFanOutBound({ initialN: 3, probeK: 3, finalN: 3 }),
  runs: [
    { runId: 'r_gate-0', purpose: 'gate', completedAt: 1 },
    { runId: 'r_gate-1', purpose: 'gate', completedAt: 2 },
    { runId: 'r_gate-2', purpose: 'gate', completedAt: 3 },
  ],
})

/**
 * A report that OUTSPENT its preview — the flag `exceedsPreview` exists for.
 *
 * Produced by handing `buildFanOutReport` more runs than the bound allows, which is the same way a
 * real under-counted bound would produce one. A literal `exceedsPreview: true` would pin a shape
 * the builder need never have answered with, and the whole point of the flag is that it is derived
 * rather than declared.
 */
const EXCEEDED_REPORT = buildFanOutReport({
  previewed: computeFanOutBound({ initialN: 1, probeK: 0, finalN: 1 }),
  runs: [
    { runId: 'r_gate-0', purpose: 'gate', completedAt: 1 },
    { runId: 'r_gate-1', purpose: 'gate', completedAt: 2 },
    { runId: 'r_probe-0', purpose: 'probe', completedAt: 3 },
  ],
})

const AUTHORING_TOOL = toToolName(AUTHORING_DRAFT_WRITE_FUNCTION_ID)
const AUTHORING_UTTERANCE = 'write a test for two factor auth'
const VERIFY_TOOL = toToolName(AUTHORING_DRAFT_VERIFY_FUNCTION_ID)
const VERIFY_UTTERANCE = 'check the shelved draft again'
const FUNNEL_TOOL = toToolName(AUTHORING_FUNNEL_GET_FUNCTION_ID)
const FUNNEL_UTTERANCE = 'how is this session doing so far'

// Named once, so a cell cannot agree with a restated copy of itself.
const AUTHORING_OUTCOME = 'drafted'

// Parsed through the output contract, so the control pins the refusal, not the fail-closed wrapper.
const AUTHORING_REFUSED_RESULT: AuthoringDraftWriteOutput = AuthoringDraftWriteOutputSchema.parse({
  outcome: 'refused',
  refusal: {
    filePath: 'tests/checkout.spec.ts',
    testName: 'adds a product to the cart',
    matchedRef: 'tests/checkout.spec.ts::adds a product to the cart',
    score: 0.91,
    threshold: 0.8,
    sharedTokens: 5,
    comparedTests: 42,
    continuations: ['extend-that-test', 'name-the-differing-assertion'],
  },
  fanOut: buildFanOutReport({
    previewed: computeFanOutBound({ initialN: 3, probeK: 3, finalN: 3 }),
    runs: [],
  }),
})

function authoringHarness(report: unknown): Harness {
  return harness({
    planned: {
      toolCalls: [{
        toolName: AUTHORING_TOOL,
        input: { intent: 'two factor auth', scope: { tier: 'product', key: 'app' } },
      }],
    },
    results: {
      [AUTHORING_DRAFT_WRITE_FUNCTION_ID]: { outcome: AUTHORING_OUTCOME, fanOut: report },
    },
  })
}

describe('exception — the authoring receipt carries the fan-out report', () => {
  it('extends the outcome line with the RENDERER’s own sentence', async () => {
    const run = authoringHarness(HAPPY_REPORT)
    const result = await run.runTurn({ message: AUTHORING_UTTERANCE })

    expect(result.status).toBe('completed')
    expect(run.invocations.map((call) => call.functionId))
      .toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
    // Composed from the renderer, not from a restated literal — this is the equality mutation R
    // breaks when a surface hand-formats the sentence instead of calling the one render.
    expect(result.receipts[0]?.outcome).toBe(
      `${AUTHORING_OUTCOME} — ${renderFanOutReport(HAPPY_REPORT)}`,
    )
  })

  it('puts the same rendered line on the LOG, which is what a person actually reads', async () => {
    const run = authoringHarness(HAPPY_REPORT)
    await run.runTurn({ message: AUTHORING_UTTERANCE })

    const receipt = run.log.events.find((event) => event.kind === 'clause_receipt')
    // The return value is what one caller sees; the append-only log is the triage report several
    // surfaces render. A report that reached the first and not the second would leave the
    // disclosure unreadable exactly where it is looked for after the fact.
    expect(receipt?.kind === 'clause_receipt' ? receipt.outcome : '').toBe(
      `${AUTHORING_OUTCOME} — ${renderFanOutReport(HAPPY_REPORT)}`,
    )
  })

  it('surfaces the EXCEEDED phrase verbatim when the loop outspent its preview', async () => {
    const run = authoringHarness(EXCEEDED_REPORT)
    const result = await run.runTurn({ message: AUTHORING_UTTERANCE })

    // This line is the only path `FAN_OUT_PHRASES.exceeded` has to a screen.
    expect(EXCEEDED_REPORT.exceedsPreview).toBe(true)
    // Asserted against the CONSTANT, never a restated copy of the sentence: a literal here would
    // be a second place this project's words live, which is what the phrase table exists to stop.
    expect(result.receipts[0]?.outcome).toContain(FAN_OUT_PHRASES.exceeded)
  })

  it('leaves every OTHER op’s line untouched — one field, on one op', async () => {
    // A real `quarantine.list` result with a report: only a misrouted rule grows its line.
    const run = harness({
      results: { [PROPOSALS_LIST]: { ...PROPOSALS_LIST_RESULT, fanOut: HAPPY_REPORT } },
    })
    const result = await run.runTurn({ message: '/fn quarantine.list' })

    expect(result.receipts[0]?.outcome).toBe('0 quarantine entries')
    expect(result.receipts[0]?.outcome).not.toContain(FAN_OUT_PHRASES.reportLead)
  })

  it('renders NOTHING extra when the result carries no parsable report', async () => {
    // A malformed or absent `fanOut` falls back to the plain receipt line and does not throw.
    const run = harness({
      planned: {
        toolCalls: [{
          toolName: AUTHORING_TOOL,
          input: { intent: 'two factor auth', scope: { tier: 'product', key: 'app' } },
        }],
      },
      results: {
        [AUTHORING_DRAFT_WRITE_FUNCTION_ID]: { outcome: AUTHORING_OUTCOME, fanOut: 'nine runs' },
      },
    })
    const result = await run.runTurn({ message: AUTHORING_UTTERANCE })

    expect(result.status).toBe('completed')
    expect(result.receipts[0]?.outcome).toBe(AUTHORING_OUTCOME)
  })
})

// The stamp overwrites: a planner-emitted `sessionRef` would let a model claim another session.

const SESSION_ID = 'chat-test-session'

describe('the authoring sessionRef stamp', () => {
  it('stamps the session\'s OWN id into the write op\'s args', async () => {
    const run = harness({
      planned: {
        toolCalls: [{
          toolName: AUTHORING_TOOL,
          input: { intent: 'two factor auth', scope: { tier: 'product', key: 'app' } },
        }],
      },
      results: { [AUTHORING_DRAFT_WRITE_FUNCTION_ID]: { outcome: 'drafted' } },
    })

    await run.runTurn({ message: AUTHORING_UTTERANCE })

    expect(run.invocations).toHaveLength(1)
    expect((run.invocations[0]?.input as { sessionRef?: string }).sessionRef).toBe(SESSION_ID)
  })

  it('OVERWRITES a planner-emitted ref rather than honouring it', async () => {
    const run = harness({
      planned: {
        toolCalls: [{
          toolName: AUTHORING_TOOL,
          input: {
            intent: 'two factor auth',
            scope: { tier: 'product', key: 'app' },
            sessionRef: 'sess-victim',
          },
        }],
      },
      results: { [AUTHORING_DRAFT_WRITE_FUNCTION_ID]: { outcome: 'drafted' } },
    })

    await run.runTurn({ message: AUTHORING_UTTERANCE })

    expect((run.invocations[0]?.input as { sessionRef?: string }).sessionRef).toBe(SESSION_ID)
    expect(JSON.stringify(run.invocations[0]?.input)).not.toContain('sess-victim')
  })

  it('stamps NO other op — one field, on one op', async () => {
    // The blast radius, measured on the same reasoning as the fan-out line's own sibling cell: a
    // stamp applied to every invocation would pass both cells above and red this one.
    const run = harness({ results: { [PROPOSALS_LIST]: { ok: true } } })

    await run.runTurn({ message: '/fn quarantine.list' })

    expect(run.invocations[0]?.functionId).toBe(PROPOSALS_LIST)
    expect(run.invocations[0]?.input).not.toHaveProperty('sessionRef')
  })

  it('OVERWRITES a planner-emitted ref on the VERIFY op too', async () => {
    // THE SIBLING THE ONE-ID GUARD MISSED. `authoring.draft.verify` carries `sessionRef` on its
    // own input schema, spreads it onto the receipt it persists, and is planner-reachable like
    // every other registered op — so a guard that names only the write op leaves the same
    // attribution forgery open one function id over. The guarded vocabulary has to be the SET of
    // ops that carry the field, which is what `SESSION_STAMPED_FUNCTION_IDS` states.
    const run = harness({
      planned: {
        toolCalls: [{
          toolName: VERIFY_TOOL,
          input: { draftPath: 'tests/.agent-qa-drafts/abc.yaml', sessionRef: 'sess-bravo' },
        }],
      },
      results: { [AUTHORING_DRAFT_VERIFY_FUNCTION_ID]: { ok: true } },
    })

    await run.runTurn({ message: VERIFY_UTTERANCE })

    expect(run.invocations[0]?.functionId).toBe(AUTHORING_DRAFT_VERIFY_FUNCTION_ID)
    expect((run.invocations[0]?.input as { sessionRef?: string }).sessionRef).toBe(SESSION_ID)
    expect(JSON.stringify(run.invocations[0]?.input)).not.toContain('sess-bravo')
  })
})

// The window stamp is a default-if-absent, while the session arm's ref is overwritten.

describe('the authoring funnel window stamp', () => {
  it('DEFAULTS an absent window to this session — the surface default, constructed', async () => {
    const run = harness({
      planned: { toolCalls: [{ toolName: FUNNEL_TOOL, input: {} }] },
      results: { [AUTHORING_FUNNEL_GET_FUNCTION_ID]: { ok: true } },
    })

    await run.runTurn({ message: FUNNEL_UTTERANCE })

    expect(run.invocations[0]?.functionId).toBe(AUTHORING_FUNNEL_GET_FUNCTION_ID)
    expect((run.invocations[0]?.input as { window?: unknown }).window)
      .toEqual({ scope: 'session', sessionRef: SESSION_ID })
  })

  it('OVERWRITES a planner-emitted session ref in the window', async () => {
    const run = harness({
      planned: {
        toolCalls: [{
          toolName: FUNNEL_TOOL,
          input: { window: { scope: 'session', sessionRef: 'sess-bravo' } },
        }],
      },
      results: { [AUTHORING_FUNNEL_GET_FUNCTION_ID]: { ok: true } },
    })

    await run.runTurn({ message: FUNNEL_UTTERANCE })

    expect((run.invocations[0]?.input as { window?: unknown }).window)
      .toEqual({ scope: 'session', sessionRef: SESSION_ID })
    expect(JSON.stringify(run.invocations[0]?.input)).not.toContain('sess-bravo')
  })

  it('leaves an all-time window byte-untouched — the model may ask a wider question', async () => {
    const run = harness({
      planned: {
        toolCalls: [{ toolName: FUNNEL_TOOL, input: { window: { scope: 'all-time' } } }],
      },
      results: { [AUTHORING_FUNNEL_GET_FUNCTION_ID]: { ok: true } },
    })

    await run.runTurn({ message: FUNNEL_UTTERANCE })

    expect(run.invocations[0]?.input).toEqual({ window: { scope: 'all-time' } })
  })

  it('leaves a last-n window byte-untouched', async () => {
    const run = harness({
      planned: {
        toolCalls: [{ toolName: FUNNEL_TOOL, input: { window: { scope: 'last-n', n: 5 } } }],
      },
      results: { [AUTHORING_FUNNEL_GET_FUNCTION_ID]: { ok: true } },
    })

    await run.runTurn({ message: FUNNEL_UTTERANCE })

    expect(run.invocations[0]?.input).toEqual({ window: { scope: 'last-n', n: 5 } })
  })

  it('stamps NO window onto any other op — the blast radius, both stamps', async () => {
    const run = harness({ results: { [PROPOSALS_LIST]: { ok: true } } })

    await run.runTurn({ message: '/fn quarantine.list' })

    expect(run.invocations[0]?.input).not.toHaveProperty('window')
    expect(run.invocations[0]?.input).not.toHaveProperty('sessionRef')
  })
})
