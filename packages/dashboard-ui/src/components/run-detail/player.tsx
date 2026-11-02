import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { Pause, Play, Crosshair, Maximize2, Minimize2, Search } from 'lucide-react'
import type { RecordingEntry, RunDetailArtifactRef } from '@vostride/agent-qa-schema'
import { validRecordedAnnotation } from '@vostride/agent-qa-schema'
import { ScreenshotViewer } from '@/components/screenshot-viewer'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EVIDENCE_COPY, resolveEvidenceView } from '@/lib/evidence-state-view'
import { formatOffset, frameUsable, type PlayerSource, type Playhead, type TimelineModel, type UsableFrame } from '@/lib/playhead'
import { captionModel, mediaErrorView, PLAYER_COPY, PLAYBACK_SPEEDS, storePlayerSource, VIDEO_UNTIMED_NOTE } from '@/lib/player-view'
import { routes } from '@/lib/routes'
import { probeMediaError } from '@/lib/media-error-probe'
import { frameAnnotation, videoActionOffset, videoActionCue } from '@/lib/frame-annotation'
import { MediaViewport } from '@/components/media-viewport'
import type { StepAnnotation } from '@/lib/api'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import type { MediaFacade } from '@/test/media-facade'
import type { SuiteClock } from '@/lib/suite-timeline'
import { ActionSentence } from './action-sentence'
import { EvidenceState } from './evidence-state'

export function PlayerFrame({ runId, frame, annotation, wholeStep = false, embedded }: {
  runId: string
  frame?: RunDetailArtifactRef
  annotation?: StepAnnotation
  wholeStep?: boolean
  embedded?: { magnifier: boolean; annotationsVisible: boolean; fullscreen: boolean; onAvailability?: (available: boolean) => void }
}) {
  const [error, setError] = useState<ReturnType<typeof mediaErrorView>>()
  const [attempt, setAttempt] = useState(0)
  const request = useRef<AbortController | null>(null)
  const url = frame ? routes.runArtifact(runId, frame.sha) : undefined
  useEffect(() => () => request.current?.abort(), [url])
  if (error || (frame && !frameUsable(frame))) return (
    <div data-artifact-state='unavailable' className='p-3'>
      <EvidenceState kind='frame' {...(error ?? mediaErrorView('frame', { blobAbsent: true }))}
        onAction={() => { setError(undefined); setAttempt(value => value + 1) }} />
    </div>
  )
  if (!frameUsable(frame)) return (
    <div data-artifact-state='unavailable' className='p-3'>
      <EvidenceState kind='frame' state='not-captured' {...EVIDENCE_COPY.frame['not-captured'][wholeStep ? 'step' : 'sub-action']} />
    </div>
  )
  return (
    <div data-artifact-state='available' className='p-3'>
      <ScreenshotViewer key={attempt} src={url!} annotation={annotation} embedded={embedded} onUnavailable={() => {
        request.current?.abort()
        const controller = new AbortController()
        request.current = controller
        void probeMediaError(url!, controller.signal).then(result => {
          if (!controller.signal.aborted) setError(mediaErrorView('frame', result))
        })
      }} />
    </div>
  )
}

export interface PlayerProps {
  model: TimelineModel
  playhead: Playhead | null
  source: PlayerSource
  recording?: RecordingEntry
  frame?: UsableFrame
  runId: string
  onSourceChange: (source: PlayerSource) => void
  onPlayheadChange: (playhead: Playhead) => void
  seekFraction?: number
  seekRevision?: number
  onProgress?: (testIndex: number, seconds: number) => void
  onPlayheadObserved?: (playhead: Playhead) => void
  onRecordingEnded?: () => void
  autoPlay?: boolean
  media?: MediaFacade
  timeline?: ReactNode
  clock?: SuiteClock
  isTimelineKeyIgnored?: (event: KeyboardEvent) => boolean
}

function PlayerFooter({ timeline, caption, controls, note, readout }: {
  timeline?: ReactNode
  caption: ReactNode
  controls: ReactNode
  note?: ReactNode
  readout?: ReactNode
}) {
  return <div data-player-footer className='pb-2'>
    <div data-player-timeline-row className='flex min-w-0 items-start pr-3'>{timeline}{readout}</div>
    <div data-player-actions className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3'>
      {caption}
      <div data-player-controls className='ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2'>{controls}</div>
    </div>
    {note && <p className='px-3 pt-1 text-xs text-muted-foreground'>{note}</p>}
  </div>
}

