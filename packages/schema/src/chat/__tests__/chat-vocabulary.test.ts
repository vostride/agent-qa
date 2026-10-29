import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CHAT_SESSION_EVENT_KINDS,
  CLAUSE_RECEIPT_STATUSES,
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  ChatSessionEventSchemaError,
  ChatScenarioSchema,
  SCENARIO_EXPECTATIONS,
  clauseReachedCapability,
  guardChatSessionEvent,
} from '../index'
import type { ChatSessionEvent, ChatSessionEventKind } from '../index'

/**
 * The total map: one sentence per kind, and the day an eleventh kind is declared this stops
 * compiling until it has one too. It is `satisfies` rather than an annotation so the literal keeps
 * its own literal type while still being checked for totality.
 */
const KIND_MEANING = {
  user_message: 'what the person typed',
  stage_outcome: 'which stage answered, and how',
  clause_receipt: 'one clause through the function layer',
  clause_result: 'what one clause\'s op returned, MASKED',
  approval_decision: 'what a person answered at an ask-tier gate',
  mark_unhandled: 'a clause nothing in this build handles',
  model_change: 'the session model changed',
  active_tools_change: 'the reachable toolset changed',
  compaction: 'the degrade pass ran',
  aborted: 'a turn ended without completing',
  turn_complete: 'the fsync boundary marker',
} satisfies Record<ChatSessionEventKind, string>

const AT = '2026-08-09T00:00:00.000Z'

function userMessage(): ChatSessionEvent {
  return { kind: 'user_message', turnId: 'turn-1', at: AT, text: 'proposals' }
}

describe('the chat session event vocabulary is closed and total', () => {
  it('every declared kind has a meaning, and the union is exactly the declared list', () => {
    expect(Object.keys(KIND_MEANING).sort()).toEqual([...CHAT_SESSION_EVENT_KINDS].sort())
    expect(CHAT_SESSION_EVENT_KINDS).toHaveLength(11)
  })

  it('the receipt statuses are exactly four, closed', () => {
    // The order is part of the contract: an index into this tuple must stay valid.
    expect([...CLAUSE_RECEIPT_STATUSES]).toEqual(['executed', 'failed', 'not-run', 'refused'])
  })

  it('exactly two of the four statuses mean the capability was REACHED', () => {
    // Pinned over the whole set, so a new status lands in one bucket by decision, not by default.
    const reached = CLAUSE_RECEIPT_STATUSES.filter((status) => clauseReachedCapability(status))
    const unreached = CLAUSE_RECEIPT_STATUSES.filter((status) => !clauseReachedCapability(status))

    expect([...reached]).toEqual(['executed', 'refused'])
    // Stated positively too: `failed` is ambiguous between a gate refusal and a mid-flight throw,
    // and `not-run` is the one member that unambiguously means nothing happened. Neither may claim
    // to answer a question the vocabulary cannot answer for it.
    expect([...unreached]).toEqual(['failed', 'not-run'])
    expect(reached.length + unreached.length).toBe(CLAUSE_RECEIPT_STATUSES.length)
  })

  it('a scenario expects one of exactly two things', () => {
    expect([...SCENARIO_EXPECTATIONS]).toEqual(['should_execute', 'fail_closed'])
  })

  it('no member of the vocabulary carries a fractional confidence', () => {
    // Stage-1 resolution is binary, so no confidence field may appear anywhere in this vocabulary.
    const spelled = JSON.stringify({
      kinds: CHAT_SESSION_EVENT_KINDS,
      statuses: CLAUSE_RECEIPT_STATUSES,
      expectations: SCENARIO_EXPECTATIONS,
      scenario: Object.keys(ChatScenarioSchema.shape),
    })
    expect(spelled).not.toMatch(/confidence|score|threshold/i)
  })
})

