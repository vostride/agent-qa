// Each test's stored run artifact names where it ran, and stores a remote by its origin only.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateSuiteId } from '@vostride/agent-qa-ids'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  CountingTarget,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'
import type { RemoteBrowserEndpoint } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000
const PLANTED_QUERY_VALUE = 'planted-query-value-7f3a'
const PLANTED_HEADER_VALUE = 'planted-header-value-91c2'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => {
  refuseWithoutChromium()
  pinnedTmpdir = pinProcessTmpdir()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

interface StoredRun {
  readonly raw: string
  readonly payload: Record<string, any>
  readonly members: Array<{ name: string | undefined; failureSummary: string | undefined }>
}

function storedRuns(project: InProcessFixture): StoredRun[] {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    return db.getRuns({}).map((run) => {
      const payload = (db.getRunArtifact(run.id)?.payload ?? {}) as unknown as Record<string, any>
      return {
        raw: JSON.stringify(payload),
        payload,
        members: (db.readRunDetailRows(run.id)?.members ?? []).map((member) => ({
          name: member.name,
          failureSummary: member.failureSummary,
        })),
      }
    })
  } finally {
    db.close()
  }
}

function onlyRun(project: InProcessFixture, log: string): StoredRun {
  const runs = storedRuns(project)
  expect(runs, log).toHaveLength(1)
  return runs[0]!
}

// Runs `agent-qa run` in this process; the mocked exit throws, so only the first exit counts.
async function runCli(project: InProcessFixture, args: readonly string[]): Promise<string> {
  vi.stubEnv('HOME', freshUpdateCheckHome())
  const printed: string[] = []
  let exited = false
  const keep = (...parts: unknown[]): void => {
    if (!exited) printed.push(plain(parts.map(String).join(' ')))
  }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  vi.spyOn(process, 'exit').mockImplementation(() => {
    exited = true
    throw new Error('fixture command exit')
  })
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await program
    .parseAsync(['--config', project.configPath, 'run', ...args], { from: 'user' })
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.message === 'fixture command exit')) throw error
    })
  return printed.join('\n')
}

interface Scene {
  readonly target: CountingTarget
  readonly endpoint: RemoteBrowserEndpoint | undefined
}

async function onScene(
  options: {
    readonly remote?: boolean
    readonly requireHeader?: readonly [string, string]
    readonly onHit?: (scene: Scene) => void
  },
  drive: (scene: Scene) => Promise<void>,
): Promise<void> {
  let scene: Scene | undefined
  const target = new CountingTarget(() => {
    if (scene !== undefined) options.onHit?.(scene)
  })
  await target.listen()
  try {
    const endpoint = options.remote === false
      ? undefined
      : await startRemoteBrowserEndpoint(
          options.requireHeader === undefined ? {} : { requireHeader: options.requireHeader },
        )
    scene = { target, endpoint }
    try {
      await drive(scene)
    } finally {
      await endpoint?.close()
    }
  } finally {
    await target.close()
  }
}

function remoteProject(
  scene: Scene,
  knobs: Partial<InProcessFixtureInput> = {},
  remote: Partial<NonNullable<InProcessFixtureInput['remote']>> = {},
): InProcessFixture {
  return createInProcessFixture({
    origin: scene.target.origin,
    environment: 'local',
    remote: { name: 'grid', protocol: 'playwright', url: scene.endpoint!.wsEndpoint, ...remote },
    ...knobs,
  })
}

function originOf(endpoint: RemoteBrowserEndpoint): string {
  return `ws://127.0.0.1:${new URL(endpoint.wsEndpoint).port}`
}

function expectRemotePlace(place: unknown, endpoint: RemoteBrowserEndpoint, log: string): void {
  expect(place, log).toMatchObject({
    place: 'remote',
    name: 'grid',
    protocol: 'playwright',
    origin: originOf(endpoint),
    headless: 'decided by the remote',
  })
  const record = place as { browserVersion?: unknown; unsupported?: Array<{ capability: string }> }
  expect(record.browserVersion, log).toEqual(expect.stringMatching(/\S/))
  expect(record.unsupported?.map((entry) => entry.capability), log).toContain('launch flags')
}

