import { describe, it, expect } from 'vitest'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSuiteFile } from '../suite-parser.js'

const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

describe('parseSuiteFile', () => {
  it('rejects legacy YAML with variables: block (Phase 181 Option C migration)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suite-parser-'))
    const path = join(dir, 'legacy.suite.yaml')
    await writeFile(
      path,
      [
        'name: Legacy',
        'target: web',
        'variables:',
        '  FOO: bar',
        'tests:',
        '  - test: a.yaml',
        `    id: ${VALID_TEST_ID}`,
      ].join('\n'),
    )
    await expect(parseSuiteFile(path)).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })

  it('parses a clean suite successfully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suite-parser-'))
    const path = join(dir, 'clean.suite.yaml')
    await writeFile(
      path,
      [
        'name: Clean',
        'target: web',
        'tests:',
        '  - test: a.yaml',
        `    id: ${VALID_TEST_ID}`,
      ].join('\n'),
    )
    const parsed = await parseSuiteFile(path)
    expect(parsed.name).toBe('Clean')
    expect(parsed.tests).toEqual([{ test: 'a.yaml', id: VALID_TEST_ID }])
    await rm(dir, { recursive: true, force: true })
  })
})
