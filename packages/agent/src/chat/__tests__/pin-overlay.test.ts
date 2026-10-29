// there is no session pin overlay.
//
// RE-SPELLED 2026-10-01. This file pinned the `/pin` holder's contract:
// normalisation to the `fn:` spelling, the unknown-class refusal, the live gate predicate and the
// tighten-only member set. 432-13 removed `/pin` from chat resolution together with the op gate it
// tightened, and 432-18 deletes the holder (`agent/src/chat/pin-overlay.ts`), its schema predicate
// (`schema/src/chat/pin-overlay.ts`) and the chat state's pin field. Every one of those claims lost
// its subject; what survives is the absence:
//
//   - neither module exists and no barrel publishes a pin member at runtime,
//   - a session's chat state carries no pin set,
//   - `/pin <class>` follows the ordinary unknown-directive behaviour: the resolver answers it
//     exactly as it answers a directive nobody ever declared, and it binds no op, so the turn
//     engine hands it to the planner like any other clause stage 1 leaves unresolved,
//   - the resolver keys that remain are the ones a session still has.
//
// Independent chat session concurrency and clause receipt ordering are measured where sessions run
// (agent-local `chat-session-isolation.e2e.test.ts`, `chat-directives-hermetic.e2e.test.ts`).

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as schema from '@vostride/agent-qa-schema'

import * as agent from '../../index.js'
import { createChatState } from '../chat-state.js'
import { CHAT_RESOLVER_TABLE, resolveClause } from '../resolver-table.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT_PIN_MODULE = join(HERE, '..', 'pin-overlay.ts')
const SCHEMA_PIN_MODULE = join(HERE, '..', '..', '..', '..', 'schema', 'src', 'chat', 'pin-overlay.ts')

/** The runtime members the holder and its predicate published. */
const RETIRED_AGENT_PIN_EXPORTS = ['ChatPinError', 'createPinOverlay', 'PIN_ACTION_CLASS_PREFIX'] as const
const RETIRED_SCHEMA_PIN_EXPORTS = ['pinDenies'] as const

/** A directive spelling no version of the table ever declared — the ordinary unknown directive. */
const NEVER_DECLARED = '/frobnicate'

describe('the session pin overlay is gone', () => {
  it('the holder and its schema predicate are deleted', () => {
    // The control: the directory the holder lived in is the one this file sits under.
    expect(existsSync(join(HERE, '..', 'resolver-table.ts'))).toBe(true)
    expect(existsSync(AGENT_PIN_MODULE), 'agent/src/chat/pin-overlay.ts is still present').toBe(false)
    expect(existsSync(SCHEMA_PIN_MODULE), 'schema/src/chat/pin-overlay.ts is still present').toBe(false)
  })

  it('neither barrel publishes a pin member at runtime', () => {
    const agentKeys = new Set(Object.keys(agent))
    const schemaKeys = new Set(Object.keys(schema))
    expect(agentKeys.size, 'the agent barrel is empty, so the census would be vacuous').toBeGreaterThan(0)
    expect(RETIRED_AGENT_PIN_EXPORTS.filter((name) => agentKeys.has(name)), 'agent barrel').toEqual([])
    expect(RETIRED_SCHEMA_PIN_EXPORTS.filter((name) => schemaKeys.has(name)), 'schema barrel').toEqual([])
    expect([...agentKeys].filter((name) => /pin(overlay|error|_action)/i.test(name))).toEqual([])
  })

  it('a session chat state carries no pin set and no way to record one', () => {
    const state = createChatState({ activeModel: 'unbound' })
    expect(Object.keys(state.read()).sort()).toEqual(['activeModel', 'closing', 'conversation'])
    expect(Object.keys(state).sort()).toEqual([
      'beginTurn', 'endTurn', 'read', 'requestClose', 'setActiveModel', 'setConversation',
    ])
  })

  it('/pin resolves exactly as a directive nobody declared, binding no op', () => {
    for (const argument of ['fn:runs.start', 'runs.start', 'config-write', '']) {
      const pin = resolveClause(CHAT_RESOLVER_TABLE, `/pin ${argument}`.trim())
      const unknown = resolveClause(CHAT_RESOLVER_TABLE, `${NEVER_DECLARED} ${argument}`.trim())
      expect(pin, `/pin ${argument}`).toEqual(unknown)
      expect(pin).toEqual({ kind: 'unresolved' })
    }
  })

  // 432-18 task 2: spelling edges. None of them is a near-miss for a pin any more — each is the
  // same unresolved clause a directive nobody declared is.
  it('case, whitespace and suffix variants of /pin resolve as unknown directives too', () => {
    for (const clause of ['/PIN fn:runs.start', '/Pin runs.list', '/pin\tfn:runs.start', '  /pin  fn:runs.list  ', '/pinned fn:runs.start', '/pin/fn:runs.start']) {
      expect(resolveClause(CHAT_RESOLVER_TABLE, clause), JSON.stringify(clause)).toEqual({ kind: 'unresolved' })
    }
  })

  it('no resolver row is keyed on a pin', () => {
    const aliases = CHAT_RESOLVER_TABLE.map((row) => row.alias)
    expect(aliases.length, 'the resolver table is empty, so the absence would be vacuous').toBeGreaterThan(0)
    expect(aliases.filter((alias) => /^\/?pin$/.test(alias))).toEqual([])
    // The surviving directive still resolves, so the table is the live one.
    expect(resolveClause(CHAT_RESOLVER_TABLE, '/model claude-fast').kind).not.toBe('unresolved')
  })
})
