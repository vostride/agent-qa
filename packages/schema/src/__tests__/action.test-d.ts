import { expectTypeOf, test } from 'vitest'
import { asRef } from '../primitives/ref'
import type {
  Action,
  ActionExecutor,
  ActionsFor,
  AndroidAction,
  CommonAction,
  IosAction,
  MobileAction,
  Platform,
  Surface,
  WebAction,
} from '../index'

test('the action legs partition the action union and compose per platform', () => {
  expectTypeOf<Surface>().toEqualTypeOf<'web' | 'mobile' | 'android' | 'ios' | 'common'>()
  expectTypeOf<Platform>().toEqualTypeOf<'web' | 'android' | 'ios'>()

  expectTypeOf<IosAction>().not.toEqualTypeOf<never>()

  // Web and mobile action legs are mutually exclusive except `fill`.
  type SharedWebMobileVerb = 'fill'
  expectTypeOf<Extract<WebAction['type'], MobileAction['type']>>().toEqualTypeOf<SharedWebMobileVerb>()
  expectTypeOf<
    Exclude<Extract<WebAction['type'], MobileAction['type']>, SharedWebMobileVerb>
  >().toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction['type'], CommonAction['type']>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<MobileAction['type'], CommonAction['type']>>().toEqualTypeOf<never>()

  type LegUnion =
    | WebAction['type']
    | MobileAction['type']
    | AndroidAction['type']
    | IosAction['type']
    | CommonAction['type']

  expectTypeOf<Exclude<Action['type'], LegUnion>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<LegUnion, Action['type']>>().toEqualTypeOf<never>()

  expectTypeOf<ActionsFor<'web'>>().toEqualTypeOf<WebAction | CommonAction>()
  expectTypeOf<ActionsFor<'android'>>().toEqualTypeOf<MobileAction | AndroidAction | CommonAction>()
  expectTypeOf<ActionsFor<'ios'>>().toEqualTypeOf<MobileAction | IosAction | CommonAction>()
})

