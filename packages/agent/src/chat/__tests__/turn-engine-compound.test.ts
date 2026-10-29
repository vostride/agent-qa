// Stages 3 and 4 of the turn engine, measured (Phase 392 plan 07 — D-10 / D-11 / D-18, Pitfall 1).
//
// THE PORT DOUBLES HERE ARE ENGINE-MECHANICS DOUBLES, NOT SCENARIO MOCKS. D-13's "no mocks in
// either lane" is a rule about the SCENARIO corpus: a deterministic scenario never touches the LLM
// by contract, and a planner scenario runs against a live model. This file is neither. It drives
// the engine's own wiring, so the planner seat holds a scripted port and the dispatch seat holds a
// spy — because the claims under test are "nothing was invoked", "these were invoked in this
// order" and "this caller was minted", none of which is observable through a real adapter without
// also making a real request. The resolver table, the clause splitter and the reconciliation
// strategy are the REAL shipped ones, which is what keeps the routing under test genuine.
//
// THE ZERO-INVOCATION ASSERTION IS THE FILE'S CENTRE. D-10 says reconciliation completes before the
// first side effect, and the only way to measure "before" is to count effects on a turn that got
// refused. A suite that checked the refusal MESSAGE and not the spy would pass against an engine
// that ran the first clause and then changed its mind.

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

// RE-SPELLED 2026-10-01 (432-17): `proposals.list` is deleted with the inbox. `quarantine.list` is
// the read op folded in its place: it declares the same kind of classifier (`output.entries.length`)
// over the same `{ entries }` shape, so every claim below keeps its subject.
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

/**
 * A refusal shape `invokeFunction` publishes, as a scripted stand-in with the same NAME.
 * 2026-10-01 (432-19): the input refusal, since the gate's denial error is deleted.
 */
class FunctionInputError extends Error {
  override readonly name = 'FunctionInputError'
}

interface MemoryLog extends SessionLogPort {
  readonly events: ChatSessionEvent[]
  boundaries: number
  /** How many handles this log handed out, and how many came back (392-12). */
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
  // The double answers the HANDLE contract (392-12): the write verbs come back from `open()`
  // scoped to the session it opened, so a turn cannot reach a log-level append — there is none.
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
  /** What `/model` was actually asked to switch to. EMPTY is the CR-04 assertion (392-11). */
  readonly modelCalls: string[]
  runTurn(input: AgentAskInput): Promise<AgentAskResult>
}

interface HarnessOptions {
  readonly planned?: PlannerStageOutcome
  readonly failOn?: string
  readonly reconcile?: ReconcileStrategy
  readonly compaction?: boolean
  /**
   * Bind SPY directive handlers, plus the config thunk the `/model` event path needs.
   *
   * A directive's side effects are the model override and the event it produces — neither of
   * which is observable through the invoke spy, because a directive never travels the function
   * layer. So CR-04's claim ("nothing happened on a refused turn") needs its own seat, and this is
   * it. (432-13: `/pin` is gone; its handler seat went with it.)
   */
  readonly directives?: boolean
  /**
   * The `/model` argument the spy REFUSES in its pre-flight (392-14, E3; `/pin` until 432-13).
   *
   * The composed host resolves a named model in `validate` and throws for one it cannot resolve,
   * and the engine turns that into the refusal path. A batch needs a second directive that says no.
   */
  readonly unresolvableModel?: string
  /**
   * What the invoke seat ANSWERS, per function id (394-14).
   *
   * The spy resolved a fixed `{ ok: true }` for every op while nothing on this surface read an op
   * RESULT — D-18's map-not-territory rule meant the receipt line was a function of the id alone.
   * The fan-out report is that rule's one recorded exception, so the seat now has to be able to
   * answer with a real result for the one op whose result reaches a rendered line.
   */
  readonly results?: Readonly<Record<string, unknown>>
  /**
   * Answer ONE timestamp for every event of the turn (432-13, EDGE-03). Order must come from the
   * utterance, never from a clock that happens to move between clauses.
   */
  readonly fixedClock?: boolean
}

