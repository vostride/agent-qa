import type { Background, Rgb } from './palette.js'

export interface TerminalPort {
  isTTY: boolean
  env: NodeJS.ProcessEnv
  setRawMode(on: boolean): void
  write(text: string): void
  onData(listener: (chunk: string) => void): () => void
  // Every chunk the input delivers passes through `filter` before any listener sees it.
  intercept(filter: (chunk: string) => string): () => void
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

// OSC 11 asks for the background; DA1 follows as a sentinel every terminal answers, in order.
const QUERY = '\x1b]11;?\x1b\\\x1b[c'
const DA1_REPLY = /\x1b\[\?[\d;]*c/
const OSC11_REPLY =
  /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i
const MAX_REPLY_LENGTH = 256
const LATE_OSC11_REPLY = /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/g
const LATE_DA1_REPLY = /\x1b\[\?[\d;]*c/g
// The unfinished start of a reply at a chunk's end. A lone ESC is the Escape key, so it passes.
const REPLY_START = /\x1b(?:\](?:1(?:1(?:;[^\x07\x1b]*\x1b?)?)?)?|\[\?[\d;]*)$/

export function processTerminalPort(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
): TerminalPort {
  return {
    isTTY: stdin.isTTY === true && stdout.isTTY === true,
    env,
    setRawMode: (on) => {
      stdin.setRawMode(on)
    },
    write: (text) => {
      stdout.write(text)
    },
    onData: (listener) => {
      const forward = (chunk: Buffer | string) => listener(chunk.toString())
      stdin.on('data', forward)
      stdin.resume()
      return () => {
        stdin.off('data', forward)
        // Whatever is still buffered is part of the reply and must not reach the first prompt.
        while (stdin.readableLength > 0 && stdin.read() !== null) {}
        stdin.pause()
      }
    },
    intercept: (filter) => {
      const original = stdin.emit
      const emit = original as (
        this: NodeJS.ReadStream,
        event: string | symbol,
        ...args: unknown[]
      ) => boolean
      const filtered = function (
        this: NodeJS.ReadStream,
        event: string | symbol,
        ...args: unknown[]
      ): boolean {
        const chunk = args[0]
        if (event !== 'data' || (typeof chunk !== 'string' && !Buffer.isBuffer(chunk))) {
          return emit.call(this, event, ...args)
        }
        // latin1 keeps every byte as it came, and the replies are plain ASCII.
        const text = typeof chunk === 'string' ? chunk : chunk.toString('latin1')
        const kept = filter(text)
        if (kept === text) return emit.call(this, event, ...args)
        if (kept === '') return true
        return emit.call(
          this,
          event,
          typeof chunk === 'string' ? kept : Buffer.from(kept, 'latin1'),
        )
      }
      stdin.emit = filtered as typeof stdin.emit
      return () => {
        if (stdin.emit === filtered) stdin.emit = original
      }
    },
    setTimeout,
    clearTimeout,
  }
}

// Drops the background and DA1 replies a slow terminal sends after the probe gave up, so they
// never reach a prompt as keys. Nothing a key sends looks like either reply.
export function createLateReplyFilter(): { take(chunk: string): string; finished(): boolean } {
  let held = ''
  let finished = false
  return {
    take: (chunk) => {
      let text = held + chunk
      held = ''
      if (finished) return text
      text = text.replace(LATE_OSC11_REPLY, '')
      const withoutDa1 = text.replace(LATE_DA1_REPLY, '')
      if (withoutDa1 !== text) finished = true
      text = withoutDa1
      const start = finished ? null : REPLY_START.exec(text)
      if (start !== null && text.length - start.index <= MAX_REPLY_LENGTH) {
        held = text.slice(start.index)
        text = text.slice(0, start.index)
      }
      return text
    },
    finished: () => finished,
  }
}

export function parseOsc11(text: string): Rgb | undefined {
  const match = OSC11_REPLY.exec(text)
  if (match === null) return undefined
  const channel = (hex: string) => Number.parseInt(hex, 16) / (16 ** hex.length - 1)
  return { r: channel(match[1]!), g: channel(match[2]!), b: channel(match[3]!) }
}

function quietly(action: () => void): void {
  try {
    action()
  } catch {
    // Restoring the terminal is best effort; the probe never throws into init.
  }
}

export async function probeTerminalBackground(
  port: TerminalPort,
  timeoutMs = 1000,
): Promise<Rgb | undefined> {
  if (!port.isTTY || port.env.TERM === 'dumb') return undefined
  let off: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    port.setRawMode(true)
    return await new Promise<Rgb | undefined>((settle) => {
      let reply = ''
      timer = port.setTimeout(() => {
        // A slow terminal can still answer, so the input is filtered until its DA1 reply passes.
        quietly(() => {
          const filter = createLateReplyFilter()
          // A reply cut off at the timeout is finished by the chunks that follow.
          filter.take(reply)
          const release = port.intercept((chunk) => {
            const kept = filter.take(chunk)
            if (filter.finished()) release()
            return kept
          })
        })
        settle(parseOsc11(reply))
      }, timeoutMs)
      off = port.onData((chunk) => {
        reply += chunk
        if (reply.length > MAX_REPLY_LENGTH) settle(undefined)
        else if (DA1_REPLY.test(reply)) settle(parseOsc11(reply))
      })
      port.write(QUERY)
    })
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) port.clearTimeout(timer)
    if (off !== undefined) quietly(off)
    quietly(() => port.setRawMode(false))
  }
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function backgroundFromColorFgBg(value: string | undefined): Background | undefined {
  if (value === undefined) return undefined
  const background = value.split(';').at(-1) ?? ''
  if (!/^\d+$/.test(background)) return undefined
  const code = Number(background)
  if (code === 7 || code === 15) return 'light'
  if (code <= 6 || code === 8) return 'dark'
  return undefined
}

export function classifyBackground(
  rgb: Rgb | undefined,
  env: NodeJS.ProcessEnv,
): Background | undefined {
  if (rgb !== undefined) return relativeLuminance(rgb) < 0.5 ? 'dark' : 'light'
  return backgroundFromColorFgBg(env.COLORFGBG)
}
