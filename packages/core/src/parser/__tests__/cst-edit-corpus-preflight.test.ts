// Proves the corpus parses before any patch applies, without importing the CST applier.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseTestFile } from '../yaml-parser.js'

const CORPUS_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'cst-edit-corpus',
)

interface CorpusExpectations {
  $comment: string[]
  schemaVersion: number
  frozenAt: string
  cases: Record<
    string,
    {
      input: string
      patchSet: { thoughts: string; patches: unknown[] }
      expect: Record<string, unknown>
      rationale: string
      measured: string
      disclosure: string | null
    }
  >
}

const expectations = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'expectations.json'), 'utf8'),
) as CorpusExpectations

const caseIds = Object.keys(expectations.cases)

describe('the frozen edit corpus — shape of the denominator', () => {
  it('carries the treadmill warning, a schema version and a freeze date', () => {
    expect(expectations.schemaVersion).toBe(2)
    expect(expectations.frozenAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const comment = expectations.$comment.join(' ')
    expect(comment).toContain('FROZEN SCORING DENOMINATOR')
    expect(comment).toContain('MUST NOT mint new members')
    expect(comment).toContain('treadmill law')
  })

  it('holds exactly nine cases, each with a rationale, a measurement and a disclosure field', () => {
    expect(caseIds).toHaveLength(9)
    for (const id of caseIds) {
      const row = expectations.cases[id]!
      expect(row.rationale.length, `${id} rationale`).toBeGreaterThan(80)
      expect(row.measured.length, `${id} measured`).toBeGreaterThan(30)
      expect(row, `${id} disclosure field`).toHaveProperty('disclosure')
    }
  })

  it('names every fixture on disk and no fixture is orphaned', () => {
    const onDisk = readdirSync(CORPUS_DIR)
      .filter((name) => name.endsWith('.yaml'))
      .sort()
    const named = caseIds.map((id) => expectations.cases[id]!.input).sort()
    expect(named).toEqual(onDisk)
  })

  it('carries a patch set for every case, validated by the shipped vocabulary', async () => {
    const { TestEditPatchSetSchema } = await import('@vostride/agent-qa-schema')
    for (const id of caseIds) {
      const result = TestEditPatchSetSchema.safeParse(expectations.cases[id]!.patchSet)
      expect(result.success, `${id}: ${JSON.stringify(result.error?.issues)}`).toBe(true)
    }
  })
})

describe('the frozen edit corpus — every input is a real test document', () => {
  it.each(caseIds)('%s parses cleanly through the shipped parseTestFile', (id) => {
    const row = expectations.cases[id]!
    const path = join(CORPUS_DIR, row.input)
    const { tests, errors } = parseTestFile(readFileSync(path, 'utf8'), path)

    expect(errors.map((error) => error.message)).toEqual([])
    expect(tests).toHaveLength(1)
  })

  it.each(caseIds)('%s is UTF-8 text with no stray control bytes', (id) => {
    const bytes = readFileSync(join(CORPUS_DIR, expectations.cases[id]!.input))
    // A raw control byte makes a file invisible to grep and has shipped on this project before.
    // Tab, newline and carriage return are the only ones a YAML test document has any business
    // carrying, and a corpus input carries none of the three outside line terminators.
    const stray = [...bytes].filter((byte) => byte < 0x20 && byte !== 0x0a)
    expect(stray).toEqual([])
    expect(bytes.toString('utf8').endsWith('\n')).toBe(true)
  })
})
