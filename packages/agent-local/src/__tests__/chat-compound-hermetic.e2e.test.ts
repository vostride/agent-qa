// Both halves of a compound request run in order, or none run and the refused half is named.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_ASK_FUNCTION_ID,
  QUARANTINE_LIST_FUNCTION_ID,
  RUNS_LIST_FUNCTION_ID,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type {
  ChatLanguageModel,
  ChatTokenAccounting,
  JobModelCapability,
  ReconcileStrategy,
} from '@vostride/agent-qa-agent'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  browserConfigSchema,
  deviceConfigSchema,
  platformBase,
} from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatSessionEvent,
  FunctionCaller,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHAT_SESSIONS_SUBDIR } from '../session/jsonl-session-log.js'
import { composeLocalAgent } from '../composition/compose-local-agent.js'
import type { LocalAgentHost } from '../composition/compose-local-agent.js'

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

/** A person holding every scope, so a refusal below can only ever be the axis under test. */
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const JOB_MODEL: JobModelCapability = {
  modelId: 'fixture:compound-model',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const MINT_IDENTITY = (filePath: string): string => filePath

interface PlannerTripwire {
  readonly model: ChatLanguageModel
  readonly calls: () => number
}

/**
 * A model that FAILS the turn if it is ever reached, and counts the attempt either way.
 *
 * The cast is the one in the file and it is over a transport shape, not over a contract: the SDK's
 * language-model interface is large and every member beyond these five is unreachable from a call
 * that throws in `doGenerate`.
 */
function plannerTripwire(modelId: string): PlannerTripwire {
  let calls = 0
  const reached = (): never => {
    calls += 1
    throw new Error('the planner was consulted on an all-canonical utterance')
  }
  const model = {
    specificationVersion: 'v4',
    provider: 'fixture',
    modelId,
    supportedUrls: {},
    doGenerate: reached,
    doStream: reached,
  } as unknown as ChatLanguageModel
  return { model, calls: () => calls }
}

describe('the composed compound turn: complete, or loud', () => {
  let root: string
  let agentQaRoot: string
  const hosts: LocalAgentHost[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chat-compound-'))
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
  })

  afterEach(() => {
    for (const composed of hosts.splice(0)) void composed.close()
    rmSync(root, { recursive: true, force: true })
  })

  function compose(
    options: {
      chatModel?: ChatLanguageModel
      chatReconcile?: ReconcileStrategy
      chatAccounting?: ChatTokenAccounting
    } = {},
  ): LocalAgentHost {
    const composed = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => join(root, 'agent-qa-knowledge'),
      model: () => JOB_MODEL,
      ...options,
    })
    hosts.push(composed)
    return composed
  }

  async function ask(
    host: LocalAgentHost,
    message: string,
    sessionId?: string,
  ): Promise<AgentAskResult> {
    return (await invokeFunction(
      host.registry,
      AGENT_ASK_FUNCTION_ID,
      sessionId === undefined ? { message } : { message, sessionId },
      HUMAN,
    )) as AgentAskResult
  }

  function sessionEvents(sessionId: string): ChatSessionEvent[] {
    const path = join(agentQaRoot, CHAT_SESSIONS_SUBDIR, `${sessionId}.jsonl`)
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .slice(1)
      .map((line) => JSON.parse(line) as ChatSessionEvent)
  }

  describe('the all-canonical compound turn never touches the LLM', () => {
    // Two different ops that answer honestly in a bare project, so the order can be wrong.
    const UTTERANCE = '/fn quarantine.list and status'

    it('plans and executes exactly two clauses, in utterance order, with the planner untouched', async () => {
      const tripwire = plannerTripwire('fixture:never-called')
      const host = compose({ chatModel: tripwire.model })

      const result = await ask(host, UTTERANCE)

      expect(result.status).toBe('completed')
      // One receipt per clause, and every one `executed`.
      expect(result.receipts).toHaveLength(2)
      expect(result.receipts.map((receipt) => receipt.status)).toEqual(['executed', 'executed'])
      // Against imported ids, so an op renamed at its declaration breaks this.
      expect(result.receipts.map((receipt) => receipt.functionId)).toEqual([
        QUARANTINE_LIST_FUNCTION_ID,
        RUNS_LIST_FUNCTION_ID,
      ])
      expect(result.receipts.map((receipt) => receipt.clause)).toEqual(['/fn quarantine.list', 'status'])
      // The centre of the claim: a model was bound and was never reached.
      expect(tripwire.calls()).toBe(0)
    })

    it('mints human for BOTH stage-1 clauses', async () => {
      const tripwire = plannerTripwire('fixture:never-called')
      const host = compose({ chatModel: tripwire.model })

      const result = await ask(host, UTTERANCE)

      expect(result.receipts.map((receipt) => receipt.origin)).toEqual(['human', 'human'])
    })

    it('leaves the full ledger on disk, with the planner logged as SKIPPED', async () => {
      const tripwire = plannerTripwire('fixture:never-called')
      const host = compose({ chatModel: tripwire.model })

      const result = await ask(host, UTTERANCE)
      const events = sessionEvents(result.sessionId)

      expect(events.map((event) => event.kind)).toEqual([
        'user_message',
        'stage_outcome',
        'stage_outcome',
        'stage_outcome',
        // One masked `clause_result` before each receipt of a clause that ran, in execution order.
        'clause_result',
        'clause_receipt',
        'clause_result',
        'clause_receipt',
        'turn_complete',
      ])
      expect(
        events
          .filter((event) => event.kind === 'stage_outcome')
          .map((event) => [event.stage, event.outcome]),
      ).toEqual([
        ['resolver', 'resolved'],
        // `skipped`, not `resolved` and not `unresolved`: the stage was never asked. A build with
        // no model bound would log the same word for a different reason, which is why the model
        // above exists.
        ['planner', 'skipped'],
        ['reconcile', 'resolved'],
      ])
    })
  })

  describe('the fail-closed compound arm', () => {
    it('executes ZERO clauses and names the unroutable half', async () => {
      // No model bound: the headless posture, where an unresolved clause has nowhere left to go.
      const host = compose()

      const result = await ask(host, '/fn quarantine.list and write a test for two factor auth')

      expect(result.status).toBe('fail_closed')
      // The clause that COULD have run did not. This is the assertion `compound/` scenarios pin
      // as `executed == 0`, and it is about atomicity rather than about the failing clause.
      expect(result.receipts).toHaveLength(0)
      expect(result.unhandled?.clause).toBe('write a test for two factor auth')
      expect(result.unhandled?.reason).toContain('write a test for two factor auth')
    })

    it('records the refusal as a mark_unhandled event', async () => {
      const host = compose()

      const result = await ask(host, '/fn quarantine.list and write a test for two factor auth')
      const events = sessionEvents(result.sessionId)

      expect(events.filter((event) => event.kind === 'mark_unhandled')).toHaveLength(1)
      expect(events.find((event) => event.kind === 'mark_unhandled')).toMatchObject({
        clause: 'write a test for two factor auth',
      })
      // No clause receipt exists at all, because no clause was attempted.
      expect(events.filter((event) => event.kind === 'clause_receipt')).toHaveLength(0)
    })
  })

  describe('config drift is an event', () => {
    it('emits model_change with from/to when a session reopens under a different model', async () => {
      const first = compose({ chatModel: plannerTripwire('fixture:model-a').model })
      const opened = await ask(first, '/fn quarantine.list')
      await first.close()
      hosts.splice(hosts.indexOf(first), 1)

      // The SAME session, re-opened by a host whose re-read configuration resolves another model.
      const second = compose({ chatModel: plannerTripwire('fixture:model-b').model })
      const resumed = await ask(second, '/fn quarantine.list', opened.sessionId)

      expect(resumed.sessionId).toBe(opened.sessionId)
      const drift = sessionEvents(opened.sessionId).filter((event) => event.kind === 'model_change')
      expect(drift).toHaveLength(1)
      expect(drift[0]).toMatchObject({
        from: 'fixture:model-a',
        to: 'fixture:model-b',
        // Not `verb`: nobody typed `/model`. The two facts stay distinguishable in the record.
        source: 'config_reread',
      })
    })

    it('emits nothing when the same host reopens the same session', async () => {
      const host = compose({ chatModel: plannerTripwire('fixture:model-a').model })
      const opened = await ask(host, '/fn quarantine.list')
      await ask(host, '/fn quarantine.list', opened.sessionId)

      const events = sessionEvents(opened.sessionId)
      expect(events.filter((event) => event.kind === 'model_change')).toHaveLength(0)
      expect(events.filter((event) => event.kind === 'active_tools_change')).toHaveLength(0)
    })
  })

  describe('the degrade pass reaches the session log when a host binds accounting', () => {
    it('emits ONE compaction event on the turn that triggers, ahead of the user message', async () => {
      // A substrate fixture: only the hook binding and its event on the engine log are tested here.
      const accounting = {
        estimate: (messages: readonly unknown[]): number => messages.length * 1000,
        getCeilings: () => ({ contextWindow: 4, maxOutput: 1 }),
        degrade: (messages: readonly unknown[]) => ({ ok: true as const, messages: [...messages] }),
      }
      const host = compose({ chatAccounting: accounting as unknown as ChatTokenAccounting })

      const opened = await ask(host, '/fn quarantine.list')
      // Turn 1 replayed an empty conversation, so nothing could be compacted and nothing is logged.
      expect(sessionEvents(opened.sessionId).filter((e) => e.kind === 'compaction')).toHaveLength(0)

      await ask(host, '/fn quarantine.list', opened.sessionId)
      const events = sessionEvents(opened.sessionId)
      const compactions = events.filter((event) => event.kind === 'compaction')
      expect(compactions).toHaveLength(1)
      // After the second turn's user message, before its stage work.
      const userMessages = events
        .map((event, index) => ({ event, index }))
        .filter((entry) => entry.event.kind === 'user_message')
      expect(events.indexOf(compactions[0]!)).toBeGreaterThan(userMessages[1]!.index)
    })
  })

  describe('the strategy seam is composition-only and test-visible', () => {
    it('honours an injected strategy, so the mutation proof has something to switch', async () => {
      // The real host must take the strategy it is handed, or the mutation proof measures nothing.
      const refuseEverything: ReconcileStrategy = (reconcileInput) => ({
        kind: 'unhandled',
        clause: reconcileInput.clauses[0] ?? { text: '', index: 0 },
        reason: 'the injected strategy refused',
      })
      const host = compose({ chatReconcile: refuseEverything })

      const result = await ask(host, '/fn quarantine.list')

      expect(result.status).toBe('fail_closed')
      expect(result.unhandled?.reason).toBe('the injected strategy refused')
    })

    it('uses the shipped override when the option is absent, so absence is the safe default', async () => {
      const host = compose()

      const result = await ask(host, '/fn quarantine.list')

      expect(result.status).toBe('completed')
      expect(result.receipts[0]).toMatchObject({ functionId: QUARANTINE_LIST_FUNCTION_ID })
    })
  })
})

