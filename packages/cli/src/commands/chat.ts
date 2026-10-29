// A thin client: each typed line is one `agent.ask` call, and `/` commands route in the engine.

import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import {
  AGENT_ASK_FUNCTION_ID,
  CHAT_HELP_ENTRIES,
  composeBanner,
  foldFunctionResult,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import { listSessions } from '@vostride/agent-qa-agent-local'
import type { ChatSessionListing, LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import type { AgentAskResult, MaskFn } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import pc from 'picocolors'

import {
  buildStarterPrompts,
  createChatCompleter,
} from '../capability-catalog/chat-discovery.js'
import { loadCapabilityCatalog } from '../capability-catalog/loader.js'
import { readAnalyticsPrivacyDeclaration, resolveConfig } from '../config.js'
import { analyticsEvent, composeAnalyticsHost } from '../composition/analytics-host.js'
import type { CliAnalyticsHost } from '../composition/analytics-host.js'
import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
} from '../composition/declared-secrets.js'
import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
} from '../composition/local-agent-host.js'
import { resolveCliChatCapabilities } from '../llm-utils.js'
import type { CliChatCapabilities } from '../llm-utils.js'
import { receiptLine } from './receipt-line.js'
import { renderClauseResults } from './result-render.js'

type ChatErrorCode = 'unknown-session' | 'no-session-to-continue'

class ChatCommandError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ChatCommandError'
  }
}

interface ChatOptions {
  continue?: boolean
  session?: string
  list?: boolean
}

// The seams a test substitutes: the streams and the interrupt registration; the rest is real.
export interface ChatCommandDeps {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  onInterruptHandler?: (handler: () => Promise<void>) => void
  // Substitutable because the default reaches a provider, so a suite could not run offline.
  chatCapabilities?: (configPath: string) => Promise<CliChatCapabilities | undefined>
  // Substitutable so a suite neither touches a real home directory nor misses an emission.
  composeAnalytics?: typeof composeAnalyticsHost
}

function globalOptions(command: Command): { config?: string } {
  return command.parent?.opts<{ config?: string }>() ?? {}
}

/** Everything the composition root needs, derived from one flag — the `fn.ts` derivation. */
function compositionInput(
  command: Command,
): { agentQaRoot: string; configPath: string } {
  const configPath = resolve(globalOptions(command).config ?? 'agent-qa.config.yaml')
  return {
    agentQaRoot: resolve(dirname(configPath), '.agent-qa'),
    configPath,
  }
}

// The same vocabulary `ask` prints, from the shared `receipt-line.ts`, because they are one turn.
function renderTurn(result: AgentAskResult): string {
  const lines: string[] = []
  if (result.refusedLineCount !== undefined) {
    // A resumed session with mid-file damage stays usable, so the REPL says so in one line.
    lines.push(
      pc.yellow(
        `${result.refusedLineCount} line(s) of this session could not be read; `
        + 'the conversation continues without them.',
      ),
    )
  }
  if (result.receipts.length > 0) lines.push(...result.receipts.map(receiptLine))
  // What the ops returned, between their receipts and the planner's prose, rendered whole.
  lines.push(...renderClauseResults(result.results, result.receipts.length))
  if (result.answer !== undefined) lines.push(result.answer)
  if (result.status === 'fail_closed') {
    lines.push(
      pc.red(
        result.unhandled?.reason
        ?? 'The turn was refused before anything ran, and nothing was carried out.',
      ),
    )
  }
  return lines.join('\n')
}

/** The listing, including the half a person has to go and look at. */
function renderListing(listing: ChatSessionListing): string {
  const lines: string[] = []
  if (listing.sessions.length === 0) {
    lines.push(pc.dim('No chat sessions yet.'))
  } else {
    lines.push(pc.bold(`Chat sessions (${listing.sessions.length})`))
    for (const session of listing.sessions) {
      lines.push(
        `  ${pc.bold(session.sessionId)}  ${pc.dim(session.createdAt)}`
        + `  ${pc.dim(`model ${session.model}`)}`
        + `  ${pc.dim(`${session.eventCount} events`)}`,
      )
    }
  }
  if (listing.refused.length > 0) {
    // A listing that dropped unreadable files would hide conversations that exist.
    lines.push(pc.yellow(`${listing.refused.length} session file(s) could not be read:`))
    for (const refused of listing.refused) {
      lines.push(`  ${refused.file}: ${refused.reason}`)
    }
  }
  return lines.join('\n')
}

function printUnavailable(error: DeclaredSecretsUnavailableError): void {
  const [first, ...rest] = error.lines
  if (first === undefined) return
  printRunText([pc.red(first), ...rest.map((line) => pc.dim(line))].join('\n'),
    (text) => console.error(text))
}

