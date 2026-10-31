import { expectTypeOf, test } from 'vitest'
import { asRef } from '../primitives/ref'
import type {
  AndroidAction,
  Fill,
  IosAction,
  Scroll,
  Surface,
  SwipeByDirection,
  SwipeByPath,
  WaitFor,
} from '../index'

type ExpectedFill = {
  ref: ReturnType<typeof asRef>
  text: string
  clearMode: 'replace' | 'append'
  submit: boolean
}

test('the action surfaces and the fill shape are fixed', () => {
  expectTypeOf<Surface>().toEqualTypeOf<'web' | 'mobile' | 'android' | 'ios' | 'common'>()
  expectTypeOf<AndroidAction>().not.toEqualTypeOf<never>()
  expectTypeOf<IosAction>().not.toEqualTypeOf<never>()
  expectTypeOf<Fill>().toEqualTypeOf<ExpectedFill>()
})

test('fill and scroll values typecheck and a direction scroll refuses reveal text', () => {
  const fill: Fill = {
    ref: asRef('e1'),
    text: 'x',
    clearMode: 'replace',
    submit: false,
  }

  const directionScroll: Scroll = {
    mode: 'direction',
    direction: 'down',
    ref: asRef('list'),
    amount: 'page',
    retryOpposite: true,
  }

  const untilVisibleScroll: Scroll = {
    mode: 'untilVisible',
    text: 'Submit',
    direction: 'down',
    maxSwipes: 10,
    retryOpposite: true,
  }

  const invalidDirectionScroll: Scroll = {
    mode: 'direction',
    direction: 'down',
    amount: 'page',
    // @ts-expect-error direction scrolls do not accept the untilVisible-only reveal text field.
    text: 'Submit',
    retryOpposite: true,
  }

  void fill
  void directionScroll
  void untilVisibleScroll
  void invalidDirectionScroll
})

test('wait-for values typecheck for text, selector and gone', () => {
  const textWait: WaitFor = {
    on: 'text',
    text: 'Ready',
    timeoutMs: 5000,
  }

  const selectorWait: WaitFor = {
    on: 'selector',
    selector: '#ready',
    timeoutMs: 5000,
  }

  const goneWait: WaitFor = {
    on: 'gone',
    text: 'Loading',
    timeoutMs: 5000,
  }

  void textWait
  void selectorWait
  void goneWait
})

test('swipes by direction and by path typecheck and a path swipe requires a to point', () => {
  const swipeByDirection: SwipeByDirection = {
    type: 'swipe',
    mode: 'direction',
    direction: 'up',
    durationMs: 300,
  }

  const swipeByPath: SwipeByPath = {
    type: 'swipe',
    mode: 'path',
    from: { x: 0, y: 0 },
    to: { x: 10, y: 20 },
    coordSpace: 'viewport',
    durationMs: 300,
  }

  // @ts-expect-error path swipes require a to point.
  const swipeMissingTo: SwipeByPath = { type: 'swipe', mode: 'path', from: { x: 0, y: 0 }, coordSpace: 'viewport', durationMs: 300 }

  void swipeByDirection
  void swipeByPath
  void swipeMissingTo
})
