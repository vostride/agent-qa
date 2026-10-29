import { expectTypeOf, test } from 'vitest'

import type { ComposeLocalAgentInput } from '../compose-local-agent.js'

test('ComposeLocalAgentInput keeps the CLI chat and ask options', () => {
  type Kept = 'observeSessionEvent'
  expectTypeOf<Extract<keyof ComposeLocalAgentInput, Kept>>().toEqualTypeOf<Kept>()
})
