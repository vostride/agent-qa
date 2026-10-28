// `agent-qa chat` — the interactive REPL (Phase 392, D-01 / D-17 / D-23 / D-24).
//
// A THIN CLIENT, on `fn.ts`'s idiom and `ask.ts`'s reasoning. Every line a person types becomes ONE
// `invokeFunction(agent.ask, …)` call. This file owns no turn capability: the routing, the
// reconciliation, the execution, the session log and the directives all live behind a registered
// op, so this whole surface could be deleted and every one of them would still be reachable from
// the MCP projection, the daemon and the scenario harness (§3's L10 law, made structural by D-24).
//
// THE ONE-SHOT AND THE REPL ARE THE SAME TURN (D-01). What differs is the session and the loop, and
// nothing else — `ask` is a single-turn session on the same log grammar (D-17), which is why chat
// needs no special case in the adapter and why a routing change cannot be right in one surface and
// wrong in the other.
//
// THE CANON IS CONSULTED IN EXACTLY ONE PLACE, and it is not here. `/help`, `/quit` and `/model`
// are resolver table entries, so they travel the same turn entry as any other utterance and the
// engine's handlers carry them out. This file never matches a `/` prefix of its own: a REPL
// that recognised `/quit` itself would be a second list of what chat understands, free to disagree
// with the one that actually routes. `/quit` is observed through the live state the engine mutates.
//
// NOTHING ASKS (432-13, D-14). A typed line is carried out by its turn; there is no inline confirm
// and no three-answer decision prompt. The REPL reads only the lines a person types. A refused
// clause prints its refusal sentence beside its receipt (432-42, D-18).
//
// EVERYTHING PRINTED CROSSES THE DECLARED MASK, and nothing restores it (441 D-07).
//
// NO MODEL IS BUILT HERE, and the arch rollcall pins that (CHAT-06). Whatever model a turn uses is
// resolved by the composition; a chat surface constructing its own client would be a model egress
// with none of `createModel`'s masking, profile resolution or auth.

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
import { printRunText } from '@vostride/agent-qa-core'
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

/**
 * The seams a test substitutes, and the whole of them.
 *
 * The streams, because a suite that needed a real terminal would be a suite that never runs; and
 * the interrupt registration, because raising a real SIGINT in a test measures the runner's signal
 * disposition rather than what this file does with one. Everything else — the registry, the
 * session adapter, the banner's reads — is the real composition in every invocation including the
 * tested ones.
 *
 * 2026-10-03 (quick-261003-tsr, IN-10): `isTty` is deleted. It decided whether an inline confirm
 * was built, and none has been since 432-13.
 */
export interface ChatCommandDeps {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  onInterruptHandler?: (handler: () => Promise<void>) => void
  /**
   * How this invocation resolves what a chat session plans with (392 plan 09).
   *
   * On the list for the same reason the streams are: the default reaches a provider, and a suite
   * that had to would be a suite that never runs offline. The DEFAULT is the production path and
   * every tested invocation that does not substitute it takes that path.
   */
  chatCapabilities?: (configPath: string) => Promise<CliChatCapabilities | undefined>
  /**
   * How this invocation composes its analytics (398-10).
   *
   * On the list for the same reason `chatCapabilities` is: the default is the production path, and
   * on a configured machine it resolves the real identity store and constructs a live client. A
   * suite that could not substitute it would either touch a real home directory or be unable to
   * observe an emission at all — and an emission nothing observes is the defect this phase keeps
   * finding, where a host builds the right event and drops it.
   */
  composeAnalytics?: typeof composeAnalyticsHost
}

function globalOptions(command: Command): { config?: string } {
  return command.parent?.opts<{ config?: string }>() ?? {}
}

// 2026-10-01 (432-17, D-05): `CHAT_DOOR_SURFACE`, the word this door minted proposals as (400-05),
// is deleted with the proposal records it stamped.

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

/**
 * One turn, rendered.
 *
 * The SAME vocabulary `ask` prints, because they are the same turn (D-01) — the receipt line is
 * literally shared now (`receipt-line.ts`, imported by both surfaces) and the shapes below are the
 * shapes `ask` reports. A REPL with its own wording would make a person's scripted run and their
 * conversation disagree about what happened, and two copies of one line is how that starts.
 */
