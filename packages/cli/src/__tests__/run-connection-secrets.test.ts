// Connection-only secrets reach the connection and the mask, and nothing a test or a hook can touch.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'

import { createRunCommand } from '../commands/run.js'
import {
  CountingTarget,
  PLANTED_SECRET_NAME,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from '../composition/__tests__/in-process-run-fixture.js'
import type {
  InProcessFixture,
  InProcessFixtureInput,
} from '../composition/__tests__/in-process-run-fixture.js'
import {
  refuseWithoutChromium,
  startRemoteBrowserEndpoint,
} from '../composition/__tests__/remote-browser-endpoint.js'
import type { RemoteBrowserEndpoint } from '../composition/__tests__/remote-browser-endpoint.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

const RUN_BUDGET_MS = 180_000
const REMOTE_TOKEN = 'r3m0te/t0ken+v@lue'
const PLANTED = 'step-secret-planted'
const BEARER = { Authorization: 'Bearer {{secret:REMOTE_TOKEN}}' }
const KEYSTORE_PASSWORD = 'k3ystore-pass-value'
const APK_SIGNATURE = 'apk-signature-value'

const roots: string[] = []
let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(() => {
  removeInProcessFixtures()
  removeTempRoots(roots.splice(0))
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

interface Scene {
  readonly project: InProcessFixture
  readonly endpoint: RemoteBrowserEndpoint
  readonly target: CountingTarget
  readonly printed: string[]
  readonly stderr: string[]
  readonly exit: MockInstance
}

interface SceneInput {
  readonly headers?: Readonly<Record<string, string>>
  readonly requireHeader?: readonly [name: string, value: string]
  readonly knobs?: Partial<InProcessFixtureInput>
}

async function onRemote(input: SceneInput, drive: (scene: Scene) => Promise<void>): Promise<void> {
  refuseWithoutChromium()
  const target = new CountingTarget()
  await target.listen()
  try {
    const endpoint = await startRemoteBrowserEndpoint(
      input.requireHeader === undefined ? {} : { requireHeader: input.requireHeader },
    )
    try {
      const project = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        remote: {
          name: 'grid',
          protocol: 'playwright',
          url: endpoint.wsEndpoint,
          ...(input.headers === undefined ? {} : { headers: input.headers }),
        },
        ...input.knobs,
      })
      vi.stubEnv('HOME', freshUpdateCheckHome())
      const printed: string[] = []
      const stderr: string[] = []
      const keep = (...args: unknown[]): void => { printed.push(plain(args.map(String).join(' '))) }
      vi.spyOn(console, 'log').mockImplementation(keep)
      vi.spyOn(console, 'warn').mockImplementation(keep)
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        keep(...args)
        stderr.push(...plain(args.map(String).join(' ')).split('\n'))
      })
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('fixture command exit')
      })
      await drive({ project, endpoint, target, printed, stderr, exit })
    } finally {
      await endpoint.close()
    }
  } finally {
    await target.close()
  }
}

async function runThroughCli(scene: Scene, pattern: string): Promise<void> {
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(
    program.parseAsync(['--config', scene.project.configPath, 'run', pattern], { from: 'user' }),
  ).rejects.toThrow('fixture command exit')
}

function exitCode(scene: Scene): unknown {
  return scene.exit.mock.calls.at(-1)?.[0]
}

function remoteLabel(endpoint: RemoteBrowserEndpoint): string {
  const { port } = new URL(endpoint.wsEndpoint)
  return `grid (playwright ws://127.0.0.1:${port})`
}

function misuse(name: string, file: string): string {
  return `${name} is a remote's or device's credential and only connects to it; ${file} uses it in a step. Use another secret there.`
}