function reportError(error: unknown, mask?: MaskFn): void {
  process.exitCode = 1
  if (error instanceof DeclaredSecretsUnavailableError) {
    printUnavailable(error)
    return
  }
  const line = error instanceof ChatCommandError
    ? `Chat error [${error.code}]: ${error.message}`
    : error instanceof Error
      ? `Chat error [${error.name}]: ${error.message}`
      : `Chat error: ${String(error)}`
  // A refusal raised before the loader exists has nothing to mask with.
  let shown = line
  if (mask !== undefined) {
    try {
      shown = mask(line)
    } catch (maskError) {
      if (!(maskError instanceof DeclaredSecretsUnavailableError)) throw maskError
      printUnavailable(maskError)
      return
    }
  }
  printRunText(pc.red(shown), (block) => console.error(block))
}

// Both resume paths are validated before the loop opens, not refused on the first typed turn.
function resolveSessionId(
  agentQaRoot: string,
  options: ChatOptions,
): string | undefined {
  if (options.session !== undefined) {
    const listing = listSessions(agentQaRoot)
    const known = listing.sessions.some((session) => session.sessionId === options.session)
    if (!known) {
      throw new ChatCommandError(
        'unknown-session',
        `No chat session named ${options.session} exists here. `
        + 'Run `agent-qa chat --list` to see what does; a session is never created by naming one.',
      )
    }
    return options.session
  }
  if (options.continue !== true) return undefined

  const listing = listSessions(agentQaRoot)
  // The most recent by the header's own `createdAt`, chosen rather than taken from a position: the
  // listing is sorted by FILE NAME, which agrees with time by the id's construction and would stop
  // agreeing the day the id format changed.
  const latest = [...listing.sessions].sort((left, right) =>
    left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0,
  )[0]
  if (latest === undefined) {
    throw new ChatCommandError(
      'no-session-to-continue',
      'There is no chat session to continue here. Run `agent-qa chat` to start one.',
    )
  }
  return latest.sessionId
}

function emitHuman(mask: MaskFn, text: string): void {
  if (text === '') return
  printRunText(mask(text))
}

