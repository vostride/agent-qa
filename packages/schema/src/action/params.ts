import type { Point } from '../primitives/point'
import type { Ref } from '../primitives/ref'

// Execution shapes take a required `ref`; the grounding gate converts the emission shapes below.
export type Fill = {
  ref: Ref
  text: string
  clearMode: 'replace' | 'append'
  submit: boolean
}

export type Scroll =
  | {
      mode: 'direction'
      direction: 'up' | 'down' | 'left' | 'right'
      ref?: Ref
      amount: 'page' | 'halfPage' | 'toEnd'
      retryOpposite: boolean
    }
  | {
      mode: 'untilVisible'
      text: string
      ref?: Ref
      direction: 'up' | 'down' | 'left' | 'right'
      maxSwipes: number
      retryOpposite: boolean
    }

export type WaitFor =
  | { on: 'text'; text: string; timeoutMs: number }
  | { on: 'selector'; selector: string; timeoutMs: number }
  | { on: 'gone'; text: string; timeoutMs: number }

type SwipeBase = {
  type: 'swipe'
  durationMs: number
}

export type SwipeByDirection = SwipeBase & {
  mode: 'direction'
  direction: 'up' | 'down' | 'left' | 'right'
  ref?: Ref
}

export type SwipeByPath = SwipeBase & {
  mode: 'path'
  from: Point
  to: Point
  coordSpace: 'viewport' | 'screen'
}

// Planner-facing: `ref` is optional beside a `target` the grounding gate resolves before execution.
export type EmittedTargetDescriptor = {
  role: string
  name: string
  row?: string
}

// Flattens an intersection into a single object literal (preserving `?`/`readonly` via a
// homomorphic mapped type) so the emission projections compare equal to zod's flat inference.
type Simplify<T> = { [K in keyof T]: T[K] }

// Widen a ref-bearing execution branch to its emitted form: a branch with a REQUIRED `ref`
// gets `ref` optional plus an optional `target`; branches without a required `ref` pass
// through unchanged (their optional container-`ref` is handled by `WithEmittedTarget`).
export type WithEmittedRef<T> = T extends { ref: Ref }
  ? Simplify<Omit<T, 'ref'> & { ref?: Ref, target?: EmittedTargetDescriptor }>
  : T

// Add the optional `target` descriptor to every branch of a shape whose `ref` is already
// optional (container refs: scroll/swipe).
export type WithEmittedTarget<T> = T extends unknown
  ? Simplify<T & { target?: EmittedTargetDescriptor }>
  : never

export type PlannedFill = WithEmittedRef<Fill>
export type PlannedScroll = WithEmittedTarget<Scroll>
