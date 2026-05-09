import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { BaseObservation, SuiteObservation } from '../schema.js'
import {
  ensureMemoryDirs,
  writeObservation,
  parseObservation,
  listObservations,
} from '../observation-io.js'

const CANONICAL_OBSERVATION_ID = 'obs_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const CANONICAL_SUITE_OBSERVATION_ID = 'obs_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const LEGACY_OBSERVATION_ID = 'obs_amber-birch-coral-delta-ember-falcon'

const validBase: BaseObservation = {
  id: CANONICAL_OBSERVATION_ID,
  title: 'Login page: modal appears after a short delay',
  content: 'Login modal appears after ~2s delay',
  trust: 0.5,
  created: '2026-04-10T12:00:00Z',
  last_confirmed: '2026-04-10T12:00:00Z',
  confirmed_count: 1,
  contradicted_count: 0,
  source_test: 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
}

const validSuite: SuiteObservation = {
  ...validBase,
  id: CANONICAL_SUITE_OBSERVATION_ID,
  position: 4,
  suite_snapshot: [
    { test: 'tests/web/auth.yaml', id: 't_lack-auto-quit-dow-boat-urus' },
    { test: 'tests/web/checkout.yaml', id: 't_pile-reak-bun-ended-joch-crate' },
  ],
}

function toFrontmatter(data: BaseObservation | SuiteObservation): Record<string, unknown> {
  const { content, ...frontmatter } = data
  return frontmatter
}

function toObservationDocument(data: BaseObservation | SuiteObservation): string {
  return `---\n${stringifyYaml(toFrontmatter(data), { lineWidth: 0 })}---\n${data.content}\n`
}

describe('ensureMemoryDirs', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-qa-mem-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates products/, suites/, tests/ subdirectories', async () => {
    await ensureMemoryDirs(root)
    for (const sub of ['products', 'suites', 'tests']) {
      const s = await stat(join(root, sub))
      expect(s.isDirectory()).toBe(true)
    }
  })

  it('is idempotent (calling twice does not error)', async () => {
    await ensureMemoryDirs(root)
    await expect(ensureMemoryDirs(root)).resolves.not.toThrow()
  })
})

describe('writeObservation', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-qa-mem-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates file at root/tier/scope/id.md', async () => {
    const path = await writeObservation(root, 'products', 'hacker-news', validBase)
    expect(path).toBe(join(root, 'products', 'hacker-news', `${validBase.id}.md`))
    const s = await stat(path)
    expect(s.isFile()).toBe(true)
  })

  it('file content starts with frontmatter and ends with a markdown body newline', async () => {
    const path = await writeObservation(root, 'products', 'hacker-news', validBase)
    const content = await readFile(path, 'utf-8')
    expect(content.startsWith('---\n')).toBe(true)
    expect(content).toContain('\n---\n')
    expect(content.endsWith(`${validBase.content}\n`)).toBe(true)
  })

  it('file content stores metadata in frontmatter and body in the markdown body', async () => {
    const path = await writeObservation(root, 'products', 'hacker-news', validBase)
    const content = await readFile(path, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    expect(match).not.toBeNull()
    const parsed = parseYaml(match![1])
    const body = match![2]
    expect(parsed).toEqual(toFrontmatter(validBase))
    expect(body).toBe(`${validBase.content}\n`)
  })

  it('writes markdown body content with code block and table text outside frontmatter', async () => {
    const markdownBodyObservation: BaseObservation = {
      ...validBase,
      id: 'obs_bright-canyon-delta-ember-falcon-garden-harbor-island-jungle-kite',
      title: 'Settings page: export panel includes a code example',
      content: [
        'The export panel shows a markdown body example before the download action.',
        '',
        '```ts',
        'console.log("export ready")',
        '```',
        '',
        '| Column | Value |',
        '| --- | --- |',
        '| Status | Ready |',
      ].join('\n'),
    }

    const path = await writeObservation(root, 'products', 'hacker-news', markdownBodyObservation)
    const content = await readFile(path, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    expect(match).not.toBeNull()
    const parsed = parseYaml(match![1])
    const body = match![2]
    expect(parsed).toEqual(toFrontmatter(markdownBodyObservation))
    expect(body).toContain('```ts')
    expect(body).toContain('| Column | Value |')
  })

  it('rejects legacy 6-word observation ids on write', async () => {
    const legacyObservation = { ...validBase, id: LEGACY_OBSERVATION_ID }
    await expect(writeObservation(root, 'products', 'hacker-news', legacyObservation)).rejects.toThrow(
      'Observation ID must be obs_ followed by 10 id-agent words',
    )
  })
})

