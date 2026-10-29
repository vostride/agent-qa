import type { LiveStepRow, StepStatus } from '@/lib/run-stream-reducer'

// Each status has its own accessible name, so colour is never the only signal.
export const LIVE_STEP_STATUS_NAMES = {
  pending: 'pending',
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  healed: 'healed',
  skipped: 'skipped',
  cancelled: 'cancelled',
} as const satisfies Record<StepStatus, string>

// A live label is shown as written, an old `<SECRET_n>` included.
export function liveLabelText(raw: string): string {
  return raw
}

// A row with empty or whitespace text is not drawn, so no surface paints a `step N` placeholder.
export function liveRowShown(row: Pick<LiveStepRow, 'text'>): boolean {
  // The text arrived as JSON from another process, so a producer that sent none is not drawn
  // rather than throwing here.
  return typeof row.text === 'string' && row.text.trim() !== ''
}
