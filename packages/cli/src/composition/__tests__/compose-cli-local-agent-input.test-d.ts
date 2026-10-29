import { expectTypeOf, test } from 'vitest'

import type { ComposeCliLocalAgentInput } from '../local-agent-host.js'

test('C430-NO-SESSION-SURFACE-OPTION: ComposeCliLocalAgentInput keeps the CLI chat and ask options', () => {
  type Kept = 'observeSessionEvent'
  expectTypeOf<Extract<keyof ComposeCliLocalAgentInput, Kept>>().toEqualTypeOf<Kept>()
})