/**
 * The ops this harness folds through the REAL composition-root fold (399.1-03).
 *
 * TWO SPECS, AND THE SECOND ONE IS THE MEASUREMENT. `authoring.draft.write` declares the fan-out
 * disclosure; `quarantine.list` (`proposals.list` until 432-17) declares a classifier that says only
 * how many entries it listed,
 * and routing it through the SAME `foldFunctionResult` is what lets the blast-radius cell below see
 * a shared runner that started folding everybody's result with one op's rule. While the exception
 * was an id comparison inside `turn-engine.ts` that widening was one deleted line away and
 * mutation S of the phase's mutation driver (since removed) made it; the fold is a member of one spec now, so the
 * only place the same widening can still be written is the runner's post-classify seat — which is
 * exactly where mutation S went.
 *
 * 2026-08-20 (399.1-04): `proposals.list` USED TO DECLARE NOTHING, and mutation S attacked the
 * runner's absent-classifier branch. `classify` is a REQUIRED member now — there is no undeclared
 * op left anywhere in the registry to leak onto — so both the control below and mutation S moved
 * onto the seat that still exists: what the runner does with the verdict an op DID declare. The
 * claim is unchanged: one field, on one op.
 *
 * Spelled as the specs THEMSELVES rather than mimicked: a hand-written stand-in would be a second
 * copy of the disclosure, and these cells would then agree with the copy while the shipped fold
 * drifted.
 */
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

