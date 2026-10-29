import type { LiveStepRow, StepStatus } from '@/lib/run-stream-reducer'

/**
 * THE LIVE STEP ROW'S WORDS.
 *
 * Each status has its own accessible name, so a glyph's colour is never the only thing that says
 * what state a step is in. The row reads these; it spells none of its own.
 */
export const LIVE_STEP_STATUS_NAMES = {
  pending: 'pending',
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  healed: 'healed',
  skipped: 'skipped',
  cancelled: 'cancelled',
} as const satisfies Record<StepStatus, string>

// a live label is shown as written, an old `<SECRET_n>` included.
export function liveLabelText(raw: string): string {
  return raw
}

/**
 * Whether a live row is drawn at all (owner decision 2026-09-26 (2), G-428-2): "either show the
 * entire step text or don't show it at all". A row whose text is empty or only whitespace is not
 * drawn, so no surface ever paints a `step N` placeholder in its place.
 */
export function liveRowShown(row: Pick<LiveStepRow, 'text'>): boolean {
  // The text arrived as JSON from another process, so a producer that sent none is not drawn
  // rather than throwing here.
  return typeof row.text === 'string' && row.text.trim() !== ''
}
