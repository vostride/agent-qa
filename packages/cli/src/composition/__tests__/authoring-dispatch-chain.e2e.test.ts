// Drives `authoring.draft.write` through the loop's gate runs to `runs.start`; nobody is asked.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { generateTestId } from '@vostride/agent-qa-ids'
import { DRAFT_STABILITY_RUNS_N, authoredSuiteTargetPath } from '@vostride/agent-qa-schema'
import type { RiskActionDescriptor } from '@vostride/agent-qa-schema'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import {
  CountingTarget,
  createInProcessFixture,
  runDirs,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { IN_PROCESS_TARGET_NAME } from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

afterAll(() => { removeInProcessFixtures() })

/**
 * The draft the fixture model returns.
 *
 * It names the fixture's OWN target through the fixture's own constant, so a rename cannot leave
 * this cell authoring against a target the project does not declare.
 */
const MODEL_DOCUMENT = [
  `test-id: ${generateTestId()}`,
  'name: Submit the in-process thing',
  `target: ${IN_PROCESS_TARGET_NAME}`,
  'steps:',
  '  - Click the Submit button',
  '  - Verify the page says "Example"',
  '',
].join('\n')

type Fixture = ReturnType<typeof createInProcessFixture>

interface GateRow {
  readonly action?: string
  readonly outcome?: string
  readonly verdict?: string
  readonly trustSource?: string
  readonly riskTier?: string
  readonly runId?: string
  readonly executionContext?: string
  readonly reason?: string
}

/** Every `run:start` decision this project recorded, each read out of its own run dir. */
function gateRows(fixture: Fixture): GateRow[] {
  return runDirs(fixture).flatMap((dir) => {
    const path = join(dir, 'execution_audit.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as GateRow)
      .filter((row) => row.action === 'run:start')
  })
}

function rowFor(fixture: Fixture, runId: string): GateRow {
  const rows = gateRows(fixture).filter((row) => row.runId === runId)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

/** The old ledger a workspace may still hold. Nothing in this build reads or writes it. */
const LEGACY_LEDGER_BYTES =
  '{"schemaVersion":1,"kind":"grant","at":"2026-08-20T00:00:00.000Z","grantId":"grant_run_start","actionClass":"run:start","scope":{"project":"local-workspace"}}\n'

function plantLegacyLedger(fixture: Fixture): void {
  const dir = join(fixture.project, 'agent-qa-knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'grants.jsonl'), LEGACY_LEDGER_BYTES, 'utf8')
}

function grantsLedgerBytes(fixture: Fixture): string | undefined {
  const path = join(fixture.project, 'agent-qa-knowledge', 'grants.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

interface ProbeResult {
  readonly ack?: { readonly runId: string }
  readonly error?: unknown
}

describe('one human ask, N gated runs, driven from the authoring loop', () => {
  it('THE STORE SURVIVES EVERY PRODUCTION FRAME — and reaches nobody outside the dispatch', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'shared' })
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(fixture.project, 'no-browsers')

      plantLegacyLedger(fixture)
      const ledgerBefore = grantsLedgerBytes(fixture)

      const { registry: probeRegistry } = composeCliLocalAgent({
        agentQaRoot: fixture.agentQaRoot,
        configPath: fixture.configPath,
        resolveExecutionContext: () => 'local-headless',
      })
      const probe = async (): Promise<ProbeResult> => {
        try {
          return {
            ack: await invokeFunction(
              probeRegistry,
              'runs.start',
              { patterns: [fixture.testPattern] },
              CLI_FUNCTION_CALLER,
            ) as { runId: string },
          }
        } catch (error) {
          return { error }
        }
      }

      // A confirm that records and refuses every ask; it is never consulted.
      const asked: string[] = []
      const { registry } = composeCliLocalAgent({
        agentQaRoot: fixture.agentQaRoot,
        configPath: fixture.configPath,
        resolveExecutionContext: () => 'local-interactive',
        // The input declares no confirm, so the recording port is smuggled past the type.
        ...{
          confirm: {
            surface: 'tty-prompt',
            ask: (action: RiskActionDescriptor) => {
              asked.push(action.name)
              return false
            },
          },
        } as object,
        model: () => ({
          modelId: 'fixture:authoring-dispatch-chain',
          generate: () => Promise.resolve({ text: MODEL_DOCUMENT }),
        }) as never,
      })

      const answered = await invokeFunction(
        registry,
        'authoring.draft.write',
        { intent: 'Check that submitting the in-process thing shows the confirmation banner' },
        CLI_FUNCTION_CALLER,
      ) as {
        readonly outcome: string
        readonly draftRef?: { readonly filePath: string; readonly testName: string }
        readonly receipt: { readonly disposition: string; readonly gateRuns: readonly { readonly runId: string }[] }
        readonly written?: { readonly file: { readonly kind: string; readonly filePath?: string } }
      }
      const gateRunIds = answered.receipt.gateRuns.map((run) => run.runId)

      // ---- (1) NOBODY WAS ASKED ----------------------------------------------------------------
      expect(asked).toEqual([])

      // ---- (2) N GATE RUNS, AND NO DECISION ROW FOR ANY OF THEM --------------------------------
      expect(gateRunIds.length).toBeGreaterThanOrEqual(DRAFT_STABILITY_RUNS_N)
      expect(gateRows(fixture)).toEqual([])
      for (const runId of gateRunIds) {
        expect(runDirs(fixture).map((dir) => dir.split('/').pop())).toContain(runId)
      }

      // The final write goes through the real host writer.
      const suiteTarget = authoredSuiteTargetPath(
        answered.draftRef?.filePath ?? 'tests/.agent-qa-drafts/none.yaml',
        answered.draftRef?.testName ?? 'none',
      )
      if (answered.outcome === 'drafted' || answered.outcome === 'repaired') {
        const writes = answered.receipt.disposition !== 'rejected'
        expect(answered.written?.file.kind).toBe(writes ? 'written' : 'not-written')
        expect(existsSync(join(fixture.project, suiteTarget))).toBe(writes)
        if (writes) {
          expect(answered.written?.file.filePath).toBe(suiteTarget)
          expect(readFileSync(join(fixture.project, suiteTarget))
            .equals(readFileSync(join(fixture.project, answered.draftRef!.filePath)))).toBe(true)
        }
      } else {
        expect(answered.written).toBeUndefined()
        expect(existsSync(join(fixture.project, suiteTarget))).toBe(false)
      }

      // ---- (3) A RUN FROM OUTSIDE THE DISPATCH STARTS THE SAME WAY -----------------------------
      const outsider = await probe()
      expect(outsider.error).toBeUndefined()
      expect(outsider.ack?.runId).toMatch(/^r_/)
      expect(gateRows(fixture)).toEqual([])

      // Nothing writes `grants.jsonl`, so an existing one stays byte for byte.
      expect(grantsLedgerBytes(fixture)).toEqual(ledgerBefore)
      expect(ledgerBefore).toBe(LEGACY_LEDGER_BYTES)
    } finally {
      await target.close()
    }
  }, 300_000)
})
