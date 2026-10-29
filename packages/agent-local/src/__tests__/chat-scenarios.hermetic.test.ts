// THE HERMETIC LANE (Phase 392 plan 09, CHAT-02 / CHAT-03 / D-13 / D-15).
//
// Every `deterministic` scenario in the frozen corpus, driven through `composeLocalAgent()` and
// `invokeFunction` — the real registry, the real gate, the real session log on a real disk. Nothing
// here assembles a turn engine, a resolver table or a reconciler by hand, because a differential
// built from parts can pass while the composition wires them wrong or not at all (Pitfall 3).
//
// IT ITERATES THE MANIFEST, NEVER THE DIRECTORY. `SCENARIO_CORPUS` decides what runs, and a source
// assertion at the bottom of this file pins the absence of any directory walk over `scenarios/`.
// That is not stylistic: the ceiling below is a ratio, and a runner that discovered its own cells
// would let the denominator grow every time somebody wrote a file (D-15, the treadmill law).
//
// "NO MOCKS IN EITHER LANE" IS A TRUE STATEMENT HERE, AND THE MODEL IS HOW IT IS PROVED. A
// deterministic scenario never touches the LLM BY CONTRACT — so there is nothing to mock — but an
// absence cannot prove a skip: a host with no model bound could not call one however wrong its
// routing was. So every composition below binds a real `ChatLanguageModel` whose generate hook
// counts and throws, and the final assertion is that it was reached zero times across the whole
// corpus. It is a tripwire, not a stand-in for an answer.
//
// WHAT EACH EXPECTATION KIND MEANS, stated once because a runner that decided per-cell would be a
// place for a cell to quietly decay:
//
//   should_execute — the turn COMPLETED; one receipt per clause; the receipts' function ids equal
//                    `ops` in utterance order; every receipt reached its capability and came back
//                    `executed`; `receipts.length === expect.executed`; and the session log carries
//                    ZERO `mark_unhandled` rows. Plus `emitsSessionEvent` and `answerContains`
//                    where the scenario states them — for the four directives those two ARE the
//                    assertion, since a directive invokes nothing and its numbers are the numbers
//                    a turn that did nothing at all would show (392-08).
//
//   fail_closed    — NOTHING was carried out (`executed` count 0, matching `expect.executed`), the
//                    turn did not complete, the refusal NAMES the clause, AND the session log
//                    carries none of the rows a side effect leaves. The naming is checked against
//                    `unhandled.reason` OR a failed receipt's clause, because the fail-closed cells
//                    refuse at different depths and all are honest refusals: `near-miss-alias`
//                    never routes and leaves a `mark_unhandled` row, while `fn-unknown-op` reaches
//                    `invokeFunction` step 1, which raises `UnknownFunctionError` naming the op
//                    before any dependency is touched.
//
// `executed == 0` WAS NOT ENOUGH, AND 392-VERIFICATION IS WHY (392-11). Both defects that arm
// missed stayed true through it: a directive never crosses the function layer, so a `/pin` carried
// out on a refused turn moved no count; and a clause erased by a model answer left no receipt to
// count either. So the arm now asserts the EVENTS — no `approval_decision`, no verb-sourced
// `model_change`, no `executed` receipt row — which is what a refused turn's own log must look
// like. `pin-and-write-test` is the cell that makes the assertion bite rather than pass vacuously.
//
// THE PORTS THE OP-BOUND CELLS NEED ARE BOUND (392-02's handover note, discharged). A run executor
// and one seeded run handoff, and nothing else. Without them `run`, `quoted-conjunction` and
// `digest` refuse for a reason that has nothing to do with routing — and a corpus whose cells fail
// for fixture reasons is a corpus that teaches its readers to ignore it. D-13's "no mocks" is about
// the LLM; a composed local host with real adapters over fixture data is not a mock.
//
// ARGUMENTS ARE PINNED WHERE THE COMPOSITION CAN SEE THEM. `ClauseReceipt` carries no arguments and
// must not: D-18 keeps this log refs-and-one-liners because surfaces render it directly, and op
// input is exactly the field that could carry a secret. So the two cells whose bound argument is
// load-bearing here — `run` and the Pitfall-5 quoted span — are asserted at the run executor's own
// seam, which is where production hands them over. Every scenario's `argsPin` is additionally
// walked against the stage-1 table in `packages/agent`'s `scenario-manifest.test.ts`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_ASK_FUNCTION_ID,
  SCENARIO_CORPUS,
  ceilingExceeded,
  computeMarkUnhandledRate,
  invokeFunction,
  parseScenario,
  scenarioRelativePath,
} from '@vostride/agent-qa-agent'
import type { ChatLanguageModel, JobModelCapability } from '@vostride/agent-qa-agent'
import { FsEventLog, HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  CLAUSE_RECEIPT_STATUSES,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  asRunId,
  clauseReachedCapability,
} from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatScenario,
  ChatSessionEvent,
  CompletedRunHandoff,
  FunctionCaller,
  MaskedResolvedConfig,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYamlDocument } from 'yaml'