// A seek written before the media has data, or while another seek is still pending, can leave
// Chromium resuming a suspended preload='metadata' pipeline on a non-key frame (MEDIA_ERR_DECODE).
const HAVE_CURRENT_DATA = 2

function addressKey(playhead: Playhead | null | undefined) {
  return playhead ? `${playhead.testIndex}:${playhead.stepIndex}:${playhead.subActionIndex}` : ''
}

function PlayerVideo({ model, playhead, recording, runId, media, seekFraction, seekRevision, onPlayheadChange, onPlayheadObserved, onProgress, onRecordingEnded, autoPlay, speed, setSpeed, isTimelineKeyIgnored, readoutHost, transportHost, toolbar, view, clock }: PlayerProps & {
  recording: Extract<RecordingEntry, { state: 'present' }>
  readoutHost: HTMLElement | null
  transportHost: HTMLElement | null
  toolbar: ReactNode
  speed: number
  setSpeed: (speed: number) => void
  view: { magnifier: boolean; annotationsVisible: boolean; fullscreen: boolean; onAvailability?: (available: boolean) => void }
}) {
  const element = useRef<HTMLVideoElement>(null)
  const active = useRef<MediaFacade | null>(null)
  const latest = useRef({ model, playhead, onPlayheadChange, onPlayheadObserved, onProgress, onRecordingEnded })
  latest.current = { model, playhead, onPlayheadChange, onPlayheadObserved, onProgress, onRecordingEnded }
  const followed = useRef('')
  const mediaReady = useRef(false)
  const consumedSeek = useRef<{ fraction: number; revision: number | undefined } | null>(null)
  const hasData = useRef(false)
  const pendingSeek = useRef<number | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [error, setError] = useState<ReturnType<typeof mediaErrorView>>()
  const [attempt, setAttempt] = useState(0)
  const url = routes.runArtifact(runId, recording.ref.sha)
  const marker = model.markers.find(candidate => addressKey(candidate) === addressKey(playhead))
  const offset = marker ? videoActionOffset(marker.subAction) : undefined
  const key = addressKey(playhead)
  const cue = view.annotationsVisible ? videoActionCue(model.markers.map(candidate => candidate.subAction), time * 1000, dimensions.width, dimensions.height) : undefined

  useEffect(() => {
    const facade = media ?? element.current
    if (!facade) return
    active.current = facade
    mediaReady.current = false
    consumedSeek.current = null
    hasData.current = false
    pendingSeek.current = undefined
    setReady(false)
    const controller = new AbortController()
    let animation: number | undefined
    const stopAnimation = () => {
      if (animation !== undefined) cancelAnimationFrame(animation)
      animation = undefined
    }
    const loaded = () => {
      mediaReady.current = true
      setReady(true)
      view.onAvailability?.(true)
      setTime(facade.currentTime)
      setDimensions({ width: element.current?.videoWidth ?? 0, height: element.current?.videoHeight ?? 0 })
    }
    // Chromium may fail later decodes if a suspended start's first seek waits for a later task.
    const loadedInEvent = () => flushSync(loaded)
    const settle = () => {
      const target = pendingSeek.current
      if (target === undefined || !canSeek(facade)) return
      pendingSeek.current = undefined
      facade.currentTime = target
      setTime(facade.currentTime)
    }
    const dataLoaded = () => { hasData.current = true; settle() }
    const seeked = () => { update(); settle() }
    const update = () => {
      setTime(facade.currentTime)
      latest.current.onProgress?.(latest.current.model.testIndex, facade.currentTime)
      if (facade.paused || latest.current.model.axis !== 'time') return
      const current = latest.current.model.markers.filter(candidate => videoActionOffset(candidate.subAction)! <= facade.currentTime * 1000)
        .reduce<typeof marker>((last, candidate) => !last || videoActionOffset(candidate.subAction)! >= videoActionOffset(last.subAction)! ? candidate : last, undefined)
      if (!current || addressKey(current) === addressKey(latest.current.playhead) || addressKey(current) === followed.current) return
      followed.current = addressKey(current)
      const observe = latest.current.onPlayheadObserved ?? latest.current.onPlayheadChange
      observe({ testIndex: current.testIndex, stepIndex: current.stepIndex, subActionIndex: current.subActionIndex })
    }
    const tick = () => {
      animation = undefined
      if (facade.paused || controller.signal.aborted) return
      update()
      animation = requestAnimationFrame(tick)
    }
    const ended = () => {
      stopAnimation(); facade.pause(); setPlaying(false); setTime(facade.currentTime)
      latest.current.onRecordingEnded?.()
    }
    const failed = () => {
      facade.pause()
      view.onAvailability?.(false)
      void probeMediaError(url, controller.signal).then(result => {
        if (!controller.signal.aborted) { setError(mediaErrorView('video', result)); setReady(false) }
      })
    }
    const onPlay = () => { setPlaying(true); stopAnimation(); animation = requestAnimationFrame(tick) }
    const onPause = () => { setPlaying(false); stopAnimation() }
    const events: Record<string, EventListener> = {
      loadedmetadata: loadedInEvent,
      resize: loadedInEvent,
      loadeddata: dataLoaded,
      timeupdate: update,
      seeked,
      ended,
      error: failed,
      play: onPlay,
      pause: onPause,
    }
    for (const [name, listener] of Object.entries(events)) facade.addEventListener(name, listener)
    if (!facade.paused) facade.pause()
    if (!media && element.current && element.current.readyState >= 1) loaded()
    return () => {
      controller.abort()
      stopAnimation()
      for (const [name, listener] of Object.entries(events)) facade.removeEventListener(name, listener)
      if (!facade.paused) facade.pause()
      active.current = null
    }
  }, [media, url, attempt])

  useEffect(() => {
    if (!ready || !mediaReady.current || model.axis !== 'time' || offset === undefined || !active.current) return
    if (followed.current === key) { followed.current = ''; return }
    seekTo(active.current, offset / 1000)
  }, [ready, model.axis, key, offset])

  useEffect(() => {
    if (seekFraction === undefined || !Number.isFinite(seekFraction)) {
      consumedSeek.current = null
      return
    }
    if (!ready || !mediaReady.current || model.axis !== 'time'
      || recording.durationMs === undefined || !active.current) return
    // Duration publication is an observation, not another command. Keep an
    // unconsumed command pending until metadata/timing is usable for this media.
    if (consumedSeek.current?.fraction === seekFraction && consumedSeek.current.revision === seekRevision) return
    followed.current = ''
    seekTo(active.current, Math.max(0, Math.min(1, seekFraction)) * recording.durationMs / 1000)
    consumedSeek.current = { fraction: seekFraction, revision: seekRevision }
  }, [ready, model.axis, seekFraction, seekRevision, recording.durationMs, media, url, attempt])

  function canSeek(facade: MediaFacade) {
    return (hasData.current || facade.readyState >= HAVE_CURRENT_DATA) && !facade.seeking
  }

  function seekTo(facade: MediaFacade, seconds: number) {
    if (!canSeek(facade)) { pendingSeek.current = seconds; return }
    pendingSeek.current = undefined
    facade.currentTime = seconds
    setTime(facade.currentTime)
  }

  useEffect(() => {
    if (active.current) active.current.playbackRate = speed
  }, [speed, attempt])

  useEffect(() => {
    if (ready && autoPlay) void active.current?.play().catch(() => {
      setError(mediaErrorView('video', {})); setReady(false); view.onAvailability?.(false)
    })
  }, [ready, autoPlay])

  function togglePlayback() {
    const facade = active.current
    if (!ready || !facade) return false
    if (facade.paused) void facade.play().catch(() => { setError(mediaErrorView('video', {})); setReady(false); view.onAvailability?.(false) })
    else facade.pause()
  }

  useKeyboardShortcuts({
    ' ': event => {
      if (!isTimelineKeyIgnored || isTimelineKeyIgnored(event)) return false
      return togglePlayback()
    },
  })

  return <>
    <div data-player-preview className='relative px-3 pt-3' data-artifact-state={error ? 'unavailable' : 'available'}>
      {error ? <EvidenceState {...error} kind='video' onAction={() => {
        setError(undefined); setReady(false); setPlaying(false); followed.current = ''; setAttempt(value => value + 1)
      }} /> : <MediaViewport {...dimensions} magnifier={view.magnifier} fullscreen={view.fullscreen} mediaKey={`${url}:${attempt}`}
        annotation={cue?.annotation} annotationLabel={cue?.recent ? 'Last recorded action' : undefined}>
        <video key={attempt} ref={element} src={url} preload='metadata' muted playsInline className='h-full w-full object-contain' />
      </MediaViewport>}
      {toolbar}
    </div>
    {readoutHost && createPortal(<PlayerTime elapsedMs={clock ? clock.offsetMs === undefined ? undefined : clock.offsetMs + time * 1000 : time * 1000}
      totalMs={clock ? clock.totalMs : recording.durationMs} />, readoutHost)}
    {transportHost && createPortal(<>
      <Button size='icon-sm' variant='ghost' aria-label={playing ? PLAYER_COPY.pause : PLAYER_COPY.play} disabled={!ready}
        onClick={togglePlayback}>
        {playing ? <Pause className='h-4 w-4' /> : <Play className='h-4 w-4' />}
      </Button>
      <Select value={String(speed)} onValueChange={value => {
        const next = Number(value)
        if (!PLAYBACK_SPEEDS.some(candidate => candidate === next)) return
        setSpeed(next)
        if (active.current) active.current.playbackRate = next
      }}>
        <SelectTrigger aria-label={PLAYER_COPY.speed} size='sm' className='w-[60px] shrink-0 gap-0.5 px-1.5 [&>svg]:size-3'><SelectValue /></SelectTrigger>
        <SelectContent>{PLAYBACK_SPEEDS.map(value => <SelectItem key={value} value={String(value)}>{value}×</SelectItem>)}</SelectContent>
      </Select>
    </>, transportHost)}
  </>
}

