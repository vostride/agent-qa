// Uses the shipped parser, because `suiteTextCorpus` drops every document `parseTestFile` refuses.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTestFile } from '@vostride/agent-qa-core'
import { describe, expect, it } from 'vitest'

const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../agent/src/authoring/__tests__/fixtures/dedup-corpus',
)
const SUITE_DIR = join(CORPUS_DIR, 'suite')

interface Expectations {
  readonly suiteMembers: Readonly<Record<string, { readonly document: string }>>
}

const EXPECTATIONS = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'expectations.json'), 'utf8'),
) as Expectations

/** Every document on disk, walked rather than listed, so a new member cannot arrive unchecked. */
const SUITE_FILES = readdirSync(SUITE_DIR)
  .filter((entry) => entry.endsWith('.yaml'))
  .sort()

describe('the dedup corpus suite side is producible by the shipped parser', () => {
  it('walks the whole suite directory, and the frozen table names exactly those documents', () => {
    // A vacuous walk is the failure mode an `it.each` cannot report: zero files yields zero cells
    // and a green file. Both directions are pinned here — the directory is non-empty, and the
    // documents `expectations.json` scores against are exactly the documents walked, so a member
    // tabled but deleted (or present but untabled) reds before the parser is ever reached.
    expect(SUITE_FILES.length).toBeGreaterThan(0)

    const tabled = [...new Set(
      Object.values(EXPECTATIONS.suiteMembers).map((member) => member.document),
    )].sort()
    expect(tabled).toEqual(SUITE_FILES.map((file) => `suite/${file}`))
  })

  it.each(SUITE_FILES)(
    '%s yields exactly one test and zero errors through the shipped parseTestFile',
    (filename) => {
      const path = join(SUITE_DIR, filename)
      const parsed = parseTestFile(readFileSync(path, 'utf8'), path)

      // The parser's OWN messages, not a count: a bare `toHaveLength(0)` says a document was
      // refused without saying which schema clause refused it, and the clause is the finding.
      expect(
        parsed.errors.map((error) => error.message),
        `${filename} is refused by the shipped parser, so suiteTextCorpus() skips it and no host `
        + 'can ever hand it to dedupBeforeAuthor — a corpus member production cannot produce',
      ).toEqual([])
      expect(parsed.tests).toHaveLength(1)
    },
  )
})
