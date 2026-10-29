import { expectTypeOf, test } from 'vitest'

import type { ComposeLocalAgentInput } from '../compose-local-agent.js'

test('C430-NO-SESSION-SURFACE-OPTION: ComposeLocalAgentInput keeps the CLI chat and ask options', () => {
  type Kept = 'observeSessionEvent'
  expectTypeOf<Extract<keyof ComposeLocalAgentInput, Kept>>().toEqualTypeOf<Kept>()
})
