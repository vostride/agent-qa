// The `--gate-run` and `--excluded-from-outcomes` markers, from argv to the handoff on disk.

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { createRunsReader } from '@vostride/agent-qa-agent-local'
import { RunsStartInputSchema } from '@vostride/agent-qa-schema'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { runMarkers } from '../run.js'
import {
  CountingTarget,
  createSuiteFixture,
  runCli,
  type SuiteFixture,
} from './suite-run-fixture.js'

describe("(1) argv → request: runMarkers maps this command's two options", () => {
  it('carries both markers when both flags are set', () => {
    expect(runMarkers({ gateRun: true, excludedFromOutcomes: true }))
      .toEqual({ gateRun: true, excludedFromOutcomes: true })
  })

  it('carries each marker on its own — they are DISTINCT axes', () => {
    // C8 ratifies that a gate-run still feeds curation, so "verify-before-present" and "keep this
    // run out of the outcome projection" are two decisions and a caller may take either alone.
    expect(runMarkers({ gateRun: true })).toEqual({ gateRun: true })
    expect(runMarkers({ excludedFromOutcomes: true })).toEqual({ excludedFromOutcomes: true })
  })

  it('leaves the fields ABSENT for an ordinary run', () => {
    expect(runMarkers({})).toEqual({})
  })

  it('treats an explicit false as absence, never as a marker value', () => {
    // `--no-gate-run`-shaped input, or a programmatic caller spreading a defaulted options object.
    // The result must be an ABSENT field: `{ gateRun: false }` would not survive the request schema
    // one altitude below (see (2)), and a run whose handoff carried `gateRun: false` would be a run
    // of a kind the vocabulary does not have.
    const markers = runMarkers({ gateRun: false, excludedFromOutcomes: false })
    expect(markers).toEqual({})
    expect(Object.hasOwn(markers, 'gateRun')).toBe(false)
    expect(Object.hasOwn(markers, 'excludedFromOutcomes')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// (2) The literal-true boundary, on the schema that decides it.
//
// ONE STEP EITHER SIDE OF THE THRESHOLD, and the middle step too. `true` carries, ABSENT means
// unmarked, and `false` is REFUSED — refused, not coerced, not defaulted, not dropped. The
// distinction is the whole cell: an implementation that silently turned `false` into absence would
// satisfy "only true carries" while quietly accepting a request nobody should be able to make, and
// the caller would never learn its request was rewritten.
//
// ASSERTED ON THE PARSED RESULT, never on prose. `Object.hasOwn` rather than `=== undefined`,
// because "the key is absent" and "the key is present holding undefined" serialize differently into
// the handoff and only one of them is what `?: true` means.
describe('(2) request boundary: RunsStartInput markers accept only literal true', () => {
  it.each(['gateRun', 'excludedFromOutcomes'] as const)('%s: true is carried', (field) => {
    const parsed = RunsStartInputSchema.parse({ [field]: true })
    expect(parsed[field]).toBe(true)
    expect(Object.hasOwn(parsed, field)).toBe(true)
  })

  it.each(['gateRun', 'excludedFromOutcomes'] as const)('%s: false is a SCHEMA REFUSAL', (field) => {
    const result = RunsStartInputSchema.safeParse({ [field]: false })
    expect(result.success).toBe(false)
    // The refusal names the field it refused, so a caller learns WHICH request was rejected rather
    // than that "a request" was.
    expect(result.error?.issues.some((issue) => issue.path[0] === field)).toBe(true)
    // And it is a throw on the strict parse path, not a value with a warning attached.
    expect(() => RunsStartInputSchema.parse({ [field]: false })).toThrow()
  })

  it.each(['gateRun', 'excludedFromOutcomes'] as const)('%s: absent means unmarked', (field) => {
    const parsed = RunsStartInputSchema.parse({})
    expect(Object.hasOwn(parsed, field)).toBe(false)
    expect(parsed[field]).toBeUndefined()
  })

  it('the two axes are independent at the boundary as well', () => {
    // A refusal on one field must not be satisfiable by supplying the other.
    expect(RunsStartInputSchema.safeParse({ gateRun: true, excludedFromOutcomes: false }).success)
      .toBe(false)
    const parsed = RunsStartInputSchema.parse({ gateRun: true })
    expect(parsed.gateRun).toBe(true)
    expect(Object.hasOwn(parsed, 'excludedFromOutcomes')).toBe(false)
  })
})

// Read back through `createRunsReader`, so the markers are what the handoff version guard admits.
describe('(3) carriage: the markers ride argv → request → RunConfig → handoff', () => {
  const target = new CountingTarget()
  let fixtures: SuiteFixture[] = []

  beforeAll(async () => { await target.listen() })
  afterAll(async () => { await target.close() })
  beforeEach(() => { target.reset(); fixtures = [] })
  afterEach(() => {
    for (const fixture of fixtures) rmSync(fixture.project, { recursive: true, force: true })
  })

  async function handoffOfTheOneRun(fixture: SuiteFixture) {
    const documents = await createRunsReader(join(fixture.project, '.agent-qa')).list()
    // Exactly one run, so "the handoff" is unambiguous. A second run dir would mean the invocation
    // started something this cell did not account for.
    expect(documents).toHaveLength(1)
    return documents[0] as { gateRun?: true; excludedFromOutcomes?: true }
  }

  function fixtureForCarriage(): SuiteFixture {
    // `local`, so the gate allows and the run reaches a handoff. The gate legs live in
    // `run-gate-suite.e2e.test.ts`; this file is about what a run that HAPPENED carries.
    const fixture = createSuiteFixture({ origin: target.origin, environment: 'local' })
    fixtures.push(fixture)
    return fixture
  }

  it('WITH both flags: the handoff carries both markers as literal true', async () => {
    const fixture = fixtureForCarriage()

    await runCli(fixture, fixture.suitePattern, '--gate-run', '--excluded-from-outcomes')

    const handoff = await handoffOfTheOneRun(fixture)
    expect(handoff.gateRun).toBe(true)
    expect(handoff.excludedFromOutcomes).toBe(true)
  }, 180_000)

  it('WITHOUT them: the handoff is unmarked — the fields are ABSENT, not false', async () => {
    const fixture = fixtureForCarriage()

    await runCli(fixture, fixture.suitePattern)

    const handoff = await handoffOfTheOneRun(fixture)
    // `Object.hasOwn`, not `!== true`: `?: true` means the key is not there at all, and the
    // exclusion gate downstream reads `handoff.excludedFromOutcomes === true` off the document a
    // projection rebuild replays. A persisted `false` would be a value neither schema admits.
    expect(Object.hasOwn(handoff, 'gateRun')).toBe(false)
    expect(Object.hasOwn(handoff, 'excludedFromOutcomes')).toBe(false)
  }, 180_000)
})
