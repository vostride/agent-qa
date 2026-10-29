// The two durable run markers, end to end on the CLI door (INVK-06; 393 WTST-06, re-aimed by 401).
//
// WHAT CHANGED UNDER THIS FILE, AND WHY IT STILL MATTERS. Until Phase 401 `runs.start` executed a
// run by re-entering this command AS A CHILD PROCESS, so `--gate-run` and `--excluded-from-outcomes`
// were the only channel the two markers had into `RunConfig`: the chain was
// request → port → child argv → command flag → RunConfig → handoff. On the invocation core the
// middle of that chain is gone — request → RunConfig, mapped on ONE line inside
// `run-invocation-core.ts` — and 401-04 put this command's SUITE path on that core too, so the
// carriage a `gateRun` takes today crosses a wire that did not exist when these cells were written.
//
// Three claims live here, at three altitudes, and each one is asserted where it is actually decided:
//
//   1. argv → request. `runMarkers` is the option→field mapping, and it is where a `false` must
//      already be gone. Pure function, asserted directly.
//   2. request → REFUSAL. `RunsStartInputSchema` types both fields `z.literal(true).optional()`, so
//      `false` is a SCHEMA REFUSAL rather than a coercion — one step either side of the threshold,
//      asserted on the parsed result and never on log text.
//   3. request → RunConfig → handoff. Asserted on the shipped binary, reading the handoff back
//      through the PRODUCTION store (`createRunsReader`) rather than by re-deriving a path — the
//      document a reader gets is the document the version guard admits.
//
// THE FULL EXCLUSION-CONSUMER DIFFERENTIAL IS NOT HERE. Whether `projectRunOutcomes` and the
// fingerprint fold actually exclude a marked run is plan 401-08's census, over its own frozen
// consumer set. This file proves CARRIAGE on this door and stops there — one producer per claim.

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

// ---------------------------------------------------------------------------------------------
// (3) argv → request → RunConfig → handoff, on the binary a person runs.
//
// THE SUITE DOOR, because that is the wire 401-04 changed. The markers used to be spread straight
// onto the suite path's own `startRun` literal; they now ride `RunsStartInput` into the core, which
// stamps them over whatever the assembler returned. Both cells drive `dist/cli.js` — a reading taken
// on a stale dist compares two copies of the previous build and calls the result a measurement.
//
// READ BACK THROUGH THE PRODUCTION STORE. `createRunsReader(agentQaRoot)` is the same enumeration
// `runs.get` uses: it walks `<root>/runs/<slug>/handoff.json` and loads each document through
// `guardCompletedRunHandoff`. So the markers are read as the version guard admits them, not as raw
// JSON text a cell re-derived a path to — and a marker that survived onto disk in a shape the guard
// rejects would show up here as an absent document rather than as a passing assertion.
//
// PAIRED, differing in exactly the two flags: marked, and unmarked. Without the unmarked control a
// door that stamped `gateRun: true` on EVERY run would pass the marked cell.
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
