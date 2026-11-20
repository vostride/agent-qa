import pc from 'picocolors'
import {
  isGitHubActions,
  printRunText,
  stdoutCarriesData,
  type RunTextEnv,
} from './run-text-output.js'

export type LogColors = ReturnType<typeof pc.createColors>
export type LogLineLevel = 'error' | 'warn' | 'info' | 'debug'

export interface LogLine {
  tag: string
  message: string
  level?: LogLineLevel
  data?: Record<string, unknown>
  time?: Date
}

type TagColor = 'cyan' | 'cyanBright' | 'blue' | 'blueBright' | 'magenta' | 'magentaBright' | 'gray'

// Green, red and yellow mean a status, so no tag takes them.
const TAG_COLORS: Readonly<Record<string, TagColor>> = {
  server: 'cyan',
  mcp: 'cyan',
  daemon: 'cyan',
  queue: 'blue',
  'post-run': 'blue',
  jobs: 'blue',
  run: 'cyanBright',
  appium: 'magenta',
  live: 'magentaBright',
  embedder: 'magentaBright',
  knowledge: 'blueBright',
  plugin: 'gray',
  agent: 'cyan',
  adapter: 'cyan',
  cache: 'cyan',
  planner: 'cyan',
  hook: 'cyan',
  runner: 'cyan',
  procedure: 'cyan',
  evidence: 'cyan',
}

const TAG_WIDTH = 9
const CONTINUATION = ' '.repeat('HH:MM:SS'.length + 2 + TAG_WIDTH + 2)

export function isCi(env: RunTextEnv = process.env): boolean {
  const ci = env.CI
  return (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false') || isGitHubActions(env)
}

export function colorEnabled(env: RunTextEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  const force = env.FORCE_COLOR
  if (force !== undefined) return force !== '0' && force !== 'false'
  if (isTTY) return env.TERM !== 'dumb'
  return isCi(env)
}

export function colorsFor(stream: { isTTY?: boolean }, env?: RunTextEnv): LogColors {
  return pc.createColors(colorEnabled(env ?? process.env, stream.isTTY === true))
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatLogLine(line: LogLine, colors: LogColors): string {
  const at = line.time ?? new Date()
  const time = colors.dim(
    `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}:${twoDigits(at.getSeconds())}`,
  )
  const tag = colors[TAG_COLORS[line.tag] ?? 'cyan'](line.tag.padEnd(TAG_WIDTH))
  const tint =
    line.level === 'error' ? colors.red : line.level === 'warn' ? colors.yellow : undefined
  const body = line.message
    .split('\n')
    .map((part) => (tint === undefined ? part : tint(part)))
    .join(`\n${CONTINUATION}`)
  const data = line.data ?? {}
  const keys = Object.keys(data)
  const suffix =
    keys.length === 0
      ? ''
      : ` ${colors.dim(keys.map((key) => `${key}=${JSON.stringify(data[key])}`).join(' '))}`
  return `${time}  ${tag}  ${body}${suffix}`
}

export function printLogLine(
  line: LogLine,
  options: { env?: RunTextEnv; to?: 'stdout' | 'stderr' } = {},
): void {
  const env = options.env ?? process.env
  const level = line.level ?? 'info'
  const wantsStdout =
    options.to === 'stdout' || (options.to === undefined && level !== 'error' && level !== 'warn')
  let print: (text: string) => void
  let stream: { isTTY?: boolean }
  if (wantsStdout && !stdoutCarriesData()) {
    print = (text) => console.log(text)
    stream = process.stdout
  } else if (options.to === undefined && level === 'warn') {
    print = (text) => console.warn(text)
    stream = process.stderr
  } else {
    print = (text) => console.error(text)
    stream = process.stderr
  }
  printRunText(formatLogLine(line, colorsFor(stream, env)), print, { env })
}
