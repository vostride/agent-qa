import { expectTypeOf, test } from 'vitest'

import type { AGENT_HOST_MEMBERS, AgentHost } from '../chat/host.js'

test('AgentHost has exactly the members AGENT_HOST_MEMBERS lists', () => {
  type Listed = (typeof AGENT_HOST_MEMBERS)[number]
  expectTypeOf<Exclude<keyof AgentHost, Listed>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Listed, keyof AgentHost>>().toEqualTypeOf<never>()
})
