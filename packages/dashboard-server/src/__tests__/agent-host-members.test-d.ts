import { expectTypeOf, test } from 'vitest'

import type { AGENT_HOST_MEMBERS, AgentHost } from '../chat/host.js'

test('C430-AGENT-HOST-MEMBERS-EXACT', () => {
  type Listed = (typeof AGENT_HOST_MEMBERS)[number]
  expectTypeOf<Exclude<keyof AgentHost, Listed>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Listed, keyof AgentHost>>().toEqualTypeOf<never>()
})
