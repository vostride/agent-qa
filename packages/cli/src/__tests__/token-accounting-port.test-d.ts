// cli alone may import runner and model, so the token-accounting port conformance is proved here.

import { expectTypeOf, test } from 'vitest'
import { createTokenAccounting } from '@vostride/agent-qa-model'
import type { TokenAccounting as RunnerTokenAccounting } from '@vostride/agent-qa-runner'

type ModelAccounting = ReturnType<typeof createTokenAccounting>

test('the model token accounting satisfies the runner token accounting port', () => {
  // Load-bearing gate: a `satisfies` binding of the model factory's return type to the runner
  // port. A non-conforming shape (a dropped method, a diverged signature) is a tsc error under
  // `pnpm --filter @vostride/agent-qa-cli exec tsc --noEmit`.
  const _proof = (undefined as unknown as ModelAccounting) satisfies RunnerTokenAccounting
  void _proof

  // Readability mirror of the same assertion for vitest --typecheck (knowledge-hint-reader idiom).
  expectTypeOf<ModelAccounting>().toExtend<RunnerTokenAccounting>()
})
