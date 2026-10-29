// At most one capture in flight; a tick during a pending capture is skipped, never queued.

import type { LiveFrame } from '@vostride/agent-qa-schema'
import type { LiveStreamCapability, PlatformAdapter } from '../platform.js'
import { defaultLiveStreamTimer } from './live-stream-hub.js'
import type { RunTimerPort } from './ports.js'

// One still a second, inside the viewer's freshness window.
export const LIVE_SNAPSHOT_INTERVAL_MS = 1_000
export const LIVE_KEEPALIVE_QUIET_MS = 2_000

export function createSnapshotLiveStream(input: {
  capture: () => Promise<Uint8Array | undefined>
  timer?: RunTimerPort
  intervalMs?: number
}): LiveStreamCapability {
  const timer = input.timer ?? defaultLiveStreamTimer()
  const intervalMs = input.intervalMs ?? LIVE_SNAPSHOT_INTERVAL_MS
  let seq = 0
  let emit: ((frame: LiveFrame) => void) | undefined
  let cancelTick: (() => void) | undefined
  let inFlight = false
  // Bumped on every start and stop, so a capture that resolves after a stop (or after a stop and a
  // fresh start) can tell it belongs to a watched interval that is already over.
  let generation = 0

  async function captureOnce(ownGeneration: number): Promise<void> {
    try {
      const bytes = await input.capture()
      if (bytes === undefined || bytes.byteLength === 0) return
      const onFrame = emit
      if (onFrame === undefined || ownGeneration !== generation) return
      const { width, height } = imageSizeOf(bytes)
      onFrame({
        id: ++seq,
        bytes,
        metadata: { width, height, timestamp: timer.now() },
        kind: 'snapshot',
      })
    } catch {
      // A failed capture emits nothing; the next tick tries again.
    } finally {
      inFlight = false
    }
  }

  function tick(): void {
    if (emit === undefined) return
    cancelTick = timer.schedule(intervalMs, tick)
    if (inFlight) return
    inFlight = true
    void captureOnce(generation)
  }

  return {
    kind: 'snapshot',
    async start(onFrame) {
      if (emit !== undefined) return
      emit = onFrame
      generation += 1
      tick()
    },
    async ack() {},
    async stop() {
      emit = undefined
      generation += 1
      const cancel = cancelTick
      cancelTick = undefined
      cancel?.()
    },
  }
}

/** What a run or an editor session registers with its hub: a stream, and what replaces it on a failed start. */
export type LiveStreamRegistration = {
  capability: LiveStreamCapability
  fallback?: LiveStreamCapability
}

// The adapter's own stream wins; a snapshot-only adapter gets no fallback, sparing `screenshot()`.
export function liveStreamFor(
  adapter: Pick<PlatformAdapter, 'liveStream' | 'screenshot'> | undefined,
  options: { timer?: RunTimerPort } = {},
): LiveStreamRegistration | undefined {
  if (adapter === undefined) return undefined
  const own = adapter.liveStream
  if (own?.kind === 'snapshot') return { capability: own }
  const screenshot = adapter.screenshot?.bind(adapter)
  const snapshot =
    screenshot === undefined
      ? undefined
      : createSnapshotLiveStream({
          capture: () => screenshot(),
          ...(options.timer === undefined ? {} : { timer: options.timer }),
        })
  if (own !== undefined) {
    return snapshot === undefined ? { capability: own } : { capability: own, fallback: snapshot }
  }
  return snapshot === undefined ? undefined : { capability: snapshot }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52] as const
const UNKNOWN_SIZE = { width: 0, height: 0 } as const

/**
 * Width and height from a PNG IHDR or a JPEG SOF header, so a snapshot frame has a size before
 * the viewer decodes it. Anything it cannot read — another format, a truncated header — answers
 * 0 by 0, and every read is bounded by the byte length.
 */
export function imageSizeOf(bytes: Uint8Array): { width: number; height: number } {
  if (startsWith(bytes, PNG_SIGNATURE, 0)) {
    if (bytes.byteLength < 24 || !startsWith(bytes, PNG_IHDR, 12)) return { ...UNKNOWN_SIZE }
    return { width: uint32At(bytes, 16), height: uint32At(bytes, 20) }
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSizeOf(bytes)
  return { ...UNKNOWN_SIZE }
}

function jpegSizeOf(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return { ...UNKNOWN_SIZE }
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Standalone markers carry no length: TEM, RST0-RST7 and a stray SOI.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    // The size lives in a frame header, which always precedes the scan and the end of image.
    if (marker === 0xda || marker === 0xd9) return { ...UNKNOWN_SIZE }
    if (offset + 3 >= bytes.byteLength) return { ...UNKNOWN_SIZE }
    const length = uint16At(bytes, offset + 2)
    if (length < 2) return { ...UNKNOWN_SIZE }
    // SOF0-SOF15, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 8 >= bytes.byteLength) return { ...UNKNOWN_SIZE }
      return { width: uint16At(bytes, offset + 7), height: uint16At(bytes, offset + 5) }
    }
    offset += 2 + length
  }
  return { ...UNKNOWN_SIZE }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at: number): boolean {
  if (bytes.byteLength < at + prefix.length) return false
  return prefix.every((value, index) => bytes[at + index] === value)
}

function uint16At(bytes: Uint8Array, at: number): number {
  return bytes[at] * 0x100 + bytes[at + 1]
}

function uint32At(bytes: Uint8Array, at: number): number {
  return bytes[at] * 0x1000000 + bytes[at + 1] * 0x10000 + bytes[at + 2] * 0x100 + bytes[at + 3]
}
