// 2026-10-17 (443-07, D-09/D-17): an authoring verify run keeps its gate-run flag and its learning
// exclusion, and its runs.db row carries the verify-run mark; an ordinary run beside it does not.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateTestId } from '@vostride/agent-qa-ids'
import type { CompletedRunHandoff, RunStartAcknowledgement } from '@vostride/agent-qa-schema'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import {
  CountingTarget,
  IN_PROCESS_TARGET_NAME,
  createInProcessFixture,
  runDirs,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

type Fixture = ReturnType<typeof createInProcessFixture>

const GATE_RUN_KEY = 'agent-qa.gate-run'

const MODEL_DOCUMENT = [
  `test-id: ${generateTestId()}`,
  'name: Submit the in-process thing',
  `target: ${IN_PROCESS_TARGET_NAME}`,
  'steps:',
  '  - Click the Submit button',
  '  - Verify the page says "Example"',
  '',
].join('\n')

const target = new CountingTarget()
const priorBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
let project: Fixture

beforeAll(async () => {
  await target.listen()
  project = fixture()
})
afterAll(async () => {
  await target.close()
  if (priorBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = priorBrowsersPath
  removeInProcessFixtures()
})

function fixture(): Fixture {
  const created = createInProcessFixture({ origin: target.origin, environment: 'local' })
  const browsersRoot = join(created.project, 'no-browsers')
  mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  return created
}

function handoffFor(runId: string): CompletedRunHandoff {
  for (const dir of runDirs(project)) {
    const path = join(dir, 'handoff.json')
    if (!existsSync(path)) continue
    const document = JSON.parse(readFileSync(path, 'utf8')) as CompletedRunHandoff
    if (String(document.runId) === runId) return document
  }
  throw new Error(`no handoff on disk for run ${runId}`)
}

function rowAttributes(runId: string): Record<string, string> | undefined {
  const path = join(project.project, '.agent-qa', 'runs.db')
  if (!existsSync(path)) return undefined
  const db = new DashboardDatabase({ dbPath: path })
  try {
    const row = db.getRun(runId)
    return row === undefined ? undefined : { ...(row.attributes ?? {}) } as Record<string, string>
  } finally {
    db.close()
  }
}

describe('the verify run mark on a run row', () => {
  it('a verify run started through authoring keeps its flag and exclusion and has a marked row', async () => {
    const composed = composeCliLocalAgent({
      agentQaRoot: project.agentQaRoot,
      configPath: project.configPath,
      resolveExecutionContext: () => 'local-headless',
      model: () => ({
        modelId: 'fixture:443-verify-run-record',
        generate: () => Promise.resolve({ text: MODEL_DOCUMENT }),
      }) as never,
    })
    try {
      const answered = await invokeFunction(
        composed.registry,
        'authoring.draft.write',
        { intent: 'Check that submitting the in-process thing shows the confirmation banner' },
        CLI_FUNCTION_CALLER,
      ) as { readonly receipt: { readonly gateRuns: readonly { readonly runId: string }[] } }
      const gateRunIds = answered.receipt.gateRuns.map((run) => run.runId)
      expect(gateRunIds.length, 'the authoring receipt returned no gate run id').toBeGreaterThan(0)

      for (const runId of gateRunIds) {
        expect(handoffFor(runId).gateRun, `handoff gateRun of ${runId}`).toBe(true)
        const status = await invokeFunction(
          composed.registry,
          'runs.postprocessing',
          { runId },
          CLI_FUNCTION_CALLER,
        ) as { readonly skipped?: { readonly reason: string } }
        expect(status.skipped?.reason, `post-processing skipped reason of ${runId}`).toBe('gate-run')
        const attributes = rowAttributes(runId)
        expect(attributes, `runs.db row for ${runId}`).toBeDefined()
        expect(attributes?.[GATE_RUN_KEY], `the verify-run mark on ${runId}`).toBe('true')
      }
    } finally {
      await composed.close()
    }
  }, 300_000)

  it('an ordinary run in the same project has no mark', async () => {
    const composed = composeCliLocalAgent({
      agentQaRoot: project.agentQaRoot,
      configPath: project.configPath,
      resolveExecutionContext: () => 'local-headless',
    })
    try {
      const ack = await invokeFunction(
        composed.registry,
        'runs.start',
        { patterns: [project.testPattern] },
        CLI_FUNCTION_CALLER,
      ) as RunStartAcknowledgement
      const runId = String(ack.runId)
      expect(handoffFor(runId).gateRun, 'the ordinary handoff carries no gateRun').toBeUndefined()
      const status = await invokeFunction(
        composed.registry,
        'runs.postprocessing',
        { runId },
        CLI_FUNCTION_CALLER,
      ) as { readonly skipped?: { readonly reason: string } }
      expect(status.skipped, 'the ordinary run is not skipped').toBeUndefined()
      const attributes = rowAttributes(runId)
      expect(attributes, `runs.db row for ${runId}`).toBeDefined()
      expect(attributes?.['agent-qa.trigger'], 'the ordinary row is a recorded cli run').toBe('cli')
      expect(Object.hasOwn(attributes ?? {}, GATE_RUN_KEY), 'the ordinary row carries no mark').toBe(false)
    } finally {
      await composed.close()
    }
  }, 180_000)
})
