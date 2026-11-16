import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'
import { actionSentenceText, buildActionSentence, RESULT_WORDS } from './action-vocabulary'
import { formatOffset, type TimelineMarker, type TimelineModel } from './playhead'

export const TIMELINE_COPY = textTable({
  slider: () => t('player.timeline.slider'),
  signals: () => t('player.timeline.signals'),
  results: () => RESULT_WORDS,
})

export type MarkerDensity = 'glyph' | 'tick' | 'scroll'
export const MARKER_DENSITIES = ['glyph', 'tick', 'scroll'] as const satisfies readonly MarkerDensity[]
export const TICK_SLOT_PX = 16
export const SCROLL_SLOT_PX = 8

export function markerDensity(slotWidth: number): MarkerDensity {
  return slotWidth < SCROLL_SLOT_PX ? 'scroll' : slotWidth < TICK_SLOT_PX ? 'tick' : 'glyph'
}

export function timelineValueText(marker: TimelineMarker, total: number): string {
  const time = formatOffset(marker.recordingOffsetMs)
  const values = {
    step: marker.stepIndex + 1,
    index: marker.ordinal,
    total,
    sentence: actionSentenceText(buildActionSentence(marker.subAction)),
    result: RESULT_WORDS[marker.result],
  }
  return time === undefined
    ? t('player.timeline.marker', values)
    : t('player.timeline.markerAt', { ...values, time })
}

export function timelineReadout(model: TimelineModel, marker: TimelineMarker | undefined, short = false, position?: number): string {
  const ordinal = marker?.ordinal ?? 0
  const total = model.markers.length
  if (short) return `#${ordinal}/${total}`
  const offset = model.axis === 'time' ? formatOffset(position === undefined ? marker?.recordingOffsetMs : position * model.extent) : undefined
  return offset === undefined
    ? t('player.timeline.readout', { index: ordinal, total })
    : t('player.timeline.readoutAt', { index: ordinal, total, offset, extent: formatOffset(model.extent) ?? '' })
}
