import { expectTypeOf } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { Ref } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'

const web = new WebPlatformAdapter()

void web.execute({ type: 'click', ref: asRef('e1') })

// @ts-expect-error tap is a mobile verb and is illegal on the web adapter.
void web.execute({ type: 'tap', ref: asRef('e1') })

expectTypeOf<{ type: 'click'; ref: Ref }>().toMatchTypeOf<
  Parameters<WebPlatformAdapter['execute']>[0]
>()