export function createChatCommand(deps: ChatCommandDeps = {}): Command {
  return new Command('chat')
    .description('Talk to agent-qa: one conversation, every capability the function layer has')
    .option('--continue', 'reopen the most recent session instead of starting one')
    .option('--session <id>', 'reopen a named session')
    .option('--list', 'list the sessions in this project and exit')
    .action(async (options: ChatOptions, command: Command) => {
      const composition = compositionInput(command)
      let host: LocalAgentHost | undefined
      let analytics: CliAnalyticsHost | undefined
      // The session aggregate, read once at close; every field is a count, never typed text.
      const startedAt = Date.now()
      let turnCount = 0
      let functionCallCount = 0
      let endReason: 'exit' | 'interrupt' | 'error' | 'unknown' = 'exit'
      let mask: MaskFn | undefined
      try {
        const declaredSecrets = createDeclaredSecretMask(composition.configPath)
        // E3: refuse before any host or model when the secrets file cannot be read.
        declaredSecrets.redactor()
        const print = declaredSecrets.mask
        mask = print

        if (options.list === true) {
          // A READ that exits. Composing a host here would create the runtime root — and a
          // project that has never opened chat would acquire a sessions directory by asking
          // whether it had any (the `jobs()` laziness rule, applied to a listing).
          emitHuman(print, renderListing(listSessions(composition.agentQaRoot)))
          return
        }

        const sessionId = resolveSessionId(composition.agentQaRoot, options)

        // Seeded by `--session`, then kept current by `observeSessionEvent` on each durable append.
        let activeSessionId = sessionId

        // Read tolerantly and without auth plugins, so `analytics.privacy` applies on a bad config.
        let config: Awaited<ReturnType<typeof resolveConfig>> | undefined
        try {
          config = await resolveConfig({
            configPath: globalOptions(command).config,
            loadAuthPlugins: false,
          })
        } catch {
          config = undefined
        }
        // A document that fails validation can still declare privacy, so the opt-out is read too.
        const analyticsConfig = config
          ?? await readAnalyticsPrivacyDeclaration(globalOptions(command).config)
        analytics = await (deps.composeAnalytics ?? composeAnalyticsHost)({
          surface: 'chat',
          ...(analyticsConfig === undefined ? {} : { config: analyticsConfig }),
          maskingContext: { mask: declaredSecrets.mask },
        })

        // `undefined` on a project with no usable LLM composes a headless host, not a refusal.
        const chatCapabilities = (deps.chatCapabilities ?? resolveCliChatCapabilities)(
          composition.configPath,
        )
        const chatModel = await chatCapabilities

        host = composeCliLocalAgent({
          ...composition,
          declaredSecrets,
          // The explain counter hooks bind against this port inside the composition root.
          analytics,
          ...(chatModel === undefined
            ? {}
            : {
              chatModel: chatModel.model,
              chatModelFor: chatModel.modelFor,
              chatAccounting: chatModel.accounting,
            }),
          // Tells the REPL its session id during the first turn rather than after it.
          observeSessionEvent: (id) => { activeSessionId = id },
          // The mid-turn render, on the turn output's stream, unconditional under piped stdin too.
          chatPresent: (text: string) => {
            const stream = deps.output ?? process.stdout
            printRunText(declaredSecrets.mask(text), (block) => {
              stream.write(`${block}\n`)
            })
          },
        })
        const chat = host.chat

        // Writes `aborted` for an in-flight turn; a hard kill's torn tail is repaired on open.
        const interrupt = async (): Promise<void> => {
          endReason = 'interrupt'
          await chat.abortActiveTurn()
        }
        if (deps.onInterruptHandler !== undefined) {
          deps.onInterruptHandler(interrupt)
        } else {
          process.once('SIGINT', () => {
            void interrupt().finally(() => {
              process.exit(130)
            })
          })
        }

        // One read on open, through the same invoke binding and fold a turn dispatches through.
        const banner = await composeBanner(
          async (functionId, input, caller) => {
            const payload = await invokeFunction(host!.registry, functionId, input, caller)
            return { payload, ...foldFunctionResult(host!.registry, functionId, payload) }
          },
          CLI_FUNCTION_CALLER,
        )
        if (banner !== undefined) emitHuman(print, banner)

        // Loaded eagerly because the loader fails loud: a missing catalog is a broken install.
        const catalog = loadCapabilityCatalog()

        const prompt = createInterface({
          input: deps.input ?? process.stdin,
          output: deps.output ?? process.stdout,
          prompt: '> ',
          // A3's primary path. Every candidate is a form the shipped resolver answers — the
          // completer derives them from the catalog's rows and the census-tied typed forms, and
          // has no list of its own. On a stream that cannot complete (a piped stdin, which is what
          // the suite drives) readline simply never calls it, so the degrade is silence rather
          // than a wrong suggestion.
          completer: createChatCompleter(catalog.rows, CHAT_HELP_ENTRIES),
        })

        // The starter prompts: three suggestions rendered from catalog rows, deterministic in
        // sorted alias order. No sentence about any capability is written here — the text is each
        // row's own description, which is the op's declared summary.
        const starters = buildStarterPrompts(catalog.rows, CHAT_HELP_ENTRIES)
        if (starters.length > 0) {
          emitHuman(print, [pc.dim('Try one of these, or just ask:'), ...starters].join('\n'))
        }

        // Readline CLOSES when its input ends, which for a scripted stdin happens while a turn is
        // still in flight. Prompting a closed interface throws, so the state is tracked rather than
        // assumed — the alternative is a REPL that reports "readline was closed" as if it were a
        // failure of the person's last request.
        let promptClosed = false
        prompt.on('close', () => {
          promptClosed = true
        })

        let announced = sessionId !== undefined
        if (announced) emitHuman(print, pc.dim(`session ${String(sessionId)}`))

        if (!promptClosed) prompt.prompt()
        for await (const line of prompt) {
          const utterance = line.trim()
          if (utterance === '') {
            if (!promptClosed) prompt.prompt()
            continue
          }

          const turnStartedAt = Date.now()
          try {
            const result = (await invokeFunction(
              host.registry,
              AGENT_ASK_FUNCTION_ID,
              activeSessionId === undefined
                ? { message: utterance }
                : { message: utterance, sessionId: activeSessionId },
              CLI_FUNCTION_CALLER,
            )) as AgentAskResult

            // `tool_call_count` counts clause receipts; tokens are absent, as the result has none.
            turnCount += 1
            functionCallCount += result.receipts.length
            analytics?.port.capture(analyticsEvent(analytics, 'agent-qa.chat.turn.completed', {
              duration_ms: Date.now() - turnStartedAt,
              tool_call_count: result.receipts.length,
              errored: result.status === 'fail_closed',
            }))

            activeSessionId = result.sessionId
            if (!announced) {
              // Printed once, because it is what `--session` takes.
              emitHuman(print, pc.dim(`session ${result.sessionId}`))
              announced = true
            }
            emitHuman(print, renderTurn(result))
          } catch (error) {
            // A refused or failed TURN ends the turn, never the conversation. The person is still
            // here and their next line is still a request; exiting on a refusal would make one
            // unroutable clause cost them the session.
            //
            // IT IS STILL A TURN, and it is counted as one. A session aggregate that only counted
            // turns that succeeded would report a conversation that went smoothly no matter how it
            // actually went, which is the one thing a usage number must not do.
            turnCount += 1
            analytics?.port.capture(analyticsEvent(analytics, 'agent-qa.chat.turn.completed', {
              duration_ms: Date.now() - turnStartedAt,
              errored: true,
            }))
            reportError(error, print)
            process.exitCode = undefined
          }

          // `/quit` is read off this session's engine state; before a first turn nothing closes.
          if (activeSessionId !== undefined && chat.stateFor(activeSessionId)?.closing === true) break
          if (!promptClosed) prompt.prompt()
        }
        prompt.close()
      } catch (error) {
        endReason = 'error'
        reportError(error, mask)
      } finally {
        // One session event per opened conversation, emitted at close so no early return misses it.
        if (analytics !== undefined) {
          analytics.port.capture(analyticsEvent(analytics, 'agent-qa.chat.session.completed', {
            duration_ms: Date.now() - startedAt,
            turn_count: turnCount,
            function_call_count: functionCallCount,
            end_reason: endReason,
          }))
          await analytics.shutdown()
        }
        await host?.close()
      }
    })
}