describe("a remote run's evidence", () => {
  it('a direct test on a Playwright server names the remote, its browser and what it could not use', async () => {
    await onScene({}, async (scene) => {
      const project = remoteProject(scene)
      const log = await runCli(project, [project.testPattern])
      const stored = onlyRun(project, log)
      expectRemotePlace(stored.payload.config?.runtime?.place, scene.endpoint!, log)
      expect(scene.endpoint!.sessions(), log).toBe(1)
    })
  }, RUN_BUDGET_MS)

  it('every member of a suite on the remote carries the place its suite connected to', async () => {
    await onScene({}, async (scene) => {
      const project = remoteProject(scene, { secondSuiteMember: true })
      writeFileSync(
        join(project.project, 'suites', 'more.suite.yaml'),
        [
          `suite-id: ${generateSuiteId()}`,
          'name: the other suite',
          `target: ${project.targetName}`,
          'tests:',
          '  - test: tests/member.yaml',
          `    id: ${project.memberTestId}`,
          '',
        ].join('\n'),
      )
      const log = await runCli(project, [project.suitePattern, 'suites/more.suite.yaml'])
      const stored = onlyRun(project, log)
      const members = stored.payload.source?.members as Array<Record<string, any>> | undefined
      expect(members?.length, log).toBe(3)
      for (const member of members ?? []) {
        expectRemotePlace(member.config?.runtime?.place, scene.endpoint!, log)
      }
    })
  }, RUN_BUDGET_MS)

  it('a one-suite run on the remote stores the place its session reported', async () => {
    await onScene({}, async (scene) => {
      const project = remoteProject(scene, { secondSuiteMember: true })
      const log = await runCli(project, [project.suitePattern])
      const stored = onlyRun(project, log)
      expect(stored.payload.source?.kind, log).toBe('suite')
      expectRemotePlace(stored.payload.config?.runtime?.place, scene.endpoint!, log)
    })
  }, RUN_BUDGET_MS)

  it('a test launched here records its place as here', async () => {
    await onScene({ remote: false }, async (scene) => {
      const project = createInProcessFixture({ origin: scene.target.origin, environment: 'local' })
      const log = await runCli(project, [project.testPattern])
      const stored = onlyRun(project, log)
      expect(stored.payload.config?.runtime?.place, log).toEqual({ place: 'here' })
    })
  }, RUN_BUDGET_MS)

  it('a remote that refuses the credentials records the auth failure kind for a direct test', async () => {
    await onScene({ requireHeader: ['x-grid-key', 'never-sent'] }, async (scene) => {
      const project = remoteProject(scene)
      const log = await runCli(project, [project.testPattern])
      const stored = onlyRun(project, log)
      expect(stored.payload.config?.runtime?.place, log).toEqual({
        place: 'remote',
        name: 'grid',
        protocol: 'playwright',
        origin: originOf(scene.endpoint!),
        failureKind: 'auth',
      })
      expect(stored.members[0]?.failureSummary, log).toContain('refused the credentials')
      expect(scene.endpoint!.refusals(), log).toBe(1)
    })
  }, RUN_BUDGET_MS)

  it("a suite whose remote refuses the credentials records the auth failure kind as the suite's place", async () => {
    await onScene({ requireHeader: ['x-grid-key', 'never-sent'] }, async (scene) => {
      const project = remoteProject(scene, { secondSuiteMember: true })
      const log = await runCli(project, [project.suitePattern])
      const stored = onlyRun(project, log)
      expect(stored.payload.config?.runtime?.place, log).toMatchObject({
        place: 'remote',
        name: 'grid',
        failureKind: 'auth',
      })
    })
  }, RUN_BUDGET_MS)

  it('a direct test whose remote session drops records the lost failure kind', async () => {
    let dropped: Promise<void> | undefined
    await onScene(
      { onHit: (scene) => { dropped ??= scene.endpoint!.close() } },
      async (scene) => {
        const project = remoteProject(scene)
        try {
          const log = await runCli(project, [project.testPattern])
          expect(dropped, log).toBeDefined()
          const stored = onlyRun(project, log)
          const place = stored.payload.config?.runtime?.place
          expect(place, log).toMatchObject({
            place: 'remote',
            name: 'grid',
            origin: originOf(scene.endpoint!),
            failureKind: 'lost',
          })
          expect(stored.members, log).toEqual([
            {
              name: 'the standalone test',
              failureSummary:
                `The connection to remote grid (playwright ${originOf(scene.endpoint!)}) ` +
                'was lost while this test ran.',
            },
          ])
        } finally {
          await dropped
        }
      },
    )
  }, RUN_BUDGET_MS)

  it('the stored config shows the remote by its origin and none of its path, query or header values', async () => {
    await onScene({}, async (scene) => {
      const endpoint = scene.endpoint!
      const pathToken = new URL(endpoint.wsEndpoint).pathname.replace(/^\//, '')
      expect(pathToken.length).toBeGreaterThan(8)
      const project = remoteProject(scene, {}, {
        url: `${endpoint.wsEndpoint}?label=${PLANTED_QUERY_VALUE}`,
        headers: { 'x-grid-label': PLANTED_HEADER_VALUE },
      })
      const log = await runCli(project, [project.testPattern])
      const stored = onlyRun(project, log)
      expect(endpoint.sessions(), log).toBe(1)
      const config = stored.payload.config as Record<string, any>
      const origin = originOf(endpoint)
      expect(config.rawConfigContent, log).toContain(origin)
      expect(config.parsedConfig?.registry?.remotes, log).toEqual([
        { name: 'grid', protocol: 'playwright', url: origin },
      ])
      expect(config.effectiveConfig?.registry?.remotes, log).toEqual([
        { name: 'grid', protocol: 'playwright', url: origin },
      ])
      for (const planted of [pathToken, PLANTED_QUERY_VALUE, PLANTED_HEADER_VALUE]) {
        expect(stored.raw.includes(planted), `${planted} is stored\n${log}`).toBe(false)
      }
    })
  }, RUN_BUDGET_MS)

  it('the stored config hides a remote whose url and headers alias anchors outside its block', async () => {
    await onScene({}, async (scene) => {
      const endpoint = scene.endpoint!
      const pathToken = new URL(endpoint.wsEndpoint).pathname.replace(/^\//, '')
      expect(pathToken.length).toBeGreaterThan(8)
      const project = remoteProject(scene, { remoteAnchoredInDevices: true }, {
        url: `${endpoint.wsEndpoint}?label=${PLANTED_QUERY_VALUE}`,
        headers: { 'x-grid-label': PLANTED_HEADER_VALUE },
      })
      const log = await runCli(project, [project.testPattern])
      const stored = onlyRun(project, log)
      expect(endpoint.sessions(), log).toBe(1)
      const config = stored.payload.config as Record<string, any>
      const origin = originOf(endpoint)
      const match = { avd: origin, serial: null }
      const remotes = [{ name: 'grid', protocol: 'playwright', url: origin }]
      const raw = parseYaml(config.rawConfigContent as string) as Record<string, any>
      for (const shown of [raw, config.parsedConfig, config.effectiveConfig]) {
        expect(shown?.registry?.devices?.pixel?.match, log).toEqual(match)
        expect(shown?.registry?.remotes, log).toEqual(remotes)
      }
      for (const planted of [pathToken, PLANTED_QUERY_VALUE, PLANTED_HEADER_VALUE]) {
        expect(stored.raw.includes(planted), `${planted} is stored\n${log}`).toBe(false)
      }
    })
  }, RUN_BUDGET_MS)
})
