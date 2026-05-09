export type NormalizedRunStatus =
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'flaky'
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
    case 'flaky':
      return 'flaky'
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
      return { raw, normalized, label: 'Timed Out', tone: 'danger', terminal: true }
    case 'cancelled':
      return { raw, normalized, label: 'Cancelled', tone: 'muted', terminal: true }
    case 'flaky':
      return { raw, normalized, label: 'Flaky', tone: 'warning', terminal: true }
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

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return getRunStatusDescriptor(status).terminal
}

export function shouldRouteRunToLive(status: string | null | undefined): boolean {
  return normalizeRunStatus(status) === 'running'
}

export function normalizeStepStatus(status: string | null | undefined): NormalizedStepStatus {
  switch (normalizeRunStatus(status)) {
    case 'passed':
      return 'passed'
    case 'cancelled':
      return 'cancelled'
    case 'flaky':
      return 'flaky'
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
    case 'flaky':
      return 'flaky'
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
