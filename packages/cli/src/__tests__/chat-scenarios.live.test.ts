// THE LIVE LANE (Phase 392 plan 09, CHAT-02 / CHAT-03 / CHAT-06 / D-13).
//
// A RELEASE GATE, NOT A PER-COMMIT ONE. `planner/` and `compound/` scenarios route through a real
// model, so they cost tokens and take wall-clock, and D-13 puts them behind an env gate for exactly
// that reason. The gate is `AGENT_QA_LIVE_CHAT_CONFIG` — the path of a project config whose
// `registry.llms` and auth plugins this host can resolve.
//
// A SKIP IS ANNOUNCED, ALWAYS. The one describe below that never skips prints which lane actually
// ran and, when it did not, why. A credential guard that degrades to a no-op when the environment
// differs has produced green runs that measured nothing in this codebase before; a skip nobody can
// see is that failure wearing a passing colour.
//
// THE FIRST CASE IS THE AUTH SMOKE (RESEARCH A5), and its position is the design. One trivial
// `generateText` through the composed model, so an auth failure reds ONE named case instead of
// shot-gunning nine scenario cells with nine different-looking errors that all mean "not logged in".
//
// THE MODEL COMES FROM THE HOST'S OWN RESOLUTION (CHAT-06). `resolveCliChatCapabilities` is the same
// function `agent-qa chat` calls — `createModel` behind the masking middleware and the profile
// resolution, never a provider client built here. A source assertion at the bottom pins the absence
// of any `@ai-sdk/*` import, by SPECIFIER rather than by vocabulary: this header talks about
// provider clients repeatedly and must stay free to (392-08's lesson — a source pin over a file
// that explains its own rule must match the mechanism, never the word).
//
// k = 1. Each live scenario runs ONCE per gate run. The aggregate honesty mechanism is the ceiling,
// not repetition: a corpus of nine cells measured once already answers "did routing hold", and
// k > 1 buys a variance estimate that nothing yet consumes. RETUNE PATH: if a cell is observed
// flapping across gate runs, raise k for the whole lane rather than for that cell — a per-cell k is
// a per-cell tolerance, and a tolerance attached to the flakiest cell is how a gate stops gating.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { CHAT_SESSIONS_SUBDIR } from '@vostride/agent-qa-agent-local'
import type { LocalAgentHost, RunExecutionPort } from '@vostride/agent-qa-agent-local'
import { FsEventLog, HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CLAUSE_RECEIPT_STATUSES,
  asRunId,
  clauseReachedCapability,
} from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatScenario,
  ChatSessionEvent,
  CompletedRunHandoff,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { generateText } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYamlDocument } from 'yaml'

import { composeCliLocalAgent } from '../composition/local-agent-host.js'
import { resolveCliChatCapabilities } from '../llm-utils.js'
import type { CliChatCapabilities } from '../llm-utils.js'

const SCENARIOS_ROOT = fileURLToPath(
  new URL('../../../agent/src/chat/scenarios/', import.meta.url),
)

/** The gate. A project config this host can resolve auth for; absent means the lane does not run. */
const LIVE_CONFIG = process.env.AGENT_QA_LIVE_CHAT_CONFIG

const SKIP_REASON =
  LIVE_CONFIG === undefined
    ? 'AGENT_QA_LIVE_CHAT_CONFIG is unset — no live-model auth was offered, so the planner and '
      + 'compound classes did not run. Set it to a project config path whose registry.llms and '
      + 'auth plugins resolve on this machine.'
    : undefined

const SEEDED_RUN_ID = 'RUN-1'

const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const LIVE_CORPUS = SCENARIO_CORPUS.filter((entry) => entry.lane === 'live')

/** The ceiling's denominator: `should_execute` cells in the FROZEN manifest (D-15). */
const LIVE_DENOMINATOR = LIVE_CORPUS.filter((entry) => entry.kind === 'should_execute').length

function readScenario(entry: (typeof SCENARIO_CORPUS)[number]): ChatScenario {
  const path = join(SCENARIOS_ROOT, scenarioRelativePath(entry))
  return parseScenario(parseYamlDocument(readFileSync(path, 'utf8')), entry)
}

function seedRun(agentQaRoot: string): void {
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(SEEDED_RUN_ID))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, HANDOFF_FILE),
    `${JSON.stringify({
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId(SEEDED_RUN_ID),
      scope: { tier: 'product', key: 'chat-scenarios-live' },
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
    } as unknown as CompletedRunHandoff)}\n`,
    'utf8',
  )
}

interface LiveCell {
  readonly result: AgentAskResult
  readonly events: readonly ChatSessionEvent[]
}

