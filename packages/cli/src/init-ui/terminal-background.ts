import type { Background, Rgb } from './palette.js'

export interface TerminalPort {
  isTTY: boolean
  env: NodeJS.ProcessEnv
  setRawMode(on: boolean): void
  write(text: string): void
  onData(listener: (chunk: string) => void): () => void
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

// OSC 11 asks for the background; DA1 follows as a sentinel every terminal answers, in order.
const QUERY = '\x1b]11;?\x1b\\\x1b[c'
const DA1_REPLY = /\x1b\[\?[\d;]*c/
const OSC11_REPLY =
  /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i
const MAX_REPLY_LENGTH = 256

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
    setTimeout,
    clearTimeout,
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
      timer = port.setTimeout(() => settle(parseOsc11(reply)), timeoutMs)
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
