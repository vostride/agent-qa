import { describe, expect, it } from 'vitest'

import { getRunFaviconState } from '@/hooks/use-run-status-favicon'
import {
  finalStepStatusForRun,
  getRunStatusDescriptor,
  getStatusBadgeClassName,
  isTerminalRunStatus,
  normalizeRunStatus,
  normalizeStepStatus,
  shouldRouteRunToLive,
  statusBadgeLook,
} from '@/lib/status'
import { routes } from '@/lib/routes'

describe('dashboard status normalization', () => {
  it('keeps timeout distinct while treating it as a failed terminal run', () => {
    expect(getRunStatusDescriptor('timeout')).toMatchObject({
      normalized: 'timeout',
      label: 'Timed out',
      terminal: true,
      tone: 'danger',
    })
    expect(getRunStatusDescriptor('timed_out')).toMatchObject({
      normalized: 'timeout',
      label: 'Timed out',
      terminal: true,
      tone: 'danger',
    })
    expect(finalStepStatusForRun('timeout')).toBe('failed')
  })

  it('preserves cancellation separately from failed and timeout states', () => {
    expect(getRunStatusDescriptor('cancelled')).toMatchObject({
      normalized: 'cancelled',
      label: 'Cancelled',
      terminal: true,
      tone: 'muted',
    })
    expect(getRunStatusDescriptor('canceled').normalized).toBe('cancelled')
    expect(finalStepStatusForRun('cancelled')).toBe('cancelled')
  })

  it('normalizes success, failure, and flaky terminal statuses', () => {
    expect(getRunStatusDescriptor('completed')).toMatchObject({
      normalized: 'passed',
      label: 'Passed',
      terminal: true,
      tone: 'success',
    })
    expect(getRunStatusDescriptor('failed')).toMatchObject({
      normalized: 'failed',
      label: 'Failed',
      terminal: true,
      tone: 'danger',
    })
  })

  it('routes only active runs to live execution', () => {
    expect(shouldRouteRunToLive('running')).toBe(true)
    expect(shouldRouteRunToLive('timeout')).toBe(false)
    expect(shouldRouteRunToLive('cancelled')).toBe(false)
    expect(shouldRouteRunToLive('failed')).toBe(false)
    expect(shouldRouteRunToLive('passed')).toBe(false)
    expect(isTerminalRunStatus('timeout')).toBe(true)
    expect(isTerminalRunStatus('running')).toBe(false)
    expect(routes.runDetailOrLive('run-timeout', 'timeout')).toBe('/runs/run-timeout')
    expect(routes.runDetailOrLive('run-cancelled', 'cancelled')).toBe('/runs/run-cancelled')
    expect(routes.runDetailOrLive('run-failed', 'failed')).toBe('/runs/run-failed')
    expect(routes.runDetailOrLive('run-running', 'running')).toBe('/runs/run-running/live')
  })

  // THE FIFTH VERDICT WORD HAD NO LABEL (425-04 · D-02, PXH-RUN-01).
  //
  // `timeout` is a member of the run-status vocabulary (`runStatusValues`, schema
  // functions/runs.ts), so a timed-out run reached the header and fell through to the default arm,
  // which paints the raw lowercase word. PXH-RUN-01 names "Timed out" as one of the five words the
  // reader must see. The arm is added to the ONE palette — D-01 forbids a second one — and reuses
  // the `destructive` variant `getRunStatusDescriptor` already assigns that status as its tone.
  // The six shipped arms are pinned verbatim beside it so adding the fifth word cannot re-spell
  // the other four.
  it('BADGE-TIMEOUT-ARM: the one palette labels a timed-out run and leaves the six shipped arms byte-identical', () => {
    expect(statusBadgeLook('timeout')).toEqual({ label: 'Timed out', variant: 'destructive' })

    expect(statusBadgeLook('passed')).toEqual({
      label: 'Passed',
      className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
    })
    expect(statusBadgeLook('failed')).toEqual({ label: 'Failed', variant: 'destructive' })
    expect(statusBadgeLook('healed')).toEqual({
      label: 'Healed',
      className: 'bg-amber-500/15 text-amber-500 border-amber-500/20',
    })
    expect(statusBadgeLook('flaky')).toEqual({
      label: 'Flaky',
      className: 'bg-amber-500/15 text-amber-500 border-amber-500/20',
    })
    expect(statusBadgeLook('skipped')).toEqual({ label: 'Skipped', variant: 'secondary' })
    expect(statusBadgeLook('cancelled')).toEqual({
      label: 'Cancelled',
      className: 'bg-muted text-muted-foreground border-border',
    })

    expect(statusBadgeLook('not-a-status')).toEqual({ label: 'not-a-status', variant: 'outline' })
  })

  it('keeps normalized danger and outline badges visually explicit', () => {
    expect(getStatusBadgeClassName('danger')).toContain('bg-destructive')
    expect(getStatusBadgeClassName('danger')).toContain('text-white')
    expect(getStatusBadgeClassName('danger')).not.toContain('bg-red-500/15')

    expect(getStatusBadgeClassName('outline')).toContain('border-border')
    expect(getStatusBadgeClassName('outline')).toContain('bg-transparent')
  })
})

describe('the timeout status badge', () => {
  it('both run status helpers label timeout Timed out', () => {
    expect(getRunStatusDescriptor('timeout')).toMatchObject({ label: 'Timed out', tone: 'danger' })
    expect(getRunStatusDescriptor('timed_out')).toMatchObject({ label: 'Timed out', tone: 'danger' })
    expect(statusBadgeLook('timeout').label).toBe('Timed out')
  })

  it('a run word flaky reads unknown while a step and a member keep flaky', () => {
    expect(normalizeRunStatus('flaky')).toBe('unknown')
    expect(getRunStatusDescriptor('flaky').normalized).toBe('unknown')
    expect(getRunFaviconState('flaky')).toBe('default')
    expect(normalizeStepStatus('flaky')).toBe('flaky')
    expect(statusBadgeLook('flaky').label).toBe('Flaky')
  })
})
