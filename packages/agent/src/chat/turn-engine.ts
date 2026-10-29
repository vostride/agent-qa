// Stage 3 completes before stage 4 begins, so no effect of any kind precedes the verdict.

import type {
  AgentAskInput,
  AgentAskResult,
  ChatSessionEvent,
  ChatSessionHandle,
  ClauseReceipt,
  ClauseResult,
  ChatTurnStatus,
  FunctionCaller,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import { AUTHORING_DRAFT_WRITE_FUNCTION_ID } from '../functions/ops/authoring-draft-write.js'
import { CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID } from '../functions/ops/config-project-scaffold.js'
import {
  WRITE_TEST_UNCONFIGURED_DETAIL,
  writeTestScaffoldStopDetail,
  resolveWriteTestRoute,
} from '../config-mutation/write-test-route.js'

import type {
  CallerMint,
  ChatClause,
  ChatDirectiveHandlers,
  ChatInvokeBinding,
  ChatTurnStateSink,
  ClauseSplitter,
  CompactionHook,
  PlannerStageOutcome,
  PlannerStagePort,
  ReconcileStrategy,
  ResolvedClause,
} from './ports.js'
import { diffChatConfig, foldChatConfigState } from './config-drift.js'
import type { ChatConfigState } from './config-drift.js'
import { replayToModelMessages } from './compaction.js'
import { directiveNotBoundReason, resolveClause } from './resolver-table.js'
import { replaySession } from './session-repair.js'
import { SESSION_STAMPED_FUNCTION_IDS, WINDOW_STAMPED_FUNCTION_IDS } from './session-stamps.js'
import type { ChatDirectiveName, ChatResolverTable } from './resolver-table.js'

export interface TurnEngineDeps {
  readonly table: ChatResolverTable
  readonly split: ClauseSplitter
  readonly reconcile: ReconcileStrategy
  readonly sessionLog: SessionLogPort
  readonly mint: CallerMint
  readonly invoke: ChatInvokeBinding
  // Absent means headless: an unresolved clause fails the turn closed by name.
  readonly planner?: PlannerStagePort
  readonly compaction?: CompactionHook
  // A per-session thunk, so a file changed under a running session shows up as drift.
  readonly config?: (sessionId: string) => ChatConfigState | Promise<ChatConfigState>
  // A factory per session, so one conversation's `/model` or `/quit` cannot reach another.
  readonly directives?: (sessionId: string) => ChatDirectiveHandlers
  // The turn id goes out at the start, because an interrupted turn never produces a result.
  readonly state?: (sessionId: string) => ChatTurnStateSink
  // A thunk on the authoring loop's port, so a scaffold written this turn changes the answer.
  readonly configuredTargets?: () => Promise<readonly string[]>
  // Display-only: nothing waits on it, and an absent or failing port does not stop the turn.
  readonly present?: (text: string) => void | Promise<void>
  readonly now: () => string
  readonly mintTurnId: () => string
}

/** What `agent.ask` is bound to. One method, because a turn is one thing that happens. */
export interface TurnEngine {
  runTurn(input: AgentAskInput): Promise<AgentAskResult>
}

// Fallback for ops with no classifier; stringifying the result would put payloads in the log.
function summarise(functionId: string): string {
  return `${functionId} completed`
}

// Re-exported from `session-stamps.ts`, which the model-facing projection also reads.
export { SESSION_STAMPED_FUNCTION_IDS, WINDOW_STAMPED_FUNCTION_IDS }

// Overwrites the receipt `sessionRef`; defaults `window`, overwriting only its session ref.
function stampSessionFacts(functionId: string, args: unknown, sessionId: string): unknown {
  const stampsRef = SESSION_STAMPED_FUNCTION_IDS.has(functionId)
  const stampsWindow = WINDOW_STAMPED_FUNCTION_IDS.has(functionId)
  if (!stampsRef && !stampsWindow) return args
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args

  const stamped: Record<string, unknown> = { ...(args as Record<string, unknown>) }
  if (stampsRef) stamped.sessionRef = sessionId
  if (stampsWindow) {
    const window = stamped.window
    if (window === undefined) {
      stamped.window = { scope: 'session', sessionRef: sessionId }
    } else if (
      typeof window === 'object'
      && window !== null
      && !Array.isArray(window)
      && (window as { scope?: unknown }).scope === 'session'
    ) {
      stamped.window = { ...(window as Record<string, unknown>), sessionRef: sessionId }
    }
  }
  return stamped
}

/**
 * What stage 2 produced when it was skipped or when no planner is bound.
 *
 * The EMPTY plan rather than an absent one, so stage 3 reads one shape whatever happened upstream:
 * a reconciliation strategy that had to ask "was there a planner" before asking "what did it say"
 * would have two paths through the decision that refuses a turn, and only one of them would be
 * exercised by a host that binds a model.
 */
const NO_PLAN: PlannerStageOutcome = { toolCalls: [] }

/** The refusal NAME the function layer publishes, which is what a failed receipt carries. */
function refusalName(error: unknown): string {
  if (error instanceof Error) return error.name === '' ? error.message : error.name
  return String(error)
}

/** The refusal SENTENCE a person reads. See `routeWriteTest`'s catch for why not the name. */
function refusalMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : refusalName(error)
}

