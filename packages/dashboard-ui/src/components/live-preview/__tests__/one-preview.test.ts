// ONE LIVE PREVIEW COMPONENT (428 SC1 · PXH-LIVE-01 · D-07).
//
// The active run page and Test → Live watch through the same component. This census reads every
// source file under src/ (tests excluded) and fails if a second live embed appears, if anything
// imports the deleted image-polling viewer, or if a component paints the live editor's base64
// screenshot again.
//
// THE NEEDLES ARE CONCATENATED so this file cannot match itself, the idiom the retired-feed cells
// use.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = resolve(process.cwd(), 'src')

const EMBED_ATTRIBUTE = 'data-live-' + 'embed'
const VIEWER_MODULE = 'screencast-' + 'viewer'
const BASE64_IMAGE = 'data:image/' + 'jpeg;base64'
const LIVE_SCREENSHOT_READ = 'liveEditor.' + 'screenshot'

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue
      files.push(...sourceFiles(path))
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      files.push(path)
    }
  }
  return files
}

const sources = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}))

describe('one live preview component', () => {
  it('ONE-PREVIEW-COMPONENT: one file embeds the live view, nothing imports the old viewer, and no component paints a base64 live screenshot', () => {
    expect(sources.length).toBeGreaterThan(50)

    expect(sources.filter((file) => file.text.includes(EMBED_ATTRIBUTE)).map((file) => file.path)).toEqual([
      'components/live-preview/live-preview.tsx',
    ])

    expect(sources.filter((file) => file.path.includes(VIEWER_MODULE)).map((file) => file.path)).toEqual([])
    expect(
      sources
        .filter((file) => new RegExp(`from\\s+['"][^'"]*${VIEWER_MODULE}['"]`).test(file.text))
        .map((file) => file.path),
    ).toEqual([])

    const components = sources.filter((file) => file.path.endsWith('.tsx'))
    expect(
      components
        .filter((file) => file.text.includes(BASE64_IMAGE) || file.text.includes(LIVE_SCREENSHOT_READ))
        .map((file) => file.path),
    ).toEqual([])
  })
})
