// The tree only tests visibility; an unknown probe answer means a search never ends not-found.

import type { Ref } from '@vostride/agent-qa-schema'
import type { InterimNode } from '../screen-builder.js'
import type { ScrollEndedBy, ScrollUntilVisibleMeta } from './metadata.js'

export type Direction = 'up' | 'down' | 'left' | 'right'

/** What one swipe proved: the container moved, it is at its extent, or nothing is known. */
export type SwipeSignal = 'moved' | 'at-boundary' | 'unknown'

/** The target is on screen, definitively not on screen, or cannot be judged. */
export type TargetVisibility = 'visible' | 'hidden' | 'unknown'

export interface ScrollPrimitives {
  /** One platform swipe in `direction`, optionally inside container `ref`. */
  swipeOnce(direction: Direction, ref?: Ref): Promise<SwipeSignal>
  /** Native search-scroll toward `target`; its `true` is confirmed by the visibility probe. */
  nativeSearchScroll?(target: string, ref?: Ref, direction?: Direction): Promise<boolean>
  /** Light probe: interim nodes only, NO refMap mint, NO screenshot. Read for visibility only. */
  readInterimTree(): Promise<InterimNode[]>
  /**
   * Is `target` visible, definitively not on screen, or impossible to judge? When supplied it
   * replaces the interim-tree name match; any other answer counts as unknown.
   */
  probeTargetVisible?(target: string, ref?: Ref): Promise<TargetVisibility>
}

export interface UntilVisibleParams {
  target: string
  direction: Direction
  maxSwipes: number
  retryOpposite: boolean
  ref?: Ref
}

export interface ScrollLoopResult {
  meta: ScrollUntilVisibleMeta
  found: boolean
}

export interface ScrollOffsets {
  before: number
  after: number
  /** Largest offset the container can reach on the swiped axis. */
  max: number
}

/**
 * The offset rule shared by every surface that can read real scroll offsets (web containers,
 * Android WebView): a changed offset is movement; an unchanged offset at the container's extent
 * in the swiped direction is the boundary; anything else is unknown.
 */
export function swipeSignalFromOffsets(direction: Direction, offsets: ScrollOffsets | undefined): SwipeSignal {
  if (!offsets) return 'unknown'
  const { before, after, max } = offsets
  if (![before, after, max].every((n) => typeof n === 'number' && Number.isFinite(n))) return 'unknown'
  if (Math.abs(after - before) >= 1) return 'moved'
  const forward = direction === 'down' || direction === 'right'
  const atExtent = forward ? after >= max - 1 : after <= 1
  return atExtent ? 'at-boundary' : 'unknown'
}

/** A page's scrolling element, read before and after a gesture that is not bound to a container. */
export interface DocumentScrollOffsets {
  x: number
  y: number
  maxX: number
  maxY: number
}

// Any member that moved is movement; a boundary needs every ranged member at its extent.
export function scrollerSetSwipeSignal(
  direction: Direction,
  before: readonly DocumentScrollOffsets[] | undefined,
  after: readonly DocumentScrollOffsets[] | undefined,
): SwipeSignal {
  if (!before || !after || before.length === 0 || before.length !== after.length) return 'unknown'
  const horizontal = direction === 'left' || direction === 'right'
  const members: ScrollOffsets[] = []
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i]
    const a = after[i]
    if (!b || !a) return 'unknown'
    const offsets = horizontal
      ? { before: b.x, after: a.x, max: a.maxX }
      : { before: b.y, after: a.y, max: a.maxY }
    if (![offsets.before, offsets.after, offsets.max].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return 'unknown'
    }
    members.push(offsets)
  }
  const signals = members.map((offsets) => swipeSignalFromOffsets(direction, offsets))
  if (signals.includes('moved')) return 'moved'
  const withRange = members.flatMap((offsets, i) => (offsets.max > 0 ? [signals[i]] : []))
  if (withRange.length === 0) return 'unknown'
  return withRange.every((signal) => signal === 'at-boundary') ? 'at-boundary' : 'unknown'
}

/**
 * The scroller-set rule over the document scroller alone: a document with no scroll range on the
 * swiped axis proves nothing, because the gesture may have moved a nested scroller.
 */