// Prints each `CROSS_BOUNDARY_REASONS` word as filed, and nothing when the change crosses nothing.
function crossBoundaryLines(answer: {
  readonly crossBoundary?: boolean
  readonly crossBoundaryReasons?: readonly string[]
}): readonly string[] {
  if (answer.crossBoundary !== true) return []
  const reasons = answer.crossBoundaryReasons ?? []
  return [
    'CROSSES A TRUST BOUNDARY — crossBoundary: true; crossBoundaryReasons: '
    + (reasons.length === 0 ? '(none named)' : reasons.join(', ')),
  ]
}

/** What one directive did: a line to print back, or the reason the turn is refused. */
type DirectiveResult =
  | { readonly kind: 'handled'; readonly text: string }
  | { readonly kind: 'refused'; readonly reason: string }

/** One collected directive: the clause the table matched, and what it matched it as. */
interface DirectiveEntry {
  readonly clause: ChatClause
  readonly directive: ChatDirectiveName
  readonly argument?: string
}

// A pure read, so a missing handler is refused early without mutating the session first.
function directiveBindingRefusal(
  handlers: ChatDirectiveHandlers | undefined,
  entry: DirectiveEntry,
): string | undefined {
  const bound = ((): boolean => {
    switch (entry.directive) {
      case 'model':
        return handlers?.model !== undefined && entry.argument !== undefined
      case 'help':
        return handlers?.help !== undefined
      case 'quit':
        return handlers?.quit !== undefined
    }
  })()
  return bound ? undefined : directiveNotBoundReason(entry.directive, entry.clause.text)
}

