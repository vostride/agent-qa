import type { RecordingEntry } from '@vostride/agent-qa-schema'
import { buildActionSentence, RESULT_WORDS } from './action-vocabulary'
import { EVIDENCE_COPY, EVIDENCE_RETRY_LABELS } from './evidence-state-view'
import { formatOffset, type PlayerSource, type TimelineAxis, type TimelineMarker, type UsableFrame } from './playhead'

export const PLAYER_COPY = {
  frames: 'Frames',
  video: 'Video',
  source: 'Playback source',
  framesTooltip: 'The exact screenshots the model saw when it decided',
  play: 'Play recording',
  pause: 'Pause recording',
  speed: 'Playback speed',
  substitution: (shown: number, total: number) => `Showing #${shown} of ${total} — the latest sub-action with a screenshot`,
  lightboxTitle: 'Cited screenshot',
  lightboxClose: 'Close screenshot',
  lightboxNote: 'This screenshot is cited by the analysis but does not belong to a recorded sub-action, so it has no place on the timeline.',
} as const
export const PLAYER_SOURCE_STORAGE_KEY = 'agent-qa.run-detail.player-source'
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8, 16] as const
export const DEFAULT_PLAYBACK_SPEED = 4
export const VIDEO_UNTIMED_NOTE = 'This recording cannot be synchronized with the selected action. Switch to Frames to see its screenshot.'

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
