import { describe, expectTypeOf, test } from 'vitest'

import type { RunRecord } from '../../commands/run.js'
import type { InProcessCliRunExecutionOptions } from '../in-process-run-execution.js'
import type { ComposeCliLocalAgentInput } from '../local-agent-host.js'

// 2026-10-17 (443-10, D-16): every drive call carries the record its door built.
describe('C443-ONE-RECORD', () => {
  test("the drive's runRecord option is required and never undefined", () => {
    expectTypeOf<InProcessCliRunExecutionOptions['runRecord']>().toEqualTypeOf<RunRecord>()
    type Optional = object extends Pick<InProcessCliRunExecutionOptions, 'runRecord'> ? true : false
    expectTypeOf<Optional>().toEqualTypeOf<false>()
    type AdmitsUndefined = undefined extends InProcessCliRunExecutionOptions['runRecord'] ? true : false
    expectTypeOf<AdmitsUndefined>().toEqualTypeOf<false>()
  })

  test("the CLI host's run bridge has no subscriber member", () => {
    type Bridge = NonNullable<ComposeCliLocalAgentInput['runBridge']>
    expectTypeOf<Extract<keyof Bridge, 'record'>>().toEqualTypeOf<'record'>()
  })
})
