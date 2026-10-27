import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import type { PlatformConfig, RecordingCapability } from '@vostride/agent-qa-runner'

export const RECORDING_DEFAULT_SIZE = { width: 1280, height: 720 }

// Read only JPEG SOF dimensions; never retain or publish frame bytes for this witness.
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  for (let i = 2; i + 8 < bytes.length;) {
    if (bytes[i++] !== 0xff) return undefined
    const marker = bytes[i++]!
    const length = bytes.readUInt16BE(i)
    if (length < 2 || i + length > bytes.length) return undefined
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 3), width: bytes.readUInt16BE(i + 5) }
    }
    i += length
  }
  return undefined
}

export interface ScreencastRecording extends RecordingCapability {
  /** The bracketed action itself has ended; waits the adapter runs after it are not execution. */
  endAction(): void
}

export function createScreencastRecording(
  getPage: () => Page | null,
  config: NonNullable<PlatformConfig['recording']>,
  getPageRevision: () => number,
): ScreencastRecording {
  let active: { page: Page; stagingPath: string } | undefined
  let recovery: typeof active
  let busy = false
  let firstFrameEpoch: number | undefined
  let scene: { width: number; height: number } | undefined
  let sceneRevision = 0
  let bracket: { end(): void } | undefined
  async function recover() {
    if (!recovery) return
    // Keep the failed session quarantined until the driver confirms it stopped.
    // A subsequent start retries this real cleanup, never publishes these bytes.
    await recovery.page.screencast.stop()
    await rm(recovery.stagingPath, { force: true })
    recovery = undefined
  }
  return {
    async start() {
      if (busy || active) throw new Error('Recording already started')
      busy = true
      try {
        await recover()
        const page = getPage()
        if (!page) throw new Error('Recording requires an initialized page')
        const stagingPath = join(config.videoDir, `${randomUUID()}.webm`)
        const size = config.videoSize ?? page.viewportSize() ?? RECORDING_DEFAULT_SIZE
        firstFrameEpoch = undefined
        scene = undefined
        sceneRevision++
        recovery = { page, stagingPath }
        try {
          await mkdir(config.videoDir, { recursive: true })
          await page.screencast.start({
            path: stagingPath,
            size,
            onFrame: async frame => {
              firstFrameEpoch ??= frame.timestamp
              const pixels = jpegSize(frame.data)
              // Only an observed 1:1 mapping is supported. Shared screencasts, custom sizes,
              // odd encoder dimensions and resized pages must never inherit guessed scaling.
              const next = pixels?.width === size.width && pixels.height === size.height
                && frame.viewportWidth === size.width && frame.viewportHeight === size.height
                ? { width: size.width, height: size.height } : undefined
              if (next?.width !== scene?.width || next?.height !== scene?.height) sceneRevision++
              scene = next
            },
          })
        } catch (error) {
          try { await recover() } catch { /* Retry cleanup before the next start. */ }
          throw error
        }
        active = recovery
        recovery = undefined
        return { zeroMs: performance.now() }
      } finally { busy = false }
    },
    beginAnnotation() {
      const recording = active
      const before = scene
      const epoch = firstFrameEpoch
      const revision = sceneRevision
      const pageRevision = getPageRevision()
      if (!recording || !before || epoch === undefined || getPage() !== recording.page) return undefined
      const viewport = recording.page.viewportSize()
      if (viewport?.width !== before.width || viewport.height !== before.height) return undefined
      const startMs = performance.timeOrigin + performance.now() - epoch
      const settle = () => {
        const after = recording.page.viewportSize()
        const endMs = performance.timeOrigin + performance.now() - epoch
        if (active !== recording || getPage() !== recording.page || revision !== sceneRevision
          || pageRevision !== getPageRevision() || after?.width !== before.width || after.height !== before.height
          || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return undefined
        return { startMs, endMs, scene: 'recorded-page' as const, transform: 'identity' as const, ...before }
      }
      let ended: { witness: ReturnType<typeof settle> } | undefined
      bracket = { end() { ended = { witness: settle() } } }
      return () => ended ? ended.witness : settle()
    },
    endAction() {
      bracket?.end()
    },
    async stop() {
      if (busy) throw new Error('Recording operation already in progress')
      busy = true
      try {
        const recording = active
        if (!recording) { await recover(); return undefined }
        active = undefined
        try {
          await recording.page.screencast.stop()
        } catch (error) {
          recovery = recording
          try { await recover() } catch { /* Retry cleanup before the next start. */ }
          throw error
        }
        return { stagingPath: recording.stagingPath, contentType: 'video/webm' }
      } finally { busy = false }
    },
  }
}
