// Concrete sharp-based screenshot compressor + image utilities (Phase 363, D-08 / Q10).
//
// This is the host-adapter home for `sharp` (the runner is storageNeutral / storage-agnostic and
// bans native image codecs by construction, Pitfall 9). Phase 356's ownership ledger claimed the
// compression pipeline would move out of core "by Phase 356"; RESEARCH Q10 found that claim STALE —
// the pipeline was still core-side. This module makes the truthful end-state real: `sharp` leaves
// core and lands here, behind the runner's `ScreenshotCompressor` port. `SharpScreenshotCompressor`
// is constructed once at the CLI composition root and injected into `runTest` (the injected-host-impl
// shape the member-runner keeps), so no core code constructs a compressor.
//
// `alignToWindow` + `getImageDimensions` are exported alongside the port impl because the mobile
// adapters (`@vostride/agent-qa-android`, `@vostride/agent-qa-ios`) call them directly for
// action-space alignment / drift assertions — they are host-side sharp utilities with the same
// storageImplementation home, not part of the `ScreenshotCompressor` port surface.

import sharp from 'sharp'
import type { CompressedScreenshot, ScreenshotCompressor } from '@vostride/agent-qa-runner'

/** Minimal structural debug-logger seam (a core `ScopedLogger` satisfies it; no core dependency). */
export interface ScreenshotCompressorLogger {
  debug(message: string, meta?: Record<string, unknown>): void
}

const STARTING_QUALITY = 70
const QUALITY_REDUCTION = 0.8
const MIN_QUALITY = 10

export interface CompressOptions {
  effectiveResolution: number
  maxBytes?: number
  actionSpaceWidth: number
}

export interface CompressResult {
  buffer: Buffer
  imageWidth: number
  imageHeight: number
}

/**
 * Resize + optional JPEG-quality compression of a screenshot buffer (v1 pipeline, verbatim).
 * fit:'inside' constrains both dimensions preserving AR (longer edge becomes eR);
 * withoutEnlargement avoids upscaling small images. The JPEG pass only runs when a byte
 * budget is set, iterating quality down to a graceful minimum-quality fallback (Pitfall 4 — never
 * re-resize inside the loop).
 */
async function compressScreenshot(
  buffer: Buffer,
  opts: CompressOptions,
  logger?: ScreenshotCompressorLogger,
): Promise<CompressResult> {
  const originalKB = (buffer.length / 1024).toFixed(1)
  const meta = await sharp(buffer).metadata()
  const srcWidth = meta.width ?? opts.actionSpaceWidth
  const srcHeight = meta.height ?? 0
  const targetEdge = opts.effectiveResolution

  let resizePipeline = sharp(buffer)
  if (srcWidth > targetEdge || srcHeight > targetEdge) {
    resizePipeline = resizePipeline.resize({
      width: targetEdge,
      height: targetEdge,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: 'lanczos3',
    })
  }
  const afterResize = await resizePipeline.toBuffer({ resolveWithObject: true })
  const resizedWidth = afterResize.info.width
  const resizedHeight = afterResize.info.height

  // Skip JPEG pass if no byte budget set.
  if (!opts.maxBytes) {
    return { buffer: afterResize.data, imageWidth: resizedWidth, imageHeight: resizedHeight }
  }

  const maxBytes = opts.maxBytes
  const targetKB = (maxBytes / 1024).toFixed(1)

  let quality = STARTING_QUALITY
  while (quality > MIN_QUALITY) {
    const { data, info } = await sharp(afterResize.data)
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })

    if (info.size <= maxBytes) {
      logger?.debug('Compressed screenshot', {
        originalKB: parseFloat(originalKB),
        compressedKB: parseFloat((info.size / 1024).toFixed(1)),
        targetKB: parseFloat(targetKB),
        quality,
      })
      return { buffer: data, imageWidth: resizedWidth, imageHeight: resizedHeight }
    }
    quality = Math.max(MIN_QUALITY, Math.round(quality * QUALITY_REDUCTION))
  }

  // Graceful fallback: return best-effort at minimum quality.
  const { data, info } = await sharp(afterResize.data)
    .jpeg({ quality: MIN_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  logger?.debug('Compressed screenshot (exceeded target)', {
    originalKB: parseFloat(originalKB),
    compressedKB: parseFloat(((info as { size: number }).size / 1024).toFixed(1)),
    targetKB: parseFloat(targetKB),
    quality: MIN_QUALITY,
  })
  return { buffer: data, imageWidth: resizedWidth, imageHeight: resizedHeight }
}

/**
 * The runner `ScreenshotCompressor` port impl (D-08 / Q10). `compress` covers the LLM-planner
 * compression call site; `dimensions` covers the action-space-width metadata fallback done inline
 * via `sharp(screenshot).metadata()` at v1 loop.ts. The loop applies `stampCaptureMode` itself
 * (runner-owned since 352), so this stays purely pixel-level and returns v1's CompressResult shape.
 */
export class SharpScreenshotCompressor implements ScreenshotCompressor {
  constructor(private readonly logger?: ScreenshotCompressorLogger) {}

  async compress(
    screenshot: Buffer,
    options: { effectiveResolution: number; maxBytes?: number; actionSpaceWidth: number },
  ): Promise<CompressedScreenshot> {
    return compressScreenshot(screenshot, options, this.logger)
  }

  async dimensions(screenshot: Buffer): Promise<{ width: number; height: number }> {
    const meta = await sharp(screenshot).metadata()
    return { width: meta.width ?? 0, height: meta.height ?? 0 }
  }
}

export interface AlignOptions {
  width: number
  height: number
}

/** Resize buffer to exact window dimensions. Used by mobile adapters for action-space alignment
 *  (e.g., iOS physical pixels → logical points). */
export async function alignToWindow(buffer: Buffer, opts: AlignOptions): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: opts.width, height: opts.height, kernel: 'lanczos3', fit: 'fill' })
    .png()
    .toBuffer()
}

export interface ImageDimensions {
  width: number
  height: number
}

/** Read image buffer width/height without decoding pixels. Used by mobile adapters for
 *  action-space drift assertions. */
export async function getImageDimensions(buffer: Buffer): Promise<ImageDimensions | undefined> {
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height) return undefined
  return { width: meta.width, height: meta.height }
}

export async function flattenOntoWhite(buffer: Buffer): Promise<Buffer> {
  const meta = await sharp(buffer).metadata()
  if (!meta.hasAlpha) return buffer
  return sharp(buffer).flatten({ background: '#ffffff' }).png().toBuffer()
}
