// Both arms go through the composition root; only the deterministic override differs between them.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_ASK_FUNCTION_ID,
  ANSWER_ONLY_TOOL_NAME,
  RUNS_DIGEST_FUNCTION_ID,
  SCENARIO_CORPUS,
  SCENARIO_CORPUS_VERSION,
  fromToolName,
  invokeFunction,
  isChatMetaToolName,
  parseScenario,
  scenarioRelativePath,
} from '@vostride/agent-qa-agent'
import type {
  ClauseAction,
  ReconcileInput,
  ReconcileStrategy,
  ReconcileVerdict,
} from '@vostride/agent-qa-agent'
import type { LocalAgentHost, RunExecutionPort } from '@vostride/agent-qa-agent-local'
import { FsEventLog, HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRunId,
} from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatScenario,
  CompletedRunHandoff,
  FunctionCaller,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYamlDocument } from 'yaml'

import { composeCliLocalAgent } from '../composition/local-agent-host.js'
import { resolveCliChatCapabilities } from '../llm-utils.js'
import type { CliChatCapabilities } from '../llm-utils.js'

const SCENARIOS_ROOT = fileURLToPath(
  new URL('../../../agent/src/chat/scenarios/', import.meta.url),
)

const HOST_SOURCE = fileURLToPath(new URL('../composition/local-agent-host.ts', import.meta.url))

const LIVE_CONFIG = process.env.AGENT_QA_LIVE_CHAT_CONFIG

/** The run the scenario's second clause names. Seeded so the cell measures routing, not a gap. */
const SEEDED_RUN_ID = 'RUN-1'

/** What the deterministic table binds for the scenario's first clause — the mapper's own verdict. */
const MAPPER_BINDING: RunsStartInput = { patterns: ['test 42'] }

// No `grantedScopes` or `safeMode` on the caller; the registry reads neither.
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

/** THE named subject, taken off the frozen manifest rather than named by a literal here. */
const SUBJECT = SCENARIO_CORPUS.find(
  (candidate) => candidate.class === 'compound' && candidate.id === 'run-42-and-digest',
)

/**
 * THE OVERRIDE-OFF STRATEGY. Defined here, injected through the composition option, and exported
 * to nothing — it is a differential's instrument and never a production surface.
 *
 * `input.mapped` is not read on any path through this function, which is the mutation: what the
 * deterministic table proved about a clause has no effect on the verdict. Everything else is left
 * exactly as the shipped strategy has it — the meta-tool filter, the tool-name reversal, the
 * unvalidated argument carry-across — so the ONE difference between the two assemblies is whether
 * the mapper is consulted.
 */
const modelVerbatimStrategy: ReconcileStrategy = (input: ReconcileInput): ReconcileVerdict => {
  const actions = input.planned.toolCalls.filter((call) => !isChatMetaToolName(call.toolName))
  const plan: ClauseAction[] = actions.map((call, index) => ({
    // The clause is presentational here: this strategy aligns by POSITION in the model's own plan,
    // because a strategy that consulted the clauses to place a call would be consulting exactly the
    // structure the override is made of.
    clause: input.clauses[index] ?? input.clauses[input.clauses.length - 1] ?? { text: '', index: 0 },
    functionId: fromToolName(call.toolName),
    args: call.input,
    source: 'planner',
  }))
  // The turn-level prose carry, re-derived: the instrument models a reconciler with no override.
  const firstAnswer = input.planned.toolCalls.find(
    (call) => call.toolName === ANSWER_ONLY_TOOL_NAME,
  )?.input
  const answer =
    typeof firstAnswer === 'object' && firstAnswer !== null
      ? (firstAnswer as { text?: unknown }).text
      : undefined
  return typeof answer === 'string'
    ? { kind: 'execute', plan, answer }
    : { kind: 'execute', plan }
}

function readSubject(): ChatScenario {
  if (SUBJECT === undefined) throw new Error('the frozen manifest no longer lists the reconciliation subject')
  const path = join(SCENARIOS_ROOT, scenarioRelativePath(SUBJECT))
  return parseScenario(parseYamlDocument(readFileSync(path, 'utf8')), SUBJECT)
}

