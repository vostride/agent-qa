// Drivers type at the shipped surfaces and never import `invokeFunction`, so a bypass shows.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import type { Client } from '@modelcontextprotocol/client'
import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
// Nothing writes `execution_audit.jsonl`; the harness reads it so a returning writer is seen.
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
  // Action classes typed as `/pin <class>`, which reach the resolver as unknown clauses.
  readonly pinBefore?: readonly string[]
  /** The context every policy decision in this drive is taken in. Injected, never ambient. */
  readonly executionContext?: ExecutionContext
}

/** What one chat drive produced, as the surface itself recorded it. */
export interface ChatDriveObservation {
  /** Every clause receipt of the drive, for a cell that needs to see what else happened. */
  readonly receipts: readonly ClauseReceipt[]
  // Every op result the drive produced, in order, from the session log's masked `clause_result`.
  readonly results: readonly ClauseResult[]
  // Execution-audit rows this drive landed, always none; a returning decision row shows here.
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

// The one clause form that reaches any capability without a model: the generic passthrough.
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
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-'))
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

// Drive one capability through the shipped `agent-qa chat` by typing; this decides no verdict.
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

// One body with `driveChatDispatch`, so both drive the REPL with the same workspace and posture.
export async function driveChatLines(
  typedLines: readonly string[],
  executionContext?: ExecutionContext,
  // A populated project the caller owns and removes; the default is this file's empty one.
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

// One reader for every driver and the spawned anchors, never a render, so doors are compared.
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

// An unknown tool is a protocol refusal and a declined call is in band, and they are kept apart.
export async function driveMcpCall(input: {
  readonly toolName: string
  readonly args: Record<string, unknown>
  // The server's caller; absent, the shipped tokenless `MCP_FUNCTION_CALLER`.
  readonly caller?: FunctionCaller
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
