// EVERY WORD THE DASHBOARD-UI FIREWALL FORCES TO BE WRITTEN TWICE, PINNED EQUAL (428 D-15 · PXH-LIVE-02/03).
//
// dashboard-ui imports only ids and schema, so the live preview spells the embed's report events,
// its host parameter, the frame socket's refusal and end reasons, and the control socket's
// session-gone close code a second time in `lib/live-preview.ts`. This package may read both
// sides: the server's constants through `@vostride/agent-qa-dashboard`, the UI's by reading its
// source, as `live-view-dom.test.ts` reads published sentences. A one-sided change reds the cell
// that owns the word, and the message carries both spellings.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  LIVE_EDITOR_SUPERSEDED_CLOSE_CODE,
  LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE,
  LIVE_EMBED_HOST_PARAM,
  LIVE_EMBED_REPORT_EVENTS,
  LIVE_VIEW_END_REASONS,
  LIVE_VIEW_REFUSAL_REASONS,
} from '@vostride/agent-qa-dashboard'
import { describe, expect, it } from 'vitest'

import { PACKAGES_ROOT } from './spawned-chat.js'

const UI_SOURCE_PATH = join(PACKAGES_ROOT, 'dashboard-ui', 'src', 'lib', 'live-preview.ts')

function uiSource(): string {
  return readFileSync(UI_SOURCE_PATH, 'utf8')
}

/** The members of a published `NAME = [ 'a', 'b' ]` array (prettier-ignore arrays, one per line). */
function uiArray(name: string): string[] {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'u').exec(uiSource())
  if (match === null) throw new Error(`${name} is no longer an exported array literal in lib/live-preview.ts`)
  return [...(match[1] as string).matchAll(/'([^']*)'/gu)].map((member) => member[1] as string)
}

function uiString(name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*'([^']+)'`, 'u').exec(uiSource())
  if (match === null) throw new Error(`${name} is no longer an exported single-quoted literal in lib/live-preview.ts`)
  return match[1] as string
}

function uiNumber(name: string): number {
  const match = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'u').exec(uiSource())
  if (match === null) throw new Error(`${name} is no longer an exported number literal in lib/live-preview.ts`)
  return Number(match[1])
}

/** The body of `parseEmbedReport`, so a cell can show which closed set guards which field. */
function parseEmbedReportSource(): string {
  const source = uiSource()
  const start = source.indexOf('export function parseEmbedReport(')
  if (start === -1) throw new Error('parseEmbedReport is no longer exported from lib/live-preview.ts')
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end === -1 ? undefined : end)
}

function spellings(server: unknown, ui: unknown): string {
  return `server spells ${JSON.stringify(server)}; dashboard-ui spells ${JSON.stringify(ui)}`
}

describe('the live-view words the firewall writes twice (428-23 Task 2)', () => {
  it('EMBED-REPORT-EVENTS-SPELLED-EQUAL: the embed reports the events the preview parses', () => {
    const server: readonly string[] = LIVE_EMBED_REPORT_EVENTS
    const ui = uiArray('LIVE_EMBED_REPORT_EVENTS')
    expect(Array.isArray(server), `the server publishes the set; ${spellings(server, ui)}`).toBe(true)
    expect(server.length, spellings(server, ui)).toBeGreaterThan(0)
    expect([...ui].sort(), spellings(server, ui)).toEqual([...server].sort())
  })

  it('HOST-HINT-SPELLED-EQUAL: the preview sets the parameter the embed reads', () => {
    const server = `?${LIVE_EMBED_HOST_PARAM}=dashboard`
    const ui = uiString('LIVE_PREVIEW_HOST_QUERY')
    expect(ui, spellings(server, ui)).toBe(server)
  })

  it('SESSION-GONE-CODE-EQUAL: the preview names a gone session by the code the server closes with', () => {
    const server = LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE
    const ui = uiNumber('LIVE_EDITOR_SESSION_GONE_CLOSE_CODE')
    expect(typeof server, spellings(server, ui)).toBe('number')
    expect(ui, spellings(server, ui)).toBe(server)
    expect(server, spellings(server, ui)).toBe(4404)
  })

  it('SUPERSEDED-CODE-EQUAL: the editor knows a replaced control socket by the code the server closes it with', () => {
    const server = LIVE_EDITOR_SUPERSEDED_CLOSE_CODE
    const ui = uiNumber('LIVE_EDITOR_SUPERSEDED_CLOSE_CODE')
    expect(typeof server, spellings(server, ui)).toBe('number')
    expect(ui, spellings(server, ui)).toBe(server)
    expect(server, spellings(server, ui)).toBe(4409)
  })

  it('REFUSAL-REASONS-KNOWN-TO-UI: every refusal the frame socket can send is one the preview accepts', () => {
    const parse = parseEmbedReportSource()
    expect(parse, 'parseEmbedReport guards a refusal with LIVE_EMBED_REFUSAL_REASONS')
      .toContain('oneOf(LIVE_EMBED_REFUSAL_REASONS, fields.reason)')
    const server: readonly string[] = LIVE_VIEW_REFUSAL_REASONS
    const ui = uiArray('LIVE_EMBED_REFUSAL_REASONS')
    expect(Array.isArray(server), `the server publishes the set; ${spellings(server, ui)}`).toBe(true)
    expect(server.length, spellings(server, ui)).toBeGreaterThan(0)
    const unknown = server.filter((reason) => !ui.includes(reason))
    expect(unknown, `${spellings(server, ui)}; unknown to the UI: ${JSON.stringify(unknown)}`).toEqual([])
  })

  it('END-REASONS-KNOWN-TO-UI: every end the frame socket can send is one the preview accepts', () => {
    const parse = parseEmbedReportSource()
    expect(parse, 'parseEmbedReport guards an end with LIVE_EMBED_END_REASONS')
      .toContain('oneOf(LIVE_EMBED_END_REASONS, fields.reason)')
    const server: readonly string[] = LIVE_VIEW_END_REASONS
    const ui = uiArray('LIVE_EMBED_END_REASONS')
    expect(Array.isArray(server), `the server publishes the set; ${spellings(server, ui)}`).toBe(true)
    expect(server.length, spellings(server, ui)).toBeGreaterThan(0)
    const unknown = server.filter((reason) => !ui.includes(reason))
    expect(unknown, `${spellings(server, ui)}; unknown to the UI: ${JSON.stringify(unknown)}`).toEqual([])
  })
})
