// VITE-PROXY-SHAPE. Vite expands a string proxy entry to `changeOrigin: true`,
// which rewrites `Host` to the target. The live-editor doors and the run-detail mark POSTs run the
// same-site guard, which compares `Origin` to `Host`, so a rewritten Host makes the dashboard's own
// dev page look cross-site and every guarded door refuses it under `vite dev`. Object form without
// `changeOrigin` forwards the page's own Host. The guard itself is never widened for a dev server.

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const viteConfig = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf-8')

/** The `server.proxy` object literal's text, braces included. */
function proxyBlock(source: string): string {
  const start = source.indexOf('proxy: {')
  expect(start, 'vite.config.ts declares server.proxy').toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(open, index + 1)
  }
  throw new Error('server.proxy is never closed')
}

/** Each top-level key of the proxy object and the first non-space character of its value. */
function proxyEntries(block: string): { key: string; valueStart: string }[] {
  const entries: { key: string; valueStart: string }[] = []
  let depth = 0
  for (let index = 0; index < block.length; index += 1) {
    const char = block[index]
    if (char === '{') { depth += 1; continue }
    if (char === '}') { depth -= 1; continue }
    if (depth !== 1 || (char !== "'" && char !== '"')) continue
    const close = block.indexOf(char, index + 1)
    const after = block.slice(close + 1).match(/^\s*:\s*(\S)/)
    if (after !== null) entries.push({ key: block.slice(index + 1, close), valueStart: after[1] ?? '' })
    index = close
  }
  return entries
}

describe('VITE-PROXY-SHAPE', () => {
  it('every dev proxy entry is an object literal, never a bare target string', () => {
    const entries = proxyEntries(proxyBlock(viteConfig))

    expect(entries.map((entry) => entry.key)).toEqual(['/api/live-editor/ws', '/api'])
    for (const entry of entries) {
      expect(entry.valueStart, `${entry.key} maps to an object, so Vite does not set changeOrigin`)
        .toBe('{')
    }
  })

  it('VITE-PROXY-SHAPE: no entry sets changeOrigin to true', () => {
    expect(viteConfig).not.toMatch(/changeOrigin\s*:\s*true/)
  })

  it('VITE-PROXY-SHAPE: the control-socket entry stays first, so it wins over /api', () => {
    const keys = proxyEntries(proxyBlock(viteConfig)).map((entry) => entry.key)

    expect(keys.indexOf('/api/live-editor/ws')).toBe(0)
  })
})
