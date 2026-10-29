// RE-SPELLED 2026-10-01 (432-17, D-05): `proposals.list` is deleted with the inbox. The read these
// cells drive through the composed host is now `quarantine.list`, another allow-tier read that
// answers honestly (an empty listing) in a bare temp project, so every claim keeps its subject.
// The 392 tracer: one deterministic utterance through every layer (CHAT-01 / CHAT-05 / D-24).
//
// What this file measures that no unit test can: that the WHOLE spine is joined. The op is
// registered, `chatTurn` is bound at THE composition root, the gate lets the turn through, the
// stage-1 table resolves the clause without the planner being consulted, the clause's own
// invocation crosses `invokeFunction` a second time with a composition-minted human-origin caller,
// the receipt comes back parsed against the declared output contract, and the whole turn is on
// disk as an append-only JSONL file with a versioned header.
//
// EVERY HOP GOES THROUGH `composeLocalAgent()` AND `invokeFunction`. Nothing here constructs a turn
// engine, a resolver table or a session log by hand — a differential assembled from parts can pass
// while the composition wires them wrong or not at all (the produced-not-literal law, 390 round 3).
//
// THE FAIL-CLOSED ARM IS HALF THE FILE, and it is the half that would rot first. D-08's rule is
// that an unroutable clause with no planner bound fails the turn closed NAMING the clause and
// executing NOTHING. A tracer that only proved the happy path would ship a routing layer whose
// failure mode is a silent drop, which is the exact regression CHAT-03's ceiling exists to
// measure later.

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

// 432-13 (D-05/D-14): the tracer's utterance was the bare `proposals` alias, which left chat
// resolution with the inbox. The same op is reached through the one `/fn` branch, and every claim
// below (table resolution, human origin, the durable JSONL shape, resume) is unchanged.
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
      // RESEARCH Pitfall 1: a stage-1 table hit is a person typing, so the composition mints
      // `human` for it. An `agent` here would mean the deterministic aliases had quietly lost
      // access to every `requiresHumanOrigin` op in the catalogue.
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
      // 399.1-05: the op's MASKED result lands beside its receipt, in that order — the map, then
      // the territory. The receipt is written after the loop's dispatch and this line inside it,
      // so `clause_result` precedes the `clause_receipt` it belongs to.
      'clause_result',
      'clause_receipt',
      'turn_complete',
    ])
    // The stage ledger, in the pinned order — and the middle entry is the tracer's central claim:
    // the planner was SKIPPED, not asked and not failed. `skipped` is a distinct outcome for
    // exactly this reason (D-01/D-06 — a canonical utterance never touches the LLM).
    expect(
      events
        .filter((event) => event.kind === 'stage_outcome')
        .map((event) => [event.stage, event.outcome]),
    ).toEqual([
      ['resolver', 'resolved'],
      ['planner', 'skipped'],
      ['reconcile', 'resolved'],
    ])
    // The boundary marker is LAST, which is what makes this turn non-dangling on reopen (D-19).
    expect(events[events.length - 1]).toMatchObject({
      kind: 'turn_complete',
      status: 'completed',
      turnId: result.turnId,
    })
    // D-18 map-not-territory: the receipt names the op and summarises; the op's own payload
    // (the ledger rows) stays in its store and appears nowhere in these bytes. The outcome sentence
    // says "0 quarantine entries", so the payload KEY is what is asserted absent.
    const receipt = events.find((event) => event.kind === 'clause_receipt')
    expect(receipt).toMatchObject({ functionId: QUARANTINE_LIST_FUNCTION_ID, origin: 'human' })
    expect(JSON.stringify(receipt)).not.toContain('"entries":')
  })

  it('an unroutable clause with no planner bound fails the turn closed', async () => {
    const result = await ask('write a test for two factor auth')

    expect(result.status).toBe('fail_closed')
    // D-10's exact claim: ZERO clauses executed. Not "the failing one was skipped" — nothing ran.
    expect(result.receipts.filter((receipt) => receipt.status === 'executed')).toHaveLength(0)
    expect(result.unhandled?.clause).toBe('write a test for two factor auth')
    // D-08: the message NAMES what could not be done. A fail-closed turn that said only "I
    // could not do that" would be a silent drop wearing a refusal's clothes.
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