function seedRun(agentQaRoot: string): void {
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(SEEDED_RUN_ID))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, HANDOFF_FILE),
    `${JSON.stringify({
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId(SEEDED_RUN_ID),
      scope: { tier: 'product', key: 'mutation-proof' },
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

interface Arm {
  readonly result: AgentAskResult
  /** What the injected run executor was actually called with — the bound-argument observable. */
  readonly startedRuns: readonly RunsStartInput[]
  readonly reading: string
}

function armReading(
  overrideOn: boolean,
  result: AgentAskResult,
  startedRuns: readonly RunsStartInput[],
): string {
  const ops = result.receipts.map((r) => `${r.functionId}:${r.status}:${r.origin}`).join(', ')
  return (
    `${overrideOn ? 'override on' : 'override off'} -> ${result.status} ops=[${ops}]`
    + ` runs=${JSON.stringify(startedRuns)} unhandled=${result.unhandled?.clause ?? '-'}`
  )
}

/**
 * The scenario's own contract, applied identically to both arms.
 *
 * ONE function, called twice, so "arm A passed and arm B failed" cannot be an artefact of two
 * differently-written checks. Arm B asserts that this THROWS, which is what makes the suite pass
 * by MEASURING the red rather than by declaring it.
 */
function assertScenario(scenario: ChatScenario, arm: Arm, message: string): void {
  const executed = arm.result.receipts.filter((receipt) => receipt.status === 'executed')
  expect(arm.result.status, message).toBe('completed')
  expect(arm.result.receipts.map((receipt) => receipt.functionId), message).toEqual(
    scenario.expect.ops ?? [],
  )
  expect(arm.result.receipts.map((receipt) => receipt.status), message).toEqual(
    arm.result.receipts.map(() => 'executed'),
  )
  expect(executed, message).toHaveLength(scenario.expect.executed)
}

describe("the mutation proof's subject and build", () => {
  it('takes an admitted should_execute member of the live corpus as its subject', () => {
    // The subject must be an ADMITTED member of the frozen corpus, not a file this test found.
    expect(SUBJECT).toBeDefined()
    expect(SUBJECT?.kind).toBe('should_execute')
  })

  it('is loaded against a FRESH build of the corpus it measures', () => {
    // Compares the built corpus version with the source's, so a stale dist fails here.
    const declared = /SCENARIO_CORPUS_VERSION = (\d+)/.exec(
      readFileSync(join(SCENARIOS_ROOT, 'manifest.ts'), 'utf8'),
    )?.[1]
    expect(declared, 'the manifest source no longer declares a corpus version').toBeDefined()
    expect(SCENARIO_CORPUS_VERSION).toBe(Number(declared))
    expect(SCENARIO_CORPUS_VERSION).toBeGreaterThanOrEqual(3)
    const onDisk = parseYamlDocument(
      readFileSync(join(SCENARIOS_ROOT, scenarioRelativePath(SUBJECT!)), 'utf8'),
    ) as { utterance?: string }
    expect(onDisk.utterance).toBe('run test 42 and show me the digest for RUN-1')
  })
})

describe.skipIf(LIVE_CONFIG === undefined)(
  'the deterministic override, proved by removing it',
  () => {
    let root: string
    let agentQaRoot: string
    let capabilities: CliChatCapabilities | undefined
    const hosts: LocalAgentHost[] = []

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'mutation-proof-'))
      agentQaRoot = join(root, '.agent-qa')
      mkdirSync(agentQaRoot, { recursive: true })
      seedRun(agentQaRoot)
      capabilities = await resolveCliChatCapabilities(String(LIVE_CONFIG))
    }, 120_000)

    afterAll(() => {
      for (const composed of hosts.splice(0)) void composed.close()
      rmSync(root, { recursive: true, force: true })
    })

    /**
     * ONE assembly function, called for both arms with the SAME arguments except the strategy.
     *
     * That is the differential's discipline expressed as code: there is exactly one variable
     * between the two hosts, and it is the one under test. The strategy is conditionally spread so
     * the on-arm leaves the field ABSENT — the composition's own `?? deterministicOverrideStrategy`
     * is then what answers, which is the production path rather than a re-statement of it.
     */
    async function runArm(utterance: string, reconcile?: ReconcileStrategy): Promise<Arm> {
      const startedRuns: RunsStartInput[] = []
      // A faithful executor that records the request, the one place a bound argument is observable.
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
        ...(reconcile === undefined ? {} : { chatReconcile: reconcile }),
      })
      hosts.push(host)

      const result = (await invokeFunction(
        host.registry,
        AGENT_ASK_FUNCTION_ID,
        { message: utterance },
        HUMAN,
      )) as AgentAskResult
      return {
        result,
        startedRuns,
        reading: armReading(reconcile === undefined, result, startedRuns),
      }
    }

    it('AUTH SMOKE: the host resolved a chat model', { timeout: 120_000 }, () => {
      // FIRST, deliberately: everything below composes a host around this model, so a credential
      // failure reds ONE named case instead of two arms failing in two different-looking ways that
      // both mean "not logged in" — and a differential whose arms both fail for an unrelated
      // reason is exactly the vacuous proof this plan exists to avoid.
      expect(
        capabilities,
        'the host could not resolve a chat model from the configured project — check the config '
          + 'path, its registry.llms entry, and that its auth plugin is installed',
      ).toBeDefined()
    })

    // Each attempt runs both arms and counts only if the on-arm passes; no decisive attempt fails.
    const MAX_ATTEMPTS = 3
    let decisiveOn: Arm | undefined
    let decisiveOff: Arm | undefined
    let attemptsTaken = 0
    const attemptLines: string[] = []

    beforeAll(async () => {
      if (capabilities === undefined) return
      const scenario = readSubject()
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        attemptsTaken = attempt
        const on = await runArm(scenario.utterance)
        const off = await runArm(scenario.utterance, modelVerbatimStrategy)
        let decisive = true
        try {
          assertScenario(scenario, on, on.reading)
        } catch {
          decisive = false
        }
        attemptLines.push(
          `attempt ${attempt}/${MAX_ATTEMPTS} `
            + `${decisive ? 'decisive' : 'inconclusive (the on-arm did not satisfy the scenario)'}`
            + `\n  ${on.reading}\n  ${off.reading}`,
        )
        if (decisive) {
          decisiveOn = on
          decisiveOff = off
          return
        }
      }
    }, 600_000)

    it('AUTH SMOKE: the host resolved a chat model', { timeout: 120_000 }, () => {
      // FIRST, deliberately: everything below composes a host around this model, so a credential
      // failure reds ONE named case instead of two arms failing in two different-looking ways that
      // both mean "not logged in" — and a differential whose arms both fail for an unrelated
      // reason is exactly the vacuous proof this plan exists to avoid.
      expect(
        capabilities,
        'the host could not resolve a chat model from the configured project — check the config '
          + 'path, its registry.llms entry, and that its auth plugin is installed',
      ).toBeDefined()
    })

    it('ARM A — the shipped override: the named scenario is GREEN through the composition root', () => {
      expect(
        decisiveOn,
        `no decisive attempt in ${attemptsTaken}: the on-arm never satisfied the committed `
          + 'scenario, so there is no green side for the mutation to take away. This is a report '
          + `about the live cell, not about the override.\n${attemptLines.join('\n')}`,
      ).toBeDefined()
      const scenario = readSubject()
      const on = decisiveOn!
      assertScenario(scenario, on, on.reading)
      // The two claims the scenario cannot make about itself, because a receipt carries no
      // arguments and no stage: the MAPPER's binding is what reached the run executor, and the
      // clause the table bound executed as a person acting rather than as the model acting.
      expect(on.startedRuns, on.reading).toEqual([MAPPER_BINDING])
      expect(on.result.receipts[0]?.origin, on.reading).toBe('human')
      expect(on.result.receipts[1]?.functionId, on.reading).toBe(RUNS_DIGEST_FUNCTION_ID)
      expect(on.result.receipts[1]?.origin, on.reading).toBe('agent')
    })

    it('ARM B — the override removed: the SAME scenario goes RED, and the suite measures the red', () => {
      expect(
        decisiveOff,
        `no decisive attempt in ${attemptsTaken}.\n${attemptLines.join('\n')}`,
      ).toBeDefined()
      const scenario = readSubject()
      const arm = decisiveOff!

      // THE MUTATION PROOF, in one line: the scenario's own contract, applied to the same
      // utterance through the same composition with one option changed, THROWS.
      expect(() => {
        assertScenario(scenario, arm, arm.reading)
      }, arm.reading).toThrow()

      // The predicted SHAPE, asserted rather than left to the reader. Recording which shape was
      // measured is the plan's own requirement, and asserting it is what stops the red above from
      // being satisfied by an unrelated failure — a differential whose off-arm reds for a setup
      // reason proves nothing about the mechanism.
      expect(arm.result.receipts.map((receipt) => receipt.functionId), arm.reading).toEqual([
        RUNS_DIGEST_FUNCTION_ID,
      ])
      // ZERO runs started: the half the person typed as a canonical command is simply gone. This
      // is the whole cost of the override, stated as a measurement.
      expect(arm.startedRuns, arm.reading).toEqual([])
      // And the loss is SILENT — the turn still reports success. A refusal would at least be
      // visible; this is the failure shape the deterministic override exists to make impossible.
      expect(arm.result.status, arm.reading).toBe('completed')
      expect(
        arm.result.receipts.every((receipt) => receipt.origin === 'agent'),
        arm.reading,
      ).toBe(true)
    })
  },
)

describe('the differential is built out of the composition, not out of parts', () => {
  it('imports no reconciliation module and no vendor adapter — SPECIFIERS, never vocabulary', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // Walks the file's import specifiers, because the header names what the file must not import.
    const specifiers = [...source.matchAll(/^import[^'\n]*'([^']+)'/gm)].map((match) => match[1]!)
    expect(specifiers.length).toBeGreaterThan(5)
    expect(specifiers.filter((specifier) => specifier.includes('reconcil'))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.startsWith('@ai-sdk/'))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.endsWith('agent-qa-model'))).toEqual([])
    // POSITIVE CONTROL: without it, "no such import" and "the walker found nothing" are one green.
    expect(specifiers).toContain('../composition/local-agent-host.js')
  })

  it('the strategy reaches composeLocalAgent through the host, and the host threads it', () => {
    // The behavioural proof of this threading is ARM B itself: if the passthrough were removed the
    // two arms would compose identically and the differential would collapse into one measurement
    // twice. This source assertion is the cheap companion that names WHERE the option lands, so a
    // reader of this file can find the seam without reading the host end to end.
    const host = readFileSync(HOST_SOURCE, 'utf8')
    expect(host).toMatch(/composeLocalAgent\(\{/)
    expect(host).toMatch(/chatReconcile: input\.chatReconcile/)
  })
})
