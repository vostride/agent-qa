import pc from 'picocolors'
import type { LogEntry } from './types.js'

const LEVEL_COLORS: Record<string, (s: string) => string> = {
  error: pc.red,
  warn: pc.yellow,
  info: (s: string) => s,
  debug: pc.dim,
}

export function formatLogEntry(entry: LogEntry): string {
  const time = pc.dim(entry.timestamp.slice(11, 23))
  const level = (LEVEL_COLORS[entry.level] ?? ((s: string) => s))(entry.level.toUpperCase().padEnd(5))
  const source = pc.cyan(`[${entry.source}]`)
  const dataKeys = Object.keys(entry.data)
  const dataSuffix = dataKeys.length > 0
    ? ' ' + pc.dim(dataKeys.map(k => `${k}=${JSON.stringify(entry.data[k])}`).join(' '))
    : ''
  return `${time} ${level} ${source} ${entry.message}${dataSuffix}`
}