describe('the live lane announces which lane actually ran', () => {
  it('names the gate condition, so a skip can never be mistaken for a pass', () => {
    process.stderr.write(
      `\n[chat live lane] ${SKIP_REASON ?? `running against ${String(LIVE_CONFIG)}`}\n`,
    )
    // The corpus this gate would measure exists whether or not the gate runs — so a live lane that
    // silently lost its cells is visible from the hermetic run too.
    // 6 as of corpus v4: the five original live cells plus `compound/run-42-and-delete-root`,
    // the CR-03 regression cell. It is `fail_closed`, so the DENOMINATOR did not move — a gap
    // round that grew the denominator would report a better rate for having done work.
    //
    // 5 as of corpus v7 (394-11), and the SIZE STAYING AT 6 IS WHY THIS PAIR IS PINNED TOGETHER.
    // No cell joined the lane; two changed arm, because the authoring loop registered and the two
    // write-test cells became routable. That is the one movement a denominator is allowed to make
    // — a deliberate flip that a phase claims as its arrival proof — and it is distinguishable
    // here from the forbidden one only because both numbers are read at once.
    //
    // 7 AND 6 AS OF CORPUS v8 (395-09), AND BOTH MOVED, WHICH IS THE OTHER LEGAL MOVEMENT. 392 D-08
    // designed the config handoff as a flip and 395's research found no config cell in v7 to flip,
    // so `planner/config-edit-timeout` is ADMITTED: the lane gains a member AND the ceiling gains a
    // denominator entry. v7's flip moved the second number alone; this moves both. Reading them
    // together is what lets a later reader say which of the three movements happened — a flip, an
    // admission, or the forbidden one where a gap round quietly grows the denominator for work
    // being done — without reconstructing it from the diff.
    //
    // 9 AND 8 AS OF CORPUS v9 (398-07), AND BOTH MOVED BY TWO — an admission again, on v8's shape.
    // `agent.explain` did not exist in v8's build, so "what can you do" had no reachable op and no
    // cell was ever admitted that could flip; `planner/what-can-you-do` and
    // `planner/how-do-i-explain` join together because XPLN-02 names two SHAPES of question (an
    // enumeration and a request for one capability's command) and a planner that routed the first
    // and answered the second from model memory is a real, reachable half-failure.
    //
    // NEITHER HAD MET A MODEL AT THE COMMIT THAT ADMITTED THEM. `AGENT_QA_LIVE_CHAT_CONFIG` was
    // unset in that session, so this very cell announced the skip and the two rows are pinned but
    // unmeasured. That is exactly the state this announcement exists to make impossible to mistake
    // for a pass.
    expect(LIVE_CORPUS.length).toBe(9)
    expect(LIVE_DENOMINATOR).toBe(8)
  })
})

