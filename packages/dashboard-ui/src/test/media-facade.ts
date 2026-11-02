export interface MediaFacade {
  currentTime: number
  readonly duration: number
  readonly paused: boolean
  readonly readyState: number
  readonly seeking: boolean
  playbackRate: number
  readonly seekable: Pick<TimeRanges, 'length' | 'end'>
  play(): Promise<void>
  pause(): void
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export function createFakeMedia(duration = 60, { holdSeeks = false } = {}) {
  const events = new EventTarget()
  let paused = true
  let time = 0
  let readyState = 0
  let seeking = false
  const seeks: number[] = []
  // Each write is recorded with the readyState and seeking flag it landed on.
  const writes: { at: number; readyState: number; seeking: boolean }[] = []
  // The media event being dispatched when each write landed, or '' when none was.
  const writtenDuring: string[] = []
  let dispatching = ''
  const dispatch = (type: string) => {
    dispatching = type
    try { events.dispatchEvent(new Event(type)) } finally { dispatching = '' }
  }
  return {
    get currentTime() { return time },
    set currentTime(value: number) {
      writes.push({ at: value, readyState, seeking })
      writtenDuring.push(dispatching)
      time = value; seeks.push(value)
      if (holdSeeks) seeking = true
    },
    duration,
    get paused() { return paused },
    get readyState() { return readyState },
    get seeking() { return seeking },
    playbackRate: 1,
    seekable: { length: 1, end: () => duration },
    async play() { paused = false; events.dispatchEvent(new Event('play')) },
    pause() { paused = true; events.dispatchEvent(new Event('pause')) },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    fire(type: 'loadedmetadata' | 'loadeddata' | 'timeupdate' | 'seeked' | 'resize' | 'ended' | 'error', at?: number) {
      if (at !== undefined) time = at
      if (type === 'loadedmetadata') readyState = Math.max(readyState, 1)
      if (type === 'loadeddata') readyState = Math.max(readyState, 2)
      if (type === 'seeked') seeking = false
      if (type === 'ended') paused = true
      dispatch(type)
    },
    // Chromium's preload='metadata' suspended start: HAVE_ENOUGH_DATA at once, then these in order.
    suspendedStart() {
      readyState = 4
      for (const type of ['resize', 'loadedmetadata', 'loadeddata', 'canplay']) dispatch(type)
    },
    seeks,
    writes,
    writtenDuring,
  } satisfies MediaFacade & {
    fire: unknown
    suspendedStart: unknown
    seeks: number[]
    writes: unknown
    writtenDuring: string[]
  }
}
