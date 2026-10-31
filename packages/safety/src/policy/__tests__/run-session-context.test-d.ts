import { expectTypeOf, test } from 'vitest'
import { asRunId, type RunSession } from '@vostride/agent-qa-schema'

import { resolveExecutionContext } from '../execution-context'

test('a run session reports one of four execution contexts', () => {
  const session: RunSession = {
    id: asRunId('run_execution_context'),
    status: 'passed',
    executionContext: resolveExecutionContext({ isTty: false, ciMarkers: true }),
    // Stubs the run session's other members; the assertion targets `executionContext` alone.
    subscribe: () => () => {},
    subscribeFrames: () => undefined,
    streamCapabilityOf: () => ({ kind: 'none' }),
    cancel: () => {},
    done: Promise.resolve() as unknown as RunSession['done'],
  }

  expectTypeOf(session.executionContext).toEqualTypeOf<
    'local-interactive' | 'local-headless' | 'ci' | 'cloud'
  >()
})
