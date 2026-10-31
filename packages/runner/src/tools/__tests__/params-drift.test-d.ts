import { expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import type {
  EmittedTargetDescriptor,
  Fill,
  MobileAction,
  PlannedFill,
  PlannedScroll,
  Ref,
  Scroll,
  SwipeByDirection,
  SwipeByPath,
  TabSelector,
  WaitFor,
  WebAction,
  WithEmittedRef,
} from '@vostride/agent-qa-schema'
import {
  fillSchema,
  multiTapSchema,
  navigateSchema,
  pinchSchema,
  scrollSchema,
  swipeSchema,
  tabSchema,
  waitForSchema,
  webInspectSchema,
} from '../actions/index.js'

type WithoutElementDescription<T> = T extends unknown
  ? Omit<T, 'elementDescription'>
  : never

type WithActionType<Type extends string, T> = T extends unknown
  ? T & { type: Type }
  : never

type WithSchemaTabSelector<T> = T extends { action: 'switch' }
  ? Omit<T, 'index' | 'title' | 'url'> & TabSelector
  : T

type WithSchemaInspectTab<T> = T extends { tab?: unknown }
  ? Omit<T, 'tab'> & { tab?: TabSelector | undefined }
  : T

type ScrollParams = z.infer<typeof scrollSchema>
type SwipeParams = z.infer<typeof swipeSchema>
// The swipe direction branch carries an emission `target` descriptor; the path branch does not.
type WithSwipeCompanions<T> = T extends unknown
  ? Omit<T, 'type'> & { elementDescription?: string | undefined } & (T extends { mode: 'direction' } ? { target?: EmittedTargetDescriptor } : unknown)
  : never
type SwipeParamsWithKnownCompanions = WithSwipeCompanions<SwipeByDirection | SwipeByPath>
type DirectionSwipeParams = Extract<SwipeParams, { mode: 'direction' }>
type RegistryPinchAction = WithActionType<'pinch', WithoutElementDescription<z.infer<typeof pinchSchema>>>
type RegistryMultiTapAction = WithActionType<'multiTap', WithoutElementDescription<z.infer<typeof multiTapSchema>>>
type RegistryNavigateAction = WithActionType<'navigate', z.infer<typeof navigateSchema>>
type RegistryTabAction = WithActionType<'tab', WithSchemaTabSelector<z.infer<typeof tabSchema>>>
type RegistryWebInspectAction = WithActionType<'inspect', WithSchemaInspectTab<z.infer<typeof webInspectSchema>>>
// Emission projections for the union ref-branch tools: ref-branch widened (ref optional +
// target), coord-branch untouched.
type PlannedPinchAction = WithActionType<'pinch', WithEmittedRef<Extract<MobileAction, { type: 'pinch' }>>>
type PlannedMultiTapAction = WithActionType<'multiTap', WithEmittedRef<Extract<MobileAction, { type: 'multiTap' }>>>

test('tool inference widens ref and adds a target descriptor', () => {
  // --- emission world: tool inference widens ref and adds target ---
  expectTypeOf<z.infer<typeof fillSchema>['ref']>().toEqualTypeOf<Ref | undefined>()
  expectTypeOf<z.infer<typeof fillSchema>['target']>().toEqualTypeOf<EmittedTargetDescriptor | undefined>()
  expectTypeOf<ScrollParams['ref']>().toEqualTypeOf<Ref | undefined>()
  expectTypeOf<DirectionSwipeParams['ref']>().toEqualTypeOf<Ref | undefined>()

  expectTypeOf<WithoutElementDescription<z.infer<typeof fillSchema>>>().toEqualTypeOf<PlannedFill>()
  expectTypeOf<WithoutElementDescription<z.infer<typeof scrollSchema>>>().toEqualTypeOf<PlannedScroll>()
  expectTypeOf<z.infer<typeof waitForSchema>>().toEqualTypeOf<WaitFor>()
  expectTypeOf<SwipeParams>().toMatchTypeOf<SwipeParamsWithKnownCompanions>()
  expectTypeOf<SwipeParamsWithKnownCompanions>().toMatchTypeOf<SwipeParams>()
  expectTypeOf<RegistryPinchAction>().toMatchTypeOf<PlannedPinchAction>()
  expectTypeOf<PlannedPinchAction>().toMatchTypeOf<RegistryPinchAction>()
  expectTypeOf<RegistryMultiTapAction>().toMatchTypeOf<PlannedMultiTapAction>()
  expectTypeOf<PlannedMultiTapAction>().toMatchTypeOf<RegistryMultiTapAction>()
})

test('adapter-facing actions keep ref required and carry no target', () => {
  // --- execution world: adapter-facing shapes keep ref required and carry no target ---
  expectTypeOf<Fill['ref']>().toEqualTypeOf<Ref>()
  expectTypeOf<PlannedFill['ref']>().toEqualTypeOf<Ref | undefined>()
  expectTypeOf<Extract<MobileAction, { type: 'tap' }>>().not.toHaveProperty('target')
  expectTypeOf<Extract<WebAction, { type: 'click' }>>().not.toHaveProperty('target')
  expectTypeOf<Extract<MobileAction, { type: 'pinch' }>>().not.toHaveProperty('target')

  expectTypeOf<RegistryNavigateAction>().toMatchTypeOf<Extract<WebAction, { type: 'navigate' }>>()
  expectTypeOf<Extract<WebAction, { type: 'navigate' }>>().toMatchTypeOf<RegistryNavigateAction>()
  expectTypeOf<RegistryTabAction>().toMatchTypeOf<Extract<WebAction, { type: 'tab' }>>()
  expectTypeOf<Extract<WebAction, { type: 'tab' }>>().toMatchTypeOf<RegistryTabAction>()
  expectTypeOf<RegistryWebInspectAction>().toMatchTypeOf<Extract<WebAction, { type: 'inspect' }>>()
  expectTypeOf<Extract<WebAction, { type: 'inspect' }>>().toMatchTypeOf<RegistryWebInspectAction>()
})
