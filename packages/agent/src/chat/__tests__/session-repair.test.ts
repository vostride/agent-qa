// A torn final line is a crash's expected cost; a mid-file line that fails its guard is damage.

import { describe, expect, it } from 'vitest'

import { CURRENT_CHAT_SESSION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

import {
  repairSession,
  replaySession,
} from '../session-repair.js'
import type { SessionLogLine } from '../session-repair.js'

const VERSION = CURRENT_CHAT_SESSION_SCHEMA_VERSION
const NOW = '2026-08-09T12:00:00.000Z'
const now = (): string => NOW

function at(turnId: string): { turnId: string; at: string } {
  return { turnId, at: '2026-08-09T11:59:00.000Z' }
}

const USER_1 = { kind: 'user_message', ...at('t1'), text: 'proposals' }
const RECEIPT_1 = {
  kind: 'clause_receipt',
  ...at('t1'),
  clause: 'proposals',
  functionId: 'proposals.list',
  origin: 'human',
  status: 'executed',
  outcome: 'proposals.list completed',
}
const DONE_1 = { kind: 'turn_complete', ...at('t1'), status: 'completed' }
const USER_2 = { kind: 'user_message', ...at('t2'), text: 'run test 42' }
const RECEIPT_2 = {
  kind: 'clause_receipt',
  ...at('t2'),
  clause: 'run test 42',
  functionId: 'runs.start',
  origin: 'human',
  status: 'executed',
  outcome: 'runs.start completed',
}

/** Event lines start at 2, because line 1 of a session file is its header. */
function linesOf(...events: readonly unknown[]): SessionLogLine[] {
  return events.map((event, index) => ({
    lineNumber: index + 2,
    text: JSON.stringify(event),
  }))
}

function raw(lineNumber: number, text: string): SessionLogLine {
  return { lineNumber, text }
}

describe('a session that closed cleanly needs no repair', () => {
  it('hands back exactly what was written, synthesizing nothing', () => {
    const repair = repairSession(linesOf(USER_1, RECEIPT_1, DONE_1), {
      declaredVersion: VERSION,
      now,
    })

    expect(repair.repaired).toEqual([USER_1, RECEIPT_1, DONE_1])
    expect(repair.synthesized).toEqual([])
    expect(repair.refusedLines).toEqual([])
    expect(repair.tornTail).toBeUndefined()
  })

  it('treats an empty log as a session with no turn in flight', () => {
    const repair = repairSession([], { declaredVersion: VERSION, now })

    expect(repair.repaired).toEqual([])
    expect(repair.synthesized).toEqual([])
  })
})

describe('a torn FINAL line is skipped, reported, and never thrown over', () => {
  it('drops the truncated tail and names the line it dropped', () => {
    const lines = [...linesOf(USER_1, RECEIPT_1, DONE_1, USER_2), raw(6, '{"kind":"clause_rec')]
    const repair = repairSession(lines, { declaredVersion: VERSION, now })

    expect(repair.tornTail?.lineNumber).toBe(6)
    expect(repair.refusedLines).toEqual([])
    expect(repair.repaired.slice(0, 4)).toEqual([USER_1, RECEIPT_1, DONE_1, USER_2])
  })

  it('and the turn the tear interrupted is closed by a synthesized abort', () => {
    const lines = [...linesOf(USER_1, DONE_1, USER_2), raw(5, '{"kind":"clause_rec')]
    const repair = repairSession(lines, { declaredVersion: VERSION, now })

    expect(repair.synthesized).toEqual([
      { kind: 'aborted', turnId: 't2', at: NOW, source: 'synthesized' },
    ])
  })

  it('refuses a mid-file unparseable line and keeps folding its neighbours', () => {
    const lines = [
      ...linesOf(USER_1),
      raw(3, '{"kind":"clause_rec'),
      ...linesOf(DONE_1).map((line) => ({ ...line, lineNumber: 4 })),
    ]
    const repair = repairSession(lines, { declaredVersion: VERSION, now })

    expect(repair.tornTail).toBeUndefined()
    expect(repair.refusedLines.map((line) => line.lineNumber)).toEqual([3])
    expect(repair.repaired).toEqual([USER_1, DONE_1])
  })

  it('refuses a final line that PARSES and fails the guard — that is damage, not a tear', () => {
    const lines = [
      ...linesOf(USER_1, DONE_1),
      raw(4, JSON.stringify({ kind: 'not_a_kind', turnId: 't9', at: NOW })),
    ]
    const repair = repairSession(lines, { declaredVersion: VERSION, now })

    expect(repair.tornTail).toBeUndefined()
    expect(repair.refusedLines.map((line) => line.lineNumber)).toEqual([4])
    expect(repair.refusedLines[0]?.reason).toContain('not_a_kind')
  })

  it('synthesizes nothing when every line was refused — there is no turn to close', () => {
    const repair = repairSession([raw(2, 'not json'), raw(3, 'also not json')], {
      declaredVersion: VERSION,
      now,
    })

    expect(repair.repaired).toEqual([])
    expect(repair.synthesized).toEqual([])
  })
})

describe('a DANGLING turn is closed by a synthesized abort (arm two)', () => {
  it('synthesizes for a turn whose last event is not a boundary', () => {
    const repair = repairSession(linesOf(USER_1, DONE_1, USER_2, RECEIPT_2), {
      declaredVersion: VERSION,
      now,
    })

    expect(repair.synthesized).toEqual([
      { kind: 'aborted', turnId: 't2', at: NOW, source: 'synthesized' },
    ])
    expect(repair.repaired.at(-1)).toEqual(repair.synthesized[0])
  })

  // The graceful arm. A process that was alive enough to handle Ctrl+C wrote its own `aborted`,
  // and the two sources stay distinguishable forever: one says a person stopped, the other says a
  // machine died.
  it('leaves an EXPLICIT abort alone — the graceful Ctrl+C arm needs no repair', () => {
    const explicit = { kind: 'aborted', ...at('t2'), source: 'explicit' }
    const repair = repairSession(linesOf(USER_1, DONE_1, USER_2, explicit), {
      declaredVersion: VERSION,
      now,
    })

    expect(repair.synthesized).toEqual([])
    expect(repair.repaired.at(-1)).toEqual(explicit)
  })

  it('is IDEMPOTENT: repairing an already-repaired log synthesizes nothing further', () => {
    const first = repairSession(linesOf(USER_1, DONE_1, USER_2), {
      declaredVersion: VERSION,
      now,
    })
    expect(first.synthesized).toHaveLength(1)

    const second = repairSession(linesOf(USER_1, DONE_1, USER_2, ...first.synthesized), {
      declaredVersion: VERSION,
      now,
    })
    expect(second.synthesized).toEqual([])
    expect(second.repaired).toHaveLength(4)
  })

  // APPEND-ONLY, restated as an assertion about the result: everything that was on the file is
  // still there, in order, and the only new records sit at the end.
  it('only ever APPENDS: the surviving lines keep their order and nothing is rewritten', () => {
    const repair = repairSession(linesOf(USER_1, RECEIPT_1, DONE_1, USER_2), {
      declaredVersion: VERSION,
      now,
    })

    expect(repair.repaired.slice(0, 4)).toEqual([USER_1, RECEIPT_1, DONE_1, USER_2])
    expect(repair.repaired.slice(4)).toEqual(repair.synthesized)
  })
})

describe('the declared version travels as an argument and is asked BEFORE any shape question', () => {
  // The header states the version once, so it reaches the guard as an argument, not a field.
  it('names the VERSION, not a field, when a foreign-version log carries malformed bytes', () => {
    const repair = repairSession([raw(2, JSON.stringify({ kind: 'nonsense' }))], {
      declaredVersion: 99,
      now,
    })

    expect(repair.repaired).toEqual([])
    expect(repair.refusedLines[0]?.reason).toContain('99')
    expect(repair.refusedLines[0]?.reason).not.toContain('nonsense')
  })
})

describe('replay rebuilds the live conversation, and only from repaired events', () => {
  it('renders the user text verbatim and every receipt as a one-liner', () => {
    const repair = repairSession(linesOf(USER_1, RECEIPT_1, DONE_1), {
      declaredVersion: VERSION,
      now,
    })
    const replay = replaySession(repair.repaired)

    expect(replay.messages).toEqual([
      { role: 'user', text: 'proposals', turnId: 't1' },
      { role: 'assistant', text: 'proposals.list: proposals.list completed', turnId: 't1' },
    ])
    expect(replay.abortedTurnIds).toEqual([])
  })

  it('excludes an aborted turn entirely — a question nobody answered is not context', () => {
    const repair = repairSession(linesOf(USER_1, RECEIPT_1, DONE_1, USER_2, RECEIPT_2), {
      declaredVersion: VERSION,
      now,
    })
    const replay = replaySession(repair.repaired)

    expect(replay.abortedTurnIds).toEqual(['t2'])
    expect(replay.messages.map((message) => message.turnId)).toEqual(['t1', 't1'])
  })

  // Replay over raw events keeps the dangling turn's work, so repair must run before pruning.
  it('sees a different conversation before repair than after, so the order is not decoration', () => {
    const lines = linesOf(USER_1, DONE_1, USER_2, RECEIPT_2)
    const repair = repairSession(lines, { declaredVersion: VERSION, now })

    const beforeRepair = replaySession(
      lines.map((line) => JSON.parse(line.text) as never),
    )
    const afterRepair = replaySession(repair.repaired)

    expect(beforeRepair.messages.map((message) => message.turnId)).toEqual(['t1', 't2', 't2'])
    expect(afterRepair.messages.map((message) => message.turnId)).toEqual(['t1'])
  })

  it('renders an unhandled clause as its reason, so a resumed session knows what was refused', () => {
    const unhandled = {
      kind: 'mark_unhandled',
      ...at('t1'),
      clause: 'write a test for 2FA',
      reason: 'no capability in this build authors tests',
    }
    const replay = replaySession(
      repairSession(linesOf(USER_1, unhandled, DONE_1), { declaredVersion: VERSION, now })
        .repaired,
    )

    expect(replay.messages.at(-1)).toEqual({
      role: 'assistant',
      text: 'no capability in this build authors tests',
      turnId: 't1',
    })
  })

  it('carries no payload body: a receipt contributes its op id and its one-liner, nothing else', () => {
    const replay = replaySession(
      repairSession(linesOf(USER_1, RECEIPT_1, DONE_1), { declaredVersion: VERSION, now })
        .repaired,
    )

    const rendered = replay.messages.map((message) => message.text).join('\n')
    expect(rendered).not.toContain('"status"')
    expect(rendered).not.toContain('clause')
  })
})
