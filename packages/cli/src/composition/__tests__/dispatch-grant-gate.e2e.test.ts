// D-08's DISPATCH GRANT AT THE REAL RUN GATE (Phase 401 plan 08 — RESEARCH Pitfall 6).
//
// RE-SPELLED 2026-09-30. The run gate this file measured is gone: the run core
// evaluates nothing and the door forwards no reader, so a dispatch grant had nothing to satisfy.
//
// RE-SPELLED AGAIN 2026-10-01. The overlay itself is deleted with the grant
// ledger (`agent-local/src/composition/dispatch-grants.ts`), and `composeCliLocalAgent` takes no
// `dispatchGrants` input. The four arms below kept their shapes and lost their overlay: a
// shared-target run in the fail-closed `local-headless` context starts back to back, starts alone,
// starts after an earlier run, and starts while a workspace still holds an old, damaged
// `grants.jsonl` — with no `run:start` row and no `trustSource` in any of them, and the old ledger
// left byte-identical. The history below is kept as written.
//
// WHAT IS UNDER TEST is the whole shipped path: `composeCliLocalAgent` → the 384 registry →
// `invokeFunction` → the op gate → the bound run invocation → the composition's per-run grant
// resolution → this host's default in-process drive → the core's ONE `evaluate()`. Nothing is
// substituted. The only thing a cell varies is whether a dispatch scope is OPEN.
//
// PITFALL 6, PROVEN BOTH WAYS. `resolveAsk`'s ladder is (a) trust mode, (b) credential, (c)
// STANDING GRANTS, (d) fail-closed, (e) confirm. D-08's approval has to be consulted at (c) or it
// is never consulted at all in the contexts D-08 exists for. So the positive arm is an ask-tier run
// in `local-headless` PROCEEDING on the grant, and the negative arm is the identical run — same
// fixture shape, same door, same context, same request — DENYING fail-closed with no dispatch open.
// One direction is half a proof: an implementation that granted unconditionally passes the first
// and an implementation that grants nothing passes the second.
//
// AND SINCE 401-13, A THIRD AXIS: THE CALLER (verification gap CR-03). The three arms below this
// file shipped with all varied WHETHER A DISPATCH WAS RUNNING; none of them varied WHO WAS ASKING,
// and every one of them asked from the test body — which is to say all three were the unrelated
// caller, and the positive arm's green was the defect. The last cell holds a dispatch provably OPEN
// and drives `runs.start` from outside its call tree: the dashboard-run-button / MCP-caller shape.
// It is the two-sided pair with the first cell, in one file: the dispatch's own runs still carry
// `trustSource: standing-approval`, and the outsider's row carries none at all.
//
// THE RED THIS REPLACES. Before this plan the door passed NO reader to the run gate at all, so the
// positive arm's run denied exactly like the negative one — one human approval at the authoring
// confirm, then N fail-closed refusals. Mutation 1 in the SUMMARY's ledger IS that pre-change door
// (the `gate?.reader` spread removed) and it reds the positive arms and nothing else.
//
// A DENIAL'S ASSERTION SURFACE IS FIVE ARTIFACTS (401-03 Mutation B), never an exit code or a
// message: the audit row's `outcome`, no run events, no build-ordinal ledger, zero requests at the
// target, and the reason read BACK off the row.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { invokeFunction } from '@vostride/agent-qa-agent'
import * as agentLocal from '@vostride/agent-qa-agent-local'
import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
import type { RunStartAcknowledgement, RunsStartInput } from '@vostride/agent-qa-schema'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import {
  CountingTarget,
  auditRows,
  buildOrdinalsExist,
  createInProcessFixture,
  eventTypes,
  runDirs,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { AuditRow } from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

/** The one field a consumed grant leaves on a row — the whole of the attribution claim. */
type GateAuditRow = AuditRow & { readonly trustSource?: string }

type Fixture = ReturnType<typeof createInProcessFixture>

/** The `run:start` rows, in run-dir order — one per run, each in its OWN file. */
function runGateRowsPerDir(fixture: Fixture): GateAuditRow[][] {
  return runDirs(fixture).map((dir) => {
    const path = join(dir, 'execution_audit.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as GateAuditRow)
      .filter((row) => row.action === 'run:start')
  })
}

/** The old ledger a workspace may still hold. Nothing in this build reads or writes it. */
function grantsLedgerBytes(fixture: Fixture): string | undefined {
  const path = join(fixture.project, 'agent-qa-knowledge', 'grants.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** A pre-432 ledger: a `run:start` grant, its revoke fused onto a conflict marker, a truncated line. */
const LEGACY_LEDGER_BYTES = [
  '{"schemaVersion":1,"kind":"grant","at":"2026-08-20T00:00:00.000Z","grantId":"grant_run_start","actionClass":"run:start","scope":{"project":"local-workspace"}}',
  '<<<<<<< HEAD{"schemaVersion":1,"kind":"revoke","at":"2026-08-20T01:00:00.000Z","grantId":"grant_run_start"}',
  '{"schemaVersion":1,"kind":"gra',
  '',
].join('\n')

function plantLegacyLedger(fixture: Fixture): void {
  const dir = join(fixture.project, 'agent-qa-knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'grants.jsonl'), LEGACY_LEDGER_BYTES, 'utf8')
}

/** An empty browsers root, so a member's failure is a property of the fixture, not of the machine. */
function pinEmptyBrowsersRoot(fixture: Fixture): void {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(fixture.project, 'no-browsers')
}

/**
 * Invoke `runs.start` through the SHIPPED dispatcher, on the shipped host.
 *
 * nothing is supplied beyond what 401-05's cells supply — the host takes no overlay.
 */
async function invokeRunsStart(
  fixture: Fixture,
  request: RunsStartInput,
): Promise<{ ack?: RunStartAcknowledgement; error?: unknown }> {
  pinEmptyBrowsersRoot(fixture)
  const { registry } = composeCliLocalAgent({
    agentQaRoot: fixture.agentQaRoot,
    configPath: fixture.configPath,
    resolveExecutionContext: () => 'local-headless',
  })
  try {
    return {
      ack: await invokeFunction(
        registry,
        'runs.start',
        request,
        CLI_FUNCTION_CALLER,
      ) as RunStartAcknowledgement,
    }
  } catch (error) {
    return { error }
  }
}

// The ambient channels, varied against the door's own answer on 401-05's precedent: the arm that
// agrees with the harness's own posture passes for free.
const shippedExecutionContextResolver = getActiveExecutionContext
let restoreAmbient: (() => void) | undefined

beforeEach(() => { restoreAmbient = undefined })
afterEach(() => {
  restoreAmbient?.()
  restoreAmbient = undefined
})
afterAll(() => { removeInProcessFixtures() })

function pinAmbient(value: 'ci' | 'local-interactive' | 'local-headless', ciMarker: boolean): void {
  const priorGithubActions = process.env.GITHUB_ACTIONS
  setActiveExecutionContextResolver(() => value as never)
  if (ciMarker) process.env.GITHUB_ACTIONS = 'true'
  else delete process.env.GITHUB_ACTIONS
  restoreAmbient = () => {
    setActiveExecutionContextResolver(() => shippedExecutionContextResolver())
    if (priorGithubActions === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = priorGithubActions
  }
}

describe('one human ask, N gated runs, every one of them gated', () => {
  /** The start artifacts every arm below asserts, identically. */
  function expectStartedWithNoDecision(fixture: Fixture, outcome: { ack?: RunStartAcknowledgement; error?: unknown }): void {
    expect(outcome.error, `runs.start refused: ${String(outcome.error)}`).toBeUndefined()
    expect(outcome.ack?.runId).toMatch(/^r_/)
    expect(runGateRowsPerDir(fixture).flat()).toEqual([])
    expect((auditRows(fixture) as GateAuditRow[]).map((row) => row.trustSource).filter(Boolean)).toEqual([])
  }

  // RE-SPELLED 2026-10-01 from 'THE ORDERING EDGE — two shared runs inside an open dispatch
  // start, with no decision row': there is no dispatch to open; the two runs start back to back.
  it('THE ORDERING EDGE — two shared runs start back to back, with no decision row', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'shared' })
      pinAmbient('local-interactive', false)

      const first = await invokeRunsStart(fixture, { patterns: [fixture.testPattern] })
      const second = await invokeRunsStart(fixture, { patterns: [fixture.testPattern] })

      expectStartedWithNoDecision(fixture, first)
      expectStartedWithNoDecision(fixture, second)
      expect(first.ack?.runId).not.toBe(second.ack?.runId)
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(buildOrdinalsExist(fixture)).toBe(true)
      expect(grantsLedgerBytes(fixture), 'a run minted a grant ledger').toBeUndefined()
    } finally {
      await target.close()
    }
  }, 300_000)

  it('THE SAME RUN WITHOUT THE DISPATCH — starts too: there was never a grant to need', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'shared' })
      pinAmbient('local-interactive', false)

      const outcome = await invokeRunsStart(fixture, { patterns: [fixture.testPattern] })

      expectStartedWithNoDecision(fixture, outcome)
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(buildOrdinalsExist(fixture)).toBe(true)
      expect(target.hits).toEqual(['/in-process-thing'])
    } finally {
      await target.close()
    }
  }, 300_000)

  // RE-SPELLED 2026-10-01 from 'THE GRANT DIES WITH THE DISPATCH — and the run after it
  // starts all the same' and 'AN UNRELATED CALLER DURING AN OPEN DISPATCH — starts, and no row
  // borrows the dispatch': with no overlay there is no grant to die or to borrow. The
  // surviving claim is that a run starts whatever an old ledger says, and leaves it as it was.
  it('a run beside an old, damaged grants.jsonl starts and leaves it byte-identical', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'shared' })
      pinAmbient('local-interactive', false)
      plantLegacyLedger(fixture)

      const outcome = await invokeRunsStart(fixture, { patterns: [fixture.testPattern] })

      expectStartedWithNoDecision(fixture, outcome)
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(grantsLedgerBytes(fixture)).toBe(LEGACY_LEDGER_BYTES)
    } finally {
      await target.close()
    }
  }, 300_000)

  it('the host takes no dispatch overlay and agent-local publishes none', () => {
    expect(Object.keys(agentLocal).filter((name) => /dispatchgrant/i.test(name))).toEqual([])
  })
})
