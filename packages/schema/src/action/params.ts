import type { Point } from '../primitives/point'
import type { Ref } from '../primitives/ref'

// EXECUTION shapes (adapter-facing). Defaults are modeled as required here because these
// types represent post-parse output. Critically, `ref` is REQUIRED on these shapes:
// adapters receive fully-grounded actions. The EMISSION projections at the bottom of
// this file widen `ref` to optional and add a `target` descriptor sibling — that is what the
// planner may SAY. The Plan-04 grounding gate is the converting boundary between the two
// worlds; adapter contracts must never be loosened to the emission shape (Pitfall 2).
//
// EMISSION↔EXECUTION divergence map (Phase 360 alignments — Open Question 1, Pitfall 4):
//   - `click`/`tap` carry an optional `desiredState?: DesiredState` post-condition on BOTH the
//     execution shape (web.ts/mobile.ts) and the emission schema — schema `ActionsFor<P>` is
//     now the single planner-reachable truth (no runner-side intersection widening; no default,
//     359 D-13). No divergence: the field passes through the gate unchanged.
//   - `tapCoordinate` execution shape is `{ x, y, coordSpace }` — byte-identical to the emission
//     zod (index.ts `tapCoordinate`) minus `elementDescription`, which stays EMISSION-ONLY (a
//     descriptor the grounding gate strips; never reaches the adapter). The prior `{ point: Point }`
//     execution form is deleted (breaking is sanctioned; no parallel shape).
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

// --- EMISSION projection (planner-facing) -----------------------------------------------
// What the planner MAY emit for a ref-bearing tool: `ref` becomes optional and a `target`
// sibling appears, the stated target sent beside the ref. These are NOT the shapes
// adapters receive — the grounding gate resolves `target` → `ref` before execution.
//
// `EmittedTargetDescriptor` mirrors the tool surface's `targetSchema` (the runner zod const):
// role, name and the row words of a repeated label; no `near`, no selector-like field
// and no ordinal. Recorded evidence keeps reading the schema `TargetDescriptor`;
// params-drift pins `z.infer<typeof targetSchema>` against this type so the two never drift.
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
