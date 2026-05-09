import sharp from 'sharp'

export interface ImageDimensions {
  width: number
  height: number
}

/** Read image buffer width/height without decoding pixels.
 *  Used by mobile adapters for action-space drift assertions (D-06/D-07). */
export async function getImageDimensions(buffer: Buffer): Promise<ImageDimensions | undefined> {
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height) return undefined
  return { width: meta.width, height: meta.height }
}
