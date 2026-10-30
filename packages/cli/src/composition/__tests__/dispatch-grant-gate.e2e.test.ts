// A shared-target run starts in `local-headless` with no `run:start` row and no `trustSource`.

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

/** A legacy ledger: a grant, its revoke fused onto a conflict marker, and a truncated line. */
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

// The ambient channels oppose the door's answer; an arm matching the harness proves nothing.
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

  it('two shared runs start back to back, with no decision row', async () => {
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
