// Compressor resize and JPEG quality, the `dimensions` leg and the mobile image utilities.
import sharp from 'sharp'
import { describe, it, expect } from 'vitest'

import {
  SharpScreenshotCompressor,
  alignToWindow,
  getImageDimensions,
} from '../screenshot-compressor.js'

function createTestPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer()
}

const compressor = new SharpScreenshotCompressor()

describe('SharpScreenshotCompressor.compress', () => {
  it('returns buffer at same width when input matches effectiveResolution and no resize needed', async () => {
    const png = await createTestPng(2048, 1080)
    const result = await compressor.compress(png, { effectiveResolution: 2048, actionSpaceWidth: 2048 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBe(2048)
  })

  it('resizes to effectiveResolution max edge', async () => {
    const png = await createTestPng(3000, 1500)
    const result = await compressor.compress(png, { effectiveResolution: 1000, actionSpaceWidth: 3000 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(1000)
  })

  it('resizes arbitrary dimensions using fit:inside max-edge', async () => {
    const png = await createTestPng(1179, 2556)
    const result = await compressor.compress(png, { effectiveResolution: 1568, actionSpaceWidth: 393 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.height).toBe(1568)
    expect(result.imageWidth).toBe(meta.width)
  })

  it('resize happens before quality iteration (resize unaffected by tight byte budget)', async () => {
    const png = await createTestPng(3000, 1500)
    const result = await compressor.compress(png, { effectiveResolution: 500, maxBytes: 5000, actionSpaceWidth: 3000 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(500)
  })

  it('returns buffer without JPEG pass when maxBytes undefined', async () => {
    const png = await createTestPng(1000, 500)
    const result = await compressor.compress(png, { effectiveResolution: 2000, actionSpaceWidth: 1000 })
    expect(result.buffer).toBeInstanceOf(Buffer)
  })

  it('iterates JPEG quality when maxBytes tight', async () => {
    const png = await createTestPng(1920, 1080)
    const result = await compressor.compress(png, { effectiveResolution: 2048, maxBytes: 5000, actionSpaceWidth: 1920 })
    expect(result.buffer[0]).toBe(0xff)
    expect(result.buffer[1]).toBe(0xd8)
    // Re-encodes a full frame repeatedly, so it relies on the package-level `testTimeout`.
    expect(result.buffer.length).toBeGreaterThan(0)
  })

  it('returns CompressResult with buffer, imageWidth, imageHeight fields', async () => {
    const png = await createTestPng(1000, 500)
    const result = await compressor.compress(png, { effectiveResolution: 2000, actionSpaceWidth: 1000 })
    expect(Object.keys(result).sort()).toEqual(['buffer', 'imageHeight', 'imageWidth'])
  })

  it('respects withoutEnlargement — does not upscale tiny images', async () => {
    const png = await createTestPng(100, 100)
    const result = await compressor.compress(png, { effectiveResolution: 2000, actionSpaceWidth: 100 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(100)
    expect(result.imageWidth).toBe(100)
    expect(result.imageHeight).toBe(100)
  })

  it('resizes portrait 1080x2400 to 706x1568 using fit:inside max-edge', async () => {
    const png = await createTestPng(1080, 2400)
    const result = await compressor.compress(png, { effectiveResolution: 1568, actionSpaceWidth: 1080 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.height).toBe(1568)
    expect(meta.width).toBeGreaterThanOrEqual(705)
    expect(meta.width).toBeLessThanOrEqual(707)
    expect(result.imageWidth).toBe(meta.width)
    expect(result.imageHeight).toBe(1568)
  })
})

describe('SharpScreenshotCompressor.dimensions', () => {
  it('reads width/height from the buffer metadata', async () => {
    const png = await createTestPng(1179, 2556)
    const dims = await compressor.dimensions(png)
    expect(dims).toEqual({ width: 1179, height: 2556 })
  })
})

describe('image utilities (mobile adapters)', () => {
  it('getImageDimensions returns buffer dimensions', async () => {
    const png = await createTestPng(411, 810)
    expect(await getImageDimensions(png)).toEqual({ width: 411, height: 810 })
  })

  it('alignToWindow resizes to exact logical-point dimensions', async () => {
    const png = await createTestPng(1179, 2556)
    const aligned = await alignToWindow(png, { width: 393, height: 852 })
    const meta = await sharp(aligned).metadata()
    expect(meta.width).toBe(393)
    expect(meta.height).toBe(852)
  })
})
