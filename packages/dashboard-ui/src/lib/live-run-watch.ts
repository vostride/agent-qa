// Keep a running watched member, else the lowest running handle, else the last, else roster first.

import type { MemberRow } from '@/lib/run-stream-reducer'

export interface LiveRunWatchInput {
  handles?: readonly number[] | undefined
  members: Readonly<Record<number, MemberRow>>
}

function runningHandles(members: Readonly<Record<number, MemberRow>>): number[] {
  return Object.values(members)
    .filter((member) => member.outcome === undefined)
    .map((member) => member.testIndex)
    .sort((a, b) => a - b)
}

export function watchedHandleOf(input: LiveRunWatchInput, previous: number | undefined): number {
  const running = runningHandles(input.members)
  if (previous !== undefined && running.includes(previous)) return previous
  const lowest = running[0]
  if (lowest !== undefined) return lowest
  if (previous !== undefined && input.members[previous] !== undefined) return previous
  return input.handles?.[0] ?? previous ?? 0
}
