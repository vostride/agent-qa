// A header records the toolset hash, not its ids, so a drift found on reopen has empty deltas.

import { describe, expect, it } from 'vitest'

import { CURRENT_CHAT_SESSION_SCHEMA_VERSION, guardChatSessionEvent } from '@vostride/agent-qa-schema'
import type { ChatSessionEvent, ChatSessionHeader } from '@vostride/agent-qa-schema'

import { diffChatConfig, foldChatConfigState } from '../config-drift.js'
import type { ChatConfigState } from '../config-drift.js'

const STAMP = { turnId: 'turn-1', at: '1970-01-01T00:00:01.000Z', source: 'config_reread' } as const

function state(model: string, hash: string, ids?: readonly string[]): ChatConfigState {
  return { model, toolset: ids === undefined ? { hash } : { hash, ids } }
}

function header(overrides: Partial<ChatSessionHeader> = {}): ChatSessionHeader {
  return {
    schemaVersion: CURRENT_CHAT_SESSION_SCHEMA_VERSION,
    sessionId: 'chat-1',
    createdAt: '1970-01-01T00:00:00.000Z',
    model: 'fixture-a',
    toolsetHash: 'hash-a',
    ...overrides,
  }
}

/** Every produced event must survive the reopen guard, so this is applied to all of them. */
function guarded(events: readonly ChatSessionEvent[]): ChatSessionEvent[] {
  return events.map((event) =>
    guardChatSessionEvent(event, CURRENT_CHAT_SESSION_SCHEMA_VERSION),
  )
}

describe('diffChatConfig: what the session re-read found', () => {
  it('emits nothing when nothing drifted', () => {
    expect(diffChatConfig(state('m', 'h', ['a']), state('m', 'h', ['a']), STAMP)).toEqual([])
  })

  it('emits model_change with from/to when the model drifted', () => {
    const events = guarded(diffChatConfig(state('m1', 'h'), state('m2', 'h'), STAMP))

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'model_change',
      turnId: 'turn-1',
      at: '1970-01-01T00:00:01.000Z',
      from: 'm1',
      to: 'm2',
      source: 'config_reread',
    })
  })

  it('carries the verb source when a directive set the model rather than a file', () => {
    const events = diffChatConfig(state('m1', 'h'), state('m2', 'h'), { ...STAMP, source: 'verb' })

    expect(events[0]).toMatchObject({ kind: 'model_change', source: 'verb' })
  })

  it('names added and removed ids when both sides are known', () => {
    const events = guarded(
      diffChatConfig(
        state('m', 'h1', ['runs.list', 'runs.start']),
        state('m', 'h2', ['runs.list', 'tests.write']),
        STAMP,
      ),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'active_tools_change',
      turnId: 'turn-1',
      at: '1970-01-01T00:00:01.000Z',
      addedIds: ['tests.write'],
      removedIds: ['runs.start'],
      toolsetHash: 'h2',
    })
  })

  it('still reports drift when the previous id set was never recorded, with empty deltas', () => {
    const events = guarded(
      diffChatConfig(state('m', 'h1'), state('m', 'h2', ['runs.list']), STAMP),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'active_tools_change',
      addedIds: [],
      removedIds: [],
      toolsetHash: 'h2',
    })
  })

  it('reports both drifts, model first', () => {
    const events = diffChatConfig(
      state('m1', 'h1', ['a']),
      state('m2', 'h2', ['b']),
      STAMP,
    )

    expect(events.map((event) => event.kind)).toEqual(['model_change', 'active_tools_change'])
  })

  it('emits no toolset event when the ids were merely reordered under one hash', () => {
    // The HASH is the identity, not the array order: the composition sorts before hashing, so a
    // walk that came back in a different order is not a change and must not read as one.
    expect(
      diffChatConfig(state('m', 'h', ['a', 'b']), state('m', 'h', ['b', 'a']), STAMP),
    ).toEqual([])
  })
})

describe('foldChatConfigState: what the session last recorded', () => {
  it('answers the header when no drift has been logged', () => {
    expect(foldChatConfigState(header(), [])).toEqual({
      model: 'fixture-a',
      toolset: { hash: 'hash-a' },
    })
  })

  it('answers the LATEST model_change, not the first', () => {
    const events: ChatSessionEvent[] = [
      { kind: 'model_change', turnId: 't1', at: 'x', from: 'fixture-a', to: 'fixture-b', source: 'config_reread' },
      { kind: 'model_change', turnId: 't2', at: 'y', from: 'fixture-b', to: 'fixture-c', source: 'verb' },
    ]

    expect(foldChatConfigState(header(), events).model).toBe('fixture-c')
  })

  it('answers the latest toolset hash', () => {
    const events: ChatSessionEvent[] = [
      { kind: 'active_tools_change', turnId: 't1', at: 'x', addedIds: [], removedIds: [], toolsetHash: 'hash-b' },
    ]

    expect(foldChatConfigState(header(), events).toolset).toEqual({ hash: 'hash-b' })
  })

  it('never claims to know the previous id set — the header records a hash only', () => {
    // The honest half of the unknown-deltas arm above, asserted where the ignorance originates.
    expect(foldChatConfigState(header(), []).toolset.ids).toBeUndefined()
  })

  it('ignores events that are not config drift', () => {
    const events: ChatSessionEvent[] = [
      { kind: 'user_message', turnId: 't1', at: 'x', text: 'proposals' },
      { kind: 'turn_complete', turnId: 't1', at: 'y', status: 'completed' },
    ]

    expect(foldChatConfigState(header(), events)).toEqual({
      model: 'fixture-a',
      toolset: { hash: 'hash-a' },
    })
  })
})
