// The three surface DRIVERS the verdict legs observe through (Phase 397 plan 04, D-11 / D-14;
// the dashboard door added 2026-08-21, Phase 400 plan 01).
//
// WHAT A DRIVER IS FOR, AND WHY IT IS NOT A CONVENIENCE. `adapters.ts` answers what a surface can
// REACH; this file answers what a surface DOES when something is asked of it. Those are different
// questions and only the second one can see the defect this phase exists to name. An enumeration
// leg reads a listing, and a capability rerouted around `invokeFunction` still appears in every
// listing it ever appeared in — the catalogue is intact, the gate is gone. Only a cell that drives
// the surface's OWN dispatch and observes the refusal arrive can tell those two worlds apart.
//
// THE CHAT DRIVER RUNS THE SHIPPED REPL, NOT A LOOKALIKE. It builds the real `agent-qa chat`
// command over a real fixture workspace and types at it. Every stage the product has is therefore
// in the path: readline, the one `invokeFunction(agent.ask)` call the surface owns, the clause
// splitter, the deterministic resolver table's `/fn` branch, the per-stage caller mint, the
// composed `ChatInvokeBinding` — which is a closure over `invokeFunction` supplied by
// `composeLocalAgent` — the gate, and the receipt the person reads back. NOTHING in this file
// imports `invokeFunction`, and that absence is asserted as source in `parity.test.ts`: a driver
// that called the gate directly would be measuring the gate while claiming to measure the surface,
// and would stay green through exactly the mutation (D-14's ungated op) it exists to catch.
//
// MODEL-FREE AND ZERO PROVIDER SPEND, BY CONSTRUCTION RATHER THAN BY LUCK. `chatCapabilities` is
// pinned to `undefined`, which is the shipped HEADLESS posture (`compose-local-agent.ts`:
// "Absence is a posture, not an unconfigured state") — the deterministic route still routes and
// anything else fails the turn closed. The default resolution would read this machine's
// configuration and credentials, so a suite that took it would answer differently on a laptop with
// a key in the environment than on a runner without one, which is Pitfall 3 arriving by a second
// road.
//
// THE EXECUTION CONTEXT IS INJECTED (Pitfall 3). `requiresFailClosed` is true for every context but
// `local-interactive`, so the ask arm is reachable in one context and pre-empted in every other —
// and the shipped resolver is a process-global that answers from TTY and CI markers. A verdict
// computed against it would be one answer on a laptop and another on a PR, in a suite whose entire
// job is to state what the verdict IS. Every drive therefore sets the resolver to a constant for
// its own duration and restores what it found.
//
// PURE REQUEST-RESPONSE. Each drive builds its own temp workspace and removes it, so no cell can
// observe a state another cell left behind and no cell's answer depends on the order the file ran
// in.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import type { Client } from '@modelcontextprotocol/client'
import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
// safety no longer publishes the execution-audit row, and nothing writes
// `execution_audit.jsonl`. The harness still reads that path so the cells that assert "no decision
// row" see a returning writer; the row is typed by the two fields they filter on.
interface LegacyExecutionAuditRow {
  readonly action?: unknown
  readonly verdict?: unknown
}
import type {
  ClauseReceipt,
  ClauseResult,
  ExecutionContext,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { vi } from 'vitest'

import { createChatCommand } from '../../commands/chat.js'
import { withMcpClient } from './adapters.js'
import { CONFORMANCE_EXECUTION_CONTEXT } from './policy-fixtures.js'

// ---- The chat surface --------------------------------------------------------------------------

/** One clause a drive types, in the order it is typed. */
export interface ChatDriveLine {
  readonly text: string
}

export interface DriveChatDispatchInput {
  /** The capability to reach, by registry op id. Never a wire name — chat has none. */
  readonly opId: string
  /** The op's own typed invocation fixture; the scenario row's `input`. */
  readonly input: unknown
  /**
   * Action classes to type as `/pin <class>` before the op is asked for, each `fn:<opId>`.
   *
   * Until 432-13 this was the refuse-direction wall's mechanism. `/pin` is no longer a directive,
   * so these lines reach the resolver as unknown clauses; `parity.test.ts` drives them to pin that.
   */
  readonly pinBefore?: readonly string[]
  /** The context every policy decision in this drive is taken in. Injected, never ambient. */
  readonly executionContext?: ExecutionContext
}

/** What one chat drive produced, as the surface itself recorded it. */
export interface ChatDriveObservation {
  /** Every clause receipt of the drive, for a cell that needs to see what else happened. */
  readonly receipts: readonly ClauseReceipt[]
  /**
   * Every op RESULT the drive produced, in clause execution order.
   *
   * WHY THIS MEMBER EXISTS, AND WHY IT IS NOT A CONVENIENCE. Until 399.1 the two drivers in this
   * file answered in incommensurable vocabularies: chat reported a `ClauseReceipt` — a one-line map
   * of clause to outcome, by charter carrying no territory — while MCP reported
   * `McpCallAnswered.structured`, the op's whole typed result. A cell wanting to ask "do these two
   * doors show a person the same thing" had nothing on the chat side to compare, so no cell asked,
   * and the answer was NO for forty of forty-two capabilities for two phases. `results[]`
   * is 399.1 D-05's channel and this is the driver's read of it.
   *
   * READ OFF THE SESSION LOG'S `clause_result` EVENTS, on `receipt`'s own reasoning: the printed
   * payload block is a render of these records, so the two cannot disagree, and the record arrives
   * with its fields already parted. The persisted payload is MASKED (399.1 plan 05), which is what
   * makes this member safe to hold and to print in a failure message.
   */
  readonly results: readonly ClauseResult[]
  /**
   * The execution-audit rows this drive landed, in order — always none since 432-13.
   *
   * The gate that authored them is deleted, so this is the absence witness: a
   * capability that started writing a decision row again would show up here.
   */
  readonly auditRows: readonly LegacyExecutionAuditRow[]
  /** Clauses the turn engine could not route at all — a resolution failure, not a verdict. */
  readonly unhandled: readonly string[]
  /** Everything the surface printed, i.e. what a person actually sees. */
  readonly stdout: string
}

/** One drive keyed to ONE op, which is what every parity leg asks about. */
export interface ChatDispatchOutcome extends ChatDriveObservation {
  /**
   * The receipt for the driven op, or `undefined` when the surface never reached a dispatch.
   *
   * Read out of the SESSION LOG the shipped adapter wrote rather than scraped off the terminal:
   * the printed line is a render of this record (`receipt-line.ts` reads `receipt.outcome`), so
   * the two cannot disagree, and the record carries its fields already parted.
   */
  readonly receipt: ClauseReceipt | undefined
}

/** The pin spelling every registered op's risk name carries; the gate compares exactly these bytes. */
export function pinClassFor(opId: string): string {
  return `fn:${opId}`
}

/** The one clause form that reaches ANY capability without a model: the D-06 generic passthrough. */
export function genericFnClause(opId: string, input: unknown): string {
  return `/fn ${opId} ${JSON.stringify(input)}`
}

/**
 * A deterministic project a chat session can open in, and nothing more.
 *
 * The `chat-command.test.ts` fixture, plus the one block that makes it VALIDATE. No stores, no
 * runs, no knowledge — a drive that needed any of those would be measuring a fixture rather than a
 * surface.
 *
 * WHY `use.mobile.appState` IS HERE, recorded because it was measured rather than guessed.
 * `AgentQaConfigSchema` requires that key unconditionally (`core/schema/config-schema.ts`), so the
 * shipped chat fixture's config does not pass `resolveConfig` — and 40 of the 41 capabilities never
 * notice, because nothing on their path reads the configuration before the gate refuses them. The
 * one that does is `authoring.draft.write`: the turn engine's `routeWriteTest` pre-flight asks the
 * host for its configured target names (`turn-engine.ts` → `configuredTargetNames`) BEFORE dispatch,
 * so an invalid configuration killed the whole turn with an unstructured error and produced no
 * receipt at all. A fixture that is invalid and green for 40 subjects is exactly the kind that
 * measures nothing; this one validates.
 *
 * WHY ONE TARGET IS DECLARED, for the same reason and found the same way. `routeWriteTest` refuses
 * before dispatch when `configuredTargetNames()` is EMPTY — "a project with none has nothing at
 * all, and that is the one case where silence is unanswerable" (`write-test-route.ts`) — so an
 * empty project is the single posture in which `authoring.draft.write` never reaches the gate at
 * all, and a wall driven there would be measuring a routing refusal while looking like a verdict.
 * One declared target puts the project in the ordinary posture, where the route passes through and
 * the gate is what answers.
 */
function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-397-04-'))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      registry: {
        targets: {
          conformance: { platform: 'web', url: 'https://conformance.invalid' },
        },
      },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return configPath
}

