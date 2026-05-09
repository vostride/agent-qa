import sharp from 'sharp'

export interface AlignOptions {
  width: number
  height: number
}

/** Resize buffer to exact window dimensions. Used by mobile adapters for
 *  action-space alignment (e.g., iOS physical pixels → logical points). */
export async function alignToWindow(buffer: Buffer, opts: AlignOptions): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: opts.width, height: opts.height, kernel: 'lanczos3', fit: 'fill' })
    .png()
    .toBuffer()
}
