import { PassThrough, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

import type { TerminalPort } from '../init-ui/terminal-background.js'

export const KEY = {
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  space: ' ',
  ctrlC: '\x03',
  escape: '\x1b',
} as const

export type ClackOutput = Writable & { isTTY: boolean; columns: number; rows?: number }

export interface ClackStreams {
  input: PassThrough
  output: ClackOutput
  text(): string
  // What a terminal shows now: everything written, replayed with Clack's cursor and erase codes.
  screen(): string[]
  // Each key is written after a short tick, so the prompt has drawn and is listening.
  press(...keys: string[]): Promise<void>
  waitFor(expected: string, timeoutMs?: number): Promise<void>
}

// Real Clack prompts read the input and draw on the output, as they would on a terminal.
export function clackStreams(
  options: { columns?: number; rows?: number; isTTY?: boolean } = {},
): ClackStreams {
  const input = new PassThrough()
  let written = ''
  const output = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        written += chunk.toString()
        done()
      },
    }),
    {
      isTTY: options.isTTY ?? true,
      columns: options.columns ?? 100,
      ...(options.rows === undefined ? {} : { rows: options.rows }),
    },
  )
  return {
    input,
    output,
    text: () => written,
    screen: () => replay(written),
    press: async (...keys) => {
      for (const key of keys) {
        await sleep(20)
        input.write(key)
      }
    },
    waitFor: async (expected, timeoutMs = 3000) => {
      for (let waited = 0; !written.includes(expected); waited += 10) {
        if (waited >= timeoutMs) {
          throw new Error(`the rail never drew ${JSON.stringify(expected)}:\n${written}`)
        }
        await sleep(10)
      }
    },
  }
}

// SGR and the cursor's show and hide change nothing on the grid; other escapes are skipped.
function replay(written: string): string[] {
  const lines: string[][] = [[]]
  let row = 0
  let column = 0
  const lineAt = (at: number): string[] => {
    while (lines.length <= at) lines.push([])
    return lines[at]!
  }
  const csi = (params: string, final: string): void => {
    const count = Math.max(1, Number.parseInt(params, 10) || 1)
    switch (final) {
      case 'A':
        row = Math.max(0, row - count)
        break
      case 'B':
        row += count
        break
      case 'C':
        column += count
        break
      case 'D':
        column = Math.max(0, column - count)
        break
      case 'G':
        column = count - 1
        break
      case 'K':
        if (params === '2') lineAt(row).length = 0
        else lineAt(row).splice(column)
        break
      case 'J':
        lineAt(row).splice(column)
        lines.length = row + 1
        break
    }
  }
  const characters = [...written]
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!
    if (character === '\x1b') {
      const next = characters[index + 1]
      if (next === '[') {
        let end = index + 2
        while (end < characters.length && !/[@-~]/u.test(characters[end]!)) end += 1
        csi(characters.slice(index + 2, end).join(''), characters[end] ?? '')
        index = end
      } else if (next === ']') {
        let end = index + 2
        while (
          end < characters.length &&
          characters[end] !== '\x07' &&
          characters[end] !== '\x1b'
        ) {
          end += 1
        }
        index = characters[end] === '\x1b' ? end + 1 : end
      } else {
        index += 1
      }
    } else if (character === '\n') {
      row += 1
      column = 0
    } else if (character === '\r') {
      column = 0
    } else if (character >= ' ') {
      const line = lineAt(row)
      while (line.length < column) line.push(' ')
      line[column] = character
      column += 1
    }
  }
  return lines.map((line) => line.join('').trimEnd())
}

export interface AnsweringTerminal {
  port: TerminalPort
  asked(): number
}

const DA1_REPLY = '\x1b[?62;22c'
export const DARK_BACKGROUND_REPLY = `\x1b]11;rgb:1e1e/1e1e/1e1e\x07${DA1_REPLY}`

// A terminal that answers the background probe: with no reply given it answers DA1 alone, as a
// terminal that does not report its background does.
export function answeringTerminal(reply: string = DA1_REPLY): AnsweringTerminal {
  const listeners = new Set<(chunk: string) => void>()
  let asked = 0
  const port: TerminalPort = {
    isTTY: true,
    env: { TERM: 'xterm-256color' },
    setRawMode: () => {},
    write: () => {
      asked += 1
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(reply)
      })
    },
    onData: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    intercept: () => () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  return { port, asked: () => asked }
}
