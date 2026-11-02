// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { asRef } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildTimelineModel, latestUsableFrame, type TimelineModel } from '@/lib/playhead'
import type { RunDetailGroup } from '@/lib/run-detail-view'
import { PLAYER_COPY, PLAYER_SOURCE_STORAGE_KEY, VIDEO_UNTIMED_NOTE } from '@/lib/player-view'
import { createFakeMedia } from '@/test/media-facade'
import { routes } from '@/lib/routes'

const modules = import.meta.glob<typeof import('../player')>('../player.tsx', { eager: true })
const lightboxes = import.meta.glob<typeof import('../player-lightbox')>('../player-lightbox.tsx', { eager: true })
type Props = ComponentProps<typeof import('../player').Player>
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
let group: RunDetailGroup
let model: TimelineModel
const change = vi.fn()
const sourceChange = vi.fn()
const sha = 'a'.repeat(64)
beforeEach(() => {
  vi.clearAllMocks()
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: { width: 800, height: 450 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve() {} disconnect() {}
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404 })))
  group = {
    member: { testIndex: 0, attempts: 1 },
    steps: [{
      step: { testIndex: 0, stepIndex: 0, cacheStatus: 'miss', verifierVerdict: { pass: true, reasoning: '' }, selfHealOccurred: false, briefDigest: 'digest' },
      subActions: [0, 1].map(subActionIndex => ({
        testIndex: 0, stepIndex: 0, subActionIndex, plan: 'private reasoning',
        plannedAction: { type: 'fill', ref: asRef('e1'), text: '[secret:PW]', clearMode: 'replace', submit: false },
        result: { success: true }, screenStateHash: 'screen', recordingOffsetMs: subActionIndex * 10000,
        artifactRefs: subActionIndex === 0 ? [{ id: `decision-screenshot:${sha}`, sha }] : [],
      })),
    }],
  }
  model = buildTimelineModel(group)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function render(extra: Partial<Props> = {}) {
  const module = modules['../player.tsx']
  expect(module, 'Player exists').toBeDefined()
  const { Player } = module!
  act(() => root.render(<Player model={model} playhead={model.markers[0]!} source='frames' runId='run' onSourceChange={sourceChange} onPlayheadChange={change} {...extra} />))
}
function query(selector: string) { return host.querySelector<HTMLElement>(selector)! }
function loadImage() {
  const img = query('img')
  Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } })
  act(() => img.dispatchEvent(new Event('load')))
}
async function errorImage() {
  await act(async () => { query('img').dispatchEvent(new Event('error')); await Promise.resolve() })
}

