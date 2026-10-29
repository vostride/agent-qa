// Each directive is paired with the observable it must move, read off the composed host.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_ASK_FUNCTION_ID,
  QUARANTINE_LIST_FUNCTION_ID,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { ChatLanguageModel, JobModelCapability } from '@vostride/agent-qa-agent'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
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
import type {
  LocalAgentHost,
} from '../composition/compose-local-agent.js'

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
  modelId: 'fixture:directive-model',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const MINT_IDENTITY = (filePath: string): string => filePath

/** A model object that answers nothing: every assertion here is about WHICH model, never what it said. */
function namedModel(modelId: string): ChatLanguageModel {
  const unreachable = (): never => {
    throw new Error('no directive scenario consults the planner')
  }
  return {
    specificationVersion: 'v3',
    provider: 'fixture',
    modelId,
    supportedUrls: {},
    doGenerate: unreachable,
    doStream: unreachable,
  } as unknown as ChatLanguageModel
}

describe('the composed session directives reach something', () => {
  let root: string
  let agentQaRoot: string
  const hosts: LocalAgentHost[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chat-directives-'))
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
      chatModelFor?: (name: string) => ChatLanguageModel | Promise<ChatLanguageModel>
      // The composition declares no `chatConfirm`; a factory arrives here as an excess field.
      chatConfirm?: (bindings: unknown) => undefined
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

  // Each cell types `/pin` and checks that it reaches nothing.
  describe('a typed /pin reaches nothing', () => {
    it('the op runs before and after a typed /pin, in the same session and outside it',
      async () => {
        const host = compose()
        const opened = await ask(host, '/fn quarantine.list')
        // The session id is smuggled past the type, so `inSession` stays a distinct caller.
        const inSession = { ...HUMAN, sessionId: opened.sessionId } as FunctionCaller

        await expect(
          invokeFunction(host.registry, QUARANTINE_LIST_FUNCTION_ID, {}, inSession),
        ).resolves.toBeDefined()

        const pinned = await ask(host, `/pin ${QUARANTINE_LIST_FUNCTION_ID}`, opened.sessionId)
        expect(pinned.status).toBe('fail_closed')

        await expect(
          invokeFunction(host.registry, QUARANTINE_LIST_FUNCTION_ID, {}, inSession),
        ).resolves.toBeDefined()
        await expect(
          invokeFunction(host.registry, QUARANTINE_LIST_FUNCTION_ID, {}, HUMAN),
        ).resolves.toBeDefined()
      })

    it('a typed /pin writes NO approval_decision row', async () => {
      const host = compose()
      const result = await ask(host, `/pin ${QUARANTINE_LIST_FUNCTION_ID}`)

      expect(
        sessionEvents(result.sessionId).filter((event) => event.kind === 'approval_decision'),
      ).toEqual([])
      expect(result.answer ?? '').not.toContain(`fn:${QUARANTINE_LIST_FUNCTION_ID}`)
    })

    it('executes NOTHING on a /pin turn, and publishes no pin to live state', async () => {
      const host = compose()
      const result = await ask(host, `/pin ${QUARANTINE_LIST_FUNCTION_ID}`)

      expect(result.receipts).toEqual([])
      const state = host.chat.stateFor(result.sessionId)
      expect(state).toBeDefined()
      expect(Object.keys(state!)).not.toContain('pinnedActionClasses')
    })

    it('refuses BY NAME as an unroutable clause, leaving one countable row', async () => {
      const host = compose()
      // `/pin` is not a directive, so a host with no planner refuses it as it refuses any other
      // unrouted text, naming the clause, through the engine's ONE refusal path.
      const result = await ask(host, '/pin config-write')

      expect(result.status).toBe('fail_closed')
      expect(result.unhandled?.clause).toBe('/pin config-write')
      const unhandled = sessionEvents(result.sessionId).filter(
        (event) => event.kind === 'mark_unhandled',
      )
      expect(unhandled).toHaveLength(1)
    })
  })

  describe('/model reaches the model resolution', () => {
    it('emits ONE model_change with source verb, through diffChatConfig', async () => {
      const host = compose({ chatModel: namedModel('fixture:opening-model') })
      const result = await ask(host, '/model fixture:second-model')

      const changes = sessionEvents(result.sessionId).filter(
        (event) => event.kind === 'model_change',
      )
      expect(changes).toEqual([
        expect.objectContaining({
          from: 'fixture:opening-model',
          to: 'fixture:second-model',
          source: 'verb',
        }),
      ])
    })

    it('does NOT emit a model_change straight back on the next turn', async () => {
      // A `config` thunk answering the composed model would emit a `model_change` undoing the verb.
      const host = compose({ chatModel: namedModel('fixture:opening-model') })
      const first = await ask(host, '/model fixture:second-model')
      await ask(host, '/help', first.sessionId)

      const changes = sessionEvents(first.sessionId).filter(
        (event) => event.kind === 'model_change',
      )
      expect(changes).toHaveLength(1)
      expect(host.chat.stateFor(first.sessionId)?.activeModel).toBe('fixture:second-model')
    })

    it('resolves the named model through the HOST, never by constructing one', async () => {
      // Chat cannot build a model, so the spy shows the override reached model resolution.
      const asked: string[] = []
      const host = compose({
        chatModel: namedModel('fixture:opening-model'),
        chatModelFor: (name) => {
          asked.push(name)
          return namedModel(name)
        },
      })

      await ask(host, '/model fixture:second-model')

      expect(asked).toEqual(['fixture:second-model'])
    })

    it('refuses BY NAME when the host cannot resolve the named model', async () => {
      const host = compose({
        chatModel: namedModel('fixture:opening-model'),
        chatModelFor: (name) => {
          throw new Error(`no model named ${name} is configured`)
        },
      })

      const result = await ask(host, '/model fixture:nonsense')

      // A `/model` that silently kept the old model would be the worst answer available: every
      // later turn would report a model that never answered anything.
      expect(result.status).toBe('fail_closed')
      expect(result.unhandled?.reason).toContain('fixture:nonsense')
      expect(host.chat.stateFor(result.sessionId)?.activeModel).toBe('fixture:opening-model')
    })
  })

  describe('the chrome directives answer, and /quit reaches the loop', () => {
    it('/help names the reach lever, and executes nothing', async () => {
      const host = compose()
      const result = await ask(host, '/help')

      expect(result.status).toBe('completed')
      expect(result.receipts).toEqual([])
      // `/fn` is what tells a person the thin canon is not the whole capability set.
      expect(result.answer).toContain('/fn')
    })

    it('/quit sets the live state a REPL reads, rather than being matched by the surface', async () => {
      const host = compose()
      // An ordinary turn first, so the before-state is read off the session the `/quit` turn moves.
      const opened = await ask(host, '/fn quarantine.list')
      expect(host.chat.stateFor(opened.sessionId)?.closing).toBe(false)

      const result = await ask(host, '/quit', opened.sessionId)

      expect(result.status).toBe('completed')
      // ONE vocabulary for what a person can type. A REPL matching `/quit` itself would be a
      // second list of the canon, free to disagree with the table that routes everything else.
      expect(host.chat.stateFor(opened.sessionId)?.closing).toBe(true)
      // And it moved THAT conversation only: a second session on the same host is not closing
      // because somebody else typed `/quit`.
      const other = await ask(host, '/fn quarantine.list')
      expect(host.chat.stateFor(other.sessionId)?.closing).toBe(false)
    })
  })

  describe('the live turn state', () => {
    it('carries the conversation forward across turns, and names no turn between them', async () => {
      const host = compose()
      const first = await ask(host, '/fn quarantine.list')

      // Between turns there is nothing in flight, which is what makes an abort a no-op rather
      // than a row on a turn that already completed.
      expect(host.chat.stateFor(first.sessionId)?.activeTurnId).toBeUndefined()
      expect(host.chat.stateFor(first.sessionId)?.lastTurn?.turnId).toBe(first.turnId)

      await ask(host, 'status', first.sessionId)
      const conversation = host.chat.stateFor(first.sessionId)?.conversation ?? []
      // The repaired replay, projected once. The first turn's utterance and its receipt line are
      // both in it by the second turn, oldest first.
      expect(conversation.length).toBeGreaterThan(0)
      expect(JSON.stringify(conversation)).toContain('quarantine')
    })

    it('abortActiveTurn is a no-op between turns', async () => {
      const host = compose()
      const result = await ask(host, '/fn quarantine.list')

      await host.chat.abortActiveTurn()

      expect(sessionEvents(result.sessionId).filter((e) => e.kind === 'aborted')).toEqual([])
    })

    it('writes an explicit aborted row for a turn caught in flight by a graceful abort', async () => {
      // DRIVEN FROM INSIDE A TURN, and deterministically rather than by racing one. `chatModelFor`
      // is called by the `/model` handler in the middle of `runTurn`, which is exactly the window a
      // SIGINT handler fires in — so the state it observes is the state that handler would see, and
      // there is no sleep or microtask ordering holding the assertion up.
      let observedTurnId: string | undefined
      // State is per session, so a handler asks about the session an opening turn reveals.
      let sessionId: string | undefined
      const host: LocalAgentHost = compose({
        chatModel: namedModel('fixture:opening-model'),
        chatModelFor: async (name) => {
          observedTurnId =
            sessionId === undefined ? undefined : host.chat.stateFor(sessionId)?.activeTurnId
          await host.chat.abortActiveTurn()
          return namedModel(name)
        },
      })

      const opened = await ask(host, '/fn quarantine.list')
      sessionId = opened.sessionId
      const result = await ask(host, '/model fixture:second-model', sessionId)

      // The id was published at the TOP of the turn, before anything could fail. That ordering is
      // the whole reason the state sink exists: an interrupted turn never produces a result, so a
      // handler waiting for one could never name what it was interrupting.
      expect(observedTurnId).toBe(result.turnId)
      const aborted = sessionEvents(result.sessionId).filter((e) => e.kind === 'aborted')
      expect(aborted).toEqual([
        expect.objectContaining({ source: 'explicit', turnId: result.turnId }),
      ])
    })
  })

  describe('the chat confirm seam is retired', () => {
    it('a supplied chat-confirm factory is never called, and no decision row is written', async () => {
      let calls = 0
      const host = compose({
        chatConfirm: () => {
          calls += 1
          return undefined
        },
      })

      const result = await ask(host, '/fn quarantine.list')

      expect(result.status).toBe('completed')
      expect(calls).toBe(0)
      expect(sessionEvents(result.sessionId).filter((e) => e.kind === 'approval_decision'))
        .toEqual([])
    })
  })
})
