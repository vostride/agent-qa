import { Chalk, supportsColorStderr, type ChalkInstance, type ColorSupportLevel } from 'chalk'

export type Background = 'dark' | 'light'

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface BrandPalette {
  chalk: ChalkInstance
  chevron(text: string): string
  wordmark(text: string): string
  accent(text: string): string
  success(text: string): string
  failure(text: string): string
  warning(text: string): string
  dim(text: string): string
}

const PRIMARY: Record<Background, string> = { dark: '#20b8cd', light: '#196872' }
const STATUS: Record<Background, { success: string; failure: string; warning: string }> = {
  dark: { success: '#30D158', failure: '#FF453A', warning: '#FFD60A' },
  light: { success: '#34C759', failure: '#FF3B30', warning: '#FF9500' },
}
const CHEVRON_WITHOUT_BACKGROUND = '#2ba0ab'

function forcedLevel(value: string | undefined): ColorSupportLevel | 'enabled' | undefined {
  if (value === undefined) return undefined
  if (value === 'false') return 0
  if (value === 'true' || value === '') return 'enabled'
  if (!/^\d+$/.test(value)) return undefined
  return Math.min(Number.parseInt(value, 10), 3) as ColorSupportLevel
}

// chalk never reads NO_COLOR, so agent-qa's posture decides the level and chalk only renders it.
export function colorLevelFor(
  env: NodeJS.ProcessEnv,
  stream: { isTTY?: boolean },
  detected: ColorSupportLevel = supportsColorStderr ? supportsColorStderr.level : 0,
): ColorSupportLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0
  const forced = forcedLevel(env.FORCE_COLOR)
  if (typeof forced === 'number') return forced
  if (forced === undefined && stream.isTTY !== true) return 0
  return forced === 'enabled' ? (Math.max(1, detected) as ColorSupportLevel) : detected
}

function mixHalfway(color: string, background: Rgb): string {
  const value = Number.parseInt(color.slice(1), 16)
  const primary = [value >> 16, (value >> 8) & 0xff, value & 0xff]
  const behind = [background.r, background.g, background.b].map((channel) =>
    Math.round(Math.min(1, Math.max(0, channel)) * 255),
  )
  return `#${primary
    .map((channel, i) =>
      Math.round((channel + behind[i]!) / 2)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

export function brandPalette(options: {
  background: Background | undefined
  rgb?: Rgb
  level: ColorSupportLevel
}): BrandPalette {
  const { background = 'dark', rgb, level } = options
  const chalk = new Chalk({ level })
  // At 16 colours the light turquoise rounds to black, so every turquoise becomes plain cyan.
  const turquoise = (color: string) => (level === 1 ? chalk.cyan : chalk.hex(color))
  const primary = turquoise(PRIMARY[background])
  const chevron = turquoise(
    rgb === undefined ? CHEVRON_WITHOUT_BACKGROUND : mixHalfway(PRIMARY[background], rgb),
  )
  const status = STATUS[background]
  return {
    chalk,
    chevron: (text) => chevron(text),
    wordmark: (text) => primary(text),
    accent: (text) => primary(text),
    success: (text) => chalk.hex(status.success)(text),
    failure: (text) => chalk.hex(status.failure)(text),
    warning: (text) => chalk.hex(status.warning)(text),
    dim: (text) => chalk.dim(text),
  }
}