describe('guardChatSessionEvent refuses untrusted bytes by name', () => {
  it('accepts an event this build wrote', () => {
    expect(guardChatSessionEvent(userMessage(), CURRENT_CHAT_SESSION_SCHEMA_VERSION))
      .toEqual(userMessage())
  })

  it('checks the VERSION before the shape — the order is the remedy', () => {
    const wrongVersion = CURRENT_CHAT_SESSION_SCHEMA_VERSION + 1
    // Well-formed bytes, wrong version: refused.
    expect(() => guardChatSessionEvent(userMessage(), wrongVersion))
      .toThrow(ChatSessionEventSchemaError)
    // MALFORMED bytes AND the wrong version: the message names the VERSION, not the field. If
    // shape were checked first this would complain about `kind` and send an operator to repair a
    // line whose real problem is that another build wrote it.
    const thrown = (() => {
      try {
        guardChatSessionEvent({ nonsense: true }, wrongVersion)
        return undefined
      } catch (error) {
        return error as Error
      }
    })()
    expect(thrown).toBeInstanceOf(ChatSessionEventSchemaError)
    expect(thrown?.message).toContain(String(wrongVersion))
  })

  it('refuses an EXTRA key — presence checks admit the field nobody declared', () => {
    expect(() =>
      guardChatSessionEvent(
        { ...userMessage(), smuggled: 'a payload body' },
        CURRENT_CHAT_SESSION_SCHEMA_VERSION,
      ),
    ).toThrow(ChatSessionEventSchemaError)
  })

  it('refuses a MISSING key', () => {
    const { text: _dropped, ...missing } = userMessage() as { text: string }
    expect(() => guardChatSessionEvent(missing, CURRENT_CHAT_SESSION_SCHEMA_VERSION))
      .toThrow(ChatSessionEventSchemaError)
  })

  it('refuses an unknown kind, and a line that is not an object at all', () => {
    expect(() =>
      guardChatSessionEvent(
        { kind: 'telepathy', turnId: 't', at: AT },
        CURRENT_CHAT_SESSION_SCHEMA_VERSION,
      ),
    ).toThrow(ChatSessionEventSchemaError)
    expect(() => guardChatSessionEvent('not an object', CURRENT_CHAT_SESSION_SCHEMA_VERSION))
      .toThrow(ChatSessionEventSchemaError)
  })

  it('accepts every kind this vocabulary declares, so the guard is not a four-kind guard', () => {
    const samples: Record<ChatSessionEventKind, ChatSessionEvent> = {
      user_message: userMessage(),
      stage_outcome: { kind: 'stage_outcome', turnId: 't', at: AT, stage: 'resolver', outcome: 'resolved' },
      clause_receipt: {
        kind: 'clause_receipt',
        turnId: 't',
        at: AT,
        clause: 'proposals',
        functionId: 'proposals.list',
        origin: 'human',
        status: 'executed',
        outcome: 'proposals.list completed',
      },
      approval_decision: {
        kind: 'approval_decision',
        turnId: 't',
        at: AT,
        actionClass: 'fn:proposals.accept',
        decision: 'accept',
        // `gate` is a person answering the inline confirm; `verb` is a person typing
        // `/pin`. Both decide about one class, and collapsing them would leave a reviewer unable
        // to tell a refusal of one request from a standing rule set in advance.
        source: 'gate',
      },
      clause_result: {
        kind: 'clause_result',
        turnId: 't',
        at: AT,
        functionId: 'proposals.list',
        // The payload is stored masked; that is all this kind promises at rest.
        payload: { entries: [] },
      },
      mark_unhandled: { kind: 'mark_unhandled', turnId: 't', at: AT, clause: 'write a test', reason: 'absent' },
      model_change: { kind: 'model_change', turnId: 't', at: AT, from: 'a', to: 'b', source: 'verb' },
      active_tools_change: {
        kind: 'active_tools_change',
        turnId: 't',
        at: AT,
        addedIds: ['runs.start'],
        removedIds: [],
        toolsetHash: 'deadbeefdeadbeef',
      },
      compaction: { kind: 'compaction', turnId: 't', at: AT, beforeTokens: 100, afterTokens: 50, outcome: 'degraded' },
      aborted: { kind: 'aborted', turnId: 't', at: AT, source: 'explicit' },
      turn_complete: { kind: 'turn_complete', turnId: 't', at: AT, status: 'completed' },
    }
    for (const kind of CHAT_SESSION_EVENT_KINDS) {
      expect(
        guardChatSessionEvent(samples[kind], CURRENT_CHAT_SESSION_SCHEMA_VERSION),
        kind,
      ).toEqual(samples[kind])
    }
  })
})

