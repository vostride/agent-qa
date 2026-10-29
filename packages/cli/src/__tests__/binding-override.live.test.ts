// Both arms run the same op, so only the bound argument differs; a missing run makes it observable.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_ASK_FUNCTION_ID,
  ANSWER_ONLY_TOOL_NAME,
  RUNS_DIGEST_FUNCTION_ID,
  fromToolName,
  invokeFunction,
  isChatMetaToolName,
} from '@vostride/agent-qa-agent'
import type {
  ClauseAction,
  ReconcileInput,
  ReconcileStrategy,
  ReconcileVerdict,
} from '@vostride/agent-qa-agent'
import type { LocalAgentHost, RunExecutionPort } from '@vostride/agent-qa-agent-local'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRunId,
} from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ClauseReceipt,
  CompletedRunHandoff,
  FunctionCaller,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { composeCliLocalAgent } from '../composition/local-agent-host.js'
import { resolveCliChatCapabilities } from '../llm-utils.js'
import type { CliChatCapabilities } from '../llm-utils.js'

const LIVE_CONFIG = process.env.AGENT_QA_LIVE_CHAT_CONFIG

/** The run this project actually has. The mapper binds it; it is addressable. */
const SEEDED_RUN_ID = 'RUN-1'

/** The run nobody has. The model binds it; addressing it fails by name. */
const DECOY_RUN_ID = 'RUN-404'

const UTTERANCE = `digest ${SEEDED_RUN_ID} and also show me the digest for ${DECOY_RUN_ID}`

/** The clause the table binds — the one whose executed binding flips between the two arms. */
const CANONICAL_CLAUSE = `digest ${SEEDED_RUN_ID}`

// No `grantedScopes` or `safeMode` on the caller; the registry reads neither.
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

/**
 * The override-OFF strategy: the verdict IS the model's plan (see the mutation proof's copy).
 *
 * Spelled here rather than shared, because two live differentials sharing one mutation instrument
 * would let a single edit weaken both at once — and this one is nine lines whose entire content is
 * the ABSENCE of any read of `input.mapped`.
 */
