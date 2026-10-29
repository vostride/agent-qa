// The dedup corpus's SUITE side, driven through the SHIPPED parser (Phase 394 plan 38 · CR-01).
//
// THE LAW THIS CELL STANDS ON. The production producer of the stage-2 comparison universe is
// `createDraftAuthoringPort.suiteTextCorpus` (`../../composition/local-agent-host.ts`), and its
// body reads `if (parsed.errors.length > 0) continue`. So a document the shipped `parseTestFile`
// refuses contributes NO entry to the universe on any host: it is a corpus member production can
// never hand `dedupBeforeAuthor`. A frozen row scored against such a member certifies its property
// on a world the product does not have.
//
// WHY THE CELL EXISTS AT ALL. `dedup.test.ts` already carried a producer-fidelity block, and it
// could not catch this: its `/^t_[a-z0-9-]+$/u` stand-in accepts any hyphenated lowercase string,
// and it waved through `dedup-unfingerprinted.yaml`'s SEVEN-word `test-id` for the life of the
// corpus, while `TestDefinitionSchema` refines `test-id` on `isCanonicalTestId` (exactly ten
// id-agent words) and the parser answered `0 tests`. A regex stand-in for a parser is a second,
// weaker spelling of a rule the parser already owns; the only assertion that cannot be weaker than
// the parser is the parser. (394-VERIFICATION round 5, CR-01.)
//
// WHY IT LIVES IN `cli`. The corpus lives in `packages/agent` beside the lane it screens (D-05),
// but neither `packages/agent` nor `packages/agent-local` may name `@vostride/agent-qa-core` under
// the FUNC-02 firewall — `agent-local` does not even carry it as a dependency, so the import would
// not resolve there. `cli` owns both sides: it is the package that imports `parseTestFile` and the
// package that ships `suiteTextCorpus`. One corpus, two consumers — the same placement, and the
// same reason, `corpus-parse-invariant.test.ts` next door already records for 393's corpus.
//
// STALE-DIST NOTE. `@vostride/agent-qa-core` resolves to its BUILT `dist`, so this cell reads the
// parser as SHIPPED rather than as written. That is the claim ("the shipped parseTestFile"), and
// it means `pnpm --filter @vostride/agent-qa-core build` must precede any reading taken here.
// The fixtures themselves are resolved by source-relative traversal rather than by package
// resolve, because `@vostride/agent-qa-agent` resolves to ITS dist and the fixtures live in src.

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
