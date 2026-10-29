// The session surface tag (Phase 400 plan 03, DASH-01 / D-04 / RESEARCH Pattern 6 / Pitfall 4).
//
// ONE SUBSTRATE, TAGGED ON THE HEADER AND NOWHERE ELSE. D-04 puts dashboard conversations on the
// exact `.agent-qa/sessions/chat-*.jsonl` log CLI chat writes, "tagged with their surface". The
// obvious spelling — a `surface` field on each event — is the one this cell exists to keep out:
// `guardChatSessionEvent` compares an EXACT key set per kind, so an extra field makes every session
// file written before the change unreadable by the build that comes after it. The header guard, by
// contrast, is presence-based and tolerates keys it does not know, which is why the tag goes there.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_SESSION_EVENT_KINDS,
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  guardChatSessionEvent,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { ChatSessionHeaderError, createJsonlSessionLog } from '../jsonl-session-log.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The session-events module, addressed from this test rather than imported — see cell 4. */
const SESSION_EVENTS_SOURCE = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'schema',
  'src',
  'chat',
  'session-events.ts',
)

const roots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-400-03-surface-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** The shipped writer, with only the fields a caller must supply pinned for determinism. */
function logOn(root: string, surface?: string) {
  let tick = 0
  return createJsonlSessionLog({
    root,
    now: () => new Date(Date.UTC(2026, 7, 21, 9, 0, tick++)).toISOString(),
    model: () => 'claude-sonnet-4-5',
    toolsetHash: () => 'toolset-400-03',
    random: () => 0.25,
    ...(surface === undefined ? {} : { surface }),
  })
}

function headerLineOf(root: string, sessionId: string): Record<string, unknown> {
  const path = join(root, 'sessions', `${sessionId}.jsonl`)
  const first = readFileSync(path, 'utf8').split('\n')[0] ?? ''
  return JSON.parse(first) as Record<string, unknown>
}

describe('the surface tag rides the session HEADER', () => {
  it('persists the tag a dashboard host stamps, and reads it back on reopen', async () => {
    const root = freshRoot()
    const log = logOn(root, 'dashboard')
    const opened = await log.open()
    const sessionId = opened.header.sessionId
    expect(opened.header.surface).toBe('dashboard')
    await opened.close()

    // ON THE BYTES, not on the object this process is holding: a tag the writer kept in memory and
    // never wrote is exactly the state a reopen would disagree with.
    expect(headerLineOf(root, sessionId).surface).toBe('dashboard')

    const reopened = await log.open(sessionId)
    expect(reopened.header.surface).toBe('dashboard')
    await reopened.close()
  })

  it('writes NO tag for a host that names no surface, as the CLI chat does', async () => {
    const root = freshRoot()
    const log = logOn(root)
    const opened = await log.open()
    const sessionId = opened.header.sessionId
    await opened.close()

    const header = headerLineOf(root, sessionId)
    // ABSENT, and absent rather than `null` or `''`: the documented meaning of an absent tag is
    // "a host that did not name its surface", which is every file written before this change and
    // every CLI chat session written after it. A key carrying an empty value would be a third state.
    expect(Object.keys(header)).not.toContain('surface')
    expect(opened.header.surface).toBeUndefined()
  })
})

describe('the session header stamp', () => {
  it('a session whose header is stamped 1 throws ChatSessionHeaderError', async () => {
    const root = freshRoot()
    const sessionId = 'chat-20260821-090000-h001'
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(
      join(root, 'sessions', `${sessionId}.jsonl`),
      `${JSON.stringify({
        schemaVersion: 1,
        sessionId,
        createdAt: '2026-08-21T09:00:00.000Z',
        model: 'claude-sonnet-4-5',
        toolsetHash: 'toolset-400-03',
      })}\n`,
      'utf8',
    )

    const opening = Promise.resolve().then(() => logOn(root).open(sessionId))
    await expect(opening).rejects.toThrow(ChatSessionHeaderError)
    await expect(opening).rejects.toThrow(/declares schemaVersion 1/)
  })
})