test('keypress and nativeSelect stay off the web leg, and the web verbs carry their fields', () => {
  expectTypeOf<Extract<CommonAction, { type: 'keypress' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<MobileAction, { type: 'nativeSelect' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction, { type: 'keypress' }>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction, { type: 'nativeSelect' }>>().toEqualTypeOf<never>()

  expectTypeOf<Extract<WebAction, { type: 'fill' }>>().toEqualTypeOf<
    Extract<MobileAction, { type: 'fill' }>
  >()
  expectTypeOf<Extract<WebAction, { type: 'navigate' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction, { type: 'tab' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction, { type: 'inspect' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction, { type: 'route' }>>().toMatchTypeOf<{
    type: 'route'
    urlPattern: string
    headers?: Record<string, string>
    body?: string
    contentType?: string
  }>()
  expectTypeOf<Extract<WebAction, { type: 'unroute' }>>().toMatchTypeOf<{
    type: 'unroute'
    urlPattern?: string
  }>()
  expectTypeOf<Extract<WebAction, { type: 'networkState'; mode: 'offline' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction, { type: 'networkState'; mode: 'throttle' }>>().toMatchTypeOf<{
    type: 'networkState'
    mode: 'throttle'
    latencyMs: number
    downloadKbps: number
    uploadKbps: number
  }>()
  expectTypeOf<Extract<WebAction, { type: 'storageState'; op: 'save' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction, { type: 'storageState'; op: 'restore' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<WebAction, { type: 'handleDialog' }>>().toMatchTypeOf<{
    type: 'handleDialog'
    accept: boolean
    promptText?: string
  }>()
  expectTypeOf<Extract<WebAction, { type: 'uniqueValue' }>>().toMatchTypeOf<{
    type: 'uniqueValue'
    prefix: string
  }>()
  type WebFocus = Extract<WebAction, { type: 'focus' }>
  expectTypeOf<WebFocus>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<WebFocus, { text: string }>>().toEqualTypeOf<never>()
})

test('the Android, iOS and keypress actions carry their fields', () => {
  expectTypeOf<Extract<AndroidAction, { type: 'pressBack' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<AndroidAction, { type: 'pressHome' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<AndroidAction, { type: 'pressRecent' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<AndroidAction, { type: 'openNotifications' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<AndroidAction, { type: 'openQuickSettings' }>>().not.toEqualTypeOf<never>()
  type AndroidIntent = Extract<AndroidAction, { type: 'intent' }>
  expectTypeOf<AndroidIntent>().toMatchTypeOf<{
    type: 'intent'
    action: string
    data?: string
    packageName?: string
    extras?: Array<{
      key: string
      type: 'string' | 'int' | 'long' | 'float' | 'bool'
      value: string
    }>
  }>()
  expectTypeOf<Extract<AndroidAction, { type: 'keyevent' }>>().toMatchTypeOf<{
    type: 'keyevent'
    keycode: string
  }>()
  expectTypeOf<Extract<IosAction, { type: 'pressButton' }>>().toMatchTypeOf<{
    type: 'pressButton'
    button: 'home' | 'volumeUp' | 'action'
  }>()
  expectTypeOf<Extract<IosAction, { type: 'pickerSelect'; value: string }>>().toMatchTypeOf<{
    type: 'pickerSelect'
    ref: ReturnType<typeof asRef>
    value: string
  }>()
  expectTypeOf<Extract<IosAction, { type: 'pickerSelect'; order: number }>>().toMatchTypeOf<{
    type: 'pickerSelect'
    ref: ReturnType<typeof asRef>
    order: number
  }>()
  expectTypeOf<Extract<IosAction, { type: 'swipeFromEdge' }>>().toMatchTypeOf<{
    type: 'swipeFromEdge'
    edge: 'left' | 'right' | 'top' | 'bottom'
  }>()
  expectTypeOf<Extract<IosAction, { type: 'openUniversalLink' }>>().toMatchTypeOf<{
    type: 'openUniversalLink'
    url: string
    bundleId?: string
  }>()
  expectTypeOf<Extract<CommonAction, { type: 'keypress' }>>().toMatchTypeOf<{
    type: 'keypress'
    keys: string[]
    mode: 'press' | 'down' | 'up'
  }>()
})

test('assertAI, extractAI and the app verbs are common actions, and clicks and taps carry a desired state', () => {
  type CommonAssertAI = Extract<CommonAction, { type: 'assertAI' }>
  expectTypeOf<CommonAssertAI>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<CommonAction, { type: 'assertValue' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<CommonAction, { type: 'extractAI' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<CommonAction, { type: 'assert' }>>().toEqualTypeOf<never>()
  expectTypeOf<CommonAssertAI>().toMatchTypeOf<{
    type: 'assertAI'
    claim: string
    mode: 'multimodal' | 'visual' | 'text'
  }>()
  expectTypeOf<Extract<CommonAction, { type: 'reportValue' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<CommonAction, { type: 'openApp' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<CommonAction, { type: 'openLink' }>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<CommonAction, { type: 'executeScript' }>>().not.toEqualTypeOf<never>()
  expectTypeOf<Extract<MobileAction, { type: 'launchApp' }>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<MobileAction, { type: 'stopApp' }>>().not.toEqualTypeOf<never>()

  expectTypeOf<Extract<WebAction, { type: 'click' }>>().toMatchTypeOf<{
    type: 'click'
    desiredState?: 'checked' | 'unchecked' | 'selected' | 'unselected'
  }>()
  expectTypeOf<Extract<MobileAction, { type: 'tap' }>>().toMatchTypeOf<{
    type: 'tap'
    desiredState?: 'checked' | 'unchecked' | 'selected' | 'unselected'
  }>()
  expectTypeOf<Extract<MobileAction, { type: 'tapCoordinate' }>>().toMatchTypeOf<{
    type: 'tapCoordinate'
    x: number
    y: number
    coordSpace: 'viewport' | 'content' | 'screen'
  }>()
  expectTypeOf<Extract<MobileAction, { type: 'tapCoordinate' }>>().not.toEqualTypeOf<never>()
})

test('an executor accepts only its platform actions and no action carries a platform key', () => {
  const webExec = (((_: never) => {}) as unknown) as ActionExecutor<'web'>
  webExec({ type: 'click', ref: asRef('e1') })
  webExec({ type: 'delay', ms: 10 })

  // @ts-expect-error tap is a MobileAction and is illegal on a web executor.
  webExec({ type: 'tap', ref: asRef('e1') })

  const mobileExec = (((_: never) => {}) as unknown) as ActionExecutor<'android'>
  mobileExec({ type: 'tap', ref: asRef('e1') })
  mobileExec({ type: 'pressBack' })
  mobileExec({ type: 'delay', ms: 10 })

  // @ts-expect-error click is a WebAction and is illegal on a mobile executor.
  mobileExec({ type: 'click', ref: asRef('e1') })

  const valid: Action = { type: 'tap', ref: asRef('e1') }

  // @ts-expect-error Action members carry no `platform` key.
  const invalid: Action = { type: 'tap', platform: 'web', ref: asRef('e1') }

  const taggedTap = { type: 'tap' as const, platform: 'web' as const, ref: asRef('e2') }

  // @ts-expect-error non-fresh values carrying forbidden platform metadata must not satisfy Action.
  const invalidFromVariable: Action = taggedTap

  // @ts-expect-error non-fresh values carrying forbidden platform metadata must not execute on mobile.
  mobileExec(taggedTap)

  void valid
  void invalid
  void invalidFromVariable
})

test('tab, multi-tap and coordinate actions refuse empty selectors, legacy shapes and unsupported finger counts', () => {
  const tabByIndex: Action = { type: 'tab', action: 'switch', index: 0 }

  // @ts-expect-error empty tab selectors are guaranteed to fail.
  const emptyTab: Action = { type: 'tab', action: 'switch' }

  const twoFingerTap: Action = { type: 'multiTap', fingers: 2, ref: asRef('e3') }
  const threeFingerTap: Action = { type: 'multiTap', fingers: 3, x: 10, y: 20, coordSpace: 'viewport' }

  const coordTap: Action = { type: 'tapCoordinate', x: 10, y: 20, coordSpace: 'viewport' }

  // @ts-expect-error tapCoordinate does not accept the legacy { point } execution shape.
  const legacyCoordTap: Action = { type: 'tapCoordinate', point: { x: 10, y: 20 } }

  const checkedClick: Action = { type: 'click', ref: asRef('e4'), desiredState: 'checked' }
  const selectedTap: Action = { type: 'tap', ref: asRef('e5'), desiredState: 'selected' }

  // @ts-expect-error unsupported finger counts are rejected.
  const zeroFingerTap: Action = { type: 'multiTap', fingers: 0, ref: asRef('e3') }

  // @ts-expect-error unsupported finger counts are rejected.
  const oneFingerTap: Action = { type: 'multiTap', fingers: 1, ref: asRef('e3') }

  // @ts-expect-error unsupported finger counts are rejected.
  const manyFingerTap: Action = { type: 'multiTap', fingers: 99, ref: asRef('e3') }

  void tabByIndex
  void emptyTab
  void twoFingerTap
  void threeFingerTap
  void coordTap
  void legacyCoordTap
  void checkedClick
  void selectedTap
  void zeroFingerTap
  void oneFingerTap
  void manyFingerTap
})

test('path swipes require a to point and refuse a direction', () => {
  const swipeStart = { x: 0, y: 0 }
  const swipeEnd = { x: 10, y: 20 }
  const directionSwipe: Action = { type: 'swipe', mode: 'direction', direction: 'up', durationMs: 300 }
  const pathSwipe: Action = {
    type: 'swipe',
    mode: 'path',
    from: swipeStart,
    to: swipeEnd,
    coordSpace: 'viewport',
    durationMs: 300,
  }

  // @ts-expect-error path swipes require a to point.
  const swipeMissingTo: Action = { type: 'swipe', mode: 'path', from: swipeStart, coordSpace: 'viewport', durationMs: 300 }

  // @ts-expect-error path swipes cannot carry direction.
  const pathSwipeWithDirection: Action = { type: 'swipe', mode: 'path', from: swipeStart, to: swipeEnd, coordSpace: 'viewport', durationMs: 300, direction: 'up' }

  void directionSwipe
  void pathSwipe
  void swipeMissingTo
  void pathSwipeWithDirection
})
