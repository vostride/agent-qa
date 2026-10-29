// The CLI door's SUITE path: `agent-qa run <suite>`, through the shipped binary.
//
// Nothing asks and nothing gates a suite run on its target. A no-tty suite run against a local,
// shared or undeclared target starts: it writes `runStarted`, advances its build ordinal and knocks
// on the target. `--dry-run` stops before any of those.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'

import {
  auditRows,
  buildOrdinalsExist,
  CountingTarget,
  createSuiteFixture,
  eventTypes,
  runCli,
  type FixtureEnvironment,
  type SuiteFixture,
} from './suite-run-fixture.js'

const target = new CountingTarget()
let fixtures: SuiteFixture[] = []

beforeAll(async () => { await target.listen() })
afterAll(async () => { await target.close() })

beforeEach(() => {
  target.reset()
  fixtures = []
})

afterEach(() => {
  for (const fixture of fixtures) rmSync(fixture.project, { recursive: true, force: true })
})

function fixtureFor(environment: FixtureEnvironment): SuiteFixture {
  const fixture = createSuiteFixture({ origin: target.origin, environment })
  fixtures.push(fixture)
  return fixture
}

describe('the CLI suite path starts a no-tty run', () => {
  it.each<[string, FixtureEnvironment]>([
    ['local-declared', 'local'],
    ['shared-declared', 'shared'],
    ['undeclared', undefined],
  ])('a no-tty suite run against a %s target starts', async (_label, environment) => {
    const fixture = fixtureFor(environment)

    await runCli(fixture, fixture.suitePattern)

    expect(auditRows(fixture).filter((row) => row.action === 'run:start')).toEqual([])
    expect(eventTypes(fixture)[0]).toBe('runStarted')
    expect(buildOrdinalsExist(fixture)).toBe(true)
    expect(target.hits).toContain('/suite-thing')
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------
// --dry-run: the disposition RESEARCH Open Q2 records under D-02, measured rather than asserted.
//
// "Stops BEFORE invoking the core" is an ORDERING claim, and briefing §C's rule is that an ordering
// claim is proven by the ABSENCE of the downstream side effects, not by the absence of output. So
// this cell asserts the absence of the run's artifacts — and there is no audit row EITHER. A dry
// run is not a refused run; it is a question about what would
// run, and a decision about nothing has nothing to record.
//
// AND IT IS A REAL BEHAVIOUR FIX. On the pre-migration binary this exact invocation EXECUTED THE
// SUITE: `probeHits: ["/suite-thing","/suite-thing"]`, `build-ordinals.json` present, a full
// `runStarted…runFinished` event log, a handoff, exit 1. The suite path simply had no `--dry-run`
// handling; only the single-test path did. Every assertion below is red on that build.
describe('--dry-run stops before the core on the suite path', () => {
  it('reports the suite and its members, and starts nothing — not even a gate decision', async () => {
    const fixture = fixtureFor('local')

    const result = await runCli(fixture, fixture.suitePattern, '--dry-run')

    // It reported. (An "absence" cell that never proved the command did its job would pass on a
    // command that crashed at argv parsing.)
    expect(result.stdout).toContain('Found 1 suite(s), 1 test(s):')
    expect(result.stdout).toContain('the gated suite')
    expect(result.stdout).toContain('tests/member.yaml')
    expect(result.status).toBe(0)

    // No gate decision — the run was never a candidate, so there was nothing to authorize.
    expect(auditRows(fixture).filter((row) => row.action === 'run:start')).toEqual([])
    // No run.
    expect(eventTypes(fixture)).toEqual([])
    // No assembly: no ordinal…
    expect(buildOrdinalsExist(fixture)).toBe(false)
    // …and no knock at the target.
    expect(target.hits).toEqual([])
  }, 180_000)
})