describe('parseObservation', () => {
  it('returns { data, error: null } for valid base observation', () => {
    const content = toObservationDocument(validBase)
    const result = parseObservation(content, `${validBase.id}.md`)
    expect(result.data).toEqual(validBase)
    expect(result.error).toBeNull()
  })

  it('returns { data: null, error } for content with no frontmatter delimiters', () => {
    const result = parseObservation('just some text', 'obs_test.md')
    expect(result.data).toBeNull()
    expect(result.error).toContain('No frontmatter delimiters found')
  })

  it('returns { data: null, error } for content with invalid YAML', () => {
    const result = parseObservation('---\n: : : invalid{{{\n---\n', 'obs_test.md')
    expect(result.data).toBeNull()
    expect(result.error).toContain('YAML parse error')
  })

  it('returns { data: null, error } for content failing Zod validation', () => {
    const invalid = { ...toFrontmatter(validBase), trust: 5 } // trust > 1
    const content = `---\n${stringifyYaml(invalid, { lineWidth: 0 })}---\n${validBase.content}\n`
    const result = parseObservation(content, `${validBase.id}.md`)
    expect(result.data).toBeNull()
    expect(result.error).not.toBeNull()
  })

  it('returns { data: null, error } when id does not match filename stem', () => {
    const content = toObservationDocument(validBase)
    const result = parseObservation(content, 'obs_wrong-name-here-now-go-away.md')
    expect(result.data).toBeNull()
    expect(result.error).toContain('ID mismatch')
  })

  it('discriminates: position present validates as SuiteObservation', () => {
    const content = toObservationDocument(validSuite)
    const result = parseObservation(content, `${validSuite.id}.md`)
    expect(result.data).toEqual(validSuite)
    expect(result.error).toBeNull()
  })

  it('discriminates: no position validates as BaseObservation', () => {
    const content = toObservationDocument(validBase)
    const result = parseObservation(content, `${validBase.id}.md`)
    expect(result.data).toEqual(validBase)
    expect(result.error).toBeNull()
  })

  it('accepts legacy 6-word observation ids when reading from disk', () => {
    const legacyObservation = { ...validBase, id: LEGACY_OBSERVATION_ID }
    const content = toObservationDocument(legacyObservation)
    const result = parseObservation(content, `${legacyObservation.id}.md`)
    expect(result.data).toEqual(legacyObservation)
    expect(result.error).toBeNull()
  })

  it('returns { data: null, error } for frontmatter-only legacy content with no markdown body', () => {
    const content = `---\n${stringifyYaml(validBase as Record<string, unknown>, { lineWidth: 0 })}---\n`
    const result = parseObservation(content, `${validBase.id}.md`)
    expect(result.data).toBeNull()
    expect(result.error).toContain('body')
  })

  it('returns { data: null, error } for titleless content even when a markdown body exists', () => {
    const { title, ...titlelessFrontmatter } = toFrontmatter(validBase)
    const content = `---\n${stringifyYaml(titlelessFrontmatter, { lineWidth: 0 })}---\nThis titleless observation should be rejected.\n`
    const result = parseObservation(content, `${validBase.id}.md`)
    expect(result.data).toBeNull()
    expect(result.error).not.toBeNull()
  })

  it('returns { data: null, error } for blank markdown body content', () => {
    const content = `---\n${stringifyYaml(toFrontmatter(validBase), { lineWidth: 0 })}---\n   \n`
    const result = parseObservation(content, `${validBase.id}.md`)
    expect(result.data).toBeNull()
    expect(result.error).toContain('body')
  })
})

describe('round-trip tests', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-qa-mem-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('write -> read -> parse produces identical base observation', async () => {
    const path = await writeObservation(root, 'products', 'my-app', validBase)
    const content = await readFile(path, 'utf-8')
    const result = parseObservation(content, `${validBase.id}.md`)
    expect(result.data).toEqual(validBase)
    expect(result.error).toBeNull()
  })

  it('write -> read -> parse produces identical suite observation', async () => {
    const path = await writeObservation(root, 'suites', 'my-suite', validSuite)
    const content = await readFile(path, 'utf-8')
    const result = parseObservation(content, `${validSuite.id}.md`)
    expect(result.data).toEqual(validSuite)
    expect(result.error).toBeNull()
  })

  it('edge case: content with colons, quotes, and newlines survives round-trip', async () => {
    const edgeBase: BaseObservation = {
      ...validBase,
      id: 'obs_edge-case-colon-quote-newline-signal-syntax-harbor-island-jungle',
      content: 'Field has: colons, "quotes", and\nnewlines',
    }
    const path = await writeObservation(root, 'tests', 'edge', edgeBase)
    const content = await readFile(path, 'utf-8')
    const result = parseObservation(content, `${edgeBase.id}.md`)
    expect(result.data).toEqual(edgeBase)
    expect(result.error).toBeNull()
  })

  it('markdown body with fenced code block, table, and multi-line text survives round-trip', async () => {
    const markdownBodyObservation: BaseObservation = {
      ...validBase,
      id: 'obs_fabric-galaxy-harbor-island-jungle-kite-lantern-meadow-nova-orbit',
      title: 'Export flow: preview shows table and code block before save',
      content: [
        'The markdown body preview mixes explanatory text with rich formatting.',
        '',
        '```json',
        '{"status":"ready"}',
        '```',
        '',
        '| Step | Result |',
        '| --- | --- |',
        '| Preview | Ready |',
      ].join('\n'),
    }

    const path = await writeObservation(root, 'tests', 'edge', markdownBodyObservation)
    const content = await readFile(path, 'utf-8')
    const result = parseObservation(content, `${markdownBodyObservation.id}.md`)
    expect(result.data).toEqual(markdownBodyObservation)
    expect(result.error).toBeNull()
  })
})

describe('listObservations', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-qa-mem-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns obs_*.md filenames sorted alphabetically', async () => {
    await writeFile(join(dir, 'obs_beta.md'), 'x', 'utf-8')
    await writeFile(join(dir, 'obs_alpha.md'), 'x', 'utf-8')
    await writeFile(join(dir, 'README.md'), 'x', 'utf-8')
    await writeFile(join(dir, 'obs_test.txt'), 'x', 'utf-8')

    const result = await listObservations(dir)
    expect(result).toEqual(['obs_alpha.md', 'obs_beta.md'])
  })

  it('returns empty array for non-existent directory without throwing', async () => {
    const result = await listObservations(join(dir, 'nonexistent'))
    expect(result).toEqual([])
  })

  it('ignores non-obs_ files and non-.md files', async () => {
    await writeFile(join(dir, 'README.md'), 'x', 'utf-8')
    await writeFile(join(dir, 'obs_test.txt'), 'x', 'utf-8')
    await writeFile(join(dir, 'data.json'), 'x', 'utf-8')

    const result = await listObservations(dir)
    expect(result).toEqual([])
  })
})