import { CHAT_SESSIONS_SUBDIR } from '../session/jsonl-session-log.js'
import { composeLocalAgent } from '../composition/compose-local-agent.js'
import type { LocalAgentHost, RunExecutionPort } from '../composition/compose-local-agent.js'

/**
 * The corpus lives with the package that owns the routing it characterises (D-14), and this runner
 * lives with the composition that can drive it. Asserted below rather than assumed: a path that
 * moved would leave the walk scanning nothing and agreeing with an empty manifest forever.
 */
const SCENARIOS_ROOT = fileURLToPath(new URL('../../../agent/src/chat/scenarios/', import.meta.url))

/** The run the `digest` cell names. Seeded so that cell measures routing rather than a missing run. */
const SEEDED_RUN_ID = 'RUN-1'

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

/** A person holding every scope, so a refusal below can only ever be the axis under test. */
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const JOB_MODEL: JobModelCapability = {
  modelId: 'fixture:hermetic-scenarios',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const MINT_IDENTITY = (filePath: string): string => filePath

const HERMETIC_CORPUS = SCENARIO_CORPUS.filter((entry) => entry.lane === 'hermetic')

/** The ceiling's denominator: `should_execute` cells in the FROZEN manifest (D-15). */
const HERMETIC_DENOMINATOR = HERMETIC_CORPUS.filter((entry) => entry.kind === 'should_execute').length

function readScenario(entry: (typeof SCENARIO_CORPUS)[number]): ChatScenario {
  const path = join(SCENARIOS_ROOT, scenarioRelativePath(entry))
  return parseScenario(parseYamlDocument(readFileSync(path, 'utf8')), entry)
}

/** A model that FAILS the turn if it is ever reached, and counts the attempt either way. */
function plannerTripwire(): { model: ChatLanguageModel; calls: () => number } {
  let calls = 0
  const reached = (): never => {
    calls += 1
    throw new Error('a deterministic-class scenario consulted the planner')
  }
  const model = {
    specificationVersion: 'v3',
    provider: 'fixture',
    modelId: 'fixture:never-called',
    supportedUrls: {},
    doGenerate: reached,
    doStream: reached,
  } as unknown as ChatLanguageModel
  return { model, calls: () => calls }
}

/**
 * A model that emits exactly the tool calls it was handed (392-14).
 *
 * THE MODEL IS THE UNTRUSTED PARTY THIS MECHANISM CONSTRAINS, and that is the whole justification
 * for this seam. D-13's "no mocks in either lane" is a rule about scenarios whose OUTCOME would
 * otherwise be the mock's behaviour rather than a model's — a `should_execute` cell passing
 * because a stand-in said the right thing teaches nothing. A script that encodes the ADVERSARIAL
 * shape on a `fail_closed` cell is the opposite move: it is fault injection against the guard, in
 * the same family as the mutation differentials, and the cell's claim is that the guard refuses
 * whatever the model says. Nothing here asserts what a model WOULD emit.
 *
 * Without it, `run-42-and-delete-root-empty-answer` would be green pre-fix for a reason that has
 * nothing to do with the defect: the tripwire throws, the planner stage folds that into a
 * `failure`, and the turn fails closed on an unreachable planner rather than on the empty-prose
 * claim. A cell that passes for the wrong reason is worse than no cell.
 */
function scriptedPlanner(
  calls: readonly { readonly toolName: string; readonly input: string }[],
): { model: ChatLanguageModel; calls: () => number } {
  let reached = 0
  const model = {
    specificationVersion: 'v3',
    provider: 'fixture',
    modelId: 'fixture:scripted',
    supportedUrls: {},
    doGenerate: () => {
      reached += 1
      return Promise.resolve({
        content: calls.map((call, index) => ({
          type: 'tool-call' as const,
          toolCallId: `scripted-${String(index)}`,
          toolName: call.toolName,
          input: call.input,
        })),
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      })
    },
    doStream: (): never => {
      throw new Error('the hermetic lane never streams')
    },
  } as unknown as ChatLanguageModel
  return { model, calls: () => reached }
}

/**
 * Which cells get a scripted planner instead of the tripwire — a NAMED map, never a predicate.
 *
 * The same discipline `HERMETIC_COMPOUND` uses in `scenario-manifest.test.ts`: a cell cannot
 * acquire a scripted model by matching a pattern, only by being listed here in committed code.
 * Every other cell in the lane still gets the tripwire, and the zero-calls assertion still holds
 * over the `should_execute` arm, which no entry here may join.
 */
const SCRIPTED_PLANNERS: ReadonlyMap<
  string,
  readonly { readonly toolName: string; readonly input: string }[]
> = new Map([
  [
    'run-42-and-delete-root-empty-answer',
    [
      {
        toolName: 'answer_only',
        input: JSON.stringify({ clause: 'delete the knowledge root', text: '' }),
      },
    ],
  ],
  [
    // 392-15, CR-01 verbatim. Stage 2 is asked only about "summarise the last failure" — the table
    // already resolved "run test 42" — and the script answers with TWO calls, the FIRST of them
    // about the clause the table resolved. The model's patterns are deliberately unlike the
    // table's (`tests/everything.spec.ts` vs `test 42`) so a pre-fix run shows WHOSE arguments
    // executed: the extra call was popped by the clause that needed a proposal, `runs.start` ran a
    // second time against a clause that asked for a digest, and `runs_digest` was discarded.
    'run-42-and-summarise-extra-call',
    [
      {
        toolName: 'runs_start',
        input: JSON.stringify({ patterns: ['tests/everything.spec.ts'] }),
      },
      { toolName: 'runs_digest', input: JSON.stringify({ runId: 'RUN-1' }) },
    ],
  ],
])

function seedRun(agentQaRoot: string, runId: string): void {
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
  mkdirSync(runDir, { recursive: true })
  const handoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'chat-scenarios' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 'TST-42',
        testName: 'checks out',
        filePath: 'tests/checkout.spec.ts',
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      },
    ],
  } as unknown as CompletedRunHandoff
  writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff)}\n`, 'utf8')
}

interface Cell {
  readonly result: AgentAskResult
  readonly events: readonly ChatSessionEvent[]
  readonly startedRuns: readonly RunsStartInput[]
  readonly plannerCalls: number
}

describe('the hermetic lane: the frozen deterministic corpus over the real composition', () => {
  let root: string
  let agentQaRoot: string
  const hosts: LocalAgentHost[] = []
  /** What actually ran, keyed by scenario id — the ceiling below reads this and nothing else. */
  const cells = new Map<string, Cell>()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chat-scenarios-'))
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
    seedRun(agentQaRoot, SEEDED_RUN_ID)
  })

  afterEach(() => {
    for (const composed of hosts.splice(0)) void composed.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function runCell(scenario: ChatScenario): Promise<Cell> {
    const script = SCRIPTED_PLANNERS.get(scenario.id)
    const tripwire = script === undefined ? plannerTripwire() : scriptedPlanner(script)
    const startedRuns: RunsStartInput[] = []
    // A FAITHFUL executor, not a stub that returns a plausible id. The composition reads the run's
    // own durable event log back and refuses a host that reported a run without producing one
    // (`RunProducedNoEventsError`) — which is the composition contributing the half a host must not
    // be trusted with. So the fixture does what a real executor does: it writes the run's first
    // event, under the id of the run this project already has.
    const runExecution: RunExecutionPort = {
      execute(request) {
        startedRuns.push(request)
        new FsEventLog({ root: agentQaRoot, runId: SEEDED_RUN_ID }).append({
          seq: 1,
          ts: 1,
          runId: SEEDED_RUN_ID,
          type: 'runStarted',
          payload: {},
        } as never)
        return Promise.resolve({ runId: asRunId(SEEDED_RUN_ID) })
      },
    }
    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => join(root, 'agent-qa-knowledge'),
      model: () => JOB_MODEL,
      runExecution,
      chatModel: tripwire.model,
    })
    hosts.push(host)

    const result = (await invokeFunction(
      host.registry,
      AGENT_ASK_FUNCTION_ID,
      { message: scenario.utterance },
      HUMAN,
    )) as AgentAskResult

    const events = readFileSync(
      join(agentQaRoot, CHAT_SESSIONS_SUBDIR, `${result.sessionId}.jsonl`),
      'utf8',
    )
      .split('\n')
      .filter((line) => line !== '')
      .slice(1)
      .map((line) => JSON.parse(line) as ChatSessionEvent)

    const cell: Cell = { result, events, startedRuns, plannerCalls: tripwire.calls() }
    cells.set(scenario.id, cell)
    return cell
  }

  it('walks a real corpus rather than an empty one', () => {
    // Every assertion below is `it.each` over the manifest, and an empty manifest would make the
    // whole file green while measuring nothing. 17 as of corpus v6: the 13 deterministic cells plus
    // the four hermetic compound cells — `pin-and-write-test` (392-11), 392-14's
    // `pin-and-pin-nonsense` / `run-42-and-delete-root-empty-answer`, and 392-15's
    // `run-42-and-summarise-extra-call`.
    expect(HERMETIC_CORPUS.length).toBe(17)
    // THE DENOMINATOR. All four hermetic compound cells are `fail_closed`, so no round grew it for
    // doing work. 432-13 (corpus v10) moved it DOWN, deliberately: the retired `pin` and `proposals`
    // aliases stay as `fail_closed` absence cells, taking the should_execute count from 11 to 9.
    expect(HERMETIC_DENOMINATOR).toBe(9)
  })

  it.each(HERMETIC_CORPUS.map((entry) => [`${entry.class}/${entry.id}`, entry] as const))(
    '%s routes as its file says',
    async (_label, entry) => {
      const scenario = readScenario(entry)
      const cell = await runCell(scenario)
      const { result } = cell
      const executed = result.receipts.filter((receipt) => receipt.status === 'executed')
      // 399.1 D-02: `refused` is a fourth word for a clause that RAN AND RETURNED, so a roll-call
      // spelled over `executed` alone acquired a hole exactly its width the day the member landed.
      // An op that reached its capability and declined leaves this row — and a blocked config
      // proposal is FILED on the way, carrying its own id so a person can find it.
      const reached = result.receipts.filter((receipt) => clauseReachedCapability(receipt.status))

      if (scenario.expect.kind === 'should_execute') {
        expect(result.status).toBe('completed')
        expect(result.receipts.map((receipt) => receipt.functionId)).toEqual(
          scenario.expect.ops ?? [],
        )
        // Every clause that was dispatched reached its capability and came back. A cell tolerating
        // a `failed` receipt would go green while the op it names refuses.
        expect(result.receipts.map((receipt) => receipt.status)).toEqual(
          result.receipts.map(() => 'executed'),
        )
        expect(executed).toHaveLength(scenario.expect.executed)
        // A `should_execute` turn that left a refusal row is the decay the ceiling exists to catch.
        expect(cell.events.filter((event) => event.kind === 'mark_unhandled')).toHaveLength(0)
      } else {
        // D-10's atomicity: NOTHING was carried out, whatever depth the refusal came from — and
        // "nothing" means no capability was REACHED, not merely that none reported success.
        expect(result.status).not.toBe('completed')
        expect(reached).toHaveLength(0)
        expect(executed).toHaveLength(0)
        expect(executed).toHaveLength(scenario.expect.executed)
        const named = scenario.expect.namesClause
        expect(named, 'a fail_closed scenario must name what it refused (D-08)').toBeTruthy()
        const namings = [
          result.unhandled?.reason ?? '',
          result.unhandled?.clause ?? '',
          ...result.receipts.map((receipt) => receipt.clause),
        ]
        expect(namings.some((text) => text.includes(named ?? ''))).toBe(true)
        // THE SIDE-EFFECT ROWS, which is the half `executed == 0` could not see (392-11). A turn
        // that told a person "nothing in the request was carried out" must have a log that says the
        // same thing: no pin decision, no verb-sourced model switch, no executed receipt.
        expect(
          cell.events.filter(
            (event) =>
              event.kind === 'approval_decision'
              || (event.kind === 'model_change' && event.source === 'verb')
              || (event.kind === 'clause_receipt'
                // The LOG's status is bytes rather than a type — `ChatClauseReceiptEvent.status` is
                // a bare `string` because this reader may be handed a line an older build wrote.
                // Narrowing through the closed set is what lets the one predicate answer for it
                // without the reader casting a word nothing has checked.
                && CLAUSE_RECEIPT_STATUSES.some(
                  (status) => status === event.status && clauseReachedCapability(status),
                )),
          ),
        ).toEqual([])
      }

      // ONE RECEIPT PER PLANNED ACTION, where the cell says how many (D-11, W-01). The field was
      // declared in the vocabulary and supplied by the cells that pin it, and until now no runner
      // read it — a pin nothing consumes is a comment with a schema.
      if (scenario.expect.planned !== undefined) {
        expect(result.receipts).toHaveLength(scenario.expect.planned)
      }

      if (scenario.expect.emitsSessionEvent !== undefined) {
        expect(cell.events.map((event) => event.kind)).toContain(scenario.expect.emitsSessionEvent)
      }
      if (scenario.expect.answerContains !== undefined) {
        expect(result.answer ?? '').toContain(scenario.expect.answerContains)
      }

      // A SCRIPTED CELL MUST REFUSE AT THE RECONCILER, NOT AT AN UNREACHABLE PLANNER (392-14).
      // Without this, `run-42-and-delete-root-empty-answer` would stay green for a reason that has
      // nothing to do with the defect: if the script ever stopped being wired the tripwire would
      // throw, stage 2 would fold that into a `failure`, and the turn would fail closed naming the
      // same clause with the same `executed: 0`. So the two facts that make the cell about the
      // guard are pinned: the model WAS reached, and what it said reached stage 3 intact — a
      // planner `stage_outcome` of `resolved` is exactly `toolCalls.length > 0`.
      if (SCRIPTED_PLANNERS.has(scenario.id)) {
        expect(cell.plannerCalls).toBe(1)
        expect(
          cell.events
            .filter((event) => event.kind === 'stage_outcome')
            .map((event) => [event.stage, event.outcome]),
        ).toEqual([
          ['resolver', 'unresolved'],
          ['planner', 'resolved'],
          ['reconcile', 'unresolved'],
        ])
      }

      // THE STRONG FORM OF "NO LLM IN THIS LANE", and it applies to the arm that claims it: a
      // `should_execute` deterministic cell is entirely table-resolvable BY CONTRACT, so a model
      // was bound and must have gone untouched. A `fail_closed` cell whose clause the table does
      // not know legitimately flows onward to stage 2 — and what it proves instead is the stronger
      // fact: even with a planner present and unable to help, an unroutable clause becomes a named
      // refusal rather than an invocation.
      if (scenario.expect.kind === 'should_execute') expect(cell.plannerCalls).toBe(0)
    },
  )

  it('binds the run executor the arguments actually cross, quoted span intact', () => {
    // `ClauseReceipt` carries no arguments by design (D-18), so this is the one seam in the
    // composed path where a bound argument is observable — and it is the seam production uses.
    expect(cells.get('run')?.startedRuns).toEqual([{ patterns: ['tests/checkout.spec.ts'] }])
    // The Pitfall-5 claim, end to end: ONE clause, one start, and the quoted conjunction survives
    // into the bound argument rather than being torn into a phantom second clause.
    expect(cells.get('quoted-conjunction')?.startedRuns).toEqual([
      { patterns: ['"add and remove items"'] },
    ])
  })

  it('measures the mark_unhandled rate over the FROZEN manifest and holds the ceiling', () => {
    // The denominator is the manifest's `should_execute` count. Guarded first: a run in which some
    // cells threw before recording would produce a smaller tally and a vacuously green ceiling.
    const measured = HERMETIC_CORPUS.filter((entry) => entry.kind === 'should_execute')
    expect(measured.every((entry) => cells.has(entry.id))).toBe(true)

    const refusals = measured.flatMap((entry) => cells.get(entry.id)?.events ?? [])
    const counts = computeMarkUnhandledRate(refusals, HERMETIC_DENOMINATOR)

    expect(counts.denominator).toBe(HERMETIC_DENOMINATOR)
    // THE GATE FIRST, so a control that breaks routing reds the gate rather than short-circuiting
    // on the stricter line below and leaving the gate itself unexercised.
    expect(ceilingExceeded(counts)).toBe(false)
    // Then the stronger claim this lane can make: these cells never touch a model, so an unhandled
    // clause here is a routing defect and not a model having a bad day. Note the two are not the
    // same threshold — 1/5 over an eleven-cell denominator tolerates two misses, and this line is
    // what actually holds the hermetic lane to none.
    expect(counts.unhandledCount).toBe(0)
  })
})

describe('the runner cannot discover its own cells (source assertion)', () => {
  it('reaches the corpus only through the manifest — no directory walk over scenarios/', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // Structure, not vocabulary: the prose above says "directory walk" repeatedly and must be free
    // to. What is pinned is that no reader API is CALLED against the scenarios tree.
    expect(source).not.toMatch(/readdirSync\s*\(/)
    expect(source).not.toMatch(/globSync\s*\(/)
    expect(source).toMatch(/SCENARIO_CORPUS\.filter/)
  })
})