test('PLAYER-OPENS-ON-FRAMES', () => {
  render({ recording: { state: 'absent', reason: 'not-captured' } })
  expect(query('[data-player]').dataset.playerSource).toBe('frames')
  const video = query('[data-slot="toggle-group-item"][aria-label^="Video"]')
  expect(video.getAttribute('aria-label')).toBe('Video — No recording for this test')
  expect(video.className).toContain('opacity-60')
  expect(video.hasAttribute('disabled')).toBe(false)
  act(() => video.click())
  expect(sourceChange).toHaveBeenCalledWith('video')
})
test('PLAYER-FRAME-THREE-ROADS', async () => {
  for (const unavailable of [{ evidenceIncomplete: true }, { present: false }]) {
    const marker = model.markers[0]!
    render({ model: { ...model, markers: [{ ...marker, ref: { ...marker.ref!, ...unavailable } }] } })
    expect(query('[data-evidence-kind="frame"]').dataset.evidenceState).toBe('unavailable')
    expect(query('[data-evidence-kind="frame"]').dataset.evidenceIncomplete).toBe('true')
    expect(query('img')).toBeNull()
  }
  render()
  expect(query('[data-artifact-state="available"] img')).not.toBeNull()
  await errorImage()
  expect(query('[data-evidence-kind="frame"]').dataset.evidenceState).toBe('unavailable')
  expect(query('[data-evidence-kind="frame"]').dataset.evidenceIncomplete).toBe('true')
})
test('PLAYER-CAPTION-SUBSTITUTION', () => {
  render({ frame: latestUsableFrame(group.steps[0]!.subActions) })
  const caption = query('[data-player-caption]')
  expect(caption.textContent).toContain(PLAYER_COPY.substitution(1, 2))
  expect(caption.dataset.frameSourceSubAction).toBe('0')
  expect(caption.className).toContain('[overflow-wrap:anywhere]')
  expect(caption.className).toContain('[&_[data-action-family]]:text-sm')
  expect(caption.textContent).toContain('Filled')
  expect(caption.textContent).not.toContain('passed')
  expect(caption.textContent).not.toContain('0:00')
  expect(caption.textContent).toContain('Filled with [secret:PW]')
  render()
  expect(query('[data-frame-source-sub-action]')).toBeNull()
  expect(query('[data-player-caption]').textContent).not.toContain('Showing')
})
test('PLAYER-ONE-MINTER', () => {
  render()
  expect(query('img').getAttribute('src')).toBe(routes.runArtifact('run', sha))
})
test('PLAYER-FRAME-ANNOTATION follows the shown frame, including parent fallback', () => {
  const actions = group.steps[0]!.subActions
  actions[0]!.result.annotation = { kind: 'point', viewport: { width: 800, height: 600 }, point: { x: 100, y: 200 } }
  actions[1]!.result.annotation = { kind: 'region', viewport: { width: 800, height: 600 }, region: { boundingBox: { x: 300, y: 400, width: 50, height: 60 } } }
  model = buildTimelineModel(group)
  render({ playhead: model.markers[1]!, frame: latestUsableFrame(actions) })
  loadImage()
  expect(query('[title="Hide annotations"]')).not.toBeNull()
  expect(query('.bg-turquoise-500')).not.toBeNull()
  expect(query('.border-emerald-500\\/70')).toBeNull()
  render({ playhead: model.markers[1]! })
  expect(query('img')).toBeNull()
  expect(button('Hide annotations').disabled).toBe(true)
  render({ frame: { index: 99, ref: model.markers[0]!.ref! } })
  loadImage()
  expect(button('Hide annotations').disabled).toBe(true)
})
test('PLAYER-FRAME-NOT-CAPTURED-ROWS', () => {
  render({ playhead: model.markers[1]! })
  expect(query('[data-evidence-kind="frame"]').textContent).toContain('No screenshot for this action')
  render({ model: { ...model, markers: [], segments: [] }, playhead: null })
  expect(query('[data-evidence-kind="frame"]').textContent).toContain('No screenshots for this step')
})

function recording() {
  return { state: 'present' as const, ref: { id: `recording:${sha}` as const, sha }, contentType: 'video/webm' as const, byteLength: 100, durationMs: 20000 }
}
function video(extra: Partial<Props> = {}) {
  group.member.recording = recording()
  model = buildTimelineModel(group)
  const media = createFakeMedia(Infinity)
  render({ source: 'video', recording: recording(), media, ...extra })
  return media
}
// A preload='metadata' load as Chromium delivers it: the first frame's data arrives with the metadata.
function metadata(media: ReturnType<typeof createFakeMedia>) { act(() => { media.fire('loadedmetadata'); media.fire('loadeddata') }) }
function button(name: string) { return query(`button[aria-label="${name}"]`) as HTMLButtonElement }

