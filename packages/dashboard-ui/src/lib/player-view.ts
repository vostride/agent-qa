import type { RecordingEntry } from '@vostride/agent-qa-schema'
import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'
import { buildActionSentence, RESULT_WORDS } from './action-vocabulary'
import { EVIDENCE_COPY, EVIDENCE_RETRY_LABELS } from './evidence-state-view'
import { formatOffset, type PlayerSource, type TimelineAxis, type TimelineMarker, type UsableFrame } from './playhead'

export const PLAYER_COPY = textTable({
  frames: () => t('player.frames'),
  video: () => t('player.video'),
  source: () => t('player.source'),
  framesTooltip: () => t('player.framesTooltip'),
  play: () => t('player.play'),
  pause: () => t('player.pause'),
  speed: () => t('player.speed'),
  substitution: () => (shown: number, total: number) => t('player.substitution', { shown, total }),
  lightboxTitle: () => t('player.lightboxTitle'),
  lightboxClose: () => t('player.lightboxClose'),
  lightboxNote: () => t('player.lightboxNote'),
})
export const PLAYER_SOURCE_STORAGE_KEY = 'agent-qa.run-detail.player-source'
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8, 16] as const
export const DEFAULT_PLAYBACK_SPEED = 4
export const VIDEO_UNTIMED_NOTE = () => t('player.videoUntimed')

export function initialPlayerSource(recording: RecordingEntry | undefined, axis: TimelineAxis, storage?: Pick<Storage, 'getItem'>): PlayerSource {
  if (recording?.state !== 'present' || axis === 'ordinal') return 'frames'
  try {
    return (storage ?? globalThis.localStorage)?.getItem(PLAYER_SOURCE_STORAGE_KEY) === 'frames' ? 'frames' : 'video'
  } catch {
    return 'video'
  }
}

export function storePlayerSource(source: PlayerSource, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? globalThis.localStorage)?.setItem(PLAYER_SOURCE_STORAGE_KEY, source) } catch { /* Storage is optional. */ }
}

export function mediaErrorView(kind: 'frame' | 'video', error: { status?: number; blobAbsent?: boolean }) {
  if (error.status === 404 || error.blobAbsent) return {
    state: 'unavailable' as const,
    incomplete: true,
    ...EVIDENCE_COPY[kind].unavailable,
    explanation: EVIDENCE_COPY.frame.unavailable.explanation,
  }
  return {
    state: 'failed' as const,
    failure: 'load' as const,
    ...EVIDENCE_COPY[kind].failed.load,
    actionLabel: EVIDENCE_RETRY_LABELS[kind],
  }
}

export function captionModel(marker: TimelineMarker, frame?: UsableFrame) {
  return {
    sentence: buildActionSentence(marker.subAction),
    ordinal: marker.ordinal,
    result: RESULT_WORDS[marker.result],
    offset: formatOffset(marker.recordingOffsetMs),
    ...(frame?.substitution ? {
      substitution: PLAYER_COPY.substitution(frame.substitution.shown, frame.substitution.total),
      frameSourceSubAction: frame.index,
    } : {}),
  }
}
