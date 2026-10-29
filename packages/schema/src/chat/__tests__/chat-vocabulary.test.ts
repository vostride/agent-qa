// The chat vocabulary's own corpus (Phase 392 plan 01, task 2 — D-14 / D-18 / 388 C13).
//
// Three claims, and each one exists because a different kind of drift would otherwise be silent:
//
//   1. EXHAUSTIVENESS. A total `Record<ChatSessionEventKind, …>` stops compiling the day an
//      eleventh kind is declared without somebody saying what it means. This is the `kinds.ts`
//      double-lock idiom — the compile-time half here, the runtime half in the guard below,
//      because the two catch different drifts.
//   2. THE GUARD REFUSES, BY NAME AND IN ORDER. Reopen reads untrusted bytes: a file another
//      build wrote, a line a crash tore, a hand-edited session. Every refusal is the one named
//      error class, and the VERSION question is answered before the shape question — a version
//      mismatch has a remedy an operator can act on, and reporting it as a missing field names
//      the wrong problem (the `job-checkpoint-store.ts:231-237` decision).
//   3. THE ENUMS ARE CLOSED. Receipt statuses and scenario expectations are compared as exact
//      sets, so a fourth member cannot arrive without the corpus that gives it meaning.

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
  it('D-14: every declared kind has a meaning, and the union is exactly the declared list', () => {
    expect(Object.keys(KIND_MEANING).sort()).toEqual([...CHAT_SESSION_EVENT_KINDS].sort())
    // Ten from day one, including the kinds nothing emits yet (CHAT-05 names four of them). A
    // kind declared late would make "this build does not know that kind" and "that kind did not
    // occur" the same bytes for every reader written in between.
    //
    // ELEVEN AS OF 399.1-05, and the eleventh is the one exception the day-one rule contemplates:
    // `clause_result` did not exist to be declared, because the CHANNEL it records — the turn's
    // `results[]` — was minted by 399.1's D-05. It is additive and append-only: no reader of a
    // ten-kind log sees a different byte, and no existing kind changed.
    expect(CHAT_SESSION_EVENT_KINDS).toHaveLength(11)
  })

  it('D-11 + 399.1 D-02: the receipt statuses are exactly four, closed', () => {
    // FOUR SINCE 2026-08-20, and the assertion is spelled out rather than counted for the reason it
    // always was: this is a published vocabulary, every surface renders every member, and a member
    // arriving or leaving must be a visible edit HERE and not an arithmetic change somewhere.
    //
    // `refused` is the addition (399.1 D-02) and the ORDER is part of the pin: it is appended, so
    // nothing that indexed this tuple moved. A guardrail declining an op is neither `executed` — the
    // change did not happen — nor `failed`, which sends a reader hunting a defect that is not there.
    expect([...CLAUSE_RECEIPT_STATUSES]).toEqual(['executed', 'failed', 'not-run', 'refused'])
  })

  it('399.1-03: exactly two of the four statuses mean the capability was REACHED', () => {
    // THE PREDICATE EVERY ROLL-CALL OVER THIS SET NOW ASKS, pinned exhaustively over the set itself
    // rather than over a list somebody typed — so a FIFTH member arriving lands in one of these two
    // buckets by somebody's decision, and cannot join silently on whichever side the `||` chain
    // happens to put it.
    //
    // IT MATTERS BECAUSE A ROLL-CALL SPELLED OVER `executed` ALONE WENT BLIND THE DAY `refused`
    // LANDED. D-10's atomicity claim is that a fail-closed turn carried nothing out, and both
    // scenario runners checked it as "no receipt says executed" — a complete statement of it only
    // while `executed` was the only word for a clause that ran and returned. An op that reached its
    // capability and declined files a blocked proposal on the way, and that row was invisible.
    const reached = CLAUSE_RECEIPT_STATUSES.filter((status) => clauseReachedCapability(status))
    const unreached = CLAUSE_RECEIPT_STATUSES.filter((status) => !clauseReachedCapability(status))

    expect([...reached]).toEqual(['executed', 'refused'])
    // Stated positively too: `failed` is ambiguous between a gate refusal and a mid-flight throw,
    // and `not-run` is the one member that unambiguously means nothing happened. Neither may claim
    // to answer a question the vocabulary cannot answer for it.
    expect([...unreached]).toEqual(['failed', 'not-run'])
    expect(reached.length + unreached.length).toBe(CLAUSE_RECEIPT_STATUSES.length)
  })

  it('CHAT-02: a scenario expects one of exactly two things', () => {
    expect([...SCENARIO_EXPECTATIONS]).toEqual(['should_execute', 'fail_closed'])
  })

  it('CHAT-01/precision: no member of the vocabulary carries a fractional confidence', () => {
    // Stage-1 resolution is BINARY by construction (D-09): an exact predicate hit or nothing. A
    // confidence field anywhere in this vocabulary would be the first half of a threshold, and a
    // threshold is how an overriding path acquires a false-positive rate.
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

  it('D-18: accepts every kind this vocabulary declares, so the guard is not a four-kind guard', () => {
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
        // 392 plan 08: `gate` is a person answering the inline confirm; `verb` is a person typing
        // `/pin`. Both decide about one class, and collapsing them would leave a reviewer unable
        // to tell a refusal of one request from a standing rule set in advance.
        source: 'gate',
      },
      clause_result: {
        kind: 'clause_result',
        turnId: 't',
        at: AT,
        functionId: 'proposals.list',
        // THE MASKED PAYLOAD, which is the whole of what this kind promises at rest (399.1-05,
        // `.planning/phases/399.1-chat-render-contract/399.1-ADJUDICATION-transcript-cleartext.md`).
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

// 432-13 (D-14/D-22): no turn writes an `approval_decision` any more — the chat confirm and the
// `/pin` verb that wrote them are gone from chat resolution. A session a person kept from before
// still reopens: both historical sources parse, in order, beside the events a turn writes today.
describe('C432-HISTORICAL-READER — pre-432 approval rows still read (432-13)', () => {
  it('C432-HISTORICAL-READER: a pre-432 session line of each approval source and decision parses unchanged', () => {
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
    // The kind stays declared, so a reader that folds it keeps compiling (D-22).
    expect(CHAT_SESSION_EVENT_KINDS).toContain('approval_decision')
  })

  // 432-42 (D-22): the reader stays and the WRITER does not. Every production source of the packages
  // that compose or run a chat turn is read, and no code line builds an event of the kind; a line
  // that only mentions it in a comment is not a writer.
  it('C432-HISTORICAL-READER: no production source of a turn-writing package builds an approval event', () => {
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

// RE-SPELLED 2026-10-01 (432-18, D-14): 'the pin overlay denies, and only denies (D-21)' pinned
// `pinDenies` over `ChatPinOverlay`. Both are deleted with the session pin overlay; the absence is
// checked here and by the agent's `chat/__tests__/pin-overlay.test.ts`. The historical `/pin` row
// (`source: 'verb'`) still parses, above.
describe('C432-PIN-ABSENT: the schema publishes no pin predicate (432-18)', () => {
  it('C432-PIN-ABSENT: no pin member is exported beside the session vocabulary', async () => {
    const barrel = await import('../index') as Record<string, unknown>
    expect(Object.keys(barrel).filter((name) => /^pin|pinOverlay/i.test(name))).toEqual([])
    expect(barrel['guardChatSessionEvent']).toBeTypeOf('function')
  })
})

describe('the scenario contract (CHAT-02)', () => {
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

  it('D-10: a fail_closed scenario can pin executed == 0 and name the clause', () => {
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
