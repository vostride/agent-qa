import { describe, expect, it } from 'vitest'

import {
  finalStepStatusForRun,
  getRunStatusDescriptor,
  getStatusBadgeClassName,
  isTerminalRunStatus,
  shouldRouteRunToLive,
} from '@/lib/status'
import { routes } from '@/lib/routes'

describe('dashboard status normalization', () => {
  it('keeps timeout distinct while treating it as a failed terminal run', () => {
    expect(getRunStatusDescriptor('timeout')).toMatchObject({
      normalized: 'timeout',
      label: 'Timed Out',
      terminal: true,
      tone: 'danger',
    })
    expect(getRunStatusDescriptor('timed_out')).toMatchObject({
      normalized: 'timeout',
      label: 'Timed Out',
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
    expect(getRunStatusDescriptor('flaky')).toMatchObject({
      normalized: 'flaky',
      label: 'Flaky',
      terminal: true,
      tone: 'warning',
    })
    expect(finalStepStatusForRun('flaky')).toBe('flaky')
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

  it('keeps normalized danger and outline badges visually explicit', () => {
    expect(getStatusBadgeClassName('danger')).toContain('bg-destructive')
    expect(getStatusBadgeClassName('danger')).toContain('text-white')
    expect(getStatusBadgeClassName('danger')).not.toContain('bg-red-500/15')

    expect(getStatusBadgeClassName('outline')).toContain('border-border')
    expect(getStatusBadgeClassName('outline')).toContain('bg-transparent')
  })
})
