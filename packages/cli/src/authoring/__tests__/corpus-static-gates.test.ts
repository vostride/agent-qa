import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTestFile } from '@vostride/agent-qa-core'
import { describe, expect, it } from 'vitest'

// Imported inside each test, so a missing export fails per draft instead of crashing collection.
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
      + 'expected RED-first state; implement the check, do not weaken '
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
    // The receipt carries the per-step table, so the gate is auditable rather than a bare boolean.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    for (const { filename } of DRAFT_EXPECTATIONS) {
      const steps = stepTexts(filename)
      const result = evaluateAssertionStrength(steps)

      expect(result.steps.map((entry) => entry.text)).toEqual(steps)
    }
  })

  it('rejects the assertion-free draft for having no assertion step at all', async () => {
    // Clause (i) is pinned apart from clause (ii), so a check that only tests vacuity cannot pass.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    const result = evaluateAssertionStrength(stepTexts('assertion-free.yaml'))

    expect(result.falsifiable).toBe(false)
    expect(result.steps.every((entry) => entry.kind === 'action')).toBe(true)
  })

  it('rejects the vacuous assertion while still classifying it as an assertion', async () => {
    // This draft has an assertion, so conflating none with a weak one reports the wrong reason.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    const result = evaluateAssertionStrength(stepTexts('page-loaded-only.yaml'))

    expect(result.falsifiable).toBe(false)
    expect(result.steps.filter((entry) => entry.kind === 'assertion')).toHaveLength(1)
  })

  it('flags the machine-generated expected value on the capture-signature draft', async () => {
    // The capture signature must be named in the table, not only folded into the boolean.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    const result = evaluateAssertionStrength(stepTexts('oracle-capture-signature.yaml'))

    expect(result.falsifiable).toBe(false)
    expect(
      result.steps.some((entry) => entry.captureSignatureHits.length > 0),
    ).toBe(true)
  })

  it('accepts the known-good control', async () => {
    // The positive half: without it a constant-false check passes every other case.
    const evaluateAssertionStrength = await loadAssertionStrengthCheck()

    const result = evaluateAssertionStrength(stepTexts('accept-control.yaml'))

    expect(result.falsifiable).toBe(true)
  })
})