function PlayerTime({ elapsedMs, totalMs }: { elapsedMs?: number; totalMs?: number }) {
  return <span data-player-time data-player-elapsed-ms={elapsedMs} data-player-total-ms={totalMs}
    title={totalMs === undefined ? 'Full playback time is unavailable because a recording duration is missing or still loading.' : undefined}
    className='mt-2.5 min-w-0 font-mono text-xs leading-4 tabular-nums'>
    <span data-player-timestamp className='inline-block max-w-full [overflow-wrap:anywhere]'>{formatOffset(elapsedMs) ?? '—'}</span>
    {' / '}<span data-player-timestamp className='inline-block max-w-full [overflow-wrap:anywhere]'>{formatOffset(totalMs) ?? '—'}</span>
  </span>
}

export function Player(props: PlayerProps) {
  const [speed, setSpeed] = useState(1)
  const [magnifier, setMagnifier] = useState(false)
  const [annotationsVisible, setAnnotationsVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [mediaAvailable, setMediaAvailable] = useState(false)
  const [readoutHost, setReadoutHost] = useState<HTMLSpanElement | null>(null)
  const [transportHost, setTransportHost] = useState<HTMLSpanElement | null>(null)
  const section = useRef<HTMLElement>(null)
  const fullscreenButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    fullscreenButton.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFullscreen(false) }
      if (event.key === 'Tab') {
        const controls = [...section.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', keydown, true)
      fullscreenButton.current?.focus()
    }
  }, [fullscreen])
  const { model, playhead, source, recording, frame, runId, onSourceChange } = props
  const marker = model.markers.find(candidate => candidate.testIndex === playhead?.testIndex
    && candidate.stepIndex === playhead.stepIndex && candidate.subActionIndex === playhead.subActionIndex)
  const selectedFrame = frame?.ref ?? marker?.ref
  useEffect(() => { setMediaAvailable(false) }, [runId, model.testIndex, source, source === 'frames' ? selectedFrame?.sha : undefined, recording?.state === 'present' ? recording.ref.sha : undefined])
  // A parent-step fallback can show an earlier action. Its geometry must follow its bytes.
  const frameOwner = frame ? model.markers.find(candidate => candidate.testIndex === playhead?.testIndex
    && candidate.stepIndex === playhead.stepIndex && candidate.subActionIndex === frame.index
    && candidate.ref?.sha === frame.ref.sha) : marker
  const caption = marker ? captionModel(marker, frame) : undefined
  const videoView = resolveEvidenceView({ kind: 'video', selection: 'sub-action', entry: recording, read: 'idle' })
  const absent = videoView.kind === 'state'
  const videoName = absent ? `${PLAYER_COPY.video} — ${videoView.title}` : PLAYER_COPY.video
  const available = mediaAvailable && (source === 'frames' ? frameUsable(selectedFrame) : !absent)
  const hasAnnotations = source === 'frames' ? !!frameAnnotation(frameOwner?.subAction)
    : model.markers.some(candidate => candidate.subAction.result.annotation && validRecordedAnnotation(candidate.subAction.result.annotation))
  const annotationTitle = source === 'video' && !hasAnnotations
    ? 'This recording has no saved timing to place action highlights on the video. Open Frames to see any saved action highlights.'
    : annotationsVisible ? 'Hide annotations' : 'Show annotations'
  const toggle = <ToggleGroup type='single' value={source} aria-label={PLAYER_COPY.source} onValueChange={value => {
          if (value === 'frames' || value === 'video') { storePlayerSource(value); onSourceChange(value) }
        }}>
          <ToggleGroupItem value='frames' title={PLAYER_COPY.framesTooltip} className='text-xs'>{PLAYER_COPY.frames}</ToggleGroupItem>
          <ToggleGroupItem value='video' aria-label={videoName} title={videoName} className={`text-xs${absent ? ' opacity-60' : ''}`}>{PLAYER_COPY.video}</ToggleGroupItem>
        </ToggleGroup>
  const toolbar = <div data-player-preview-toolbar className='absolute bottom-2 right-5 z-20 flex flex-col rounded-md border bg-background/90 p-0.5 text-muted-foreground shadow-sm'>
    <Button size='icon-sm' variant='ghost' className={`h-7 w-7${magnifier ? ' bg-primary/15 text-primary ring-1 ring-inset ring-primary/40' : ''}`} aria-label={magnifier ? 'Disable magnifier' : 'Enable magnifier'} aria-pressed={magnifier}
      disabled={!available} onClick={() => setMagnifier(value => !value)}><Search className='h-3.5 w-3.5' /></Button>
    <span title={annotationTitle} tabIndex={!hasAnnotations ? 0 : undefined} aria-label={!hasAnnotations ? annotationTitle : undefined}>
      <Button size='icon-sm' variant='ghost' className='h-7 w-7' aria-label={annotationsVisible ? 'Hide annotations' : 'Show annotations'} aria-pressed={annotationsVisible}
        disabled={!available || !hasAnnotations} onClick={() => setAnnotationsVisible(value => !value)}><Crosshair className='h-3.5 w-3.5' /></Button>
    </span>
    <Button ref={fullscreenButton} size='icon-sm' variant='ghost' className='h-7 w-7' aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} disabled={!available && !fullscreen}
      onClick={() => setFullscreen(value => !value)}>{fullscreen ? <Minimize2 className='h-3.5 w-3.5' /> : <Maximize2 className='h-3.5 w-3.5' />}</Button>
  </div>
  const view = { magnifier, annotationsVisible, fullscreen, onAvailability: setMediaAvailable }
  const title = marker && caption && <div data-player-caption data-frame-source-sub-action={caption.frameSourceSubAction}
        className='min-w-0 flex-1 basis-40 text-sm font-medium [overflow-wrap:anywhere] [&_[data-action-family]]:text-sm [&_[data-action-family]]:font-medium'>
        <ActionSentence sub={marker.subAction} wrap='free' />
        {caption.substitution && <p className='text-xs text-muted-foreground'>{caption.substitution}</p>}
      </div>
  return (
    <section ref={section} data-player data-player-source={source} role={fullscreen ? 'dialog' : undefined}
      aria-modal={fullscreen ? true : undefined} aria-label={fullscreen ? 'Evidence media fullscreen' : undefined}
      className={fullscreen ? 'fixed inset-0 z-50 overflow-auto bg-background p-4' : undefined}>
      {source === 'video' && recording?.state === 'present' && !absent
        ? <PlayerVideo key={`${runId}:${model.testIndex}:${recording.ref.sha}`} {...props} speed={speed} setSpeed={setSpeed} recording={recording} readoutHost={readoutHost} transportHost={transportHost} toolbar={toolbar} view={view} />
        : <div data-player-preview className='relative [&>[data-artifact-state]]:pb-0'>
      {source === 'frames' && <PlayerFrame key={`${runId}:${selectedFrame?.sha ?? 'none'}:${playhead?.stepIndex}:${playhead?.subActionIndex}`}
        runId={runId} frame={selectedFrame} annotation={frameAnnotation(frameOwner?.subAction)} wholeStep={!marker} embedded={view} />}
      {source === 'video' && videoView.kind === 'state' && <div className='p-3' data-artifact-state='unavailable'>
        <EvidenceState {...videoView} kind='video' />
      </div>}
      {toolbar}
      </div>}
      {/* The gesture owner stays outside member-keyed media, including absent/source transitions. */}
      <PlayerFooter timeline={props.timeline} caption={title}
        note={source === 'video' && recording?.state === 'present' && !absent && model.axis === 'ordinal' ? VIDEO_UNTIMED_NOTE : undefined}
        readout={<span ref={setReadoutHost} className={source === 'video' ? 'flex w-[13ch] shrink-0 font-mono text-xs' : 'contents'}>
          {source === 'video' && (recording?.state !== 'present' || absent) && <PlayerTime totalMs={props.clock?.totalMs} />}
        </span>}
        controls={<><span ref={setTransportHost} className='contents' />{toggle}</>} />
    </section>
  )
}
