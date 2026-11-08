import { PassThrough, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

import type { TerminalPort } from '../init-ui/terminal-background.js'

export const KEY = {
  enter: '\r',
  down: '\x1b[B',
  space: ' ',
  ctrlC: '\x03',
  escape: '\x1b',
} as const

export type ClackOutput = Writable & { isTTY: boolean; columns: number }

export interface ClackStreams {
  input: PassThrough
  output: ClackOutput
  text(): string
  // Each key is written after a short tick, so the prompt has drawn and is listening.
  press(...keys: string[]): Promise<void>
  waitFor(expected: string, timeoutMs?: number): Promise<void>
}

// Real Clack prompts read the input and draw on the output, as they would on a terminal.
export function clackStreams(options: { columns?: number; isTTY?: boolean } = {}): ClackStreams {
  const input = new PassThrough()
  let written = ''
  const output = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        written += chunk.toString()
        done()
      },
    }),
    { isTTY: options.isTTY ?? true, columns: options.columns ?? 100 },
  )
  return {
    input,
    output,
    text: () => written,
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