function renderTurn(result: AgentAskResult): string {
  const lines: string[] = []
  if (result.refusedLineCount !== undefined) {
    // ONE LINE, and it has to be said (392-03's note to this plan): a resumed session with
    // permanent mid-file damage is still a usable conversation, and a REPL that mentioned nothing
    // would re-create the swallow that plan removed. The file itself is the damage report.
    lines.push(
      pc.yellow(
        `${result.refusedLineCount} line(s) of this session could not be read; `
        + 'the conversation continues without them.',
      ),
    )
  }
  if (result.receipts.length > 0) lines.push(...result.receipts.map(receiptLine))
  // 399.1 (D-04/D-05): what the ops RETURNED, between the receipts that say they ran and the
  // prose the planner wrote. The order is the order the facts were established, and the payload
  // is rendered whole.
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

/** The listing, including the half a person has to go and look at (392-03). */
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
    // NOT decoration (392-03). A listing that dropped the files it could not read would leave a
    // person unable to find a conversation that exists, with nothing to look at.
    lines.push(pc.yellow(`${listing.refused.length} session file(s) could not be read:`))
    for (const refused of listing.refused) {
      lines.push(`  ${refused.file}: ${refused.reason}`)
    }
  }
  return lines.join('\n')
}

function printUnavailable(error: DeclaredSecretsUnavailableError): void {
  const [first, ...rest] = error.lines
  if (first !== undefined) console.error(pc.red(first))
  for (const line of rest) console.error(pc.dim(line))
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

/**
 * Which session this invocation continues, or `undefined` for a fresh one (D-17).
 *
 * BOTH RESUME PATHS ARE VALIDATED BEFORE THE LOOP OPENS, and a failure is a typed refusal rather
 * than a create. The adapter refuses an unknown id too, but it would refuse it on the FIRST TURN —
 * after a person had already typed something into what looked like their old conversation.
 */
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
      // The session aggregate, accumulated as the loop runs and read once at close. Every one of
      // these is a COUNT: what a person typed and what the turn answered are theirs, and the union
      // has no field either could ride (D-18).
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

        /**
         * WHICH CONVERSATION THIS REPL IS IN (401-01, D-13).
         *
         * `--session` seeds it, and a fresh conversation has no id at all until the engine mints
         * one on the first turn. KEPT CURRENT BY THE COMPOSITION'S OWN NOTIFICATION as well as by
         * the turn's return value: `observeSessionEvent` fires on each durable append, so the id is
         * the composition's own answer rather than this file's guess.
         */
        let activeSessionId = sessionId

        // 398-10 (D-17/D-19): THIS COMMAND'S ANALYTICS COMPOSITION ROOT, after `--list` has already
        // returned. A listing composes no host and emits nothing, and composing here would resolve
        // the identity store for a read that never opened a conversation.
        //
        // THE CONFIG IS READ HERE AND HANDED OVER (398-14, closing D-19's live hole). The earlier
        // note here deferred this read as "a second config read on the open path", and that
        // deferral WAS the defect: `analytics.privacy` is a shipped, user-settable field, and a
        // root that composes without a config drops it silently while the decision that reads it
        // stays correct one layer below. `daemon` and `mcp` already pay this same read at open.
        //
        // TOLERANT, on `mcp.ts`'s ratified posture: a project whose configuration will not resolve
        // still gets a conversation. Refusing a surface over its telemetry configuration would be
        // refusing the capability over the telemetry. `undefined` is then passed as ABSENT rather
        // than as a hole, so the binding's own default posture applies.
        //
        // `loadAuthPlugins: false` because this read exists for one boolean: a telemetry read has
        // no business executing a project's auth plugins as a side effect.
        let config: Awaited<ReturnType<typeof resolveConfig>> | undefined
        try {
          config = await resolveConfig({
            configPath: globalOptions(command).config,
            loadAuthPlugins: false,
          })
        } catch {
          config = undefined
        }
        // F-1 / CR-01: a document that fails VALIDATION can still carry a privacy DECLARATION, and
        // discarding it transmitted against a user who had set the flag. Reading is not validating,
        // so the availability posture above is untouched — this cannot refuse the surface, it can
        // only ever add an opt-out. Same path expression, so it reads the file the validator read.
        const analyticsConfig = config
          ?? await readAnalyticsPrivacyDeclaration(globalOptions(command).config)
        analytics = await (deps.composeAnalytics ?? composeAnalyticsHost)({
          surface: 'chat',
          ...(analyticsConfig === undefined ? {} : { config: analyticsConfig }),
          maskingContext: { mask: declaredSecrets.mask },
        })

        // CHAT-06, and the one place in this file that reaches a provider resolution — once, when
        // a conversation opens, after `--list` has already returned. It answers `undefined` on a
        // project with no usable LLM configuration, which composes a headless host rather than
        // refusing to open: every canonical utterance still routes, and anything else fails the
        // turn closed by name (392 plan 09, discharging 392-08's unbound `chatModelFor`).
        const chatCapabilities = (deps.chatCapabilities ?? resolveCliChatCapabilities)(
          composition.configPath,
        )
        const chatModel = await chatCapabilities

        host = composeCliLocalAgent({
          ...composition,
          declaredSecrets,
          // 398-10: the explain counter hooks bind against this port inside the composition root.
          analytics,
          ...(chatModel === undefined
            ? {}
            : {
              chatModel: chatModel.model,
              chatModelFor: chatModel.modelFor,
              chatAccounting: chatModel.accounting,
            }),
          // 432-13 (D-14): no chat confirm is built. The composition asks nobody, so a turn's
          // clauses run once and the session log gains no `approval_decision` row.
          //
          // 401-01 (D-13): the composition's own notification that a conversation has appended an
          // event, which is how the box above learns its id DURING the first turn rather than
          // after it. Nothing else is done with it here — the REPL renders from the turn result.
          observeSessionEvent: (id) => { activeSessionId = id },
          // 395-13, D-14: the mid-turn render, on THE SAME STREAM this file's own turn output
          // writes to, which is why the stream is resolved here rather than defaulted inside the
          // engine, which has no streams.
          //
          // UNCONDITIONAL, INCLUDING UNDER PIPED STDIN. A scripted session is still a transcript
          // somebody reads, and it is the surface the live lane greps; suppressing the render for
          // non-TTY would make the one automatable reading of this clause unavailable.
          chatPresent: (text: string) => {
            const stream = deps.output ?? process.stdout
            printRunText(declaredSecrets.mask(text), (block) => {
              stream.write(`${block}\n`)
            })
          },
        })
        const chat = host.chat

        // D-19's graceful arm, registered before the first turn can start. It writes the explicit
        // `aborted` event for whatever is in flight and is a no-op between turns; the hard-kill
        // arm needs nothing, because a torn tail is repaired on the next open.
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

        // D-23: ONE read on open, at most one line, and silence when there is nothing to say. It
        // runs through the same invoke binding a turn dispatches through, with this surface's own
        // caller, because opening a chat is a person asking.
        // 399.1: the same classified envelope the composition root's binding answers with, built
        // the same way — `foldFunctionResult` over the same registry the call dispatched through.
        // A banner binding that skipped the fold would be a second, quieter answer to "what does
        // this seam return", which is the shape this phase is removing rather than adding to.
        const banner = await composeBanner(
          async (functionId, input, caller) => {
            const payload = await invokeFunction(host!.registry, functionId, input, caller)
            return { payload, ...foldFunctionResult(host!.registry, functionId, payload) }
          },
          CLI_FUNCTION_CALLER,
        )
        if (banner !== undefined) emitHuman(print, banner)

        // 398 plan 09, D-01/SC-1: the ONE catalog, loaded ONCE, feeding both discovery features.
        // It is loaded here rather than lazily because the loader FAILS LOUD — a missing artifact
        // is a broken install, and the named error carrying the regen instruction is what a person
        // needs, not a session that quietly knows nothing. This surface parses nothing itself; a
        // `JSON.parse` at this call site would be the second read path SC-1 exists to prevent.
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

            // 398-10 (D-18): the turn aggregate. `tool_call_count` is the number of CLAUSE RECEIPTS
            // the turn produced — the capabilities it actually invoked — read off the result rather
            // than counted here, so it cannot disagree with what the person was shown. Tokens are
            // absent because this surface is not told any: `AgentAskResult` carries no accounting,
            // and a zero would be a measurement nobody made.
            turnCount += 1
            functionCallCount += result.receipts.length
            analytics?.port.capture(analyticsEvent(analytics, 'agent-qa.chat.turn.completed', {
              duration_ms: Date.now() - turnStartedAt,
              tool_call_count: result.receipts.length,
              errored: result.status === 'fail_closed',
            }))

            activeSessionId = result.sessionId
            if (!announced) {
              // Printed ONCE, and printed at all because it is what `--session` takes (D-17).
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

          // `/quit` is read off the live state the engine mutates, never matched here — one
          // vocabulary for what a person can type, consulted where it routes.
          //
          // READ THROUGH THIS LOOP'S OWN SESSION (392 plan 13). The state is one container per
          // conversation now, so a surface asks about the conversation it is running: this REPL
          // holds exactly one, learned from `--session`/`--continue` up front or from the first
          // turn's result. `undefined` is the honest answer before a turn has opened anything, and
          // a session that has opened nothing has not asked to close.
          if (activeSessionId !== undefined && chat.stateFor(activeSessionId)?.closing === true) break
          if (!promptClosed) prompt.prompt()
        }
        prompt.close()
      } catch (error) {
        endReason = 'error'
        reportError(error, mask)
      } finally {
        // ONE session event per invocation that opened a conversation, emitted where the host is
        // closed so it cannot be missed by a path that returns early. A `--list` never reaches
        // here with analytics composed, and an invocation that refused an unknown session id
        // composed none either — neither opened a session, so neither reports one.
        //
        // `slash_command_count` IS DELIBERATELY ABSENT. Counting it here would mean matching a `/`
        // prefix in this file, and this surface's own law (see the header) is that it never
        // recognises one: the canon is a resolver table entry, consulted where it routes. A second
        // reading of what chat understands, kept here for a chart, is exactly the drift that law
        // exists to prevent. RETUNE: the count belongs wherever the turn is routed.
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