// `model_change` comes from `diffChatConfig`, as the config re-read's does, with `source: 'verb'`.
async function runDirective(
  deps: TurnEngineDeps,
  handlers: ChatDirectiveHandlers | undefined,
  entry: DirectiveEntry,
  context: {
    readonly turnId: string
    readonly sessionId: string
    readonly append: (event: ChatSessionEvent) => Promise<void>
    readonly now: () => string
  },
): Promise<DirectiveResult> {
  const notBound = (): DirectiveResult => ({
    kind: 'refused',
    reason: directiveNotBoundReason(entry.directive, entry.clause.text),
  })

  try {
    switch (entry.directive) {
      case 'model': {
        if (handlers?.model === undefined || entry.argument === undefined) return notBound()
        const outcome = await handlers.model(entry.argument)
        if (outcome.from !== outcome.to && deps.config !== undefined) {
          // Current config with only the model wound back, so the diff yields one `model_change`.
          const current = await deps.config(context.sessionId)
          for (const event of diffChatConfig(
            { ...current, model: outcome.from },
            current,
            { turnId: context.turnId, at: context.now(), source: 'verb' },
          )) {
            await context.append(event)
          }
        }
        return { kind: 'handled', text: outcome.line }
      }
      case 'help': {
        if (handlers?.help === undefined) return notBound()
        return { kind: 'handled', text: handlers.help() }
      }
      case 'quit': {
        if (handlers?.quit === undefined) return notBound()
        return { kind: 'handled', text: handlers.quit() }
      }
    }
  } catch (error) {
    // A handler that REFUSED — a `/model` naming a model this host cannot resolve is the shipped
    // case — is a clause this build could not carry out, so it takes the engine's one refusal path
    // and leaves the same countable row. The message is the refusal's own.
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
}

export function createTurnEngine(deps: TurnEngineDeps): TurnEngine {
  return {
    async runTurn(input: AgentAskInput): Promise<AgentAskResult> {
      // Every write uses this turn's handle; the `try/finally` releases it once on every exit.
      const handle = await deps.sessionLog.open(input.sessionId)
      try {
        return await runTurnThrough(deps, handle, input)
      } finally {
        await handle.close()
      }
    },
  }
}

/**
 * The turn itself, written entirely through ONE session's handle.
 *
 * Lifted out of the closure so the open/close pair above can be a plain `try/finally` — the release
 * is then structural rather than a line each return path has to remember, which is the same reason
 * stage 4 is unreachable from a refusal by control flow rather than by a check.
 */
async function runTurnThrough(
  deps: TurnEngineDeps,
  opened: ChatSessionHandle,
  input: AgentAskInput,
): Promise<AgentAskResult> {
  const sessionId = opened.header.sessionId
  // Resolved once, after `open()`, because a turn naming no session is given its id by the adapter.
  const state = deps.state?.(sessionId)
  const directiveHandlers = deps.directives?.(sessionId)
  const turnId = deps.mintTurnId()
  // Published BEFORE anything can fail, because the state this names is "a turn is in flight"
  // and that becomes true here. A surface interrupted between this line and the boundary below
  // has the id it needs to write the explicit `aborted` event.
  state?.beginTurn(turnId)

  // Writes go through the handle; there is no adapter-level write verb to reach for.
  const append = async (event: ChatSessionEvent): Promise<void> => {
    await opened.append(event)
  }
  // On every result, refusals included, so a person hears of a damaged session when it reopens.
  const refusedLineCount =
    opened.refusedLines.length === 0
      ? {}
      : { refusedLineCount: opened.refusedLines.length }

  const finish = async (
    status: ChatTurnStatus,
    // Defaulted to empty, because every arm arriving without results is one where nothing ran.
    result: Omit<AgentAskResult, 'sessionId' | 'turnId' | 'status' | 'results'>
      & { results?: readonly ClauseResult[] },
  ): Promise<AgentAskResult> => {
    await append({ kind: 'turn_complete', turnId, at: deps.now(), status })
    // The fsync point, once per turn, so a crash loses at most the in-flight turn.
    await opened.turnBoundary()
    state?.endTurn({ turnId, status, receipts: result.receipts, ...(result.answer === undefined ? {} : { answer: result.answer }) })
    return {
      sessionId,
      turnId,
      status,
      ...refusedLineCount,
      ...result,
      results: [...result.results ?? []],
    }
  }
  // Every refusal goes through here, so each leaves the `mark_unhandled` row the field rate counts.
  const refuse = async (clause: string, reason: string): Promise<AgentAskResult> => {
    await append({ kind: 'mark_unhandled', turnId, at: deps.now(), clause, reason })
    return finish('fail_closed', { receipts: [], unhandled: { clause, reason } })
  }

  // `open()` already repaired the events, so replay and degrade see no unrepaired turn.
  const replay = replaySession(opened.events)
  // The repaired replay becomes the conversation; a bound degrade pass republishes the pruned form.
  state?.setConversation(replayToModelMessages(replay))

  // Drift events precede the user message, so a reader has the configuration before the question.
  if (deps.config !== undefined) {
    const current: ChatConfigState = await deps.config(sessionId)
    const previous = foldChatConfigState(opened.header, opened.events)
    for (const event of diffChatConfig(previous, current, {
      turnId,
      at: deps.now(),
      source: 'config_reread',
    })) {
      await append(event)
    }
  }

  await append({ kind: 'user_message', turnId, at: deps.now(), text: input.message })
  await deps.compaction?.({ turnId, sessionId, replay, append })

  // ---- Stage 1: the deterministic resolver over the clause split.
  const clauses = deps.split(input.message)
  const mapped: ResolvedClause[] = []
  const directives: DirectiveEntry[] = []
  for (const clause of clauses) {
    const resolution = resolveClause(deps.table, clause.text)
    if (resolution.kind === 'unresolved') continue
    if (resolution.entry.kind === 'directive') {
      // Collected, not dropped: a directive names no capability, yet ignoring it drops a clause.
      directives.push({
        clause,
        directive: resolution.entry.directive,
        ...(resolution.entry.argument === undefined
          ? {}
          : { argument: resolution.entry.argument }),
      })
      continue
    }
    mapped.push({
      clause,
      functionId: resolution.entry.functionId,
      args: resolution.entry.input,
    })
  }
  await append({
    kind: 'stage_outcome',
    turnId,
    at: deps.now(),
    stage: 'resolver',
    // Directives count as RESOLVED here, because they were: the table matched them. Whether
    // anything can carry them out is the next question, and answering it in this field would
    // make "stage 1 did not recognise this" and "this build cannot do it" the same bytes.
    outcome:
      mapped.length + directives.length === clauses.length ? 'resolved' : 'unresolved',
  })

  // Only the binding question here; directives are carried out below the verdict.
  for (const entry of directives) {
    const notBound = directiveBindingRefusal(directiveHandlers, entry)
    if (notBound !== undefined) return refuse(entry.clause.text, notBound)
  }

  // Every directive is validated before any applies, so a refused batch has had nothing done to it.
  if (directiveHandlers?.validate !== undefined) {
    for (const entry of directives) {
      try {
        await directiveHandlers.validate(entry.directive, entry.argument)
      } catch (error) {
        // The refusal's own message, for the reason `runDirective`'s catch takes it: the handler
        // knows what it can accept, and re-deriving that here would be a second answer to it.
        return refuse(entry.clause.text, error instanceof Error ? error.message : String(error))
      }
    }
  }

  // Everything the directives did not claim. Computed rather than reusing `clauses`, so a turn
  // that is ENTIRELY directives reaches stage 3 with nothing to reconcile and completes through
  // the same four stages as any other — one path, rather than a fast one and a careful one.
  const routable = clauses.filter(
    (clause) => !directives.some((entry) => entry.clause.index === clause.index),
  )

  // ---- Stage 2: the planner, consulted ONLY for what stage 1 could not answer.
  const unmapped = routable.filter(
    (clause) => !mapped.some((resolved) => resolved.clause.index === clause.index),
  )
  let planned: PlannerStageOutcome = NO_PLAN
  if (unmapped.length === 0) {
    // The tracer's path, and a permanent one: a fully canonical utterance is model-independent.
    await append({
      kind: 'stage_outcome',
      turnId,
      at: deps.now(),
      stage: 'planner',
      outcome: 'skipped',
    })
  } else if (deps.planner === undefined) {
    // Headless: refuse by name rather than guess.
    await append({
      kind: 'stage_outcome',
      turnId,
      at: deps.now(),
      stage: 'planner',
      outcome: 'unresolved',
    })
  } else {
    planned = await deps.planner.plan({ utterance: input.message, clauses: unmapped, sessionId })
    await append({
      kind: 'stage_outcome',
      turnId,
      at: deps.now(),
      stage: 'planner',
      // Resolved when the model produced a plan or an answer, whatever reconciliation decides.
      outcome:
        planned.failure === undefined && planned.toolCalls.length > 0 ? 'resolved' : 'unresolved',
    })
  }

  // Stage 3: deterministic reconciliation, before any side effect.
  const verdict = deps.reconcile({ clauses: routable, mapped, planned })
  await append({
    kind: 'stage_outcome',
    turnId,
    at: deps.now(),
    stage: 'reconcile',
    outcome: verdict.kind === 'execute' ? 'resolved' : 'unresolved',
  })
  if (verdict.kind === 'unhandled') {
    return refuse(verdict.clause.text, verdict.reason)
  }

  // Directive effects run only on the execute arm, and a throw still routes through `refuse()`.
  const directiveLines: string[] = []
  for (const entry of directives) {
    const line = await runDirective(deps, directiveHandlers, entry, {
      turnId,
      sessionId,
      append,
      now: deps.now,
    })
    if (line.kind === 'refused') return refuse(entry.clause.text, line.reason)
    directiveLines.push(line.text)
  }

  // Runs before the authoring dispatch, so a request is checked before any model call is spent.
  async function routeWriteTest(
    engine: TurnEngineDeps,
    step: { readonly functionId: string; readonly args: unknown },
    caller: FunctionCaller,
    appendEvent: (event: ChatSessionEvent) => Promise<void>,
    turn: string,
  ): Promise<'proceed' | 'stop'> {
    const intent = (step.args as { intent?: unknown } | undefined)?.intent
    if (typeof intent !== 'string') return 'proceed'

    const route = resolveWriteTestRoute({
      intent,
      configuredTargetNames: await (engine.configuredTargets as () => Promise<readonly string[]>)(),
    })
    if (route.kind === 'configured' || route.kind === 'passthrough') return 'proceed'
    if (route.kind === 'refuse') {
      writeTestRefusal = WRITE_TEST_UNCONFIGURED_DETAIL
      return 'stop'
    }

    // Through the same binding as every dispatch, so the scaffold is audited and receipted.
    let scaffolded: unknown
    try {
      scaffolded = (await engine.invoke(
        CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID, { domain: route.domain }, caller,
      )).payload
    } catch (error) {
      writeTestRefusal = refusalMessage(error)
      return 'stop'
    }
    const answer = scaffolded as {
      outcome?: string
      detail?: string
      summaryLine?: string
      files?: readonly string[]
      shownDiff?: string
      crossBoundary?: boolean
      crossBoundaryReasons?: readonly string[]
      blockedReason?: string
      validationIssues?: readonly string[]
      path?: string
    }
    if (answer.outcome !== 'applied' || answer.files === undefined || answer.files.length === 0) {
      // Each stop answers its own reason; none is a configuration to author a test against.
      writeTestRefusal = writeTestScaffoldStopDetail(answer)
      return 'stop'
    }

    await appendEvent({
      kind: 'clause_receipt',
      turnId: turn,
      at: engine.now(),
      clause: step.functionId,
      functionId: CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
      origin: caller.origin,
      status: 'executed',
      outcome: `applied: ${answer.files.join(', ')}`,
    })

    // THE RECEIPT, SHOWN WHERE A SURFACE EXISTS. The op's own summary, files and diff, never a
    // re-derivation. Best effort: the change is already on disk and nothing waits on this render,
    // so a surface that is absent or fails leaves the turn to continue.
    const present = engine.present
    if (present !== undefined) {
      try {
        await present(
          [
            ...crossBoundaryLines(answer),
            ...(answer.summaryLine === undefined ? [] : [answer.summaryLine]),
            ...answer.files,
            ...(answer.shownDiff === undefined ? [] : [answer.shownDiff]),
          ].filter((part) => part !== '').join('\n'),
        )
      } catch {
        // The display is a receipt, not a gate; its failure contributes nothing to the turn.
      }
    }
    return 'proceed'
  }

  // Stage 4: in utterance order, stopping on failure; the plan exists only on the execute arm.
  const receipts: ClauseReceipt[] = []
  // Appended in the loop, so its order is execution order and its length the clauses that ran.
  const results: ClauseResult[] = []
  // Set from `receipt.status` at the push site, so a thrown and a returned failure read the same.
  let failed = false
  // What the ops produced, on its way to the turn's `answer` field.
  const answerLines: string[] = []
  // Set by `routeWriteTest` before it answers `stop`; unset, `refuse()` uses the default sentence.
  let writeTestRefusal: string | undefined

  for (const step of verdict.plan) {
    // Follows the proving stage, so a model's call is never recorded as a person's.
    const caller = deps.mint.forStage(step.source)
    let receipt: ClauseReceipt
    if (failed) {
      // `not-run` is logged like any receipt, so an unattempted clause differs from a failed one.
      receipt = {
        clause: step.clause.text,
        functionId: step.functionId,
        origin: caller.origin,
        status: 'not-run',
        outcome: 'an earlier clause failed, so this one was never attempted',
      }
    } else if (
      step.functionId === AUTHORING_DRAFT_WRITE_FUNCTION_ID
      && deps.configuredTargets !== undefined
      && (await routeWriteTest(deps, step, caller, append, turnId)) === 'stop'
    ) {
      // No configuration and the scaffold wrote none, so nothing is authored and the turn says why.
      return refuse(step.clause.text, writeTestRefusal ?? WRITE_TEST_UNCONFIGURED_DETAIL)
    } else {
      try {
        // The result arrives classified, so a returned typed refusal is not reported as `executed`.
        const answered = await deps.invoke(
          step.functionId,
          stampSessionFacts(step.functionId, step.args, sessionId),
          caller,
        )
        receipt = {
          clause: step.clause.text,
          functionId: step.functionId,
          origin: caller.origin,
          // THE OP'S OWN VERDICT, not a derivation from how the call ended. Fail-closed upstream:
          // a fold that could not read its result answered `failed`, never `executed`.
          status: answered.verdict.status,
          // An empty outcome means the op's fold had nothing to add, and the line this engine has
          // always printed is the honest answer for it — the same line an op with no fold gets.
          outcome: answered.verdict.outcome === ''
            ? summarise(step.functionId)
            : answered.verdict.outcome,
        }
        // The function layer's masked payload, as returned; nothing restores a value here.
        results.push({ functionId: step.functionId, payload: answered.payload })
        // `?? null` keeps the key, which `guardChatSessionEvent`'s exact-key check needs on reopen.
        await append({
          kind: 'clause_result',
          turnId,
          at: deps.now(),
          functionId: step.functionId,
          payload: answered.payload ?? null,
        })
        // Lines come from the op's own `renderResult`; the receipt stays the map.
        answerLines.push(...answered.foldLines)
      } catch (error) {
        receipt = {
          clause: step.clause.text,
          functionId: step.functionId,
          origin: caller.origin,
          status: 'failed',
          outcome: refusalName(error),
        }
      }
    }
    // Only `failed` stops the chain: a refusal reached its capability and came back.
    if (receipt.status === 'failed') failed = true
    receipts.push(receipt)
    await append({
      kind: 'clause_receipt',
      turnId,
      at: deps.now(),
      clause: receipt.clause,
      functionId: receipt.functionId,
      origin: receipt.origin,
      status: receipt.status,
      outcome: receipt.outcome,
    })
  }

  // Directive lines lead, then op output, then the planner's prose, in the order the person asked.
  const answer = [...directiveLines, ...answerLines, verdict.answer].filter(
    (line): line is string => line !== undefined && line !== '',
  )
  return finish(failed ? 'failed' : 'completed', {
    receipts,
    results,
    ...(answer.length === 0 ? {} : { answer: answer.join('\n') }),
  })
}

/** The clause shape re-exported for composition roots that build a splitter. */
export type { ChatClause }