describe.skipIf(SKIP_REASON !== undefined)(
  'the live lane: planner/ and compound/ over the real host and a real model',
  () => {
    let root: string
    let agentQaRoot: string
    let capabilities: CliChatCapabilities | undefined
    const hosts: LocalAgentHost[] = []
    const cells = new Map<string, LiveCell>()

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'chat-live-'))
      agentQaRoot = join(root, '.agent-qa')
      mkdirSync(agentQaRoot, { recursive: true })
      seedRun(agentQaRoot)
      capabilities = await resolveCliChatCapabilities(String(LIVE_CONFIG))
    }, 120_000)

    afterAll(() => {
      for (const composed of hosts.splice(0)) void composed.close()
      rmSync(root, { recursive: true, force: true })
    })

    function compose(): LocalAgentHost {
      // A FAITHFUL run executor, not the default one: `createCliRunExecution` re-enters
      // `agent-qa run` as a child process, and a routing gate must not start a browser. It writes
      // the run's first event, because the composition reads the log back and refuses a host that
      // reported a run without producing one.
      const runExecution: RunExecutionPort = {
        execute() {
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
      const host = composeCliLocalAgent({
        agentQaRoot,
        configPath: String(LIVE_CONFIG),
        runExecution,
        // 2026-10-01 (432-17): the proposal apply delegate is deleted; the live gate still opens no
        // socket to a daemon that may be running.
        knowledgeChangeDelegate: () => Promise.reject(new Error('no change delegation in the live gate')),
        ...(capabilities === undefined
          ? {}
          : {
            chatModel: capabilities.model,
            chatModelFor: capabilities.modelFor,
            chatAccounting: capabilities.accounting,
          }),
      })
      hosts.push(host)
      return host
    }

    async function runCell(scenario: ChatScenario): Promise<LiveCell> {
      const host = compose()
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
      const cell: LiveCell = { result, events }
      cells.set(scenario.id, cell)
      // A LIVE GATE WHOSE FAILURE NOBODY CAN READ IS A GATE PEOPLE DISABLE. One line per cell,
      // naming what the model actually routed — refs and statuses only, never op payloads (D-18).
      process.stderr.write(
        `\n[chat live lane] ${scenario.class}/${scenario.id} -> ${result.status}`
          + ` ops=[${result.receipts.map((r) => `${r.functionId}:${r.status}`).join(', ')}]`
          + ` unhandled=${result.unhandled?.clause ?? '-'}`
          + ` answer=${(result.answer ?? '').slice(0, 70).replace(/\s+/g, ' ')}\n`,
      )
      return cell
    }

    it('AUTH SMOKE: the host resolves a model and it answers', { timeout: 120_000 }, async () => {
      // FIRST, deliberately. Everything below composes a host around this model; if auth is broken
      // this is the one case that reds, and it reds saying so.
      expect(
        capabilities,
        'the host could not resolve a chat model from the configured project — check the '
          + 'config path, its registry.llms entry, and that its auth plugin is installed',
      ).toBeDefined()
      const answer = await generateText({
        model: capabilities!.model,
        maxRetries: 0,
        temperature: 0,
        maxOutputTokens: 64,
        prompt: 'Reply with exactly the word: pong',
      })
      expect(answer.text.toLowerCase()).toContain('pong')
    })

    it.each(LIVE_CORPUS.map((entry) => [`${entry.class}/${entry.id}`, entry] as const))(
      '%s routes as its file says',
      { timeout: 180_000 },
      async (_label, entry) => {
        const scenario = readScenario(entry)
        const cell = await runCell(scenario)
        const { result } = cell
        const executed = result.receipts.filter((receipt) => receipt.status === 'executed')
        // 399.1 D-02: `refused` is a fourth word for a clause that RAN AND RETURNED, so a roll-call
        // spelled over `executed` alone acquired a hole exactly its width the day the member
        // landed. See `clauseReachedCapability`'s own header for why `failed` is outside it.
        const reached = result.receipts.filter((receipt) => clauseReachedCapability(receipt.status))

        if (scenario.expect.kind === 'should_execute') {
          expect(result.status).toBe('completed')
          expect(result.receipts.map((receipt) => receipt.functionId)).toEqual(
            scenario.expect.ops ?? [],
          )
          expect(result.receipts.map((receipt) => receipt.status)).toEqual(
            result.receipts.map(() => 'executed'),
          )
          expect(executed).toHaveLength(scenario.expect.executed)
        } else {
          // D-10's atomicity, live: the clause that COULD have run did not — and "did not" means
          // no capability was REACHED, not merely that none reported success.
          expect(result.status).not.toBe('completed')
          expect(reached).toHaveLength(0)
          expect(executed).toHaveLength(0)
          expect(executed).toHaveLength(scenario.expect.executed)
          const named = scenario.expect.namesClause ?? ''
          expect(named).toBeTruthy()
          const namings = [
            result.unhandled?.reason ?? '',
            result.unhandled?.clause ?? '',
            ...result.receipts.map((receipt) => receipt.clause),
          ]
          expect(namings.some((text) => text.includes(named))).toBe(true)
          // THE SIDE-EFFECT ROWS (392-11). `executed == 0` stayed true through both defects the
          // gap round closed — a directive never crosses the function layer, and an erased clause
          // leaves no receipt — so the arm reads the log a refused turn left instead.
          expect(
            cell.events.filter(
              (event) =>
                event.kind === 'approval_decision'
                || (event.kind === 'model_change' && event.source === 'verb')
                || (event.kind === 'clause_receipt'
                  // The LOG's status is bytes rather than a type — `ChatClauseReceiptEvent.status`
                  // is a bare `string` because this reader may be handed a line an older build
                  // wrote. Narrowing through the closed set is what lets the one predicate answer
                  // for it without the reader casting a word nothing has checked.
                  && CLAUSE_RECEIPT_STATUSES.some(
                    (status) => status === event.status && clauseReachedCapability(status),
                  )),
            ),
          ).toEqual([])
        }

        // ONE RECEIPT PER PLANNED ACTION, where the cell says how many (D-11, W-01): the field was
        // supplied by the cells that pin it and read by no runner until now.
        if (scenario.expect.planned !== undefined) {
          expect(result.receipts).toHaveLength(scenario.expect.planned)
        }
      },
    )

    it('holds the mark_unhandled ceiling over the FROZEN live denominator', () => {
      const measured = LIVE_CORPUS.filter((entry) => entry.kind === 'should_execute')
      // Guarded first: a run where cells threw before recording would leave a smaller tally and a
      // vacuously green ceiling.
      expect(measured.every((entry) => cells.has(entry.id))).toBe(true)

      const counts = computeMarkUnhandledRate(
        measured.flatMap((entry) => cells.get(entry.id)?.events ?? []),
        LIVE_DENOMINATOR,
      )
      process.stderr.write(
        `\n[chat live lane] mark_unhandled ${counts.unhandledCount}/${counts.denominator}\n`,
      )
      expect(counts.denominator).toBe(LIVE_DENOMINATOR)
      expect(ceilingExceeded(counts)).toBe(false)
    })
  },
)

describe('the live lane builds no provider client of its own, asserted on the source', () => {
  it('imports no vendor adapter — SPECIFIERS, never vocabulary', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // The header above discusses provider clients at length and must stay free to. What is pinned
    // is that no vendor adapter is IMPORTED and that the model arrives from the host's resolution.
    expect(source).not.toMatch(/['"]@ai-sdk\//)
    expect(source).not.toMatch(/['"]@vostride\/agent-qa-model['"]/)
    expect(source).toMatch(/resolveCliChatCapabilities/)
  })

  it('resolves a corpus that is actually there', () => {
    // A path that moved would leave every live cell unreadable in a way the skip gate would hide.
    expect(existsSync(join(SCENARIOS_ROOT, 'planner'))).toBe(true)
    expect(existsSync(join(SCENARIOS_ROOT, 'compound'))).toBe(true)
  })
})