describe('historical approval rows still read', () => {
  it('a historical session line of each approval source and decision parses unchanged', () => {
    const historical: ChatSessionEvent[] = [
      userMessage(),
      { kind: 'approval_decision', turnId: 'turn-1', at: AT, actionClass: 'fn:runs.mark', decision: 'accept', source: 'gate' },
      { kind: 'approval_decision', turnId: 'turn-1', at: AT, actionClass: 'fn:runs.mark', decision: 'accept-always', source: 'gate' },
      { kind: 'approval_decision', turnId: 'turn-1', at: AT, actionClass: 'fn:runs.start', decision: 'deny', source: 'gate' },
      { kind: 'approval_decision', turnId: 'turn-1', at: AT, actionClass: 'fn:runs.start', decision: 'deny', source: 'verb' },
      { kind: 'turn_complete', turnId: 'turn-1', at: AT, status: 'completed' },
    ]
    // Read back through the one guard reopen uses, from the JSON a session file holds.
    const reread = historical.map((event) =>
      guardChatSessionEvent(JSON.parse(JSON.stringify(event)), CURRENT_CHAT_SESSION_SCHEMA_VERSION),
    )
    expect(reread).toEqual(historical)
    // The kind stays declared, so a reader that folds it keeps compiling.
    expect(CHAT_SESSION_EVENT_KINDS).toContain('approval_decision')
  })

  // A line that only mentions the kind in a comment is not a writer.
  it('no production source of a turn-writing package builds an approval event', () => {
    const packagesDir = fileURLToPath(new URL('../../../../', import.meta.url))
    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path)
        } else if (/\.tsx?$/u.test(entry.name) && !/\.test(-d)?\.tsx?$/u.test(entry.name)) sources.push(path)
      }
    }
    for (const name of ['agent', 'agent-local', 'cli', 'dashboard-server', 'mcp', 'schema']) walk(join(packagesDir, name, 'src'))
    expect(sources.length, 'the writer census read nothing').toBeGreaterThan(500)
    const writer = /kind:\s*['"]approval_decision['"]/u
    const writers = sources.flatMap((path) => readFileSync(path, 'utf8').split('\n').flatMap((line, index) => {
      const code = line.replace(/\/\/.*$/u, '').replace(/^\s*\*.*$/u, '')
      return writer.test(code) ? [`${path}:${index + 1}: ${line.trim()}`] : []
    }))
    expect(writers, `an approval event writer returned:\n${writers.join('\n')}`).toEqual([])
    // Positive control: the census finds a writer when one is planted.
    expect(writer.test("append({ kind: 'approval_decision', turnId })")).toBe(true)
  })
})

describe('the schema publishes no pin predicate', () => {
  it('no pin member is exported beside the session vocabulary', async () => {
    const barrel = await import('../index') as Record<string, unknown>
    expect(Object.keys(barrel).filter((name) => /^pin|pinOverlay/i.test(name))).toEqual([])
    expect(barrel['guardChatSessionEvent']).toBeTypeOf('function')
  })
})

describe('the scenario contract', () => {
  it('validates a YAML-shaped scenario and rejects an unknown expectation', () => {
    const parsed = ChatScenarioSchema.parse({
      id: 'proposals-alias',
      class: 'deterministic',
      lane: 'hermetic',
      utterance: 'proposals',
      expect: { kind: 'should_execute', planned: 1, executed: 1, ops: ['proposals.list'] },
    })
    expect(parsed.expect.executed).toBe(1)
    expect(() =>
      ChatScenarioSchema.parse({
        id: 'bad',
        class: 'deterministic',
        lane: 'hermetic',
        utterance: 'x',
        expect: { kind: 'probably_works', executed: 0 },
      }),
    ).toThrow()
  })

  it('a fail_closed scenario can pin executed == 0 and name the clause', () => {
    const parsed = ChatScenarioSchema.parse({
      id: 'write-test-absent',
      class: 'compound',
      lane: 'hermetic',
      utterance: 'write a test for 2FA and run it',
      expect: { kind: 'fail_closed', executed: 0, namesClause: 'write a test for 2FA' },
    })
    expect(parsed.expect).toMatchObject({ kind: 'fail_closed', executed: 0 })
  })
})
