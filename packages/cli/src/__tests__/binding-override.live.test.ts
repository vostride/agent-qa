// THE D-12 BINDING-OVERRIDE DIFFERENTIAL (Phase 392 plan 10, CHAT-02).
//
// D-12 IS TWO CLAIMS AND THIS FILE ISOLATES THE SECOND. Where the deterministic table resolved a
// clause, the mapper's verdict beats the model's on the ACTION SET and on the BOUND ARGUMENTS — and
// the second half is the dangerous one, because a reconciler that honoured the count and not the
// binding runs the RIGHT capability against the WRONG entity, which looks exactly like success. The
// mutation proof next door measures the action-set half (a clause vanishes). This file holds the
// action set FIXED — one op, `runs.digest`, in both arms and on both clauses — so the only thing
// that can differ between the two assemblies is which argument was bound.
//
// THE DIFFERENTIAL COMPARES ONE CLAUSE AGAINST ITSELF. The utterance is two clauses: `digest RUN-1`,
// which the table binds to the run that exists, and a prose clause naming a run that does not. With
// the override on, the receipt carrying the words `digest RUN-1` is EXECUTED — it was handed the
// mapper's `RUN-1`. With the override off, THE SAME RECEIPT, carrying the same words and the same
// function id, comes back FAILED with `RunNotFoundError`, because a strategy that never consults
// the mapper fills the first clause with the first thing the model proposed. Same composition, same
// utterance, same op, one variable — and what the person's own words addressed flips.
//
// WHY A MISSING RUN IS THE OBSERVABLE. `ClauseReceipt` carries no arguments and must not: D-18 keeps
// the session log refs-and-one-liners because surfaces render it directly, and op input is exactly
// the field that could carry a secret. 392-09 named that as a gap rather than papering over it. So
// the argument is observed through the one thing a composed turn DOES publish about it — whether
// the op it was handed to succeeded. Two run ids, one addressable and one not, make the bound
// argument legible without widening a single production type.
//
// STEERING A MODEL ONTO A TABLE-BOUND CLAUSE IS HARD BY CONSTRUCTION, and that is a finding worth
// recording rather than an inconvenience. Stage 2 is consulted ONLY for the clauses stage 1 could
// not bind (`turn-engine.ts`), so a real model is never even ASKED about a table-resolved clause —
// the override's first line of defence is structural, and no prompt can get around it. What is
// live-observable, and what this file measures, is the second line: a model plan carrying a
// different binding for the same capability cannot displace what the table bound for the clause the
// table owns.
//
// TWO EARLIER STEERING ATTEMPTS WERE MEASURED AND DISCARDED, recorded because a differential's
// discarded designs are part of its evidence. `and instead start a run for <file>` was refused by
// the model as contradictory (3 of 3 attempts, `mark_unhandled`); `and also run <file>` was refused
// on the ground that a run needs a scope, an execution context and a config path that nobody
// supplied (3 of 3, again `mark_unhandled` — every one of those fields is optional in the schema,
// so this is a real model posture rather than a contract). Neither refusal is a defect in what this
// file measures, and neither was worked around by softening a prompt to make the differential
// convenient.
//
// PREDICTIONS, WRITTEN BEFORE THE RUN (what was measured is in `392-10-SUMMARY.md`):
//
//   ARM A (override on)  — the receipt for `digest RUN-1` is `executed` under a `human` origin; the
//     prose clause's receipt is the SAME function id under an `agent` origin and comes back
//     `failed`, naming `RunNotFoundError`, because the run it addresses does not exist.
//   ARM B (override off) — the receipt for `digest RUN-1` is `failed` with `RunNotFoundError` under
//     an `agent` origin: the person's canonical words were handed the model's run id.
//
// A RELEASE GATE ON PLAN 09's SWITCH (D-13), with a never-skipping announce and a visible skip as
// the default state.

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

const SKIP_REASON =
  LIVE_CONFIG === undefined
    ? 'AGENT_QA_LIVE_CHAT_CONFIG is unset — no live-model auth was offered, so the D-12 binding '
      + 'differential did not run. Set it to a project config path whose registry.llms and auth '
      + 'plugins resolve on this machine.'
    : undefined

/** The run this project actually has. The mapper binds it; it is addressable. */
const SEEDED_RUN_ID = 'RUN-1'

/** The run nobody has. The model binds it; addressing it fails by name. */
const DECOY_RUN_ID = 'RUN-404'

const UTTERANCE = `digest ${SEEDED_RUN_ID} and also show me the digest for ${DECOY_RUN_ID}`

/** The clause the table binds — the one whose executed binding flips between the two arms. */
const CANONICAL_CLAUSE = `digest ${SEEDED_RUN_ID}`

