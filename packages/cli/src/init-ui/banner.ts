import { BANNER_GAP, BANNER_ROWS, BANNER_WIDTH } from './banner-art.js'
import type { BrandPalette } from './palette.js'

export function renderBanner(options: {
  columns: number
  palette: Pick<BrandPalette, 'chevron' | 'wordmark'>
}): string[] | undefined {
  const { columns, palette } = options
  if (columns < BANNER_WIDTH) return undefined
  const gap = ' '.repeat(BANNER_GAP)
  return BANNER_ROWS.map(
    ([chevron, wordmark]) => `${palette.chevron(chevron)}${gap}${palette.wordmark(wordmark)}`,
  )
}
