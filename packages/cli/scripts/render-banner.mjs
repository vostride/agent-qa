import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const target = join(here, '..', 'src', 'init-ui', 'banner-art.ts')

const CHEVRON = '›'
const WORDMARK = 'agent-qa'
const MAX_WIDTH = 64

// A braille cell holds two columns and four rows of dots. On screen a cell is one unit wide and
// two tall, so a dot is half a unit square.
const DOTS_X = 2
const DOTS_Y = 4
const DOT = 0.5

// Terminals leave a little space between rows, so a stroke that crosses a row boundary shows a
// seam. The x-height spans exactly three rows and the baseline sits on a row boundary, which puts
// the seams at the edges of the lowercase letters rather than through them.
const ROWS = 5
const ASCENDER_ROWS = 1
const X_HEIGHT_ROWS = 3
const TRACKING = 0.94
const GAP = 1
// VT323 draws on 80-unit pixels; three dots per pixel keeps its steps whole.
const CHEVRON_DOTS_PER_PIXEL = 3
const SUPERSAMPLE = 24

async function loadFont(specifier) {
  const bytes = await readFile(require.resolve(specifier))
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

const vt323 = await loadFont('@fontsource/vt323/files/vt323-latin-400-normal.woff')
const geistMono = await loadFont('@fontsource/geist-mono/files/geist-mono-latin-700-normal.woff')

// opentype.js reuses a glyph's path between calls, so each outline is copied once and scaled here.
const outlines = new Map()
function outline(font, ch) {
  if (!outlines.has(font)) outlines.set(font, new Map())
  const forFont = outlines.get(font)
  if (!forFont.has(ch)) {
    const glyph = font.charToGlyph(ch)
    const commands = glyph.getPath(0, 0, font.unitsPerEm).commands.map((command) => ({ ...command }))
    forFont.set(ch, { commands, advance: glyph.advanceWidth, unitsPerEm: font.unitsPerEm })
  }
  return forFont.get(ch)
}

function placed({ commands, unitsPerEm }, x, y, size) {
  const k = size / unitsPerEm
  const p = (px, py) => `${(x + px * k).toFixed(4)} ${(y + py * k).toFixed(4)}`
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
  const d = commands
    .map((c) => {
      for (const [px, py] of [[c.x, c.y], [c.x1, c.y1], [c.x2, c.y2]]) {
        if (typeof px !== 'number') continue
        box.x1 = Math.min(box.x1, x + px * k)
        box.x2 = Math.max(box.x2, x + px * k)
        box.y1 = Math.min(box.y1, y + py * k)
        box.y2 = Math.max(box.y2, y + py * k)
      }
      if (c.type === 'M') return `M${p(c.x, c.y)}`
      if (c.type === 'L') return `L${p(c.x, c.y)}`
      if (c.type === 'Q') return `Q${p(c.x1, c.y1)} ${p(c.x, c.y)}`
      if (c.type === 'C') return `C${p(c.x1, c.y1)} ${p(c.x2, c.y2)} ${p(c.x, c.y)}`
      return 'Z'
    })
    .join('')
  return { d, box }
}

const xHeight = -placed(outline(geistMono, 'x'), 0, 0, 1).box.y1
const size = (X_HEIGHT_ROWS * 2) / xHeight
const baseline = (ASCENDER_ROWS + X_HEIGHT_ROWS) * 2

const chevronSize = (CHEVRON_DOTS_PER_PIXEL * DOT * vt323.unitsPerEm) / 80
const chevronBox = placed(outline(vt323, CHEVRON), 0, 0, chevronSize).box
const snap = (value, step) => Math.round(value / step) * step
const pixel = CHEVRON_DOTS_PER_PIXEL * DOT
const xMiddle = baseline - X_HEIGHT_ROWS
const chevronX = snap(-chevronBox.x1, DOT)
const chevronY = snap(xMiddle - (chevronBox.y1 + chevronBox.y2) / 2, pixel)
const chevron = placed(outline(vt323, CHEVRON), chevronX, chevronY, chevronSize)

const chevronColumns = Math.ceil(chevron.box.x2)
let pen = chevronColumns + GAP
const glyphs = []
for (const [index, ch] of [...WORDMARK].entries()) {
  const shape = outline(geistMono, ch)
  if (index === 0) pen -= placed(shape, 0, 0, size).box.x1
  let glyph = placed(shape, pen, baseline, size)
  // A bar that would straddle a row boundary moves up to sit on it, so no seam runs through it.
  const boundary = Math.ceil(glyph.box.y1 / 2) * 2
  if (ch === '-' && boundary < glyph.box.y2) glyph = placed(shape, pen, baseline - (glyph.box.y2 - boundary), size)
  glyphs.push(glyph)
  pen += (shape.advance * size * TRACKING) / shape.unitsPerEm
}
const width = Math.ceil(Math.max(...glyphs.map((glyph) => glyph.box.x2)))
const height = ROWS * 2

async function coverage(paths) {
  const scale = SUPERSAMPLE
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g transform="scale(${scale})">` +
    paths.map((d) => `<path d="${d}" fill="#000"/>`).join('') +
    '</g></svg>'
  const { data, info } = await sharp(Buffer.from(svg))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return (x0, y0) => {
    let ink = 0
    let count = 0
    for (let y = Math.round(y0 * scale); y < Math.round((y0 + DOT) * scale); y++) {
      for (let x = Math.round(x0 * scale); x < Math.round((x0 + DOT) * scale); x++) {
        ink += 255 - data[(y * info.width + x) * info.channels]
        count++
      }
    }
    return ink / (count * 255)
  }
}

const chevronInk = await coverage([chevron.d])
const wordmarkInk = await coverage(glyphs.map((glyph) => glyph.d))

// Braille numbers its dots down the left column, then the right, with the bottom row last.
const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]
function cell(ink, column, row) {
  let bits = 0
  for (let dy = 0; dy < DOTS_Y; dy++) {
    for (let dx = 0; dx < DOTS_X; dx++) {
      if (ink(column + dx * DOT, row * 2 + dy * DOT) >= 0.5) bits |= BIT[dy][dx]
    }
  }
  return bits
}

const rows = []
let wordmarkStart = width
for (let row = 0; row < ROWS; row++) {
  let chevronPart = ''
  let wordmarkPart = ''
  for (let column = 0; column < width; column++) {
    const c = cell(chevronInk, column, row)
    const w = cell(wordmarkInk, column, row)
    if (c && w) throw new Error('the chevron and the wordmark overlap')
    const glyph = (bits) => (bits ? String.fromCodePoint(0x2800 + bits) : ' ')
    if (column < chevronColumns) chevronPart += glyph(c | w)
    else wordmarkPart += glyph(c | w)
    if (w && column < wordmarkStart) wordmarkStart = column
  }
  rows.push([chevronPart, wordmarkPart])
}
const gap = wordmarkStart - chevronColumns
if (gap < 1) throw new Error('the wordmark touches the chevron')
const art = rows.map(([c, w]) => [c, w.slice(gap).trimEnd()])
const bannerWidth = chevronColumns + gap + Math.max(...art.map(([, w]) => w.length))
if (bannerWidth > MAX_WIDTH) throw new Error(`the banner is ${bannerWidth} columns, wider than ${MAX_WIDTH}`)
for (const [c, w] of art) {
  if (!/^[⠁-⣿ ]*$/u.test(c + w)) throw new Error('the banner holds a character other than braille')
}

const source = [
  '// Generated by scripts/render-banner.mjs (pnpm --filter agent-qa render:banner). Do not edit.',
  '// A document rendered from VT323 and Geist Mono (OFL-1.1); no font ships with it.',
  '',
  'export const BANNER_ROWS: readonly (readonly [chevron: string, wordmark: string])[] = [',
  ...art.map(([c, w]) => `  ['${c}', '${w}'],`),
  ']',
  '',
  `export const BANNER_GAP = ${gap}`,
  '',
  `export const BANNER_WIDTH = ${bannerWidth}`,
  '',
].join('\n')

const current = await readFile(target, 'utf8').catch(() => '')
if (current === source) {
  console.log('src/init-ui/banner-art.ts is up to date')
} else {
  await writeFile(target, source)
  console.log(`wrote ${art.length} lines, ${bannerWidth} columns, to src/init-ui/banner-art.ts`)
}
