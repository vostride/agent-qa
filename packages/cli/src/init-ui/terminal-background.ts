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

export function processTerminalPort(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): TerminalPort {
  return {
    isTTY: stdin.isTTY === true && stdout.isTTY === true,
    env: process.env,
    setRawMode: () => {},
    write: () => {},
    onData: () => () => {},
    setTimeout,
    clearTimeout,
  }
}

export function parseOsc11(_text: string): Rgb | undefined {
  return undefined
}

export async function probeTerminalBackground(
  _port: TerminalPort,
  _timeoutMs = 1000,
): Promise<Rgb | undefined> {
  return undefined
}

export function classifyBackground(
  _rgb: Rgb | undefined,
  _env: NodeJS.ProcessEnv,
): Background | undefined {
  return undefined
}
