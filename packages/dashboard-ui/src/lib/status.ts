export type NormalizedRunStatus =
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'healed'
  | 'skipped'
  | 'running'
  | 'pending'
  | 'queued'
  | 'unknown'

export type StatusTone = 'success' | 'danger' | 'warning' | 'muted' | 'info' | 'outline'

export type NormalizedStepStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'healed'
  | 'skipped'
  | 'flaky'
  | 'cancelled'

export interface RunStatusDescriptor {
  raw: string
  normalized: NormalizedRunStatus
  label: string
  tone: StatusTone
  terminal: boolean
}

function canonicalizeStatus(status: string | null | undefined): string {
  return (status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function titleCaseStatus(status: string): string {
  const clean = status.trim().replace(/[_-]+/g, ' ')
  if (!clean) return 'Unknown'
  return clean.replace(/\b\w/g, (char) => char.toUpperCase())
}

export function normalizeRunStatus(status: string | null | undefined): NormalizedRunStatus {
  switch (canonicalizeStatus(status)) {
    case 'passed':
    case 'completed':
    case 'complete':
    case 'success':
      return 'passed'
    case 'failed':
    case 'failure':
    case 'error':
    case 'errored':
      return 'failed'
    case 'timeout':
    case 'timed_out':
    case 'timedout':
      return 'timeout'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'healed':
      return 'healed'
    case 'skipped':
      return 'skipped'
    case 'running':
      return 'running'
    case 'pending':
      return 'pending'
    case 'queued':
      return 'queued'
    default:
      return 'unknown'
  }
}

export function getRunStatusDescriptor(status: string | null | undefined): RunStatusDescriptor {
  const raw = status ?? ''
  const normalized = normalizeRunStatus(status)

  switch (normalized) {
    case 'passed':
      return { raw, normalized, label: 'Passed', tone: 'success', terminal: true }
    case 'failed':
      return { raw, normalized, label: 'Failed', tone: 'danger', terminal: true }
    case 'timeout':
      return { raw, normalized, label: 'Timed out', tone: 'danger', terminal: true }
    case 'cancelled':
      return { raw, normalized, label: 'Cancelled', tone: 'muted', terminal: true }
    case 'healed':
      return { raw, normalized, label: 'Healed', tone: 'warning', terminal: true }
    case 'skipped':
      return { raw, normalized, label: 'Skipped', tone: 'muted', terminal: true }
    case 'running':
      return { raw, normalized, label: 'Running', tone: 'info', terminal: false }
    case 'pending':
      return { raw, normalized, label: 'Pending', tone: 'outline', terminal: false }
    case 'queued':
      return { raw, normalized, label: 'Queued', tone: 'outline', terminal: false }
    case 'unknown':
      return {
        raw,
        normalized,
        label: titleCaseStatus(raw),
        tone: 'outline',
        terminal: false,
      }
  }
}

export type RunStatusClass = 'pass' | 'fail' | 'cancelled' | 'live'

// Mirrors the server's `runStatusClass`; other words have no class.
const RUN_STATUS_CLASS: Record<string, RunStatusClass> = {
  pending: 'live',
  running: 'live',
  passed: 'pass',
  healed: 'pass',
  failed: 'fail',
  timeout: 'fail',
  cancelled: 'cancelled',
}

export function runStatusClass(status: string): RunStatusClass | undefined {
  return Object.hasOwn(RUN_STATUS_CLASS, status) ? RUN_STATUS_CLASS[status] : undefined
}

// A member with no outcome reads as its run only while the run is running.
export function memberStatus(runStatus: string, outcome: string | null | undefined): string | null {
  return outcome ?? (runStatus === 'running' ? 'running' : null)
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return getRunStatusDescriptor(status).terminal
}

export function shouldRouteRunToLive(status: string | null | undefined): boolean {
  return normalizeRunStatus(status) === 'running'
}

export function normalizeStepStatus(status: string | null | undefined): NormalizedStepStatus {
  if (canonicalizeStatus(status) === 'flaky') return 'flaky'
  switch (normalizeRunStatus(status)) {
    case 'passed':
      return 'passed'
    case 'cancelled':
      return 'cancelled'
    case 'healed':
      return 'healed'
    case 'skipped':
      return 'skipped'
    case 'running':
      return 'running'
    case 'pending':
    case 'queued':
      return 'pending'
    case 'failed':
    case 'timeout':
    case 'unknown':
      return 'failed'
  }
}

export function finalStepStatusForRun(status: string | null | undefined): NormalizedStepStatus {
  const normalized = normalizeRunStatus(status)

  switch (normalized) {
    case 'passed':
      return 'passed'
    case 'cancelled':
      return 'cancelled'
    case 'healed':
      return 'healed'
    case 'skipped':
      return 'skipped'
    case 'running':
      return 'running'
    case 'pending':
    case 'queued':
      return 'pending'
    case 'failed':
    case 'timeout':
    case 'unknown':
      return 'failed'
  }
}

export function getStatusBadgeClassName(tone: StatusTone): string | undefined {
  switch (tone) {
    case 'success':
      return 'border-emerald-500/20 bg-emerald-500/15 text-emerald-500'
    case 'danger':
      return 'border-transparent bg-destructive text-white dark:bg-destructive/60'
    case 'warning':
      return 'border-amber-500/20 bg-amber-500/15 text-amber-500'
    case 'muted':
      return 'border-border bg-muted text-muted-foreground'
    case 'info':
      return 'animate-pulse border-blue-500/20 bg-blue-500/15 text-blue-500'
    case 'outline':
      return 'border-border bg-transparent text-foreground'
  }
}

export function getStatusTextClassName(tone: StatusTone): string {
  switch (tone) {
    case 'success':
      return 'text-emerald-500'
    case 'danger':
      return 'text-red-500'
    case 'warning':
      return 'text-amber-500'
    case 'muted':
      return 'text-muted-foreground'
    case 'info':
      return 'text-blue-500'
    case 'outline':
      return 'text-muted-foreground'
  }
}

// One palette for the run badge and every member badge; the type is structural so no React loads.

/** The `Badge` variants this palette selects from — a subset, spelled to stay assignable. */
export type StatusBadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

/** What one status word paints: its title-cased label, and the look that carries it. */
export interface StatusBadgeLook {
  label: string
  variant?: StatusBadgeVariant
  className?: string
}

/** The closed switch, as data. One arm per word, unchanged in what it paints. */
export function statusBadgeLook(status: string): StatusBadgeLook {
  switch (status) {
    case 'passed':
      return { label: 'Passed', className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20' }
    case 'failed':
      return { label: 'Failed', variant: 'destructive' }
    case 'healed':
      return { label: 'Healed', className: 'bg-amber-500/15 text-amber-500 border-amber-500/20' }
    case 'flaky':
      return { label: 'Flaky', className: 'bg-amber-500/15 text-amber-500 border-amber-500/20' }
    case 'skipped':
      return { label: 'Skipped', variant: 'secondary' }
    case 'cancelled':
      return { label: 'Cancelled', className: 'bg-muted text-muted-foreground border-border' }
    case 'timeout':
      return { label: 'Timed out', variant: 'destructive' }
    case 'running':
      return { label: 'Running', className: 'bg-blue-500/15 text-blue-500 border-blue-500/20 animate-pulse' }
    case 'pending':
      return { label: 'Pending', variant: 'outline' }
    default:
      return { label: status, variant: 'outline' }
  }
}
