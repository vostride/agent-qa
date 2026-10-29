import { expectTypeOf } from 'vitest'
import { assertNever } from '@vostride/agent-qa-runner'
import type {
  Action as SchemaAction,
  ActionsFor as SchemaActionsFor,
  Platform,
} from '@vostride/agent-qa-schema'
import type { Action, ActionsFor, PlatformAdapter } from '@vostride/agent-qa-runner'

// the runner's action world IS the schema projection. The legacy runner union
// (LegacyFoldedWebVerbs / RuntimeOnlyCommonVerbs / RuntimeOnlyMobileVerbs and the local shape
// declarations) was demolished — runner `Action` = schema `Action`, and runner `ActionsFor<P>` =
// schema `ActionsFor<P>`. This pin now proves that equality cross-package (core → runner → schema)
// so a future re-introduction of a runner-side parallel union is a compile error here.
expectTypeOf<Action>().toEqualTypeOf<SchemaAction>()
expectTypeOf<ActionsFor<'web'>>().toEqualTypeOf<SchemaActionsFor<'web'>>()
expectTypeOf<ActionsFor<'android'>>().toEqualTypeOf<SchemaActionsFor<'android'>>()
expectTypeOf<ActionsFor<'ios'>>().toEqualTypeOf<SchemaActionsFor<'ios'>>()
expectTypeOf<ActionsFor<Platform>>().toEqualTypeOf<Action>()

expectTypeOf<PlatformAdapter<'web'>['platform']>().toEqualTypeOf<'web'>()
expectTypeOf<Parameters<PlatformAdapter<'web'>['execute']>[0]>().toEqualTypeOf<ActionsFor<'web'>>()
expectTypeOf<Parameters<PlatformAdapter['execute']>[0]>().toEqualTypeOf<Action>()

const exhausted = undefined as never
assertNever(exhausted)

// @ts-expect-error assertNever only accepts already-exhausted values.
assertNever({ type: 'click', ref: 'button' })
