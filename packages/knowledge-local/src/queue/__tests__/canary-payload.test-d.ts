import { expectTypeOf } from 'vitest'
import type { Benefit } from '@vostride/agent-qa-schema'
import { PAYLOAD_BENEFITS } from '../canary-payload.js'

// A deletion from the persisted benefit list must fail completeness.
expectTypeOf<Exclude<Benefit, (typeof PAYLOAD_BENEFITS)[number]>>().toEqualTypeOf<never>()