// Walks the parsed zod shapes, because a text search is defeated by any comment naming the key.

const CONFIG_SCHEMAS = [platformBase, browserConfigSchema, deviceConfigSchema]

interface ZodDef {
  readonly type?: string
  readonly shape?: Record<string, unknown>
  readonly options?: readonly unknown[]
  readonly innerType?: unknown
  readonly element?: unknown
  readonly valueType?: unknown
  readonly left?: unknown
  readonly right?: unknown
  readonly in?: unknown
  readonly out?: unknown
  readonly getter?: () => unknown
}

function defOf(node: unknown): ZodDef | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const internal = node as { _zod?: { def?: ZodDef }; def?: ZodDef }
  return internal._zod?.def ?? internal.def
}

function collectConfigSchemaKeys(): string[] {
  const keys = new Set<string>()
  const seen = new Set<unknown>()

  const walk = (node: unknown, depth: number): void => {
    if (depth > 16 || seen.has(node)) return
    const def = defOf(node)
    if (def === undefined) return
    seen.add(node)
    switch (def.type) {
      case 'object':
        for (const [key, value] of Object.entries(def.shape ?? {})) {
          keys.add(key)
          walk(value, depth + 1)
        }
        break
      case 'union':
        for (const option of def.options ?? []) walk(option, depth + 1)
        break
      case 'optional':
      case 'nullable':
      case 'default':
      case 'nonoptional':
      case 'readonly':
      case 'catch':
        walk(def.innerType, depth + 1)
        break
      case 'array':
        walk(def.element, depth + 1)
        break
      case 'record':
        walk(def.valueType, depth + 1)
        break
      case 'intersection':
        walk(def.left, depth + 1)
        walk(def.right, depth + 1)
        break
      case 'pipe':
        walk(def.in, depth + 1)
        walk(def.out, depth + 1)
        break
      case 'lazy':
        walk(def.getter?.(), depth + 1)
        break
      default:
        break
    }
  }

  for (const schema of CONFIG_SCHEMAS) walk(schema, 0)
  return [...keys].sort()
}

/** A key naming the reconciliation/override concept, in any casing or dotted path form. */
function overrideKnobKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const lowered = key.toLowerCase()
    return (
      lowered.includes('reconcil')
      || lowered.includes('override')
      || (lowered.includes('chat') && lowered.includes('strateg'))
    )
  })
}

describe('no production knob can disable the deterministic override', () => {
  it('walks a real, non-empty config-schema key inventory', () => {
    const keys = collectConfigSchemaKeys()
    // A walker that silently returned nothing would pass the assertion below forever.
    expect(keys.length).toBeGreaterThan(10)
  })

  it('no config-schema key names the reconciliation strategy or an override switch', () => {
    expect(overrideKnobKeys(collectConfigSchemaKeys())).toEqual([])
  })

  it('POSITIVE CONTROL: the detector flags such a key when one exists', () => {
    // Without this, "no knob" and "the detector is broken" are the same green.
    expect(overrideKnobKeys(['timeouts', 'chatReconcile'])).toEqual(['chatReconcile'])
    expect(overrideKnobKeys(['disableOverride'])).toEqual(['disableOverride'])
    expect(overrideKnobKeys(['chatStrategy'])).toEqual(['chatStrategy'])
  })
})
