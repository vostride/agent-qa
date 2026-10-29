import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

async function markerApi() {
  return import('../rebuild-marker.js')
}

describe('durable rebuild marker', () => {
  let root: string
  let knowledgeRoot: string
  let markerFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-rebuild-marker-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    markerFile = join(knowledgeRoot, 'memory', 'index', '.rebuild-requested')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the missing index directory and writes exactly one structured signal', async () => {
    const { REBUILD_MARKER_FILE, requestRebuild } = await markerApi()
    expect(REBUILD_MARKER_FILE).toBe('.rebuild-requested')
    requestRebuild({
      knowledgeRoot,
      reason: 'corrupt',
      detail: 'quick_check failed',
    })

    expect(existsSync(markerFile)).toBe(true)
    const parsed = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['reason', 'detail', 'requestedAt'])
    expect(parsed).toMatchObject({ reason: 'corrupt', detail: 'quick_check failed' })
    expect(parsed.requestedAt).toEqual(expect.any(String))
    expect(Number.isNaN(Date.parse(String(parsed.requestedAt)))).toBe(false)
  })

  it('preserves the first request byte-for-byte when later callers signal again', async () => {
    const { readRebuildRequest, requestRebuild } = await markerApi()
    requestRebuild({
      knowledgeRoot,
      reason: 'corrupt',
      detail: 'quick_check failed',
    })
    const firstSignal = readFileSync(markerFile, 'utf8')

    requestRebuild({
      knowledgeRoot,
      reason: 'absent',
      detail: 'index disappeared later',
    })

    expect(readFileSync(markerFile, 'utf8')).toBe(firstSignal)
    expect(readRebuildRequest(knowledgeRoot)).toEqual({
      present: true,
      request: JSON.parse(firstSignal),
    })
  })

  it('treats malformed content as a bare signal instead of throwing', async () => {
    const { readRebuildRequest } = await markerApi()
    mkdirSync(join(knowledgeRoot, 'memory', 'index'), { recursive: true })
    writeFileSync(markerFile, '{not valid marker json', 'utf8')

    expect(() => readRebuildRequest(knowledgeRoot)).not.toThrow()
    expect(readRebuildRequest(knowledgeRoot)).toEqual({
      present: true,
      request: undefined,
    })
  })

  it('distinguishes absence and clears an existing request idempotently', async () => {
    const { clearRebuildRequest, readRebuildRequest, requestRebuild } = await markerApi()
    expect(readRebuildRequest(knowledgeRoot)).toEqual({ present: false })

    requestRebuild({ knowledgeRoot, reason: 'locked', detail: 'reader timed out' })
    clearRebuildRequest(knowledgeRoot)
    clearRebuildRequest(knowledgeRoot)

    expect(existsSync(markerFile)).toBe(false)
    expect(readRebuildRequest(knowledgeRoot)).toEqual({ present: false })
  })
})
