import { expectTypeOf } from 'vitest'
import { asRunId, type RunSession } from '@vostride/agent-qa-schema'

import { resolveExecutionContext } from '../execution-context'

const session: RunSession = {
  id: asRunId('run_execution_context'),
  status: 'passed',
  executionContext: resolveExecutionContext({ isTty: false, ciMarkers: true }),
  // The M1-lite RunSession expanded the provisional three-field DTO with the
  // live subscribe/cancel/done seam, and 403 D-05 added the per-handle frame seam; this
  // type-only fixture stubs them — the assertion below still targets executionContext alone.
  subscribe: () => () => {},
  subscribeFrames: () => undefined,
  streamCapabilityOf: () => ({ kind: 'none' }),
  cancel: () => {},
  done: Promise.resolve() as unknown as RunSession['done'],
}

expectTypeOf(session.executionContext).toEqualTypeOf<
  'local-interactive' | 'local-headless' | 'ci' | 'cloud'
>()
