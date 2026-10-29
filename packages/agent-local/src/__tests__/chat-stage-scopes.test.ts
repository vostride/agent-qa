// Both stage callers reach every operation, and the two are identical but for origin.

import { describe, expect, it } from 'vitest'

import {
  CHAT_PLANNER_CALLER,
  CHAT_RESOLVER_CALLER,
} from '../composition/compose-local-agent.js'
import * as agentLocal from '../index.js'

describe('chat stage callers', () => {
  it('carry no scope set, safe-mode flag, credential or session, so the chat planner reaches the authoring loop', () => {
    for (const caller of [CHAT_PLANNER_CALLER, CHAT_RESOLVER_CALLER]) {
      expect(Object.keys(caller).sort()).toEqual(['origin', 'surface'])
    }
    expect('CHAT_STAGE_SCOPES' in agentLocal, 'the scope-union grant is deleted').toBe(false)
  })

  it('mints both stage callers identical but for origin', () => {
    expect({ ...CHAT_PLANNER_CALLER, origin: 'human' }).toEqual(CHAT_RESOLVER_CALLER)
    expect(CHAT_RESOLVER_CALLER.origin).toBe('human')
    expect(CHAT_PLANNER_CALLER.origin).toBe('agent')
  })
})