test('PLAYER-SHARED-FRAME-CONTROLS: visible toolbar retains annotated image through magnifier, fullscreen, Escape and toggle', () => {
  group.steps[0]!.subActions[0]!.result.annotation = { kind: 'point', viewport: { width: 800, height: 600 }, point: { x: 100, y: 200 } }
  model = buildTimelineModel(group)
  render()
  loadImage()
  const img = query('img')
  const overlay = query('[data-annotation="point"]')
  expect(overlay.style.left).toBe('75px') // 800x600 contained in 800x450 => 600x450
  expect(query('[data-media-transform]').style.left).toBe('100px')
  expect(query('[data-player-preview-toolbar]').contains(button('Enable magnifier'))).toBe(true)
  expect(host.querySelector('[title="View full size"]')).toBeNull()
  act(() => button('Enable magnifier').click())
  expect(button('Disable magnifier').getAttribute('aria-pressed')).toBe('true')
  act(() => button('Enter fullscreen').click())
  expect(query('[role="dialog"]')).not.toBeNull()
  expect(query('img')).toBe(img)
  expect(query('[data-annotation="point"]')).toBe(overlay)
  expect(button('Disable magnifier').closest('[role="dialog"]')).not.toBeNull()
  act(() => button('Hide annotations').click())
  expect(query('[data-annotation]')).toBeNull()
  act(() => button('Show annotations').click())
  expect(query('[data-annotation]')).not.toBeNull()
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(query('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(button('Enter fullscreen'))
  expect(query('img')).toBe(img)
  expect(document.body.style.overflow).toBe('')
})

test('PLAYER-VIDEO-ANNOTATION-INTERVAL: uses execution witness, same geometry and same live element in fullscreen', async () => {
  group.steps[0]!.subActions[0]!.result.annotation = { kind: 'point', viewport: { width: 800, height: 600 }, point: { x: 100, y: 200 },
    recording: { startMs: 2000, endMs: 4000, width: 800, height: 600, scene: 'recorded-page', transform: 'identity' } }
  const media = video()
  const element = query('video')
  Object.defineProperties(element, { videoWidth: { value: 800 }, videoHeight: { value: 600 } })
  metadata(media)
  expect(media.currentTime).toBe(3)
  expect(query('[data-annotation]')).not.toBeNull()
  act(() => media.fire('seeked', 2))
  expect(query('[data-annotation="point"]').style.left).toBe('75px')
  expect(query('[data-media-transform]').style.left).toBe('100px')
  await act(async () => button(PLAYER_COPY.play).click())
  media.playbackRate = 2
  const seeks = [...media.seeks]
  act(() => button('Enable magnifier').click())
  act(() => button('Enter fullscreen').click())
  expect(query('video')).toBe(element)
  expect(host.querySelectorAll('video')).toHaveLength(1)
  expect(media.currentTime).toBe(2)
  expect(media.playbackRate).toBe(2)
  expect(media.paused).toBe(false)
  expect(media.seeks).toEqual(seeks)
  expect(query('[role="dialog"] [data-annotation]')).not.toBeNull()
  expect(query('[role="dialog"] button[aria-label="Pause recording"]')).not.toBeNull()
  act(() => media.fire('timeupdate', 4))
  expect(query('[data-annotation]')).toBeNull()
  act(() => media.fire('seeked', 3))
  expect(query('[data-annotation]')).not.toBeNull()
  act(() => button('Hide annotations').click())
  expect(query('[data-annotation]')).toBeNull()
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(query('video')).toBe(element)
  render({ source: 'frames' })
  expect(media.paused).toBe(true)
  expect(query('video')).toBeNull()
})

test('PLAYER-MISSING-MEDIA-CONTROLS: same toolbar stays present and disabled with discoverable annotation limits', () => {
  render({ playhead: model.markers[1]! })
  for (const name of ['Enable magnifier', 'Hide annotations', 'Enter fullscreen']) expect(button(name).disabled).toBe(true)
  render({ source: 'video', recording: { state: 'absent', reason: 'not-captured' } })
  for (const name of ['Enable magnifier', 'Hide annotations', 'Enter fullscreen']) expect(button(name).disabled).toBe(true)
  expect(query('[aria-label^="This recording has no saved timing"]')).not.toBeNull()
  expect(query('[aria-label^="This recording has no saved timing"]').tabIndex).toBe(0)
})

test('PLAYER-OPENS-ON-VIDEO', () => {
  const media = video()
  expect(query('[data-player]').dataset.playerSource).toBe('video')
  expect(query('video')).not.toBeNull()
  expect(media.paused).toBe(true)
  expect(button(PLAYER_COPY.play).disabled).toBe(true)
  metadata(media)
  expect(button(PLAYER_COPY.play).disabled).toBe(false)
})
test('PLAYER-VIDEO-ATTRIBUTES', () => {
  video()
  const element = query('video') as HTMLVideoElement
  expect(element.src).toContain(routes.runArtifact('run', sha))
  expect(element.preload).toBe('metadata')
  expect(element.muted).toBe(true)
  expect(element.playsInline).toBe(true)
  expect(element.hasAttribute('autoplay')).toBe(false)
  expect(element.hasAttribute('controls')).toBe(false)
  expect(element.hasAttribute('poster')).toBe(false)
})
test('PLAYER-PARKED-AT-MARKER', () => {
  const media = video()
  metadata(media)
  expect(media.currentTime).toBe(0)
  render({ source: 'video', recording: recording(), media, playhead: model.markers[1]! })
  expect(media.currentTime).toBe(10)
  render({ source: 'video', recording: recording(), media, playhead: model.markers[1]!, seekFraction: 0.75 })
  expect(media.currentTime).toBe(15)
  expect(query('[data-player-time]').textContent).toContain('0:20')
  expect(query('[data-player-time]').textContent).not.toContain('Infinity')
  render({ source: 'video', recording: recording(), media, playhead: model.markers[1]!, clock: { offsetMs: 30580.25, totalMs: 61369.5 } })
  act(() => media.fire('timeupdate', 12))
  expect(query('[data-player-time]').textContent).toBe('0:42 / 1:01')
  expect(Number(query('[data-player-time]').dataset.playerElapsedMs)).toBe(42580.25)
  expect(media.currentTime).toBe(12)
  render({ source: 'video', recording: recording(), media, clock: { totalMs: undefined, offsetMs: undefined } })
  expect(query('[data-player-time]').textContent).toBe('— / —')
  expect(query('[data-player-time]').title).toContain('duration is missing or still loading')
})
test('PLAYER-PLAY-ADVANCES-PLAYHEAD', async () => {
  const media = video()
  metadata(media)
  await act(async () => button(PLAYER_COPY.play).click())
  expect(media.paused).toBe(false)
  act(() => media.fire('timeupdate', 12))
  expect(change).toHaveBeenLastCalledWith({ testIndex: 0, stepIndex: 0, subActionIndex: 1 })
  render({ source: 'video', recording: recording(), media, playhead: model.markers[1]! })
  expect(media.currentTime).toBe(12)
  act(() => media.fire('timeupdate', 13))
  expect(change).toHaveBeenCalledTimes(1)
  act(() => button(PLAYER_COPY.pause).click())
  expect(media.paused).toBe(true)
})
test('PLAYER-END-PARKS-LAST', async () => {
  const media = video()
  metadata(media)
  await act(async () => button(PLAYER_COPY.play).click())
  act(() => media.fire('ended', 20))
  expect(media.paused).toBe(true)
  expect(media.currentTime).toBe(20)
  expect(button(PLAYER_COPY.play)).not.toBeNull()
})
test('PLAYER-CONTINUOUS-PROGRESS observes real media between markers without seek feedback and cancels frames', async () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback)
    return sequence
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)))
  const progress = vi.fn()
  const observed = vi.fn()
  const media = video({ onProgress: progress, onPlayheadObserved: observed })
  metadata(media)
  await act(async () => button(PLAYER_COPY.play).click())
  const seeks = [...media.seeks]
  // Change media time without emitting timeupdate: the frame sampler must observe it.
  media.currentTime = 3.25
  media.seeks.pop()
  act(() => {
    const [id, callback] = callbacks.entries().next().value!
    callbacks.delete(id); callback(16)
  })
  expect(progress).toHaveBeenLastCalledWith(0, 3.25)
  expect(observed).not.toHaveBeenCalled()
  render({ source: 'video', recording: recording(), media, onProgress: progress, onPlayheadObserved: observed })
  expect(media.seeks).toEqual(seeks)
  expect(media.currentTime).toBe(3.25)
  act(() => button(PLAYER_COPY.pause).click())
  expect(callbacks.size).toBe(0)
  await act(async () => button(PLAYER_COPY.play).click())
  expect(callbacks.size).toBe(1)
  render({ source: 'frames' })
  expect(callbacks.size).toBe(0)
  expect(media.paused).toBe(true)
})