/**
 * An EMPTY listing, produced through the folded read op's own output contract (399.1-04).
 *
 * PRODUCED, NEVER TYPED. The op declares a classifier as of plan 04, and a classifier is run over
 * whatever this seat answers with — so a hand-written `{ ok: true }` would hand the shipped fold an
 * input its contract cannot produce, and the fail-closed guard would answer
 * `failed/unclassifiable-result` for a cell whose subject is something else entirely. Parsing it
 * here means a fixture describing an impossible shape reds AT THIS LINE.
 */
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
      // 2026-10-02 (432-39, D-02/D-12): no session is stamped onto the caller. The production mint
      // stopped stamping one when the deny overlay that read it was deleted, the port no longer
      // takes the session, and `FunctionCaller.sessionId` is deleted.
      forStage: (stage: ChatBindingStage): FunctionCaller =>
        stage === 'resolver' ? RESOLVER_CALLER : PLANNER_CALLER,
    },
    invoke: (functionId, input, caller) => {
      ordering.push(`invoke:${functionId}`)
      invocations.push({ functionId, input, caller })
      if (functionId === options.failOn) return Promise.reject(new FunctionInputError('refused'))
      // 399.1: the envelope, run through the REAL composition-root fold (399.1-03).
      //
      // It used to script `{ status: 'executed', outcome: '' }` for everything, which was right
      // while the only fold in existence was `config.field.set`'s and every cell here was about
      // ordering, atomicity and receipt COUNTS. The D-18 fan-out disclosure is now a member of
      // `authoring.draft.write`'s spec rather than an id comparison inside `turn-engine.ts`, so a
      // harness that kept scripting the legacy verdict would assert about a mechanism it had
      // switched off. `FOLD_REGISTRY` runs `foldFunctionResult` — the one the composition root
      // runs — so the cells measure the shipped disclosure and not a copy of it. Ops outside
      // `FOLD_IDS` keep the legacy envelope, which is what an unclassified op reports in
      // production, and is also what `foldFunctionResult` REFUSES to answer for an id its registry
      // does not hold (fail-closed) — so the guard is here rather than a `failed` verdict every
      // ordering cell would then have to explain.
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
          // A FACTORY, as the engine now asks for (392 plan 13): the handlers a turn runs belong to
          // the session running it. This harness drives one session at a time, so the factory
          // ignores the id and the spies stay the same objects — what is under test here is the
          // ORDER effects happen in, and the per-session keying has its own composed differential.
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
      // The measurement D-10 is actually about. Not "the failing clause was skipped" — the
      // clause that COULD have run did not, because the verdict preceded every effect.
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

  // CR-04, the gap round (392-11). THE DIRECTIVE LOOP USED TO RUN BEFORE THE VERDICT, so a turn
  // whose second clause was unroutable returned `fail_closed` — with the message "nothing in the
  // request was carried out" — while the directive it named was already in force. Every existing
  // case in this file measured effects through the INVOKE spy, and a directive never travels the
  // function layer, so `executed == 0` stayed true through the defect. These cases measure the
  // other seat. (432-13: the shipped probe was `/pin`, now an ordinary unroutable clause; the
  // effectful directive left is `/model`, and no turn writes an `approval_decision` row.)
  describe('no directive side effect precedes the reconciliation verdict', () => {
    // RE-SPELLED 2026-09-30 (432-13) from 'records NO pin when the turn is refused, though it names
    // one'. `/pin` is no longer a directive, so the same utterance is two unroutable clauses; the
    // claim that survives is that a refused turn leaves no approval row and invokes nothing.
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

    // RE-SPELLED 2026-09-30 (432-13): the directive carried out is `/model`, and the op beside it
    // is reached through `/fn` now that the `proposals` alias is gone.
    it('still carries the directive out on the execute arm, and its line still leads', async () => {
      const run = harness({ directives: true })
      const result = await run.runTurn({ message: '/model claude-fast and /fn quarantine.list' })

      expect(result.status).toBe('completed')
      expect(run.modelCalls).toEqual(['claude-fast'])
      expect(run.log.events.filter((event) => event.kind === 'approval_decision')).toHaveLength(0)
      expect(run.invocations.map((call) => call.functionId)).toEqual([PROPOSALS_LIST])
      // Directive lines lead the answer — the person asked for the model switch FIRST (D-11).
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
      // The hoisted half. The binding check reads `deps.directives` and mutates nothing, so it can
      // stay where the execution loop used to be: a build that recognises `/model` and binds no
      // handler still says so early, and stage 2 is never reached on that arm.
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

  // 392-14, the CR-04 RESIDUAL (392-VERIFICATION round 2, E3/E3b). The primary fix above is real —
  // the execution loop moved below the verdict and the single-directive control proves it. But the
  // loop itself applies directives ONE AT A TIME and returns on the first refusal, so a turn whose
  // SECOND directive says no kept the first one's irrevocable effect and its append-only row. The
  // status was already right; that is what makes this shape so hard to see from the outside, and
  // why each case folds the status and the two effects into one `toEqual` rather than asserting
  // them in sequence. A refusal that carried something out is worse than a refusal that lied about
  // it, because the person is told the session is unchanged and it is not.
  describe('E3 — the directive BATCH is refused whole: no earlier directive survives a later one', () => {
    // RE-SPELLED 2026-09-30 (432-13) from 'records NO pin when a LATER directive in the same turn
    // refuses': the batch is two `/model` directives, the second of which the pre-flight refuses.
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

  // 432-13 (D-14/D-15): chat resolution has no approval route left. `/pin` is not a directive, so it
  // is an ordinary unroutable clause, and no turn writes an `approval_decision` row.
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

  // EDGE-03 (PXH-SAFE-01/ordering): explicit operations in one utterance run, receipt and log in the
  // order the person declared them even when every event carries the same timestamp.
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

    // ---- 399.1-09 (gap round 1, D-12): the stop gate reads the RECEIPT, not the ending ----------
    //
    // THE THREE CELLS ABOVE ALL FAIL BY THROWING. `failOn` rejects, the engine's catch mints the
    // `failed` receipt AND sets the flag, and the chain stops — which was a complete statement of
    // D-11 for exactly as long as a failure could only arrive as an exception. It is not any more:
    // 399.1 made the receipt status the op's OWN verdict, and every arm of a typed refusal RETURNS.
    // So a fold answering `failed` produced a `failed` receipt over which the aggregate still said
    // `completed`, the gate never tripped, and the clause after it ran anyway. That is RC-1b
    // restated one layer up, and the two cells below are its differential.
    //
    // THE GUARD-REJECT CONTROL IS ALREADY WRITTEN AND IS NOT DUPLICATED HERE: 'executes table-bound
    // clauses in utterance order' (the first cell in this describe) is the all-executed turn — no
    // receipt says `failed`, nothing stops, the aggregate stays `completed`. A rule with a guard
    // needs a case its guard REJECTS, and that is the one.

    it('stops the chain and fails the turn on a RETURNED failed verdict', async () => {
      // PRODUCED THROUGH THE REAL FOLD, NEVER SCRIPTED. `results` here is the op's RESULT, and the
      // harness routes every `FOLD_IDS` result through `foldFunctionResult` — the same function the
      // composition root runs. `quarantine.list`'s declared classifier reads `output.entries.length`;
      // an object with no `entries` is a result its own fold cannot read, so D-03's fail-closed
      // wrapper answers `failed`/`unclassifiable-result` as a RETURN. Scripting a verdict literal
      // into the invoke seat would have pinned a verdict no producer can emit.
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

      // THE THREE FACTS IN ONE `toEqual`, on E3's precedent above: the aggregate, the receipt
      // sequence and what was actually invoked are one claim about one turn, and asserting them in
      // sequence would report only the first of the three that is wrong. The clause after a failure
      // was never attempted — thrown or returned, identically.
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
      // A D-12 POSTURE CONTROL, GREEN BEFORE AND AFTER THE FIX, and it is the reason the fix reads
      // `receipt.status === 'failed'` rather than "anything that is not `executed`". D-11 stops on
      // FAILURE; D-02 ruled that a refusal is not a failure — the control worked, the op ran and
      // came back, which is precisely what `clauseReachedCapability` already counts. A guard that
      // stopped here would turn every declined write into a turn that abandoned the rest of the
      // person's sentence.
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
    // WHY THIS KIND EXISTS AT ALL. `results[]` is the channel D-05 minted for what the ops
    // RETURNED, and it is what `renderTurn` prints and every `agent.ask` client reads. A session
    // log that carried the receipt map but not the territory would make "what did this turn
    // actually get back" unanswerable from the record — which is the same hole 399's UAT rejected
    // on the render surface, one file down.
    //
    // AND WHY IT IS MASKED. `results[]` carries the function layer's masked payload and NOTHING
    // restores a value on the way here (each surface's emit masks with the declared secrets).
    // Persisting anything else would mint a SECOND unadjudicated cleartext sink in the very file
    // the 399.1 adjudication names — see
    // `.planning/phases/399.1-chat-render-contract/399.1-ADJUDICATION-transcript-cleartext.md`
    // § "The load-bearing corollary for D-05". This describe pins the count and the verbatim
    // payload; the byte-level absence proof is in `agent-local`, on a real file.

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
      // THE CHARTER SURVIVES THE ADDITION. 392's receipt ruling is that a receipt carries refs and
      // a sentence; the territory travels beside it. A payload that had leaked onto the receipt
      // would be the prohibition this whole vocabulary is built on, satisfied by a sibling kind.
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
      // The T-392-23 shape, and the reason `source` is carried rather than re-derived. A caller
      // matching the action back against the mapper set would answer `human` here — handing a
      // model-produced invocation the self-grant power 391 D-06 withholds. Reachable only through
      // the D-16 strategy seam, which is exactly the seat an attacker-shaped mistake would sit in.
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

  /**
   * 392-16 — a style modifier is not a clause the model has to claim (G-392-1).
   *
   * THE CLOSURE IS ANCHORED ON WHAT A PERSON READS, NOT ON THE SPLITTER'S RETURN VALUE. The gap
   * was measured in the live lane as a refusal — a sentence asserting no capability handles
   * `in one sentence`, on a turn whose question the model had in fact answered — and a case that
   * asserted only `splitClauses(...)` has one element would be phrased in the fixed module's own
   * vocabulary, which is the shape this phase has watched close a round and leave the class alive.
   * This case drives the REAL splitter, the REAL resolver table and the REAL reconciliation
   * strategy, so what it measures is the refusal ceasing to be emitted.
   *
   * WHY NOT A CORPUS CELL. The composed shape is a `should_execute` turn: a hermetic cell of that
   * kind would need a scripted model standing in for the real one, which D-13 forbids for exactly
   * those cells; a `fail_closed` cell would pin the PRE-fix behaviour, which the fix removes; and
   * either admission would move a denominator D-15 froze at 11 hermetic / 3 live. The live lane at
   * k≥5 is the third seam, and it is the one that gates.
   */
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

// ---- D-18's one recorded exception: the fan-out report on the receipt (394-14 · WTST-08) -------
//
// WHY A RECEIPT LINE IS THE RIGHT SURFACE FOR IT, and why that is not a hole in D-18. The receipt's
// charter is "which op ran and how it went"; for `authoring.draft.write` the cost IS how it went,
// and the same surface asked this person to approve a number before the loop spent anything. A
// disclosure whose second half never reaches a screen is a control with nothing behind it: they
// approved nine runs and had no way to learn eleven were taken. What the exception admits is one
// typed field on one op — counts, run refs and a boolean, read through `FanOutReportSchema` — and
// never a payload body.
//
// THE LINE IS RENDERED, NEVER RECOMPUTED. Every fixture below is PRODUCED by `buildFanOutReport`
// and every expectation is composed by `renderFanOutReport`, so a surface that copied the sentence
// instead of calling the renderer is invisible here while both agree — which is exactly why
// mutation R of the phase's mutation driver (since removed) made them disagree and required these
// cells to red. A cell pinning a restated string literal would stay green through that mutation and
// would be measuring its own copy of the wording.

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

/**
 * The loop outcome every cell here drives, named ONCE (399.1-03).
 *
 * The receipt line is now the op's OWN verdict rather than the engine's `<id> completed`, so this
 * word appears in both the fixture and the expectation. Spelling it twice would let a cell agree
 * with a restated copy of itself while the harness drove something else.
 */
const AUTHORING_OUTCOME = 'drafted'

/**
 * The dedup REFUSAL arm, produced through the op's own output contract (399.1-09).
 *
 * PARSED, NEVER TYPED — the same move `PROPOSALS_LIST_RESULT` makes above and the shape
 * `refusal-classifiers.test.ts` mints for this op's refusal cell. A hand-written stand-in would hand
 * the shipped classifier an input its contract cannot produce, and the D-12 control below would then
 * be pinning the fail-closed wrapper instead of the refusal it means to pin.
 */
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
  // 399.1-03: the exception moved OUT of `turn-engine.ts` and onto this op's own `classify`. The
  // claim is unchanged and the enforcement got stronger — it was an id comparison inside a shared
  // summariser, and it is a member of one spec now. The receipt line is the op's own words, which
  // is why the expectations below no longer carry the engine's `<id> completed` prefix.
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

    // Until this line existed, `exceedsPreview` was a flag nothing could surface and
    // FAN_OUT_PHRASES.exceeded had no path to a screen at all (394-VERIFICATION, fan-out.ts:228).
    expect(EXCEEDED_REPORT.exceedsPreview).toBe(true)
    // Asserted against the CONSTANT, never a restated copy of the sentence: a literal here would
    // be a second place this project's words live, which is what the phrase table exists to stop.
    expect(result.receipts[0]?.outcome).toContain(FAN_OUT_PHRASES.exceeded)
  })

  it('leaves every OTHER op’s line untouched — one field, on one op', async () => {
    // The D-18 blast radius, measured. The exception is a named branch, not "render whatever the
    // result carried": a fix that appended a report to every receipt would pass all three cells
    // above and red this one, which is what makes them a subset rather than restatements.
    // The result carries a parsable report AND is a real `quarantine.list` output, so the only
    // reason its line could grow the disclosure is a runner that stopped asking whose rule it is.
    const run = harness({
      results: { [PROPOSALS_LIST]: { ...PROPOSALS_LIST_RESULT, fanOut: HAPPY_REPORT } },
    })
    const result = await run.runTurn({ message: '/fn quarantine.list' })

    expect(result.receipts[0]?.outcome).toBe('0 quarantine entries')
    expect(result.receipts[0]?.outcome).not.toContain(FAN_OUT_PHRASES.reportLead)
  })

  it('renders NOTHING extra when the result carries no parsable report', async () => {
    // A malformed or absent `fanOut` must not produce a fabricated line and must not throw the
    // turn away. The receipt falls back to the plain one-liner: the honest answer when the field
    // the exception admits is not there is to say only what D-18 always said.
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
    // The VERDICT survives an unparsable disclosure and the SENTENCE does not: the op still says
    // what happened, and says nothing about a report it could not read (399.1-03).
    expect(result.receipts[0]?.outcome).toBe(AUTHORING_OUTCOME)
  })
})

// ---- the sessionRef stamp (394-17, D-12 · WTST-05 · T-394-66) -----------------------------------
//
// The session is a fact about THIS COMPOSITION, and the receipt the loop mints is attributed with
// it so the per-session funnel window has anything to select. The stamp is an OVERWRITE and never
// a default-if-absent: a planner-emitted `sessionRef` is a value a MODEL wrote, and honouring it
// would let a model claim another author's session — T-392-23's shape, one op over.

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
    // The spoofing direction. A model that wrote `sessionRef: 'sess-victim'` into its tool call
    // must not have that value reach the registry — the receipt it would mint would report this
    // draft under somebody else's keep rate, which is exactly the inflation D-12 forbids.
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

// ---- the funnel window stamp (394-19, D-12 · WTST-05 · T-394-75) --------------------------------
//
// THE READ SIDE, AND ITS LAW IS THE OTHER ONE. D-12's "default scope = current session" is a
// SURFACE default — the op cannot construct it because `FunctionSpec.invoke` never sees a caller —
// so the surface that KNOWS its session is the one that supplies it. That makes the window stamp a
// DEFAULT-IF-ABSENT, which the receipt ref deliberately is not: an unattributed receipt must stay
// unattributed (absence is exclusion), while an unscoped ASK has a right answer for a chat caller.
//
// The session arm's REF is still an overwrite, for the write side's reason: which session is being
// asked about is this composition's fact, not the model's. The all-time and last-n arms pass
// through byte-untouched, because a model may legitimately ask a question this surface's default
// does not answer.

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
