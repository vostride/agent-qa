/**
 * Executable source assertions for the 387-04 acceptance criteria (KREV-02 · D-13).
 *
 * These claims are about what the serve path DOES NOT do — "no second selection pass for the
 * trace", "no score recomputed at persistence time" — and a claim of absence has no runtime
 * observation. So each check runs over comment-stripped statements AND is exercised against a
 * PLANTED violation, because a source scan that has never rejected anything is not evidence.
 *
 * `grep` is deliberately not used anywhere here: it has silently returned nothing for patterns
 * demonstrably present in these files, and a scan that can fail open is worse than no scan.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

const serving = dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, '')

/**
 * Strip line comments, block comments and template/quoted literals so a claim discussed in prose
 * is never mistaken for a statement. The serving modules document the very calls these checks
 * forbid, which is exactly the inverse-control case a naive substring scan gets wrong.
 */
function statementsOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

function statements(path: string): string {
  return statementsOf(readFileSync(path, 'utf8'))
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}

describe('the trace reuses the selection the brief already ran', () => {
  const path = join(serving, 'get-run-brief.ts')

  it('runs the serving selection exactly twice — the eligible and budgeted passes', () => {
    const source = statements(path)
    // Two calls existed BEFORE the trace (the truncation signal needs both). The acceptance
    // criterion is that the trace added no third.
    const passes = (text: string): number => (
      occurrences(text, 'selectServingRecordsWithProvenance(')
      + occurrences(text, 'selectServingRecords(')
    )
    expect(passes(source)).toBe(2)

    // POSITIVE CONTROL: a planted third selection is caught, in EITHER spelling. Without this the
    // count above could be pinned to a number that nothing ever violates.
    expect(passes(`${source}\nconst a = selectServingRecordsWithProvenance({})\n`)).toBe(3)
    expect(passes(`${source}\nconst b = selectServingRecords({})\n`)).toBe(3)
  })

  it('names no retrieval leg, index open, or embedder call in the assembly', () => {
    const source = statements(path)
    // The trace's leg is a decision about which ranking ran, taken once in `serve-trace.ts`.
    // If the assembly ever started consulting a real leg it would be doing retrieval at serve
    // time, which is a different design than the one D-13 ratified.
    for (const forbidden of [
      'lexicalLeg',
      'denseLeg',
      'anchorSeedLeg',
      'fuseWeightedRrf',
      'openIndexReaderConnection',
      'acquireEmbedder',
    ]) {
      expect(occurrences(source, forbidden)).toBe(0)
    }
    // POSITIVE CONTROL: a planted retrieval call is caught.
    expect(occurrences(`${source}\nlexicalLeg(db, q, s, 10)\n`, 'lexicalLeg')).toBe(1)
    // INVERSE CONTROL: the same token discussed only in PROSE must not be flagged. This is the
    // failure mode these modules are full of — they explain the calls they deliberately avoid.
    expect(occurrences(
      statementsOf('// the assembly never calls lexicalLeg\n/* nor denseLeg */\nconst x = 1\n'),
      'lexicalLeg',
    )).toBe(0)
  })
})

describe('both trace-returning siblings carry a trace in their signature', () => {
  it('declares a trace on the caution and authoring results', () => {
    const cautions = statements(join(serving, 'get-cautions.ts'))
    const authoring = statements(join(serving, 'get-authoring-brief.ts'))

    expect(occurrences(cautions, 'trace: ServedRetrievalTraceV1')).toBeGreaterThan(0)
    expect(occurrences(authoring, 'trace: ServedRetrievalTraceV1')).toBeGreaterThan(0)
    // The compile-time half of this claim — that the OLD bare signatures no longer exist — is in
    // `serve-trace.test-d.ts` beside this file, because a runtime case cannot see a type at all.
  })
})
