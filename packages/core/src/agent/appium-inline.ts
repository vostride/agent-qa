import type { Action } from '../types/platform.js'

const APPIUM_INLINE_RE = /\{\{appium:\s*(.+?)\}\}/

function normalizeAppiumCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

export function parseAppiumInline(text: string): Action | null {
  const match = APPIUM_INLINE_RE.exec(text)
  if (!match) return null

  const body = match[1].trim()
  const parts = body.split(/,\s*/)
  const command = normalizeAppiumCommand(parts[0])
  const args: Record<string, string | number | boolean> = {}

  for (let i = 1; i < parts.length; i++) {
    const colonIdx = parts[i].indexOf(':')
    if (colonIdx === -1) continue
    const key = parts[i].slice(0, colonIdx).trim()
    let value: string | number | boolean = parts[i].slice(colonIdx + 1).trim()
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (/^\d+(\.\d+)?$/.test(value as string)) value = Number(value)
    args[key] = value
  }

  const action: any = { type: 'executeScript', command }
  if (Object.keys(args).length > 0) action.args = args
  return action as Action
}
