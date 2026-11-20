export interface LiveLine {
  start(text: string): void
  stop(): void
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const graphemes = new Intl.Segmenter()

// The spinner's glyph and the space after it take the row's first two columns.
export function fitToRow(text: string, columns: number, tail: string): string {
  const room = columns - 2 - tail.length
  if (room <= 1) return ''
  const parts = Array.from(
    graphemes.segment(text.replace(/\s+/gu, ' ').trim()),
    (part) => part.segment,
  )
  return parts.length > room ? `${parts.slice(0, room - 1).join('')}…` : parts.join('')
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

  const draw = (): void => {
    const tail = `  ${Math.floor((Date.now() - startedAt) / 1000)}s`
    spinner.text = fitToRow(text, stream.columns || 80, tail) + tail
  }
  const onResize = (): void => {
    draw()
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
