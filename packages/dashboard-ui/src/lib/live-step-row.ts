import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'
import type { LiveStepRow, StepStatus } from '@/lib/run-stream-reducer'

// Each status has its own accessible name, so colour is never the only signal.
export const LIVE_STEP_STATUS_NAMES = textTable({
  pending: () => t('status.name.pending'),
  running: () => t('status.name.running'),
  passed: () => t('status.name.passed'),
  failed: () => t('status.name.failed'),
  healed: () => t('status.name.healed'),
  skipped: () => t('status.name.skipped'),
  cancelled: () => t('status.name.cancelled'),
}) satisfies Record<StepStatus, string>

const STATUS_NAMES: Readonly<Record<string, string>> = textTable({
  idle: () => t('status.name.idle'),
  pending: () => t('status.name.pending'),
  running: () => t('status.name.running'),
  cancelling: () => t('status.name.cancelling'),
  passed: () => t('status.name.passed'),
  failed: () => t('status.name.failed'),
  healed: () => t('status.name.healed'),
  flaky: () => t('status.name.flaky'),
  skipped: () => t('status.name.skipped'),
  cancelled: () => t('status.name.cancelled'),
  timeout: () => t('status.name.timeout'),
})

// A status the table does not name is shown as it arrived.
export function statusNameText(status: string): string {
  return Object.hasOwn(STATUS_NAMES, status) ? (STATUS_NAMES[status] as string) : status
}

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