test.each([undefined, 1])('PLAYER-CONSUMED-SEEK ignores late duration publication (revision %s)', async seekRevision => {
  const media = video({ seekFraction: 0.25, seekRevision })
  metadata(media)
  expect(media.currentTime).toBe(5)
  await act(async () => button(PLAYER_COPY.play).click())
  act(() => media.fire('timeupdate', 8))
  const seeks = [...media.seeks]
  const longer = { ...recording(), durationMs: 30000 }
  render({ source: 'video', recording: longer, media, seekFraction: 0.25, seekRevision })
  expect(media.currentTime).toBe(8)
  expect(media.seeks).toEqual(seeks)
  expect(media.paused).toBe(false)
  expect(query('[data-player-time]').textContent).toContain('0:30')
  // A fresh command still uses the newly observed duration, including the same fraction.
  render({ source: 'video', recording: longer, media, seekFraction: 0.25, seekRevision: 2 })
  expect(media.currentTime).toBe(7.5)
  render({ source: 'video', recording: longer, media, seekFraction: 0.5 })
  expect(media.currentTime).toBe(15)
})

test('PLAYER-PENDING-SEEK waits for metadata and a timed model without consuming intent', () => {
  const media = video({ seekFraction: 0.25, seekRevision: 1 })
  const { durationMs: _duration, ...unknown } = recording()
  render({ source: 'video', recording: unknown, model: { ...model, axis: 'ordinal' }, media, seekFraction: 0.25, seekRevision: 1 })
  expect(media.seeks).toEqual([])
  metadata(media)
  expect(media.seeks).toEqual([])
  render({ source: 'video', recording: { ...recording(), durationMs: 30000 }, media, seekFraction: 0.25, seekRevision: 1 })
  expect(media.currentTime).toBe(7.5)
  const seeks = [...media.seeks]
  act(() => media.fire('resize'))
  expect(media.seeks).toEqual(seeks)
})

