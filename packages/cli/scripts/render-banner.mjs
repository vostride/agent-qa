import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import figlet from 'figlet'
import opentype from 'opentype.js'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const target = join(here, '..', 'src', 'init-ui', 'banner-art.ts')

const CHEVRON = '›'
const WORDMARK = 'agent-qa'
const GAP = 1
const MAX_WIDTH = 69

// Ten raster rows pair into five half-block lines; the baseline leaves room for the descenders.
const RASTER_HEIGHT = 10
const BASELINE = 8
const WORDMARK_ADVANCE = 7

async function loadFont(specifier) {
  const bytes = await readFile(require.resolve(specifier))
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

const vt323 = await loadFont('@fontsource/vt323/files/vt323-latin-400-normal.woff')
const geistMono = await loadFont('@fontsource/geist-mono/files/geist-mono-latin-700-normal.woff')

const geistSize = (WORDMARK_ADVANCE * geistMono.unitsPerEm) / geistMono.charToGlyph('a').advanceWidth
// VT323 draws on an 80-unit pixel grid, so this size puts one of its pixels on one raster pixel.
const vt323Size = vt323.unitsPerEm / 80
const chevronAdvance = Math.round((vt323.charToGlyph(CHEVRON).advanceWidth * vt323Size) / vt323.unitsPerEm)

// VT323's chevron sits on half-pixel columns and only reads crisp at a higher cut.
const faces = new Map([
  [CHEVRON, { font: vt323, size: vt323Size, advance: chevronAdvance, threshold: 128 }],
  ...[...new Set(`${WORDMARK} `)].map((ch) => [
    ch,
    { font: geistMono, size: geistSize, advance: WORDMARK_ADVANCE, threshold: 110 },
  ]),
])

async function rasterise(ch, { font, size, advance, threshold }) {
  const path = font.getPath(ch, 0, BASELINE, size).toPathData(3)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${advance}" height="${RASTER_HEIGHT}">` +
    `<rect width="${advance}" height="${RASTER_HEIGHT}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`
  const { data, info } = await sharp(Buffer.from(svg))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const ink = (x, y) => 255 - data[(y * advance + x) * info.channels] >= threshold
  const lines = []
  for (let y = 0; y < RASTER_HEIGHT; y += 2) {
    let line = ''
    for (let x = 0; x < advance; x++) {
      const top = ink(x, y)
      const bottom = y + 1 < RASTER_HEIGHT && ink(x, y + 1)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines
}

function figletFont(glyphs) {
  const height = RASTER_HEIGHT / 2
  const maxLength = Math.max(...[...glyphs.values()].map((rows) => rows[0].length)) + 2
  const character = (rows) => rows.map((row, i) => `${row}${i === rows.length - 1 ? '@@' : '@'}`)
  const blank = Array.from({ length: height }, () => '')
  const required = []
  for (let code = 32; code <= 126; code++) required.push(code)
  required.push(196, 214, 220, 228, 246, 252, 223)
  const lines = [`flf2a$ ${height} ${BASELINE / 2} ${maxLength} -1 1 0 0 1`, 'agent-qa banner']
  for (const code of required) {
    lines.push(...character(glyphs.get(String.fromCharCode(code)) ?? blank))
  }
  lines.push(`${CHEVRON.codePointAt(0)}  SINGLE RIGHT-POINTING ANGLE QUOTATION MARK`)
  lines.push(...character(glyphs.get(CHEVRON)))
  return `${lines.join('\n')}\n`
}

function trimColumns(lines) {
  const width = Math.max(...lines.map((line) => line.length))
  const padded = lines.map((line) => line.padEnd(width))
  const inked = (x) => padded.some((line) => line[x] !== ' ')
  let start = 0
  while (start < width && !inked(start)) start++
  let end = width
  while (end > start && !inked(end - 1)) end--
  return padded.map((line) => line.slice(start, end))
}

const glyphs = new Map()
for (const [ch, face] of faces) glyphs.set(ch, await rasterise(ch, face))

const workdir = await mkdtemp(join(tmpdir(), 'agent-qa-banner-'))
let chevron
let wordmark
try {
  const fontPath = join(workdir, 'agent-qa-banner.flf')
  await writeFile(fontPath, figletFont(glyphs))
  const font = figlet.parseFont('agent-qa-banner', await readFile(fontPath, 'utf8'))
  if (!font) throw new Error('figlet could not parse the banner font')
  const render = (text) =>
    figlet.textSync(text, { font: 'agent-qa-banner', horizontalLayout: 'full' }).split('\n')
  chevron = trimColumns(render(CHEVRON))
  wordmark = trimColumns(render(WORDMARK))
} finally {
  await rm(workdir, { recursive: true, force: true })
}

if (chevron.length !== wordmark.length) throw new Error('the chevron and wordmark heights differ')
let rows = chevron.map((part, i) => [part, wordmark[i]])
const empty = ([c, w]) => !/\S/.test(c) && !/\S/.test(w)
while (rows.length > 0 && empty(rows[0])) rows = rows.slice(1)
while (rows.length > 0 && empty(rows.at(-1))) rows = rows.slice(0, -1)
rows = rows.map(([c, w]) => [c, w.trimEnd()])

for (const [c, w] of rows) {
  if (!/^[▀▄█ ]*$/.test(c + w)) throw new Error(`the banner holds a character other than half blocks`)
}
const chevronWidth = chevron[0].length
const width = chevronWidth + GAP + Math.max(...rows.map(([, w]) => w.length))
if (width > MAX_WIDTH) throw new Error(`the banner is ${width} columns, wider than ${MAX_WIDTH}`)

const source = [
  '// Generated by scripts/render-banner.mjs (pnpm --filter agent-qa render:banner). Do not edit.',
  '// A document rendered from VT323 and Geist Mono (OFL-1.1); no font ships with it.',
  '',
  'export const BANNER_ROWS: readonly (readonly [chevron: string, wordmark: string])[] = [',
  ...rows.map(([c, w]) => `  ['${c}', '${w}'],`),
  ']',
  '',
  `export const BANNER_GAP = ${GAP}`,
  '',
  `export const BANNER_WIDTH = ${width}`,
  '',
].join('\n')

await writeFile(target, source)
console.log(`wrote ${rows.length} lines, ${width} columns, to src/init-ui/banner-art.ts`)
