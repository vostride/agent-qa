// Skipped without `AGENT_QA_LIVE_CHAT_CONFIG`; the auth smoke runs first, so login fails once.

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

const SEEDED_RUN_ID = 'RUN-1'

const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const LIVE_CORPUS = SCENARIO_CORPUS.filter((entry) => entry.lane === 'live')

// The ceiling's denominator: `should_execute` cells in the frozen manifest.
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

function cellReading(scenario: ChatScenario, result: AgentAskResult): string {
  const ops = result.receipts.map((r) => `${r.functionId}:${r.status}`).join(', ')
  const answer = (result.answer ?? '').slice(0, 70).replace(/\s+/g, ' ')
  return (
    `${scenario.class}/${scenario.id} -> ${result.status} ops=[${ops}]`
    + ` unhandled=${result.unhandled?.clause ?? '-'} answer=${answer}`
  )
}

describe.skipIf(LIVE_CONFIG === undefined)(
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
        // The live gate opens no socket to a daemon that may be running.
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
        const reading = cellReading(scenario, result)
        const executed = result.receipts.filter((receipt) => receipt.status === 'executed')
        // `refused` also means a clause ran and returned, so the roll-call counts it too.
        const reached = result.receipts.filter((receipt) => clauseReachedCapability(receipt.status))

        if (scenario.expect.kind === 'should_execute') {
          expect(result.status, reading).toBe('completed')
          expect(result.receipts.map((receipt) => receipt.functionId), reading).toEqual(
            scenario.expect.ops ?? [],
          )
          expect(result.receipts.map((receipt) => receipt.status), reading).toEqual(
            result.receipts.map(() => 'executed'),
          )
          expect(executed, reading).toHaveLength(scenario.expect.executed)
        } else {
          // Atomic: the clause that could have run reached no capability, not merely no success.
          expect(result.status, reading).not.toBe('completed')
          expect(reached, reading).toHaveLength(0)
          expect(executed, reading).toHaveLength(0)
          expect(executed, reading).toHaveLength(scenario.expect.executed)
          const named = scenario.expect.namesClause ?? ''
          expect(named, reading).toBeTruthy()
          const namings = [
            result.unhandled?.reason ?? '',
            result.unhandled?.clause ?? '',
            ...result.receipts.map((receipt) => receipt.clause),
          ]
          expect(namings.some((text) => text.includes(named)), reading).toBe(true)
          // `executed == 0` misses a directive or an erased clause, so the arm reads the log.
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
            reading,
          ).toEqual([])
        }

        // One receipt per planned action, where the scenario names a count.
        if (scenario.expect.planned !== undefined) {
          expect(result.receipts, reading).toHaveLength(scenario.expect.planned)
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
      expect(counts.denominator).toBe(LIVE_DENOMINATOR)
      expect(
        ceilingExceeded(counts),
        `mark_unhandled ${counts.unhandledCount}/${counts.denominator}`,
      ).toBe(false)
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