test('PLAYER-SEEK-IDENTITY reapplies on source changes and retry only after metadata', async () => {
  const media = video({ seekFraction: 0.25, seekRevision: 1 })
  metadata(media)
  expect(media.currentTime).toBe(5)
  const replacement = createFakeMedia(20)
  render({ source: 'video', recording: recording(), media: replacement, seekFraction: 0.25, seekRevision: 1 })
  expect(replacement.seeks).toEqual([])
  metadata(replacement)
  expect(replacement.currentTime).toBe(5)
  vi.mocked(fetch).mockResolvedValue({ status: 503 } as Response)
  await act(async () => replacement.fire('error'))
  act(() => query('[data-evidence-kind="video"] button').click())
  const seeks = [...replacement.seeks]
  expect(button(PLAYER_COPY.play).disabled).toBe(true)
  metadata(replacement)
  expect(replacement.seeks).toEqual([...seeks, 0, 5])
  render({ source: 'frames' })
  const next = createFakeMedia(20)
  render({ source: 'video', recording: recording(), media: next, seekFraction: 0.25, seekRevision: 1 })
  expect(next.seeks).toEqual([])
  metadata(next)
  expect(next.currentTime).toBe(5)
})

test('PLAYER-SEEK-AWAITS-DATA: a seek requested between loadedmetadata and loadeddata is applied once, after loadeddata', () => {
  const media = video({ seekFraction: 0.25, seekRevision: 1 })
  act(() => media.fire('loadedmetadata'))
  expect(button(PLAYER_COPY.play).disabled).toBe(false)
  render({ source: 'video', recording: recording(), media, seekFraction: 0.5, seekRevision: 2 })
  expect(media.writes).toEqual([])
  act(() => media.fire('loadeddata'))
  expect(media.writes).toEqual([{ at: 10, readyState: 2, seeking: false }])
  expect(media.currentTime).toBe(10)
  act(() => media.fire('loadeddata'))
  render({ source: 'video', recording: recording(), media, seekFraction: 0.5, seekRevision: 2 })
  expect(media.writes).toHaveLength(1)
})

test('PLAYER-SEEK-ONE-IN-FLIGHT: a seek requested while the media is seeking waits for seeked and applies only the latest target', () => {
  group.member.recording = recording()
  model = buildTimelineModel(group)
  const media = createFakeMedia(Infinity, { holdSeeks: true })
  const props = { source: 'video' as const, recording: recording(), media, playhead: model.markers[1]! }
  render({ ...props, seekFraction: 0.25, seekRevision: 1 })
  metadata(media)
  expect(media.writes.map(write => write.at)).toEqual([10])
  render({ ...props, seekFraction: 0.5, seekRevision: 2 })
  render({ ...props, seekFraction: 0.75, seekRevision: 3 })
  expect(media.writes.map(write => write.at)).toEqual([10])
  act(() => media.fire('seeked'))
  expect(media.writes.map(write => write.at)).toEqual([10, 15])
  act(() => media.fire('seeked'))
  expect(media.writes.map(write => write.at)).toEqual([10, 15])
  expect(media.writes.every(write => !write.seeking && write.readyState >= 2)).toBe(true)
  expect(media.currentTime).toBe(15)
})