describe('the session EVENT grammar is untouched by the tag', () => {
  /**
   * The `EVENT_KEYS` table as it stood at `abcfe8bb`, the commit before this plan.
   *
   * A BYTE SNAPSHOT OF THE SOURCE, and it has to be the source rather than the runtime value: the
   * table is module-private on purpose (nothing outside the guard may read it), so the only way to
   * state "not one key moved" is over the text. The digest is what fails; the literal below is what
   * makes the failure readable.
   */
  const EVENT_KEYS_SNAPSHOT = `const EVENT_KEYS: Record<ChatSessionEventKind, readonly string[]> = {
  user_message: ['at', 'kind', 'text', 'turnId'],
  stage_outcome: ['at', 'kind', 'outcome', 'stage', 'turnId'],
  clause_receipt: ['at', 'clause', 'functionId', 'kind', 'origin', 'outcome', 'status', 'turnId'],
  clause_result: ['at', 'functionId', 'kind', 'payload', 'turnId'],
  approval_decision: ['actionClass', 'at', 'decision', 'kind', 'source', 'turnId'],
  mark_unhandled: ['at', 'clause', 'kind', 'reason', 'turnId'],
  model_change: ['at', 'from', 'kind', 'source', 'to', 'turnId'],
  active_tools_change: ['addedIds', 'at', 'kind', 'removedIds', 'toolsetHash', 'turnId'],
  compaction: ['afterTokens', 'at', 'beforeTokens', 'kind', 'outcome', 'turnId'],
  aborted: ['at', 'kind', 'source', 'turnId'],
  turn_complete: ['at', 'kind', 'status', 'turnId'],
}`

  const EVENT_KEYS_DIGEST = '7f6e546034789201a84addd1abbe4884'

  function extractEventKeysBlock(): string {
    const source = readFileSync(SESSION_EVENTS_SOURCE, 'utf8')
    const start = source.indexOf('const EVENT_KEYS')
    expect(start, 'the EVENT_KEYS table was not found at the path this cell reads — the assertion '
      + 'below would be about an empty string').toBeGreaterThan(-1)
    const end = source.indexOf('\n}', start)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end + 2)
  }

  it('carries the exact key table it carried before the tag landed', () => {
    const block = extractEventKeysBlock()
    expect(block).toBe(EVENT_KEYS_SNAPSHOT)
    expect(createHash('md5').update(`${block}\n`).digest('hex')).toBe(EVENT_KEYS_DIGEST)
  })

  it('refuses any event line that carries a surface key, on every kind', () => {
    for (const kind of CHAT_SESSION_EVENT_KINDS) {
      // Built from the table's OWN key set rather than from a hand-written record per kind, so a
      // kind minted later is covered the day it is declared.
      const keys = EVENT_KEYS_SNAPSHOT
        .split('\n')
        .find((line) => line.trim().startsWith(`${kind}:`))!
        .replace(/^[^[]*\[/, '')
        .replace(/\].*$/, '')
        .split(',')
        .map((key) => key.trim().replace(/'/g, ''))
      const record = Object.fromEntries(keys.map((key) => [
        key,
        key === 'kind' ? kind : key === 'at' ? '2026-08-21T09:00:00.000Z' : 'x',
      ]))

      // The control: the record the table describes is accepted, so the refusal below is about the
      // extra key and not about a record this loop built wrong.
      expect(() => guardChatSessionEvent(record, CURRENT_CHAT_SESSION_SCHEMA_VERSION)).not.toThrow()
      expect(
        () => guardChatSessionEvent(
          { ...record, surface: 'dashboard' },
          CURRENT_CHAT_SESSION_SCHEMA_VERSION,
        ),
        `a ${kind} line carrying a surface key was accepted — the tag has leaked onto the event `
        + 'grammar and every pre-400 session file is now unreadable',
      ).toThrow(/cannot be read/)
    }
  })
})
