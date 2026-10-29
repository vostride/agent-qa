// The host home for `sharp`, which the storage-neutral runner bans.

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

// `fit: 'inside'` keeps aspect ratio; the JPEG pass only lowers quality and never re-resizes.
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

// Pixel-level only: the loop stamps the capture mode itself.
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

// Reads width and height without decoding pixels.
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