function readJsonLines(path: string): readonly Record<string, unknown>[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Drive ONE capability through the chat surface's own composed dispatch, model-free.
 *
 * WHAT PRODUCES THE ANSWER: the shipped `agent-qa chat` command, over a real composition, reached
 * by typing. What this function contributes is the workspace, the typed lines and the reading of
 * what the surface wrote down. It decides nothing about verdicts.
 *
 * SINCE 432-13 `/pin` is gone and nothing on this road refuses a capability; the
 * paragraphs below record why `pinBefore` WAS the refuse-direction mechanism until then.
 *
 * WHY `pinBefore` WAS THE REFUSE-DIRECTION MECHANISM, and this is worth reading once because it is a
 * measured fact about the product rather than a choice made here. The MCP surface can be handed a
 * caller that lacks a scope, so its refuse wall is a scope refusal. The chat surface cannot:
 * `CHAT_STAGE_SCOPES` is the WHOLE closed scope union, both stage callers hold every member, and
 * the mint is composition-internal — so "a chat caller missing a required scope" is not a state
 * this product can be in, and a cell that pretended otherwise would be asserting about a caller no
 * composition mints. `parity.test.ts` pins that equality in a named cell, so the day chat narrows
 * its grants the reason recorded here reds rather than quietly going stale.
 *
 * What the chat surface CAN be made to refuse, for every one of the 41 capabilities and by a route
 * a person drives, is `/pin` — and the refusal it produces is the strongest one available for this
 * purpose: `evaluate()` consults the session deny overlay AFTER classification and BEFORE
 * `resolveAsk`, so the refusal lands a real execution-audit row (`outcome: session-pin-denied`),
 * it is independent of the execution context, and it is produced INSIDE the one gate call site.
 * A capability rerouted around `invokeFunction` cannot be pinned — it would execute — so this wall
 * reds on exactly the mutation D-14 names.
 *
 * ZERO MUTATION ON THE REFUSE PATH IS STRUCTURAL, not asserted after the fact: `invokeFunction`
 * evaluates the gate at step 5 and dispatches at step 7, so a denied invocation never reaches an
 * implementation.
 */
export async function driveChatDispatch(
  input: DriveChatDispatchInput,
): Promise<ChatDispatchOutcome> {
  const observed = await driveChatLines(
    [
      ...(input.pinBefore ?? []).map((actionClass) => `/pin ${actionClass}`),
      genericFnClause(input.opId, input.input),
    ],
    input.executionContext,
  )
  return {
    ...observed,
    receipt: observed.receipts.find((candidate) => candidate.functionId === input.opId),
  }
}

/**
 * Type ARBITRARY lines at the same shipped REPL, and report the same observation.
 *
 * THE SAME BODY, NOT A SECOND DRIVER (`spawned-chat.ts`'s no-second-copy law, applied in-process).
 * `driveChatDispatch` is this function plus one composition of clause text and one receipt lookup;
 * a separate helper for "a turn that is not one `/fn` invocation" would be a second answer to what
 * the surface was driven WITH — the workspace, the execution-context injection, the headless
 * posture and the collected interrupt handler — which is the one property every cell depends on.
 *
 * WHAT NEEDS IT. 399.1's turn-shape cells ask two questions no `opId`-keyed drive can express: what
 * a turn that executes NOTHING renders (E2E-02/empty), and what order a COMPOUND turn's payloads
 * print in (E2E-02/ordering). Neither has a single op to key on — the first has none by design and
 * the second has two — so the shape that carried the parity legs cannot carry them.
 */
export async function driveChatLines(
  typedLines: readonly string[],
  executionContext?: ExecutionContext,
  // a populated project the caller owns and removes; the default is this file's empty one.
  workspace?: { readonly configPath: string },
): Promise<ChatDriveObservation> {
  const configPath = workspace?.configPath ?? fixtureWorkspace()
  const root = dirname(resolve(configPath))
  const stdout: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  // The shipped module publishes a setter for the resolver and a getter for its ANSWER, so the
  // faithful restore is a resolver that returns what this process answered before the drive. It is
  // captured rather than assumed because a restore to a literal would be this file deciding what
  // the surrounding process's context is.
  const previousContext = getActiveExecutionContext()
  setActiveExecutionContextResolver(() => executionContext ?? CONFORMANCE_EXECUTION_CONTEXT)

  try {
    const typed = [...typedLines, '/quit']
    const stdin = new PassThrough()
    const stdoutStream = new PassThrough()
    stdoutStream.resume()
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(
        createChatCommand({
          input: stdin,
          output: stdoutStream,
          chatCapabilities: async () => undefined,
          // COLLECTED, NEVER REGISTERED. The default registration puts a SIGINT listener on the
          // process for the life of the session, and a leg that drives 41 capabilities would leave
          // 41 of them behind — the runner warns at eleven, and a suite that has to be read past a
          // warning is a suite whose next real warning goes unread. Nothing here raises SIGINT, so
          // the handler is collected and dropped.
          onInterruptHandler: () => {},
        }),
      )
    program.exitOverride()
    const parsed = program.parseAsync([
      'node',
      'agent-qa',
      '--config',
      configPath,
      'chat',
    ])
    // The `chat-command.test.ts` ordering: give the loop a tick to open its readline before the
    // first line is delivered, or a scripted line lands on a reader that does not exist yet.
    await Promise.resolve()
    for (const line of typed) stdin.write(`${line}\n`)
    stdin.end()
    await parsed
  } finally {
    log.mockRestore()
    error.mockRestore()
    setActiveExecutionContextResolver(() => previousContext)
  }

  const observed = readRuntimeObservations(join(root, '.agent-qa'))

  if (workspace === undefined) rmSync(root, { recursive: true, force: true })

  return { ...observed, stdout: stdout.join('\n') }
}

/**
 * What a drive wrote down, read off the runtime root the surface wrote it to.
 *
 * SHARED BY EVERY DRIVER IN THIS FILE, and that is the point rather than a convenience. The chat
 * door and the dashboard door are different transports over ONE session substrate, so a
 * second reader here would be a second answer to what a turn recorded — and the cells that compare
 * the two doors would then be comparing two readings rather than two doors.
 *
 * NEVER SCRAPED FROM A RENDER. The printed line and the served JSON are both renders of these
 * records, so a reader that parsed either could disagree with what the product wrote down.
 */
/**
 * EXPORTED for the spawned-wire anchors, which must read the CHILD's runtime root.
 *
 * The anchors compare an in-process drive with a drive against the shipped `agent-qa dashboard`
 * binary, and the comparand on both sides has to be produced by the SAME reader — otherwise the
 * anchor's subject is the difference between two reading recipes rather than the difference between
 * two doors. A private copy in the anchor file would be exactly that second recipe.
 */
export function readRuntimeObservations(agentQaRoot: string): Omit<ChatDriveObservation, 'stdout'> {
  const receipts: ClauseReceipt[] = []
  const results: ClauseResult[] = []
  const unhandled: string[] = []
  let sessionDir: string[] = []
  try {
    sessionDir = readdirSync(join(agentQaRoot, 'sessions'))
  } catch {
    sessionDir = []
  }
  for (const file of sessionDir) {
    for (const line of readJsonLines(join(agentQaRoot, 'sessions', file))) {
      if (line['kind'] === 'clause_receipt') {
        receipts.push({
          clause: String(line['clause']),
          functionId: String(line['functionId']),
          origin: String(line['origin']),
          status: line['status'] as ClauseReceipt['status'],
          outcome: String(line['outcome']),
        })
      }
      // The 11-kind ledger interleaves per clause: a `clause_result` lands immediately BEFORE the
      // `clause_receipt` of the clause that produced it, and a clause that did not run files none.
      // Reading them in file order is therefore reading them in clause execution order.
      if (line['kind'] === 'clause_result') {
        results.push({ functionId: String(line['functionId']), payload: line['payload'] })
      }
      if (line['kind'] === 'mark_unhandled') unhandled.push(String(line['clause']))
    }
  }
  const auditRows = readJsonLines(join(agentQaRoot, 'execution_audit.jsonl')).map(
    (row) => row as unknown as LegacyExecutionAuditRow,
  )
  return { receipts, results, auditRows, unhandled }
}

// ---- The MCP surface ---------------------------------------------------------------------------

/** A `tools/call` that the server answered, in band. */
export interface McpCallAnswered {
  readonly answered: true
  /** `true` when the server answered `isError` — an in-band refusal, not a transport failure. */
  readonly isError: boolean
  readonly text: string
  readonly structured: Record<string, unknown> | undefined
}

/** A `tools/call` the protocol refused before any handler could answer it. */
export interface McpCallRefused {
  readonly answered: false
  readonly name: string
  readonly message: string
  /** The JSON-RPC code, where the SDK carried one — `-32602` for an unknown tool. */
  readonly code: number | undefined
}

export type McpCallOutcome = McpCallAnswered | McpCallRefused

/**
 * Call ONE tool on a real server built for ONE caller, and report what came back.
 *
 * The server is the shipped factory's, driven over the SDK's own in-process handler through
 * `withMcpClient` — the same wiring every enumeration leg reads `tools/list` through, so an
 * enumeration and a call in this suite cannot be talking to two different servers.
 *
 * THE TWO ANSWER SHAPES ARE KEPT APART rather than flattened into a boolean. An unknown tool is a
 * PROTOCOL refusal (the SDK throws; there is no door), while a validation failure or a capability's
 * own refusal is an IN-BAND answer (`isError: true`, the door exists and said no). Collapsing them
 * would make the D-12 absence probe unable to tell a missing capability from a present one that
 * declined, which is the entire distinction the refuse-direction wall is about.
 */
export async function driveMcpCall(input: {
  readonly toolName: string
  readonly args: Record<string, unknown>
  /**
   * the server's caller. Absent, the shipped tokenless
   * `MCP_FUNCTION_CALLER`. Replaces the retired `grantedScopes` member, which only ever
   * handed a scope set through as a smuggle: a cell proving a retired field is unread now builds its
   * own smuggled caller and passes it here.
   */
  readonly caller?: FunctionCaller
  // no `executionContext` input. It fed only the registry's retired
  // `resolveExecutionContext` option, which reads no context since 432-20, and no cell passed it.
}): Promise<McpCallOutcome> {
  return withMcpClient(async (client: Client): Promise<McpCallOutcome> => {
    try {
      const result = await client.callTool({ name: input.toolName, arguments: input.args })
      const content = (result as { content?: readonly { type: string; text?: string }[] }).content
      return {
        answered: true,
        isError: (result as { isError?: boolean }).isError === true,
        text: (content ?? [])
          .map((entry) => (entry.type === 'text' ? (entry.text ?? '') : ''))
          .join('\n'),
        structured: (result as { structuredContent?: Record<string, unknown> }).structuredContent,
      }
    } catch (thrown) {
      const asError = thrown as { name?: string; message?: string; code?: number }
      return {
        answered: false,
        name: String(asError.name ?? 'Error'),
        message: String(asError.message ?? String(thrown)),
        code: typeof asError.code === 'number' ? asError.code : undefined,
      }
    }
  // Dispatch policy cells measure the anonymous ask/refusal, not the credentialed census.
  }, input.caller)
}