const modelVerbatimStrategy: ReconcileStrategy = (input: ReconcileInput): ReconcileVerdict => {
  const actions = input.planned.toolCalls.filter((call) => !isChatMetaToolName(call.toolName))
  const plan: ClauseAction[] = actions.map((call, index) => ({
    clause: input.clauses[index] ?? input.clauses[input.clauses.length - 1] ?? { text: '', index: 0 },
    functionId: fromToolName(call.toolName),
    args: call.input,
    source: 'planner',
  }))
  // The turn-level prose carry, re-derived; the instrument keeps it, not the shipped strategy.
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

function seedRun(agentQaRoot: string): void {
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(SEEDED_RUN_ID))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, HANDOFF_FILE),
    `${JSON.stringify({
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId(SEEDED_RUN_ID),
      scope: { tier: 'product', key: 'binding-override' },
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
  /** A tripwire: nothing in this differential should ever start a run. */
  readonly startedRuns: readonly RunsStartInput[]
  readonly reading: string
}

/** The receipt carrying the person's own canonical words — the same row in both arms. */
function canonicalReceipt(arm: Arm): ClauseReceipt | undefined {
  return arm.result.receipts.find((receipt) => receipt.clause === CANONICAL_CLAUSE)
}

function armReading(overrideOn: boolean, result: AgentAskResult): string {
  const ops = result.receipts
    .map((r) => `${r.clause} | ${r.functionId}:${r.status}:${r.origin}:${r.outcome}`)
    .join(' ;; ')
  return (
    `${overrideOn ? 'override on' : 'override off'} -> ${result.status}`
    + ` ops=[${ops}] unhandled=${result.unhandled?.clause ?? '-'}`
  )
}

describe("the binding differential's utterance", () => {
  it('names two different runs and opens with the clause the table binds', () => {
    // The two run ids must be genuinely different runs, or the differential compares one thing
    // with itself and passes forever.
    expect(DECOY_RUN_ID).not.toBe(SEEDED_RUN_ID)
    expect(UTTERANCE).toContain(DECOY_RUN_ID)
    expect(UTTERANCE.startsWith(CANONICAL_CLAUSE)).toBe(true)
  })
})

describe.skipIf(LIVE_CONFIG === undefined)(
  'the mapper binds the argument, and the model cannot re-address the clause',
  () => {
    let root: string
    let agentQaRoot: string
    let capabilities: CliChatCapabilities | undefined
    const hosts: LocalAgentHost[] = []

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'binding-override-'))
      agentQaRoot = join(root, '.agent-qa')
      mkdirSync(agentQaRoot, { recursive: true })
      seedRun(agentQaRoot)
      capabilities = await resolveCliChatCapabilities(String(LIVE_CONFIG))
    }, 120_000)

    afterAll(() => {
      for (const composed of hosts.splice(0)) void composed.close()
      rmSync(root, { recursive: true, force: true })
    })

    async function runArm(reconcile?: ReconcileStrategy): Promise<Arm> {
      const startedRuns: RunsStartInput[] = []
      // Bound so the default CLI executor — which re-enters `agent-qa run` as a child process —
      // can never fire. It records rather than refuses, so a plan that unexpectedly reached for a
      // run shows up as data instead of as an exception with a different story.
      const runExecution: RunExecutionPort = {
        execute(request) {
          startedRuns.push(request)
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
        { message: UTTERANCE },
        HUMAN,
      )) as AgentAskResult
      return { result, startedRuns, reading: armReading(reconcile === undefined, result) }
    }

    /**
     * PAIRED ATTEMPTS, with the validity condition on the MODEL'S OWN PLAN.
     *
     * An attempt is decisive when the off-arm shows the model proposed the digest op at all — a
     * fact about what the model did, never about the claim under test, so retrying on it cannot
     * retry the differential green. The claim is then asserted unconditionally on that pair. If no
     * attempt produces a model plan there is nothing to compare, and the suite FAILS saying exactly
     * that rather than reporting a proof it did not make.
     */
    const MAX_ATTEMPTS = 3
    let decisiveOn: Arm | undefined
    let decisiveOff: Arm | undefined
    let attemptsTaken = 0
    const attemptLines: string[] = []

    beforeAll(async () => {
      if (capabilities === undefined) return
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        attemptsTaken = attempt
        const on = await runArm()
        const off = await runArm(modelVerbatimStrategy)
        const planned = off.result.receipts.some(
          (receipt) => receipt.functionId === RUNS_DIGEST_FUNCTION_ID,
        )
        attemptLines.push(
          `attempt ${attempt}/${MAX_ATTEMPTS} `
            + `${planned ? 'decisive (the model planned the digest op)' : 'inconclusive (the model planned no digest)'}`
            + `\n  ${on.reading}\n  ${off.reading}`,
        )
        if (planned) {
          decisiveOn = on
          decisiveOff = off
          return
        }
      }
    }, 600_000)

    it('AUTH SMOKE: the host resolved a chat model', { timeout: 120_000 }, () => {
      expect(
        capabilities,
        'the host could not resolve a chat model from the configured project — check the config '
          + 'path, its registry.llms entry, and that its auth plugin is installed',
      ).toBeDefined()
    })

    it('THE CONTROL — override off: the clause `digest RUN-1` addresses the model’s run', () => {
      expect(
        decisiveOff,
        `no attempt in ${attemptsTaken} produced a model plan naming the digest op, so nothing `
          + `here can say the override corrected anything.\n${attemptLines.join('\n')}`,
      ).toBeDefined()
      const off = decisiveOff!
      const receipt = canonicalReceipt(off)

      // The person's own canonical words are still on the receipt — the clause was not dropped.
      expect(receipt, off.reading).toBeDefined()
      expect(receipt?.functionId, off.reading).toBe(RUNS_DIGEST_FUNCTION_ID)
      // It fails naming a missing run: the argument it is handed is the model's, not the table's.
      expect(receipt?.status, off.reading).toBe('failed')
      expect(receipt?.outcome, off.reading).toContain('RunNotFound')
      // Minted as the MODEL acting, because the planner is what bound it.
      expect(receipt?.origin, off.reading).toBe('agent')
      expect(off.startedRuns, off.reading).toEqual([])
    })

    it('THE CLAIM — override on: the SAME clause addresses the run the table bound', () => {
      expect(
        decisiveOn,
        `no attempt in ${attemptsTaken} produced a model plan naming the digest op.\n`
          + attemptLines.join('\n'),
      ).toBeDefined()
      const on = decisiveOn!
      const receipt = canonicalReceipt(on)

      // Same clause and function id, opposite outcome: only the bound argument differs.
      expect(receipt, on.reading).toBeDefined()
      expect(receipt?.functionId, on.reading).toBe(RUNS_DIGEST_FUNCTION_ID)
      expect(receipt?.status, on.reading).toBe('executed')
      // The table-bound clause executes as a person, never as a model-originated invocation.
      expect(receipt?.origin, on.reading).toBe('human')
      // The model's own proposal is not discarded — it answers the clause it was asked about, under
      // an agent origin, and fails on its own merits. The override narrows nothing but the clause
      // the table owns.
      const plannerReceipt = on.result.receipts.find(
        (candidate) => candidate.clause !== CANONICAL_CLAUSE,
      )
      expect(plannerReceipt?.functionId, on.reading).toBe(RUNS_DIGEST_FUNCTION_ID)
      expect(plannerReceipt?.origin, on.reading).toBe('agent')
      expect(on.startedRuns, on.reading).toEqual([])
    })
  },
)

describe('the binding differential is built out of the composition, not out of parts', () => {
  it('imports no reconciliation module and no vendor adapter — SPECIFIERS, never vocabulary', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const specifiers = [...source.matchAll(/^import[^'\n]*'([^']+)'/gm)].map((match) => match[1]!)
    expect(specifiers.length).toBeGreaterThan(5)
    expect(specifiers.filter((specifier) => specifier.includes('reconcil'))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.startsWith('@ai-sdk/'))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.endsWith('agent-qa-model'))).toEqual([])
    expect(specifiers).toContain('../composition/local-agent-host.js')
  })
})
