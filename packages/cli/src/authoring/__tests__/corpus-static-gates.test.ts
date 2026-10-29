import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTestFile } from '@vostride/agent-qa-core'
import { describe, expect, it } from 'vitest'

/**
 * THE RED-FIRST RECEIPT.
 *
 * This suite is committed FAILING, on purpose, with no evaluator in existence, and it
 * stays red until the assertion-strength check lands. That ordering IS the phase's
 * signature proof: gates built after a generator get built to accept whatever the
 * generator already produces, so the gates are pinned against known-bad drafts first.
 *
 * DO NOT weaken this suite to make it pass, and do not stub the module it imports.
 * Later plans build toward green over THIS EXACT TABLE — no new corpus members and no
 * edited expectation vectors (the treadmill law).
 *
 * ── The contract this suite defines ──────────────────────────────────────────────
 * `@vostride/agent-qa-agent` must export `evaluateAssertionStrength`, a deterministic
 * pure function over a draft's parsed NL steps:
 *
 *   evaluateAssertionStrength(steps: string[]): {
 *     falsifiable: boolean            // the gate-4 boolean
 *     steps: Array<{                  // the per-step table that lands in the receipt
 *       text: string
 *       kind: 'assertion' | 'action'
 *       falsifiable: boolean
 *       captureSignatureHits: string[]
 *     }>
 *   }
 *
 * `falsifiable` is true only when (i) at least one step classifies as an assertion via
 * the closed assertion-verb lexicon AND (ii) at least one such assertion references
 * concrete expected content without matching the closed vacuity lexicon, the
 * capture-signature patterns, or the tautology rule (D-09, D-10, D-12: ambiguity tunes
 * toward reject).
 *
 * The import is awaited INSIDE each test body rather than at module scope so that the
 * absence of the export is a per-draft assertion failure with a readable message —
 * never a collection crash. A collection crash would be the WRONG red: it cannot tell
 * "the evaluator does not exist yet" apart from "this file has a syntax error", and an
 * inverted exit code would accept both.
 */
const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../agent/src/authoring/__tests__/fixtures/corpus',
)

interface ExpectationsTable {
  drafts: Record<string, {
    class: string
    rejectingGate: number | null
    expectedGates: { falsifiableAssertion: boolean }
  }>
}

const EXPECTATIONS = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'expectations.json'), 'utf8'),
) as ExpectationsTable

interface AssertionStrengthResult {
  falsifiable: boolean
  steps: Array<{
    text: string
    kind: 'assertion' | 'action'
    falsifiable: boolean
    captureSignatureHits: string[]
  }>
}

type AssertionStrengthCheck = (steps: string[]) => AssertionStrengthResult

async function loadAssertionStrengthCheck(): Promise<AssertionStrengthCheck> {
  const agentModule = await import('@vostride/agent-qa-agent') as Record<string, unknown>
  const check = agentModule.evaluateAssertionStrength

  if (typeof check !== 'function') {
    throw new Error(
      '@vostride/agent-qa-agent does not export evaluateAssertionStrength — '
      + 'the gate-4 assertion-strength check does not exist yet. This is the '
      + 'expected RED-first state (D-08); implement the check, do not weaken '
      + 'this suite.',
    )
  }
  return check as AssertionStrengthCheck
}

function stepTexts(filename: string): string[] {
  const path = join(CORPUS_DIR, filename)
  const [test] = parseTestFile(readFileSync(path, 'utf8'), path).tests

  if (test === undefined) {
    throw new Error(`corpus draft ${filename} did not parse — see corpus-parse-invariant`)
  }
  return test.steps.map((step) => (typeof step === 'string' ? step : step.step))
}

const DRAFT_EXPECTATIONS = Object.entries(EXPECTATIONS.drafts)
  .map(([filename, entry]) => ({
    filename,
    className: entry.class,
    expected: entry.expectedGates.falsifiableAssertion,
  }))
  .sort((left, right) => left.filename.localeCompare(right.filename))

describe('gate 4 — assertion strength over the frozen corpus', () => {
  it.each(DRAFT_EXPECTATIONS)(
    '$filename ($className) has falsifiableAssertion=$expected',
    async ({ filename, expected }) => {
      const evaluateAssertionStrength = await loadAssertionStrengthCheck()

      const result = evaluateAssertionStrength(stepTexts(filename))

      expect(result.falsifiable).toBe(expected)
    },
  )

  it('reports a per-step classification table for every draft, not just a boolean', async () => {
    // the receipt carries the per-step table verbatim, so the gate cannot be a
    // bare boolean that nobody can audit.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    for (const { filename } of DRAFT_EXPECTATIONS) {
      const steps = stepTexts(filename)
      const result = evaluateAssertionStrength(steps)

      expect(result.steps.map((entry) => entry.text)).toEqual(steps)
    }
  })

  it('rejects the assertion-free draft for having no assertion step at all', async () => {
    // D-09 clause (i), pinned separately from clause (ii) so a check that only ever
    // tests vacuity cannot pass this suite.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    const result = evaluateAssertionStrength(stepTexts('assertion-free.yaml'))

    expect(result.falsifiable).toBe(false)
    expect(result.steps.every((entry) => entry.kind === 'action')).toBe(true)
  })

  it('rejects the vacuous assertion while still classifying it as an assertion', async () => {
    // D-09 clause (ii). page-loaded-only is D-04's independence exemplar: it HAS an
    // assertion, so a check that conflates "no assertion" with "weak assertion" would
    // report the wrong reason on the receipt even while returning the right boolean.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    const result = evaluateAssertionStrength(stepTexts('page-loaded-only.yaml'))

    expect(result.falsifiable).toBe(false)
    expect(result.steps.filter((entry) => entry.kind === 'assertion')).toHaveLength(1)
  })

  it('flags the machine-generated expected value on the capture-signature draft', async () => {
    // the capture signature must be NAMED in the table, not merely folded into
    // the boolean — the receipt has to say why.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    const result = evaluateAssertionStrength(stepTexts('oracle-capture-signature.yaml'))

    expect(result.falsifiable).toBe(false)
    expect(
      result.steps.some((entry) => entry.captureSignatureHits.length > 0),
    ).toBe(true)
  })

  it('accepts the known-good control', async () => {
    // The positive half. Without this, a constant-false check would pass every
    // other case in this file and the corpus would prove nothing.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    const result = evaluateAssertionStrength(stepTexts('accept-control.yaml'))

    expect(result.falsifiable).toBe(true)
  })
})
