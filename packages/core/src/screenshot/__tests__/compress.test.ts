import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { compressScreenshot } from '../compress.js'

function createTestPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer()
}

describe('compressScreenshot', () => {
  it('returns buffer at same width when input matches effectiveResolution and no resize needed', async () => {
    const png = await createTestPng(2048, 1080)
    const result = await compressScreenshot(png, { effectiveResolution: 2048, actionSpaceWidth: 2048 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBe(2048)
  })

  it('resizes to effectiveResolution max edge', async () => {
    const png = await createTestPng(3000, 1500)
    const result = await compressScreenshot(png, { effectiveResolution: 1000, actionSpaceWidth: 3000 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(1000)
  })

  it('resizes arbitrary dimensions using fit:inside max-edge', async () => {
    const png = await createTestPng(1179, 2556)
    const result = await compressScreenshot(png, { effectiveResolution: 1568, actionSpaceWidth: 393 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.height).toBe(1568)
    expect(result.imageWidth).toBe(meta.width)
  })

  it('resize happens before quality iteration (resize unaffected by tight byte budget)', async () => {
    const png = await createTestPng(3000, 1500)
    const result = await compressScreenshot(png, { effectiveResolution: 500, maxBytes: 5000, actionSpaceWidth: 3000 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(500)
  })

  it('returns buffer without JPEG pass when maxBytes undefined', async () => {
    const png = await createTestPng(1000, 500)
    const result = await compressScreenshot(png, { effectiveResolution: 2000, actionSpaceWidth: 1000 })
    expect(result.buffer).toBeInstanceOf(Buffer)
  })

  it('iterates JPEG quality when maxBytes tight', async () => {
    const png = await createTestPng(1920, 1080)
    const result = await compressScreenshot(png, { effectiveResolution: 2048, maxBytes: 5000, actionSpaceWidth: 1920 })
    expect(result.buffer[0]).toBe(0xff)
    expect(result.buffer[1]).toBe(0xd8)
    expect(result.buffer.length).toBeGreaterThan(0)
  })

  it('returns CompressResult with buffer, imageWidth, imageHeight fields', async () => {
    const png = await createTestPng(1000, 500)
    const result = await compressScreenshot(png, { effectiveResolution: 2000, actionSpaceWidth: 1000 })
    expect(Object.keys(result).sort()).toEqual(['buffer', 'imageHeight', 'imageWidth'])
  })

  it('respects withoutEnlargement — does not upscale tiny images', async () => {
    const png = await createTestPng(100, 100)
    const result = await compressScreenshot(png, { effectiveResolution: 2000, actionSpaceWidth: 100 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(100)
    expect(result.imageWidth).toBe(100)
    expect(result.imageHeight).toBe(100)
  })

  it('D-02: resizes portrait 1080x2400 to 706x1568 using fit:inside max-edge', async () => {
    const png = await createTestPng(1080, 2400)
    const result = await compressScreenshot(png, { effectiveResolution: 1568, actionSpaceWidth: 1080 })
    const meta = await sharp(result.buffer).metadata()
    // Height was longer edge (2400 > 1080) → resized height = 1568
    // Width scales proportionally: 1080 * (1568/2400) = 705.6 → sharp rounds to 706
    expect(meta.height).toBe(1568)
    expect(meta.width).toBeGreaterThanOrEqual(705)
    expect(meta.width).toBeLessThanOrEqual(707)
    expect(result.imageWidth).toBe(meta.width)
    expect(result.imageHeight).toBe(1568)
  })

  it('D-02: resizes landscape 2400x1080 to 1568x706 using fit:inside max-edge', async () => {
    const png = await createTestPng(2400, 1080)
    const result = await compressScreenshot(png, { effectiveResolution: 1568, actionSpaceWidth: 2400 })
    const meta = await sharp(result.buffer).metadata()
    // Width was longer edge (2400 > 1080) → resized width = 1568
    // Height scales proportionally: 1080 * (1568/2400) = 705.6 → sharp rounds to 706
    expect(meta.width).toBe(1568)
    expect(meta.height).toBeGreaterThanOrEqual(705)
    expect(meta.height).toBeLessThanOrEqual(707)
    expect(result.imageWidth).toBe(1568)
    expect(result.imageHeight).toBe(meta.height)
  })

  it('D-04: withoutEnlargement prevents height-only upscale for tall thin images', async () => {
    // Narrow tall image: both dims < effectiveResolution → no resize should happen
    const png = await createTestPng(300, 1200)
    const result = await compressScreenshot(png, { effectiveResolution: 1568, actionSpaceWidth: 300 })
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBe(300)
    expect(meta.height).toBe(1200)
    expect(result.imageWidth).toBe(300)
    expect(result.imageHeight).toBe(1200)
  })

  it('D-01: CompressResult exposes imageWidth and imageHeight matching resized buffer', async () => {
    const png = await createTestPng(1080, 2274)
    const result = await compressScreenshot(png, { effectiveResolution: 1568, actionSpaceWidth: 411 })
    const meta = await sharp(result.buffer).metadata()
    // Height was longer (2274 > 1080) → scales to 1568
    // Width: 1080 * (1568/2274) = 744.67 → sharp rounds to 744 or 745
    expect(result.imageWidth).toBe(meta.width)
    expect(result.imageHeight).toBe(meta.height)
    expect(result.imageHeight).toBe(1568)
    expect(typeof result.imageWidth).toBe('number')
    expect(typeof result.imageHeight).toBe('number')
  })
})
