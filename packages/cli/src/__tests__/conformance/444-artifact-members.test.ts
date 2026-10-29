// C444-ARTIFACT-MEMBERS (Phase 444 plan 03; D-07, V2-RUN-03).
//
// One real two-test `agent-qa run` over the stub model and Chromium: the artifact its runs.db row
// carries lists both members, each with its own file's YAML, rather than the first member's.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  dashboardDbPath,
  recordedDoorProject,
  refuseWithoutRecordingTools,
  spawnCliRun,
  type RecordedDoorProject,
} from './run-doors-fixture.js'
import { POPULATED_BUTTON_LABEL, POPULATED_TARGET_NAME } from './populated-run-fixture.js'
import { cleanupTempRoots } from './spawned-chat.js'

const FILE_BUDGET_MS = 600_000

const TESTS = [
  {
    file: 'tests/444-03/a-login.test.yaml',
    name: 'Artifact members login',
    step: `Click the ${POPULATED_BUTTON_LABEL} button on the login notice and confirm the notice state changed.`,
  },
  {
    file: 'tests/444-03/b-checkout.test.yaml',
    name: 'Artifact members checkout',
    step: `Click the ${POPULATED_BUTTON_LABEL} button on the checkout notice and confirm the notice state changed.`,
  },
] as const

interface Drive {
  project?: RecordedDoorProject
  runId?: string
  exit?: { status: number | null; text: string }
  testIds: string[]
  source?: Record<string, any>
  config?: unknown
}

const drive: Drive = { testIds: [] }

beforeAll(async () => {
  refuseWithoutRecordingTools()
  const project = await recordedDoorProject('444-03-artifact-members')
  drive.project = project
  for (const spec of TESTS) {
    const testId = generateTestId()
    const file = join(project.root, spec.file)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(
      file,
      `name: ${spec.name}\ntest-id: ${testId}\ntarget: ${POPULATED_TARGET_NAME}\nsteps:\n  - ${spec.step}\n`,
      'utf8',
    )
    drive.testIds.push(testId)
  }
  const runId = generateRunId()
  drive.runId = runId
  const outcome = await spawnCliRun(project, ['run', ...TESTS.map((spec) => spec.file)], {
    env: { AGENT_QA_RUN_ID: runId },
  })
  drive.exit = { status: outcome.status, text: `${outcome.stdout}\n${outcome.stderr}` }
  const db = new DashboardDatabase({ dbPath: dashboardDbPath(project) })
  try {
    const payload = db.getRunArtifact(runId)?.payload as unknown as Record<string, any> | undefined
    drive.source = payload?.source
    drive.config = payload?.config
  } finally {
    db.close()
  }
}, FILE_BUDGET_MS)

afterAll(async () => {
  await drive.project?.close()
  cleanupTempRoots()
})

describe('C444-ARTIFACT-MEMBERS', () => {
  it("a real two-test agent-qa run leaves both members' own YAML in its artifact", () => {
    expect(drive.exit?.status, drive.exit?.text).toBe(0)
    expect(drive.source?.kind).toBe('tests')
    const members = (drive.source?.members ?? []) as Array<Record<string, any>>
    expect(members.length).toBe(2)
    members.forEach((member, position) => {
      const spec = TESTS[position]!
      const other = TESTS[1 - position]!
      expect(member.index).toBe(position)
      expect(member.testId).toBe(drive.testIds[position])
      expect(member.name).toBe(spec.name)
      expect(member.rawYaml).toContain(spec.step)
      expect(member.rawYaml).not.toContain(other.step)
      expect(member.config?.runtime?.targetName).toBe(POPULATED_TARGET_NAME)
    })
    expect(drive.config).toBeUndefined()
  })
})