export function documentSwipeSignal(
  direction: Direction,
  before: DocumentScrollOffsets | undefined,
  after: DocumentScrollOffsets | undefined,
): SwipeSignal {
  return scrollerSetSwipeSignal(direction, before ? [before] : undefined, after ? [after] : undefined)
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Visibility = normalized accessible-name contains-match over nodes not marked invisible. */
function targetVisible(nodes: InterimNode[], target: string): boolean {
  const needle = normalizeName(target)
  for (const node of nodes) {
    if (node.state?.visible === false) continue
    if (normalizeName(node.name ?? '').includes(needle)) return true
  }
  return false
}

function opposite(direction: Direction): Direction {
  switch (direction) {
    case 'up':
      return 'down'
    case 'down':
      return 'up'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
  }
}

function result(
  found: boolean,
  swipes: number,
  reversedOnce: boolean,
  outcome: ScrollUntilVisibleMeta['outcome'],
  endedBy: ScrollEndedBy,
): ScrollLoopResult {
  return { found, meta: { swipes, reversedOnce, outcome, endedBy } }
}

type SearchEnd = 'target-visible' | 'max-swipes' | 'boundary'

export async function runUntilVisibleLoop(
  p: ScrollPrimitives,
  params: UntilVisibleParams,
): Promise<ScrollLoopResult> {
  const { target, maxSwipes, retryOpposite, ref } = params
  let swipes = 0
  // Set once any answer could not be judged: such a search ends unresolved, never not-found.
  let undetermined = false
  const visibility = async (): Promise<TargetVisibility> => {
    if (!p.probeTargetVisible) return targetVisible(await p.readInterimTree(), target) ? 'visible' : 'hidden'
    const answer: unknown = await p.probeTargetVisible(target, ref)
    return answer === 'visible' || answer === 'hidden' ? answer : 'unknown'
  }
  const visible = async (): Promise<boolean> => {
    const answer = await visibility()
    if (answer === 'unknown') undetermined = true
    return answer === 'visible'
  }

  if (await visible()) return result(true, 0, false, 'found', 'target-visible')

  if (p.nativeSearchScroll) {
    const reported = await p.nativeSearchScroll(target, ref, params.direction)
    if (reported && (await visible())) {
      return result(true, 0, false, 'found', 'target-visible')
    }
  }

  // One bounded search in `direction`: ends on the target, a boundary signal, or maxSwipes.
  const search = async (direction: Direction): Promise<SearchEnd> => {
    for (let used = 0; used < maxSwipes; used += 1) {
      const signal = await p.swipeOnce(direction, ref)
      swipes += 1
      if (await visible()) return 'target-visible'
      if (signal === 'at-boundary') return 'boundary'
    }
    return 'max-swipes'
  }

  const first = await search(params.direction)
  if (first === 'target-visible') return result(true, swipes, false, 'found', 'target-visible')
  if (!retryOpposite) {
    return result(false, swipes, false, first === 'boundary' && !undetermined ? 'not-found' : 'unresolved', first)
  }

  const second = await search(opposite(params.direction))
  if (second === 'target-visible') return result(true, swipes, true, 'found', 'target-visible')
  const bothBoundaries = first === 'boundary' && second === 'boundary'
  return result(false, swipes, true, bothBoundaries && !undetermined ? 'not-found' : 'unresolved', second)
}

export interface DirectionScrollParams {
  direction: Direction
  ref?: Ref
}

/** Direction mode is one gesture: no opposite retry, whatever the signal says. */
export async function runDirectionScroll(
  p: ScrollPrimitives,
  params: DirectionScrollParams,
): Promise<ScrollLoopResult> {
  const signal = await p.swipeOnce(params.direction, params.ref)
  return result(false, 1, false, 'unresolved', signal === 'at-boundary' ? 'boundary' : 'max-swipes')
}

export const MAX_TO_END_SWIPES = 20

/**
 * toEnd: swipe until a boundary signal or the cap. Reaching the boundary is the goal, so it
 * reports 'found'; the cap without a boundary signal reports 'unresolved'.
 */
export async function runToEndScroll(
  p: ScrollPrimitives,
  direction: Direction,
  ref?: Ref,
  cap = MAX_TO_END_SWIPES,
): Promise<ScrollLoopResult> {
  let swipes = 0
  while (swipes < cap) {
    const signal = await p.swipeOnce(direction, ref)
    swipes += 1
    if (signal === 'at-boundary') return result(true, swipes, false, 'found', 'boundary')
  }
  return result(false, swipes, false, 'unresolved', 'max-swipes')
}