test('PLAYER-REPEATED-SEEK and member continuation preserve explicit offsets and speed', async () => {
  const ended = vi.fn()
  const media = video({ onRecordingEnded: ended })
  metadata(media)
  act(() => button(PLAYER_COPY.speed).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const speed = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === '4×')!
  act(() => speed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  render({ source: 'video', recording: recording(), media, seekFraction: 0.25, seekRevision: 1, onRecordingEnded: ended })
  act(() => media.fire('timeupdate', 8))
  render({ source: 'video', recording: recording(), media, seekFraction: 0.25, seekRevision: 2, onRecordingEnded: ended })
  expect(media.currentTime).toBe(5)
  act(() => media.fire('ended', 20))
  expect(ended).toHaveBeenCalledOnce()
  const next = createFakeMedia(20)
  render({ source: 'video', model: { ...model, testIndex: 1 }, recording: recording(), media: next, seekFraction: 0, autoPlay: true })
  await act(async () => next.fire('loadedmetadata'))
  expect(next.currentTime).toBe(0)
  expect(next.paused).toBe(false)
  expect(next.playbackRate).toBe(4)
  expect(media.paused).toBe(true)
})
for (const reason of ['unsupported', 'not-captured', 'failed', 'unavailable'] as const) {
  test(`PLAYER-VIDEO-${reason.toUpperCase()}`, () => {
    render({ source: 'video', recording: { state: 'absent', reason } })
    const pane = query('[data-evidence-kind="video"]')
    expect(pane.dataset.evidenceState).toBe(reason)
    expect(pane.hasAttribute('data-evidence-incomplete')).toBe(false)
    expect(query('video')).toBeNull()
  })
}
test('PLAYER-VIDEO-BYTES-GONE', async () => {
  render({ source: 'video', recording: { state: 'absent', reason: 'unavailable', evidenceIncomplete: true } })
  expect(query('[data-evidence-kind="video"]').dataset.evidenceIncomplete).toBe('true')
  const media = video()
  await act(async () => media.fire('error'))
  expect(query('[data-evidence-kind="video"]').dataset.evidenceState).toBe('unavailable')
  expect(query('[data-evidence-kind="video"]').dataset.evidenceIncomplete).toBe('true')
})
test('PLAYER-VIDEO-LOAD-FAILURE', async () => {
  for (const status of [206, 500, 503, undefined]) {
  const cancel = vi.fn(async () => undefined)
  vi.mocked(fetch).mockReset()
  if (status === undefined) vi.mocked(fetch).mockRejectedValue(new TypeError('network unavailable'))
  else vi.mocked(fetch).mockResolvedValue({ status, body: { cancel } } as unknown as Response)
  const media = video()
  await act(async () => media.fire('error'))
  const pane = query('[data-evidence-kind="video"]')
  expect(pane.dataset.evidenceState).toBe('failed')
  expect(pane.dataset.evidenceFailure).toBe('load')
  expect(pane.textContent).toContain('Retry loading the recording')
  expect(pane.textContent).toContain('switch to Frames')
  act(() => pane.querySelector('button')!.click())
  expect(query('video')).not.toBeNull()
  expect(button(PLAYER_COPY.play).disabled).toBe(true)
  expect(fetch).toHaveBeenLastCalledWith(routes.runArtifact('run', sha), {
    method: 'GET', headers: { Range: 'bytes=0-0' }, signal: expect.any(AbortSignal),
  })
  if (status !== undefined) expect(cancel).toHaveBeenCalledOnce()
  render({ source: 'frames' })
  await errorImage()
  const frame = query('[data-evidence-kind="frame"]')
  expect(frame.dataset.evidenceState).toBe('failed')
  expect(frame.dataset.evidenceFailure).toBe('load')
  act(() => frame.querySelector('button')!.click())
  expect(query('img')).not.toBeNull()
  }
})
test('PLAYER-VIDEO-UNTIMED-NOTE', async () => {
  delete group.steps[0]!.subActions[1]!.recordingOffsetMs
  const media = video()
  metadata(media)
  expect(query('[data-player]').textContent).toContain(VIDEO_UNTIMED_NOTE)
  expect(query('[data-player]').textContent).not.toContain('has no per-action timing')
  expect(query('[data-player-caption]').textContent).not.toContain('0:00')
  expect(media.paused).toBe(true)
  render({ source: 'video', recording: recording(), media, playhead: model.markers[1]!, seekFraction: 0.8 })
  expect(media.seeks).toEqual([])
  await act(async () => button(PLAYER_COPY.play).click())
  act(() => media.fire('timeupdate', 15))
  expect(change).not.toHaveBeenCalled()
  expect(query('[data-player-time]').textContent).toContain('0:15')
  group.steps[0]!.subActions[1]!.recordingOffsetMs = 10000
  const { durationMs: _duration, ...withoutDuration } = recording()
  group.member.recording = withoutDuration
  model = buildTimelineModel(group)
  expect(model.axis).toBe('ordinal')
  render({ model, source: 'video', recording: withoutDuration, media, playhead: model.markers[1]! })
  expect(query('[data-player-caption]').textContent).not.toContain('0:10')
  expect(query('[data-player]').textContent).toContain('cannot be synchronized with the selected action')
})

function lightbox(onOpenChange = vi.fn(), returnFocus?: HTMLElement) {
  const module = lightboxes['../player-lightbox.tsx']
  expect(module, 'PlayerLightbox exists').toBeDefined()
  const { PlayerLightbox } = module!
  act(() => root.render(<PlayerLightbox runId='run' sha={sha} open onOpenChange={onOpenChange} returnFocus={returnFocus} />))
  return document.querySelector<HTMLElement>('[data-player-lightbox]')!
}
test('LIGHTBOX-NOTE-AND-CLOSE', async () => {
  const close = vi.fn()
  const pane = lightbox(close)
  expect(pane.textContent).toContain(PLAYER_COPY.lightboxTitle)
  expect(pane.textContent).toContain(PLAYER_COPY.lightboxNote)
  expect(pane.querySelector('img')?.getAttribute('src')).toBe(routes.runArtifact('run', sha))
  expect(pane.querySelectorAll('[data-slot="dialog-close"]')).toHaveLength(1)
  act(() => pane.querySelector<HTMLButtonElement>(`[aria-label="${PLAYER_COPY.lightboxClose}"]`)!.click())
  expect(close).toHaveBeenCalledWith(false)
  close.mockClear()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(close).toHaveBeenCalledWith(false)
})
test('LIGHTBOX-FOCUS-RETURNS', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  lightbox(vi.fn(), trigger)
  await act(async () => root.render(null))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})

