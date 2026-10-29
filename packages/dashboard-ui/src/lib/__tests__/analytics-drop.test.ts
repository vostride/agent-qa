// A census over all shipped source, comments included, so a re-added emitter anywhere fails.

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE_EXTENSIONS = ['.ts', '.tsx']

async function shippedSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await shippedSourceFiles(full))
      continue
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(full)
    }
  }

  return files
}

describe('the dropped dashboard product-analytics emitter', () => {
  it('names no v33 dashboard event and no ingest endpoint anywhere in the package source', async () => {
    const files = await shippedSourceFiles(SRC_DIR)
    // A guard that scans nothing passes trivially, so the corpus size is itself asserted.
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      if (file === fileURLToPath(import.meta.url)) continue
      const source = await readFile(file, 'utf8')
      if (
        /\btrackDashboard\w*\b/u.test(source)
        || /agent-qa\.dashboard\./u.test(source)
        || /\/api\/analytics\/events/u.test(source)
      ) {
        offenders.push(relative(SRC_DIR, file))
      }
    }

    expect(offenders).toEqual([])
  })
})