// 2026-10-02 (432-37, D-12): no `grantedScopes` or `safeMode` on the caller; the registry reads
// neither (432-20).
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
  // The OLD turn-level prose carry, re-derived (see the mutation proof's copy for why the
  // instrument keeps the pre-392-14 behaviour rather than following the shipped strategy).
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
}

/** The receipt carrying the person's own canonical words — the same row in both arms. */
function canonicalReceipt(arm: Arm): ClauseReceipt | undefined {
  return arm.result.receipts.find((receipt) => receipt.clause === CANONICAL_CLAUSE)
}

describe('the binding differential announces which lane actually ran', () => {
  it('names the gate condition, so a skip can never be mistaken for a pass', () => {
    process.stderr.write(
      `\n[D-12 binding differential] ${SKIP_REASON ?? `running against ${String(LIVE_CONFIG)}`}\n`,
    )
    // The two run ids must be genuinely different runs, or the differential compares one thing
    // with itself and passes forever.
    expect(DECOY_RUN_ID).not.toBe(SEEDED_RUN_ID)
    expect(UTTERANCE).toContain(DECOY_RUN_ID)
    expect(UTTERANCE.startsWith(CANONICAL_CLAUSE)).toBe(true)
  })
})

describe.skipIf(SKIP_REASON !== undefined)(
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
        ...(reconcile === undefined ? {} : { chatReconcile: reconcile }),
      })
      hosts.push(host)

      const result = (await invokeFunction(
        host.registry,
        AGENT_ASK_FUNCTION_ID,
        { message: UTTERANCE },
        HUMAN,
      )) as AgentAskResult
      process.stderr.write(
        `\n[D-12 binding differential] ${reconcile === undefined ? 'ARM A (override on) ' : 'ARM B (override off)'}`
          + ` -> ${result.status}`
          + ` ops=[${result.receipts.map((r) => `${r.clause} | ${r.functionId}:${r.status}:${r.origin}:${r.outcome}`).join(' ;; ')}]`
          + ` unhandled=${result.unhandled?.clause ?? '-'}\n`,
      )
      return { result, startedRuns }
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

    beforeAll(async () => {
      if (capabilities === undefined) return
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        attemptsTaken = attempt
        const on = await runArm()
        const off = await runArm(modelVerbatimStrategy)
        const planned = off.result.receipts.some(
          (receipt) => receipt.functionId === RUNS_DIGEST_FUNCTION_ID,
        )
        process.stderr.write(
          `\n[D-12 binding differential] attempt ${attempt}/${MAX_ATTEMPTS} `
            + `${planned ? 'DECISIVE (the model planned the digest op)' : 'inconclusive (the model planned no digest)'}\n`,
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
          + 'here can say the override corrected anything. Read the per-arm lines above.',
      ).toBeDefined()
      const receipt = canonicalReceipt(decisiveOff!)

      // The person's own canonical words are still on the receipt — the clause was not dropped.
      expect(receipt).toBeDefined()
      expect(receipt?.functionId).toBe(RUNS_DIGEST_FUNCTION_ID)
      // And it FAILED, naming the refusal of a run that does not exist: the argument it was handed
      // is the model's, not the table's. This is D-12's dangerous half, executed.
      expect(receipt?.status).toBe('failed')
      expect(receipt?.outcome).toContain('RunNotFound')
      // Minted as the MODEL acting, because the planner is what bound it.
      expect(receipt?.origin).toBe('agent')
      expect(decisiveOff!.startedRuns).toEqual([])
    })

    it('THE CLAIM — override on: the SAME clause addresses the run the table bound', () => {
      expect(decisiveOn).toBeDefined()
      const on = decisiveOn!
      const receipt = canonicalReceipt(on)

      // Same clause text, same function id, opposite outcome. The action set did not move; the
      // bound argument did — which is D-12's second claim isolated from its first.
      expect(receipt).toBeDefined()
      expect(receipt?.functionId).toBe(RUNS_DIGEST_FUNCTION_ID)
      expect(receipt?.status).toBe('executed')
      // The clause the table bound executed as a PERSON acting; a uniform mint would have handed a
      // model-originated invocation the self-grant power 391 D-06 withholds.
      expect(receipt?.origin).toBe('human')
      // The model's own proposal is not discarded — it answers the clause it was asked about, under
      // an agent origin, and fails on its own merits. The override narrows nothing but the clause
      // the table owns.
      const plannerReceipt = on.result.receipts.find(
        (candidate) => candidate.clause !== CANONICAL_CLAUSE,
      )
      expect(plannerReceipt?.functionId).toBe(RUNS_DIGEST_FUNCTION_ID)
      expect(plannerReceipt?.origin).toBe('agent')
      expect(on.startedRuns).toEqual([])
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
