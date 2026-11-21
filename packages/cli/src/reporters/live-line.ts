export interface LiveLine {
  start(text: string): void
  stop(): void
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const graphemes = new Intl.Segmenter()

const TWO_CELLS = new RegExp(
  [
    // East Asian wide and fullwidth characters, by block.
    String.raw`[\u1100-\u115F\u2E80-\u303E\u3041-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF]`,
    String.raw`[\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFF9E\uFF9F\uFFE0-\uFFE6]`,
    String.raw`[\u{16FE0}-\u{18D7F}\u{1AFF0}-\u{1B2FF}\u{1D300}-\u{1D37F}\u{20000}-\u{3FFFD}]`,
    // What a terminal draws as an emoji, the variation selector that asks for one included.
    String.raw`[\u{1F000}-\u{1FAFF}\uFE0F]|\p{Emoji_Presentation}`,
  ].join('|'),
  'u',
)
// Combining marks, variation selectors among them, and joiners: drawn on the character before.
const NO_CELL = /^[\p{Mn}\p{Me}\u200C\u200D]+$/u
const TAKES_A_CELL = /[^\p{Mn}\p{Me}\u200C\u200D]/gu

// A cell too many cuts the text a little early; a cell too few wraps the row. So a grapheme some
// terminals draw wider than others counts two: an emoji, and a cluster of letters as Thai writes.
function cellsOf(grapheme: string): number {
  if (NO_CELL.test(grapheme)) return 0
  if (TWO_CELLS.test(grapheme)) return 2
  return (grapheme.match(TAKES_A_CELL)?.length ?? 1) > 1 ? 2 : 1
}

// The spinner's glyph and the space after it take the row's first two columns.
export function fitToRow(text: string, columns: number, tail: string): string {
  const room = columns - 2 - tail.length
  if (room <= 1) return ''
  const parts = Array.from(
    graphemes.segment(text.replace(/\s+/gu, ' ').trim()),
    (part) => part.segment,
  )
  let cells = 0
  let kept = 0
  for (const [index, part] of parts.entries()) {
    cells += cellsOf(part)
    if (cells > room) return `${parts.slice(0, kept).join('')}…`
    if (cells < room) kept = index + 1
  }
  return parts.join('')
}

// The library loads here, on first use: the bundled CLI would hoist a static import into every
// command, and only a run in a terminal draws the line.
export async function createLiveLine(
  stream: NodeJS.WriteStream,
  frame: (glyph: string) => string,
): Promise<LiveLine> {
  const { default: ora } = await import('ora')
  // With stdin left to the library, a Ctrl+C typed during a step never reaches the run.
  const spinner = ora({
    stream,
    isEnabled: true,
    discardStdin: false,
    color: false,
    spinner: { frames: FRAMES.map(frame), interval: 80 },
  })
  let text = ''
  let startedAt = 0
  let ticker: NodeJS.Timeout | undefined

  // The carriage return rests the cursor at the row's start. A key the terminal echoes then lands
  // on the line, where the next frame covers it, and not past the row's end on a row of its own.
  const draw = (): void => {
    const tail = `  ${Math.floor((Date.now() - startedAt) / 1000)}s`
    spinner.text = `${fitToRow(text, stream.columns || 80, tail)}${tail}\r`
  }
  // A terminal that wraps the row again when the window narrows, and keeps the cursor on its
  // character, leaves the rest of the old line on the rows below: erasing down removes it.
  const onResize = (): void => {
    draw()
    stream.clearScreenDown()
    spinner.render()
  }

  return {
    start(next) {
      text = next
      startedAt = Date.now()
      draw()
      if (ticker !== undefined) {
        spinner.render()
        return
      }
      spinner.start()
      ticker = setInterval(draw, 1000)
      ticker.unref()
      stream.on('resize', onResize)
    },
    stop() {
      if (ticker === undefined) return
      clearInterval(ticker)
      ticker = undefined
      stream.off('resize', onResize)
      spinner.stop()
    },
  }
}
