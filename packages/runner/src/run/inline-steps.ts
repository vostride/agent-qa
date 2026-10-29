// Pure string work; the canonical hook id check mirrors agent-qa-ids without depending on it.

import type { Action } from '../platform.js'

// ---- inline hook directives (from hook-inline.ts) --------------------------

const RUNHOOK_RE = /\{\{runHook:"([^"]+)"\}\}/g
// Runner-local canonical hook-id shape: `h_` + 10 hyphen-joined lowercase words.
const CANONICAL_HOOK_ID_RE = /^h_[a-z]+(?:-[a-z]+){9}$/

export function isCanonicalHookIdShape(value: string): boolean {
  return CANONICAL_HOOK_ID_RE.test(value)
}

export interface InlineHookCall {
  hookId: string
  fullMatch: string
}

export function parseHookInline(text: string): InlineHookCall[] {
  const calls: InlineHookCall[] = []
  let match: RegExpExecArray | null
  RUNHOOK_RE.lastIndex = 0
  while ((match = RUNHOOK_RE.exec(text)) !== null) {
    if (!isCanonicalHookIdShape(match[1])) continue
    calls.push({ hookId: match[1], fullMatch: match[0] })
  }
  return calls
}

export function stripHookInline(text: string): string {
  return text.replace(RUNHOOK_RE, '').replace(/\s{2,}/g, ' ').trim()
}

// ---- inline runJS directives (from runjs-inline.ts) ------------------------

const RUNJS_DBL_RE = /\{\{runJS:"((?:[^"\\]|\\.)*)"\}\}/g
const RUNJS_SGL_RE = /\{\{runJS:'((?:[^'\\]|\\.)*)'\}\}/g

export interface RunJSMatch {
  fullMatch: string
  code: string
}

export function parseRunJSInline(text: string): RunJSMatch[] {
  const matches: RunJSMatch[] = []

  RUNJS_DBL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RUNJS_DBL_RE.exec(text)) !== null) {
    matches.push({ fullMatch: m[0], code: m[1].replace(/\\"/g, '"') })
  }

  RUNJS_SGL_RE.lastIndex = 0
  while ((m = RUNJS_SGL_RE.exec(text)) !== null) {
    matches.push({ fullMatch: m[0], code: m[1].replace(/\\'/g, "'") })
  }

  return matches
}

export function coerceRunJSResult(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ---- inline appium directives (from appium-inline.ts) ----------------------

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

  const action: Record<string, unknown> = { type: 'executeScript', command }
  if (Object.keys(args).length > 0) action.args = args
  return action as unknown as Action
}