test('PLAYER-PREFERENCE-EXPLICIT-TOGGLE-ONLY', () => {
  const storage = { getItem: vi.fn(() => 'video'), setItem: vi.fn() }
  vi.stubGlobal('localStorage', storage)
  render()
  expect(storage.setItem).not.toHaveBeenCalled()
  act(() => query('[data-slot="toggle-group-item"][aria-label^="Video"]').click())
  expect(storage.setItem).toHaveBeenCalledWith(PLAYER_SOURCE_STORAGE_KEY, 'video')
})
test('PLAYER-VIDEO-SPEED-AND-CLEANUP', async () => {
  const media = video()
  metadata(media)
  const element = query('video')
  for (const speed of [0.5, 1, 2, 4, 8, 16]) {
    act(() => button(PLAYER_COPY.speed).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map(node => node.textContent)).toEqual(['0.5×', '1×', '2×', '4×', '8×', '16×'])
    const option = options.find(node => node.textContent === `${speed}×`)!
    act(() => option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(media.playbackRate).toBe(speed)
    expect(query('video')).toBe(element)
  }
  await act(async () => button(PLAYER_COPY.play).click())
  render({ source: 'frames' })
  expect(media.paused).toBe(true)
  act(() => media.fire('timeupdate', 15))
  expect(change).not.toHaveBeenCalled()
})
test('LIGHTBOX-OVERLAY-CLOSE: a press on the overlay closes the lightbox when it completes as a click', async () => {
  const close = vi.fn()
  lightbox(close)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const overlay = document.querySelector('[data-slot="dialog-overlay"]')!
  act(() => overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
  expect(close).not.toHaveBeenCalled()
  act(() => overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })))
  expect(close).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledWith(false)
})
test('LIGHTBOX-FRAME-LOAD-FAILURE', async () => {
  vi.mocked(fetch).mockResolvedValue({ status: 500 } as Response)
  const pane = lightbox()
  await act(async () => pane.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(pane.querySelector<HTMLElement>('[data-evidence-kind="frame"]')?.dataset.evidenceFailure).toBe('load')
  expect(pane.textContent).toContain('Retry loading the screenshot')
})
