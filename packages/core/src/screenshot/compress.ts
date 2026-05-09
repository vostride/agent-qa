import sharp from 'sharp'
import type { ScopedLogger } from '../logging/types.js'

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

export async function compressScreenshot(
  buffer: Buffer,
  opts: CompressOptions,
  logger?: ScopedLogger,
): Promise<CompressResult> {
  const originalKB = (buffer.length / 1024).toFixed(1)
  const meta = await sharp(buffer).metadata()
  const srcWidth = meta.width ?? opts.actionSpaceWidth
  const srcHeight = meta.height ?? 0
  const targetEdge = opts.effectiveResolution

  // D-01, D-02: fit:'inside' constrains BOTH dimensions, preserves AR — longer edge becomes eR.
  // D-04: withoutEnlargement avoids upscaling small images (e.g., 402×874 iPhone logical points).
  // Phase 142: scaleFactor removed — coords are viewport-space identity, no scaling math needed.
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

  // Skip JPEG pass if no byte budget set (D-21)
  if (!opts.maxBytes) {
    return { buffer: afterResize.data, imageWidth: resizedWidth, imageHeight: resizedHeight }
  }

  const maxBytes = opts.maxBytes
  const targetKB = (maxBytes / 1024).toFixed(1)

  // Stage 4: JPEG quality iteration on the already-resized buffer (Pitfall 4 — never re-resize inside loop)
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

  // Graceful fallback: return best-effort at minimum quality
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
