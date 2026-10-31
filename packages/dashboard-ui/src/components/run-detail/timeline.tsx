import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { CircleSlash, Layers } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ACTION_FAMILY_ICONS, UNKNOWN_ACTION_ICON, buildActionSentence } from '@/lib/action-vocabulary'
import type { SuiteTimelineModel } from '@/lib/suite-timeline'
import { ActionSentence } from './action-sentence'
import { nearestMarker, snapToMarker, type Playhead, type PlayerSource, type TimelineMarker, type TimelineModel } from '@/lib/playhead'
import { TIMELINE_COPY, timelineValueText } from '@/lib/timeline-view'

export interface TimelineProps {
  model: TimelineModel
  playhead: Playhead | null
  source: PlayerSource
  memberLabel?: string
  seekFraction?: number
  observedPosition?: number
  mediaDurationsReady?: boolean
  onPlayheadChange: (playhead: Playhead) => void
  onSeekFraction: (fraction: number, address?: Playhead) => void
}

/** One compact scrubber; action details and evidence counts live in their respective panes. */
export function Timeline({ model, playhead, source, memberLabel, seekFraction, observedPosition, mediaDurationsReady, onPlayheadChange, onSeekFraction }: TimelineProps) {
  const track = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(320)
  const [openGroup, setOpenGroup] = useState<number | null>(null)
  const members = (model as Partial<SuiteTimelineModel>).members
  useEffect(() => {
    const element = track.current
    if (!element) return
    const measure = () => { if (element.clientWidth > 0) setWidth(element.clientWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const slider = useRef<HTMLSpanElement>(null)
  const dragging = useRef<{ pointerId: number; startX: number; moved: boolean; group?: number } | null>(null)
  const current = model.markers.find(marker => marker.testIndex === playhead?.testIndex
    && marker.stepIndex === playhead.stepIndex && marker.subActionIndex === playhead.subActionIndex)
  const videoPosition = observedPosition ?? seekFraction
  const position = source === 'video' && videoPosition !== undefined ? Math.max(0, Math.min(1, videoPosition)) : current?.position
  function select(marker: TimelineMarker) {
    onPlayheadChange({ testIndex: marker.testIndex, stepIndex: marker.stepIndex, subActionIndex: marker.subActionIndex })
  }
  function scrub(clientX: number) {
    const rect = track.current!.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    const centres = model.markers.map(marker => ({ marker, centrePx: marker.position * rect.width }))
    const snapped = source === 'frames' ? nearestMarker(x, centres) : snapToMarker(x, centres)
    if (snapped) {
      select(snapped)
      if (source === 'video') onSeekFraction(snapped.position, snapped)
    } else if (source === 'video') {
      const fraction = x / rect.width
      const previous = model.markers.filter(marker => marker.position <= fraction).at(-1) ?? model.markers[0]
      if (previous && !members) select(previous)
      onSeekFraction(fraction)
    }
  }
  function beginDrag(event: PointerEvent<HTMLElement>, marker?: TimelineMarker, group?: number) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    slider.current?.focus({ preventScroll: true })
    dragging.current = { pointerId: event.pointerId, startX: event.clientX, moved: false, group }
    track.current!.setPointerCapture(event.pointerId)
    if (marker) activate(marker)
    else if (group === undefined) scrub(event.clientX)
  }
  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const gesture = dragging.current
    if (gesture?.pointerId !== event.pointerId) return
    dragging.current = null
    if (event.type === 'pointerup' && gesture.group !== undefined && !gesture.moved) setOpenGroup(value => value === gesture.group ? null : gesture.group!)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function navigate(event: KeyboardEvent<HTMLSpanElement>) {
    const index = current ? model.markers.indexOf(current) : -1
    let target: TimelineMarker | undefined
    switch (event.key) {
      case 'ArrowLeft': target = model.markers[Math.max(0, index - 1)]; break
      case 'ArrowRight': target = model.markers[Math.min(model.markers.length - 1, index + 1)]; break
      case 'Home': target = model.markers[0]; break
      case 'End': target = model.markers.at(-1); break
      case 'PageUp': target = model.segments.slice(0, model.segments.findIndex(segment => current && segment.markers.includes(current))).filter(segment => segment.markers.length > 0).at(-1)?.markers[0]; break
      case 'PageDown': target = model.segments.slice(model.segments.findIndex(segment => current && segment.markers.includes(current)) + 1).find(segment => segment.markers.length > 0)?.markers[0]; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    if (target) {
      select(target)
      if (source === 'video') onSeekFraction(target.position, target)
    }
  }
  const clusters: TimelineMarker[][] = []
  const markerX = (marker: TimelineMarker) => marker.position * width
  for (const marker of model.markers) {
    const previous = clusters.at(-1)
    if (previous && markerX(marker) - markerX(previous[0]!) < 28) previous.push(marker)
    else clusters.push([marker])
  }
  const playheadPosition = position ?? current?.position ?? 0
  // The circle becomes the visible playhead where the pill would cover its glyph.
  // Keep the slider itself focusable and at the exact unmodified rail coordinate.
  const alignedCluster = clusters.find(cluster => Math.abs(cluster[0]!.position - playheadPosition) * width <= 10)
  const context = (marker: TimelineMarker) => {
    const member = members?.find(entry => entry.model.testIndex === marker.testIndex)
    return `${member ? `${member.label}, ` : ''}Step ${marker.stepIndex + 1}`
  }
  const activate = (marker: TimelineMarker) => {
    select(marker)
    if (source === 'video') onSeekFraction(marker.position, marker)
    setOpenGroup(null)
  }
  if (model.markers.length === 0 && !members?.length) return null
  return (
    <div data-timeline data-timeline-axis={model.axis} data-timeline-member={members ? 'suite' : model.testIndex} data-media-durations-ready={mediaDurationsReady}
      className='min-w-0 flex-1 px-5 py-1'>
      <div ref={track} data-timeline-track className='relative h-7 touch-none cursor-pointer'
        onPointerDown={event => beginDrag(event)}
        onPointerMove={event => {
          const gesture = dragging.current
          if (gesture?.pointerId !== event.pointerId) return
          if (Math.abs(event.clientX - gesture.startX) > 3) gesture.moved = true
          if (gesture.group === undefined || gesture.moved) scrub(event.clientX)
        }}
        onPointerUp={finishDrag} onPointerCancel={finishDrag}
        onLostPointerCapture={() => { dragging.current = null }}>
        <div aria-hidden='true' className='absolute inset-x-0 top-3 h-1 rounded-full bg-muted' />
        {members?.map(member => <span key={member.model.testIndex} data-timeline-member-span={member.model.testIndex}
          className={`absolute top-3 h-1 border-l border-background ${member.group.member.recording?.state !== 'present' ? 'bg-muted-foreground/30' : ''}`}
          style={{ left: `${member.start * 100}%`, width: `${(member.end - member.start) * 100}%` }} />)}
        {(current || position !== undefined) && <>
          <div aria-hidden='true' className='absolute left-0 top-3 h-1 rounded-full bg-primary/50'
            style={{ width: `${playheadPosition * 100}%` }} />
          <span ref={slider} data-timeline-playhead role='slider' tabIndex={0}
            aria-label={memberLabel ? `${TIMELINE_COPY.slider}: ${memberLabel}` : TIMELINE_COPY.slider}
            aria-orientation='horizontal' onKeyDown={navigate}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((position ?? 0) * 100)}
            aria-valuetext={current ? timelineValueText(current, model.markers.length) : 'No actions recorded for this test'}
            style={{ left: `${playheadPosition * 100}%` }}
            data-playhead-circle={alignedCluster ? true : undefined}
            className={`pointer-events-none absolute z-10 -translate-x-1/2 rounded-full ${alignedCluster ? 'top-1 h-5 w-5 bg-transparent' : 'top-[5px] h-[18px] w-1.5 bg-primary'} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`} />
        </>}
        {clusters.map(cluster => {
          const marker = cluster[0]!
          const family = buildActionSentence(marker.subAction).family
          const Icon = family ? ACTION_FAMILY_ICONS[family] : UNKNOWN_ACTION_ICON
          const style = { left: `${marker.position * 100}%` }
          const active = cluster === alignedCluster || (!alignedCluster && cluster.some(entry => entry === current))
          const classes = 'absolute top-0 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-ring'
          const circle = `flex h-5 w-5 items-center justify-center rounded-full border ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30 bg-background text-muted-foreground hover:bg-muted'}`
          return cluster.length === 1 ? <button key={marker.ordinal} type='button' data-timeline-marker={marker.ordinal} data-timeline-active={active || undefined} aria-current={active ? 'step' : undefined} style={style} className={classes}
              aria-label={`${context(marker)}: ${timelineValueText(marker, model.markers.length)}`}
              onPointerDown={event => beginDrag(event, marker)} onClick={event => { if (event.detail === 0) activate(marker) }}><span data-timeline-circle className={circle}><Icon aria-hidden='true' className='h-3 w-3' /></span></button>
            : <Popover key={marker.ordinal} open={openGroup === marker.ordinal} onOpenChange={open => setOpenGroup(open ? marker.ordinal : null)}>
            <PopoverTrigger asChild><button type='button' data-timeline-marker-group data-timeline-active={active || undefined} aria-current={active ? 'step' : undefined} style={style} className={classes}
              aria-label={`Choose from ${cluster.length} nearby actions`} onPointerDown={event => beginDrag(event, undefined, marker.ordinal)}
              onClick={event => { if (event.detail > 0) event.preventDefault() }}><span data-timeline-circle className={circle}><Layers aria-hidden='true' className='h-3 w-3' /></span></button></PopoverTrigger>
            {/* Radix hands focus back to the trigger a tick after the list unmounts. By then another
                group's list can hold focus, and taking it away would dismiss that list. */}
            <PopoverContent className='max-h-64 w-80 overflow-y-auto p-1' aria-label='Nearby actions'
              onPointerDown={event => event.stopPropagation()}
              onCloseAutoFocus={event => { if (document.activeElement !== document.body) event.preventDefault() }}>
              {cluster.map(entry => <button key={entry.ordinal} type='button' data-timeline-marker={entry.ordinal} className='block w-full rounded p-2 text-left hover:bg-muted'
                onClick={() => activate(entry)}><span className='text-xs'>{context(entry)}</span><ActionSentence sub={entry.subAction} /></button>)}
            </PopoverContent>
          </Popover>
        })}
        {members?.filter(member => member.model.markers.length === 0).map(member => <button key={`empty-${member.model.testIndex}`} type='button' data-timeline-empty-member={member.model.testIndex}
            aria-label={`${member.label}: No actions recorded`}
            className='absolute top-0 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-ring'
            style={{ left: `${(member.start + member.end) * 50}%` }}
            onPointerDown={event => beginDrag(event)} onClick={event => { if (event.detail === 0) onSeekFraction((member.start + member.end) / 2) }}>
            <span data-timeline-circle className='flex h-5 w-5 items-center justify-center rounded-full border border-muted-foreground/30 bg-background'><CircleSlash aria-hidden='true' className='h-3 w-3 text-muted-foreground' /></span>
          </button>)}
      </div>
    </div>
  )
}
