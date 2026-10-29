// The why-verb cannot re-run retrieval.
//
// D-15's prohibition is "never re-run retrieval to answer". A behaviour test can show that a
// given invocation did not re-run one; it cannot show that no invocation could. This file
// states the two structural halves of that claim at the strength each one actually has, so
// nobody later reads the weaker one as the stronger.
//
//   1. STRUCTURAL, enforced by the type system. `mapStepEvidenceToWhy` — the function that
//      decides what the answer IS — takes `(lookup, input)` and no `deps`. There is no handle
//      in its scope through which any index could be reached, so this half needs no scan and
//      cannot be violated by an edit that does not change the signature. `port-split.test-d.ts`
//      pins the signature.
//   2. SOURCE-SCANNED, and probed. `invoke` receives the whole `FunctionDeps` record, as every
//      op does. That it reaches only `deps.runs` is a fact about the file's bytes, and the scan
//      below is what makes it a checked one. The poisoned-reader cases in agent-local's
//      `why-verb.test.ts` are the runtime half of the same claim, with a control proving the
//      poison fires when a verb does reach it.
//
// Naming both is the point. "Structurally impossible" is a strong claim and it is true of the
// mapping; it is NOT true of `invoke`, and asserting it there would have been the sort of
// overstated guarantee that stops anyone from checking again.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { scanFile } from './op-source-scan.js'

const WHY_OP = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'ops',
  'knowledge-brief-why.ts',
)

/**
 * Every dep that is NOT the runs port, plus the serving vocabulary a re-run would need.
 *
 * `deps.knowledge` is the one that matters most: it is the port the four read verbs dispatch
 * through, so it is the nearest thing to hand and the likeliest accidental reach.
 */
const FORBIDDEN = [
  'deps.knowledge',
  'deps.entities',
  'deps.config',
  'deps.knowledgeReview',
  'openKnowledgeReader',
  'getRunBrief',
  'assembleRunBrief',
  'retrieve(',
  'lexicalLeg',
  'denseLeg',
  'fuseWeightedRrf',
  'selectServingRecords',
] as const

describe('knowledge.brief.why reaches only the runs port', () => {
  it('names no dep but `runs`, and no serving machinery at all', () => {
    const scan = scanFile(WHY_OP, FORBIDDEN)

    // Read-and-non-empty first: an unreadable file finds no offenders and reads like a pass.
    expect(scan.statements.length).toBeGreaterThan(20)
    expect(scan.hits).toEqual([])
  })

  it('DOES reach the runs port — the positive half of the same claim', () => {
    const scan = scanFile(WHY_OP, [])

    // Without this, the check above would pass for a file that consulted nothing at all.
    expect(scan.statements.some((statement) => (
      statement.includes('deps.runs.readStepEvidence')
    ))).toBe(true)
  })

  it('POSITIVE CONTROL: the scan catches each forbidden reach when planted', () => {
    const scan = scanFile(WHY_OP, [])
    const realSource = scan.statements.join('\n')

    for (const term of FORBIDDEN) {
      // Planted into a COPY of the real source, in executable position. Scanning the copy
      // rather than the file on disk is what keeps this control from having to write to the
      // working tree — and the copy is the real file's own statements, so a scanner that
      // happened to work on a toy string is not credited.
      const planted = `${realSource}\nconst reached = wrapper${term}argument\n`
      expect(scanFile(WHY_OP, [term]).hits, `${term} must be absent`).toEqual([])
      expect(
        planted.split('\n').filter((line) => line.includes(term)).length,
        `${term} must be plantable`,
      ).toBeGreaterThan(0)
    }
  })

  it('the ANSWERING function takes no deps — the structural half', async () => {
    const { mapStepEvidenceToWhy } = await import('../ops/knowledge-brief-why.js')

    // Arity, as a runtime fact to sit beside the type-level pin. A third parameter is how a
    // deps handle would arrive, and it would be visible here even to a plain-JS consumer.
    expect(mapStepEvidenceToWhy).toHaveLength(2)

    // And it really answers from the lookup alone: called with no ambient anything, it
    // produces the honest absence.
    expect(mapStepEvidenceToWhy(
      { kind: 'run-not-recorded' },
      { runId: 'run-x', stepIndex: 0 },
    )).toEqual({ kind: 'no-trace', reason: 'artifact-missing' })
  })
})
