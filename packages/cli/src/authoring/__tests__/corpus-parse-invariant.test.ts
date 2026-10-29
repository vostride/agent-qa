import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTestFile } from '@vostride/agent-qa-core'
import { isCanonicalTestId } from '@vostride/agent-qa-ids'
import { describe, expect, it } from 'vitest'

/**
 * The corpus invariant, NOT a gate (393 Research Pitfall 1).
 *
 * A hand-authored "known-bad" draft that fails `parseTestFile` never reaches the
 * gates at all: the corpus member proves nothing, and worse, the RED-first proving
 * suite next door reds for the wrong reason and looks like a real receipt. Known-bad
 * here means SEMANTICALLY bad — every member must be syntactically impeccable.
 *
 * This suite is GREEN from day one and must stay green for the life of the corpus.
 *
 * The corpus lives in `packages/agent` beside the gates but is proven here in
 * `cli`, because `agent` cannot import `core` (Pitfall 2) and `cli` owns both. One
 * corpus, two consumers. Resolution is the house source-relative traversal rather
 * than a package resolve: `@vostride/agent-qa-agent` resolves to its BUILT dist, and
 * the fixtures live in src, so resolving the package would mean walking dist/../src —
 * a stale-dist trap for a read that has nothing to do with the build.
 */
const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../agent/src/authoring/__tests__/fixtures/corpus',
)

/**
 * The frozen membership. This list is the denominator: gap-closure rounds must
 * not mint new corpus members, so a draft appearing or disappearing is a test failure,
 * not a fixture update.
 */
const EXPECTED_DRAFTS = [
  'accept-control.yaml',
  'assertion-free.yaml',
  'gate1-indefinitive.yaml',
  'gate2-unstable.yaml',
  'gate3-near-duplicate.yaml',
  'oracle-capture-signature.yaml',
  'oracle-capture-tautology.yaml',
  'page-loaded-only.yaml',
] as const

interface ExpectationsTable {
  drafts: Record<string, {
    class: string
    rejectingGate: number | null
    expectedGates: {
      executesDefinitive: boolean
      stableVerdict: boolean
      addsValue: boolean
      falsifiableAssertion: boolean
    }
  }>
}

function readExpectations(): ExpectationsTable {
  return JSON.parse(
    readFileSync(join(CORPUS_DIR, 'expectations.json'), 'utf8'),
  ) as ExpectationsTable
}

describe('negative corpus parse invariant', () => {
  it('contains exactly the frozen set of drafts', () => {
    const found = readdirSync(CORPUS_DIR)
      .filter((entry) => entry.endsWith('.yaml'))
      .sort()

    expect(found).toEqual([...EXPECTED_DRAFTS])
  })

  it.each([...EXPECTED_DRAFTS])(
    '%s parses through parseTestFile with zero errors',
    (filename) => {
      const path = join(CORPUS_DIR, filename)
      const result = parseTestFile(readFileSync(path, 'utf8'), path)

      // Surface the parser's own message: a bare count tells you nothing about which
      // strict-schema clause a draft tripped.
      expect(result.errors.map((error) => error.message)).toEqual([])
      expect(result.tests).toHaveLength(1)
    },
  )

  it.each([...EXPECTED_DRAFTS])(
    '%s carries a canonical test id and binds the live-lane target',
    (filename) => {
      const path = join(CORPUS_DIR, filename)
      const [test] = parseTestFile(readFileSync(path, 'utf8'), path).tests

      expect(test).toBeDefined()
      expect(isCanonicalTestId(test['test-id'])).toBe(true)
      expect(test.target).toBe('local-form')
      expect(test.steps.length).toBeGreaterThan(0)
    },
  )

  it('maps every expectations.json entry 1:1 onto a draft file', () => {
    const tabled = Object.keys(readExpectations().drafts).sort()

    expect(tabled).toEqual([...EXPECTED_DRAFTS])
  })

  it('gives every draft a rejecting gate, and only the accept control none', () => {
    const { drafts } = readExpectations()

    const acceptControls = Object.entries(drafts)
      .filter(([, entry]) => entry.rejectingGate === null)
      .map(([filename]) => filename)
    expect(acceptControls).toEqual(['accept-control.yaml'])

    // The accept control is what makes the proof falsifiable: a constant-false
    // evaluator fails it. That only holds if all four of its booleans are true.
    expect(drafts['accept-control.yaml']?.expectedGates).toEqual({
      executesDefinitive: true,
      stableVerdict: true,
      addsValue: true,
      falsifiableAssertion: true,
    })
  })

  it('covers all four gates with at least one designated rejector each', () => {
    const { drafts } = readExpectations()
    const rejecting = new Set(
      Object.values(drafts)
        .map((entry) => entry.rejectingGate)
        .filter((gate): gate is number => gate !== null),
    )

    expect([...rejecting].sort()).toEqual([1, 2, 3, 4])
  })
})
