// One deterministic utterance through every layer of the composed host, plus the fail-closed arm.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_ASK_FUNCTION_ID,
  QUARANTINE_LIST_FUNCTION_ID,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
import {
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatSessionEvent,
  ChatSessionHeader,
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

const MODEL: JobModelCapability = {
  modelId: 'fixture:tracer-model',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const MINT_IDENTITY = (filePath: string): string => filePath

// The op is reached through the one `/fn` branch.
describe('the ask tracer: agent-qa ask "/fn quarantine.list", end to end over the composed host', () => {
  let root: string
  let agentQaRoot: string
  let host: LocalAgentHost
  const hosts: LocalAgentHost[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chat-ask-tracer-'))
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
    host = compose()
  })

  afterEach(() => {
    for (const composed of hosts.splice(0)) void composed.close()
    rmSync(root, { recursive: true, force: true })
  })

  function compose(): LocalAgentHost {
    const composed = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => join(root, 'agent-qa-knowledge'),
      model: () => MODEL,
    })
    hosts.push(composed)
    return composed
  }

  async function ask(message: string, sessionId?: string): Promise<AgentAskResult> {
    return (await invokeFunction(
      host.registry,
      AGENT_ASK_FUNCTION_ID,
      sessionId === undefined ? { message } : { message, sessionId },
      HUMAN,
    )) as AgentAskResult
  }

  /** The session file as the bytes on disk, split exactly the way a reopen would split them. */
  function sessionLines(sessionId: string): string[] {
    const path = join(agentQaRoot, CHAT_SESSIONS_SUBDIR, `${sessionId}.jsonl`)
    return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '')
  }

  it('the deterministic table resolves "/fn quarantine.list" and the clause executes', async () => {
    const result = await ask('/fn quarantine.list')

    expect(result.status).toBe('completed')
    expect(result.receipts).toHaveLength(1)
    // The id is IMPORTED, never a literal: an op renamed at its declaration must break this
    // assertion rather than leave it agreeing with a string nothing dispatches any more.
    expect(result.receipts[0]).toMatchObject({
      clause: '/fn quarantine.list',
      functionId: QUARANTINE_LIST_FUNCTION_ID,
      status: 'executed',
      // A stage-1 table hit is a person typing, so the composition mints `human` for it.
      origin: 'human',
    })
    expect(result.unhandled).toBeUndefined()
  })

  it('the turn is on disk as JSONL with a versioned header and a boundary marker', async () => {
    const result = await ask('/fn quarantine.list')
    const lines = sessionLines(result.sessionId)

    const header = JSON.parse(lines[0]!) as ChatSessionHeader
    expect(header.schemaVersion).toBe(CURRENT_CHAT_SESSION_SCHEMA_VERSION)
    expect(header.sessionId).toBe(result.sessionId)

    const events = lines.slice(1).map((line) => JSON.parse(line) as ChatSessionEvent)
    expect(events.map((event) => event.kind)).toEqual([
      'user_message',
      'stage_outcome',
      'stage_outcome',
      'stage_outcome',
      // The masked result lands just before its receipt: `clause_result`, then `clause_receipt`.
      'clause_result',
      'clause_receipt',
      'turn_complete',
    ])
    // The planner is skipped, not asked and not failed: a canonical utterance never reaches it.
    expect(
      events
        .filter((event) => event.kind === 'stage_outcome')
        .map((event) => [event.stage, event.outcome]),
    ).toEqual([
      ['resolver', 'resolved'],
      ['planner', 'skipped'],
      ['reconcile', 'resolved'],
    ])
    // The boundary marker is LAST, which is what makes this turn non-dangling on reopen.
    expect(events[events.length - 1]).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
      turnId: result.turnId,
    })
    // The receipt summarises; the op's payload stays in its store, so the payload key is absent.
    const receipt = events.find((event) => event.kind === 'clause_receipt')
    expect(receipt).toMatchObject({ functionId: QUARANTINE_LIST_FUNCTION_ID, origin: 'human' })
    expect(JSON.stringify(receipt)).not.toContain('"entries":')
  })

  it('an unroutable clause with no planner bound fails the turn closed', async () => {
    const result = await ask('write a test for two factor auth')

    expect(result.status).toBe('fail_closed')
    // Nothing ran, not merely the failing clause.
    expect(result.receipts.filter((receipt) => receipt.status === 'executed')).toHaveLength(0)
    expect(result.unhandled?.clause).toBe('write a test for two factor auth')
    // The message names what could not be done; a bare refusal would be a silent drop.
    expect(result.unhandled?.reason).toContain('write a test for two factor auth')
  })

  it('a second turn appends to the same session rather than rewriting it', async () => {
    const first = await ask('/fn quarantine.list')
    const afterFirst = sessionLines(first.sessionId)

    const second = await ask('/fn quarantine.list', first.sessionId)
    expect(second.sessionId).toBe(first.sessionId)

    const afterSecond = sessionLines(first.sessionId)
    // Append-only, asserted as a PREFIX rather than as a length: a rewrite that happened to
    // produce more lines would satisfy a count and fail this.
    expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst)
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length)
  })

  it('an unknown session id is a typed refusal, never a fresh create', async () => {
    await expect(ask('/fn quarantine.list', 'chat-19700101-000000-zzzz')).rejects.toThrow(
      /chat-19700101-000000-zzzz/,
    )
  })
})
