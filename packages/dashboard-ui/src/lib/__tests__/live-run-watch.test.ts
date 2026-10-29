// The preview sticks to a running member, picks the lowest running handle, holds between members.

import { describe, expect, it } from 'vitest'

import { watchedHandleOf, type LiveRunWatchInput } from '@/lib/live-run-watch'
import {
  createInitialRunStreamState,
  reduceRunStream,
  type MemberRow,
  type RunStreamState,
} from '@/lib/run-stream-reducer'

import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { RunEventEnvelope, RunEventPayload, RunEventType } from '@vostride/agent-qa-schema'

type Outcome = NonNullable<MemberRow['outcome']>

function member(testIndex: number, outcome?: Outcome): MemberRow {
  return {
    testIndex,
    name: `member ${String(testIndex)}`,
    sawStepStarted: true,
    ...(outcome === undefined ? {} : { outcome }),
  }
}

function membersOf(...rows: readonly MemberRow[]): Record<number, MemberRow> {
  return Object.fromEntries(rows.map((row) => [row.testIndex, row]))
}

let seq = 0
function envelope(type: RunEventType, payload: unknown): RunEventEnvelope {
  seq += 1
  return { seq, ts: 0, runId: 'r1', type, payload: payload as RunEventPayload }
}

function reduced(...envelopes: readonly RunEventEnvelope[]): RunStreamState {
  return envelopes.reduce((state, one) => reduceRunStream(state, one, 0), createInitialRunStreamState())
}

describe('the live preview watches the running member', () => {
  it('WATCH-FIRST-HANDLE-BEFORE-ANY-START: with no member rows, the first roster handle, else 0', () => {
    expect({
      roster01: watchedHandleOf({ handles: [0, 1], members: {} }, undefined),
      roster35: watchedHandleOf({ handles: [3, 5], members: {} }, undefined),
      noRoster: watchedHandleOf({ members: {} }, undefined),
      // The page watches 0 before the roster arrives; that handle has no member row, so it is not
      // held once a roster that does not start at 0 is announced.
      roster35AfterPreRosterDefault: watchedHandleOf({ handles: [3, 5], members: {} }, 0),
    }).toEqual({ roster01: 0, roster35: 3, noRoster: 0, roster35AfterPreRosterDefault: 3 })
  })

  it('WATCH-THE-RUNNING-MEMBER: member 0 finished and member 1 running gives 1', () => {
    const input = { handles: [0, 1], members: membersOf(member(0, 'passed'), member(1)) }
    expect(watchedHandleOf(input, undefined)).toBe(1)
  })

  it('WATCH-STAYS-WHILE-WATCHED-RUNS: a running watched member keeps the watch; with none watched, the lowest runner', () => {
    const input = { handles: [0, 1], members: membersOf(member(0), member(1)) }
    expect({
      keeps: watchedHandleOf(input, 1),
      lowest: watchedHandleOf(input, undefined),
    }).toEqual({ keeps: 1, lowest: 0 })
  })

  it('WATCH-SWITCHES-WHEN-NEXT-STARTS: a watched member with an outcome gives way to the member that runs', () => {
    const input = { handles: [0, 1], members: membersOf(member(0, 'passed'), member(1)) }
    expect(watchedHandleOf(input, 0)).toBe(1)
  })

  it('WATCH-HOLDS-BETWEEN-MEMBERS: with nobody running, the last watched member holds and nothing that has not started is watched', () => {
    expect({
      holdsFirst: watchedHandleOf({ handles: [0, 1], members: membersOf(member(0, 'passed')) }, 0),
      holdsSecond: watchedHandleOf(
        { handles: [0, 1, 2], members: membersOf(member(0, 'passed'), member(1, 'failed')) },
        1,
      ),
    }).toEqual({ holdsFirst: 0, holdsSecond: 1 })
  })

  it('WATCH-FOLLOWS-A-RETRY: a member whose outcome a retry cleared is running again', () => {
    const state = reduced(
      envelope('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, scope: { kind: 'suite', id: 's' }, executionContext: 'local', buildOrdinal: 1, handles: [0, 1] }),
      envelope('testStarted', { testId: 't0', testIndex: 0, name: 'first', totalSteps: 1 }),
      envelope('testFinished', { testId: 't0', testIndex: 0, outcome: 'failed', durationMs: 1 }),
      envelope('testStarted', { testId: 't1', testIndex: 1, name: 'second', totalSteps: 1 }),
      envelope('testFinished', { testId: 't1', testIndex: 1, outcome: 'passed', durationMs: 1 }),
      envelope('testRetryScheduled', { testId: 't0', testIndex: 0, attempt: 2, maxAttempts: 2 }),
    )
    expect(state.members[0]?.outcome).toBeUndefined()
    expect(watchedHandleOf({ handles: state.handles, members: state.members }, 1)).toBe(0)
  })

  it('WATCH-WITHOUT-ROSTER: no roster and member 2 running gives 2', () => {
    expect(watchedHandleOf({ handles: undefined, members: membersOf(member(2)) }, undefined)).toBe(2)
  })

  it('WATCH-IS-PURE: the inputs are unchanged, and equal inputs give equal outputs', () => {
    const make = (): LiveRunWatchInput => ({
      handles: [0, 1, 2],
      members: membersOf(member(0, 'passed'), member(2), member(1)),
    })
    const input = make()
    const before = structuredClone(input)
    const first = watchedHandleOf(input, 0)
    const again = watchedHandleOf(make(), 0)
    expect({ first, again, unchanged: input }).toEqual({ first: 1, again: 1, unchanged: before })
    expect(Object.keys(input.members)).toEqual(Object.keys(before.members))
  })
})