function expectRefusedBeforeStart(scene: Scene, sentence: string): void {
  const stderr = scene.stderr.join('\n')
  expect(exitCode(scene), stderr).toBe(2)
  expect(scene.stderr.filter((line) => line.includes(sentence)), stderr).toHaveLength(1)
  expect(scene.stderr.filter((line) => /^\s+at /.test(line)), stderr).toEqual([])
  expect(scene.endpoint.sessions(), stderr).toBe(0)
  expect(scene.endpoint.refusals(), stderr).toBe(0)
  expect(scene.target.hits, stderr).toEqual([])
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

function expectNoTrace(scene: Scene, values: readonly string[]): void {
  const files = filesUnder(scene.project.agentQaRoot)
  expect(files.length).toBeGreaterThan(0)
  const db = new DashboardDatabase({ dbPath: join(scene.project.agentQaRoot, 'runs.db') })
  let rows: string
  try {
    const runs = db.getRuns()
    expect(runs.length).toBeGreaterThan(0)
    rows = JSON.stringify(runs.map((run) => [run.attributes, run.failureSummary, run.errorLog]))
  } finally {
    db.close()
  }
  const printed = scene.printed.join('\n')
  for (const value of values) {
    for (const file of files) {
      expect(readFileSync(file).toString('latin1').includes(value), file).toBe(false)
    }
    expect(rows.includes(value), rows).toBe(false)
    expect(printed.includes(value), printed).toBe(false)
  }
}

// A POSIX stand-in for the `docker` binary the hook executor calls: every subcommand succeeds,
// and `run` writes each of its arguments on its own line beside the script.
function plantFakeDocker(): string {
  if (process.platform === 'win32') {
    throw new Error('the docker stand-in is a POSIX shell script; never skip')
  }
  const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'))
  roots.push(dir)
  const script = join(dir, 'docker')
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'if [ "$1" = "run" ]; then',
      '  for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$(dirname "$0")/run-args.txt"; done',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(script, 0o755)
  vi.stubEnv('PATH', `${dir}${delimiter}${process.env['PATH'] ?? ''}`)
  return join(dir, 'run-args.txt')
}

describe("a remote's secrets at run start", () => {
  it('connect a remote whose header names a declared secret, and appear in no artifact, record or printed line', async () => {
    await onRemote(
      {
        headers: BEARER,
        requireHeader: ['authorization', `Bearer ${REMOTE_TOKEN}`],
        knobs: { extraSecrets: { REMOTE_TOKEN } },
      },
      async (scene) => {
        await runThroughCli(scene, scene.project.testPattern)

        const log = scene.printed.join('\n')
        expect(scene.endpoint.refusals(), log).toBe(0)
        expect(scene.endpoint.sessions(), log).toBe(1)
        expect(scene.target.hits.length, log).toBeGreaterThan(0)
        expectNoTrace(scene, [REMOTE_TOKEN, encodeURIComponent(REMOTE_TOKEN)])
      },
    )
  }, RUN_BUDGET_MS)

  it('send a wrong token where the endpoint refuses it, so the connecting cell is not vacuous', async () => {
    await onRemote(
      {
        headers: BEARER,
        requireHeader: ['authorization', `Bearer ${REMOTE_TOKEN}`],
        knobs: { extraSecrets: { REMOTE_TOKEN: 'a-wrong-token' } },
      },
      async (scene) => {
        await runThroughCli(scene, scene.project.testPattern)

        const log = scene.printed.join('\n')
        expect(scene.endpoint.refusals(), log).toBeGreaterThan(0)
        expect(scene.endpoint.sessions(), log).toBe(0)
      },
    )
  }, RUN_BUDGET_MS)

  it("never reach a setup hook's environment, nor do a device's capability or app.ref secrets, while the step secrets do", async () => {
    for (const scope of ['test', 'suite'] as const) {
      await onRemote(
        {
          headers: BEARER,
          requireHeader: ['authorization', `Bearer ${REMOTE_TOKEN}`],
          knobs: {
            extraSecrets: { REMOTE_TOKEN, KEYSTORE_PASSWORD, APK_SIGNATURE },
            plantedSecret: PLANTED,
            setupHook: scope,
            connectionOnlyReferences: {
              capability: '{{secret:KEYSTORE_PASSWORD}}',
              appRef: 'https://files.example.com/keyed.apk?sig={{secret:APK_SIGNATURE}}',
            },
          },
        },
        async (scene) => {
          const captured = plantFakeDocker()
          await runThroughCli(
            scene,
            scope === 'test' ? scene.project.testPattern : scene.project.suitePattern,
          )

          const log = `${scope}\n${scene.printed.join('\n')}`
          expect(existsSync(captured), log).toBe(true)
          const args = readFileSync(captured, 'utf8').split('\n')
          rmSync(captured)
          const planted = `${PLANTED_SECRET_NAME}=${PLANTED}`
          expect(
            args.some((arg, index) => arg === planted && args[index - 1] === '-e'),
            `${log}\n${args.join('\n')}`,
          ).toBe(true)
          for (const [name, value] of Object.entries({
            REMOTE_TOKEN,
            KEYSTORE_PASSWORD,
            APK_SIGNATURE,
          })) {
            expect(args.filter((arg) => arg.startsWith(`${name}=`)), log).toEqual([])
            expect(args.filter((arg) => arg.includes(value)), log).toEqual([])
          }
          expect(scene.endpoint.sessions(), log).toBe(1)
        },
      )
    }
  }, RUN_BUDGET_MS * 2)

  it('refuse a step that types one, in a direct test and in a suite member, before anything starts', async () => {
    for (const [pattern, file] of [
      ['testPattern', 'tests/direct.yaml'],
      ['suitePattern', 'tests/member.yaml'],
    ] as const) {
      await onRemote(
        {
          headers: BEARER,
          knobs: {
            extraSecrets: { REMOTE_TOKEN },
            stepText: 'Type {{secret:REMOTE_TOKEN}} into the field',
          },
        },
        async (scene) => {
          await runThroughCli(scene, scene.project[pattern])

          expectRefusedBeforeStart(scene, misuse('REMOTE_TOKEN', file))
        },
      )
    }
  }, RUN_BUDGET_MS)

  it('refuse an expected value a step states with one', async () => {
    await onRemote(
      {
        headers: BEARER,
        knobs: {
          extraSecrets: { REMOTE_TOKEN },
          stepText: 'Verify the banner reads "{{secret:REMOTE_TOKEN}}"',
        },
      },
      async (scene) => {
        await runThroughCli(scene, scene.project.testPattern)

        expectRefusedBeforeStart(scene, misuse('REMOTE_TOKEN', 'tests/direct.yaml'))
      },
    )
  }, RUN_BUDGET_MS)

  it("refuse a suite whose target's url names one before any member starts, printing no value", async () => {
    await onRemote(
      {
        headers: BEARER,
        knobs: {
          extraSecrets: { REMOTE_TOKEN },
          targetPath: '/in-process-thing?t={{secret:REMOTE_TOKEN}}',
        },
      },
      async (scene) => {
        await runThroughCli(scene, scene.project.suitePattern)

        const stderr = scene.stderr.join('\n')
        expect(exitCode(scene), stderr).toBe(2)
        expect(
          scene.stderr.filter(
            (line) =>
              line.includes('registry.targets.in-process-thing.url') &&
              line.includes('REMOTE_TOKEN'),
          ),
          stderr,
        ).toHaveLength(1)
        expect(scene.endpoint.sessions(), stderr).toBe(0)
        expect(scene.target.hits, stderr).toEqual([])
        const printed = scene.printed.join('\n')
        expect(printed.includes(REMOTE_TOKEN), printed).toBe(false)
        expect(printed.includes(encodeURIComponent(REMOTE_TOKEN)), printed).toBe(false)
      },
    )
  }, RUN_BUDGET_MS)

  it('refuse a run whose remote needs a secret the secrets file does not declare, naming both', async () => {
    for (const pattern of ['testPattern', 'suitePattern'] as const) {
      await onRemote(
        { headers: { Authorization: 'Bearer {{secret:UNDECLARED_TOKEN}}' } },
        async (scene) => {
          await runThroughCli(scene, scene.project[pattern])

          expectRefusedBeforeStart(
            scene,
            `Remote ${remoteLabel(scene.endpoint)} needs UNDECLARED_TOKEN, which .env.secrets.local does not declare. Add it there.`,
          )
        },
      )
    }
  }, RUN_BUDGET_MS)

  it("navigate a suite to its target's url resolved with the step secrets", async () => {
    await onRemote(
      {
        knobs: {
          plantedSecret: PLANTED,
          targetPath: `/in-process-thing/{{secret:${PLANTED_SECRET_NAME}}}`,
        },
      },
      async (scene) => {
        await runThroughCli(scene, scene.project.suitePattern)

        const log = scene.printed.join('\n')
        expect(scene.endpoint.sessions(), log).toBe(1)
        expect(scene.target.hits, log).toContain(`/in-process-thing/${PLANTED}`)
        expect(scene.target.hits.filter((hit) => /\{\{|%7B%7B/i.test(hit)), log).toEqual([])
      },
    )
  }, RUN_BUDGET_MS)
})
