// Runs the built `agent-qa run` on one test, one suite and `--all` in a fixture project and compares
// each scrubbed reading with its file under `__fixtures__/run-parity/`.
// `pnpm --filter agent-qa run regen:run-parity` rewrites those files from today's build.

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLI_ENTRY,
  CLI_PACKAGE_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
} from '../../__tests__/conformance/spawned-chat.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

const REPO_ROOT = resolve(CLI_PACKAGE_ROOT, '..', '..')

interface ParityInvocation {
  readonly id: string
  readonly args: readonly string[]
}

interface ParityReading {
  readonly id: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly eventTypes: readonly string[]
  readonly targetHits: readonly string[]
  readonly runDirFiles: readonly string[]
}

interface ScrubContext {
  readonly project: string
  readonly home: string
  readonly tmp: string
  readonly repoRoot: string
  readonly targetOrigin: string
}

interface ParityFixture {
  readonly project: string
  readonly home: string
}

const PARITY_INVOCATIONS: readonly ParityInvocation[] = [
  { id: 'single-test', args: ['tests/direct.yaml'] },
  { id: 'suite', args: ['suites/gate.suite.yaml'] },
  { id: 'all', args: ['--all'] },
]

function scrubTranscript(text: string, context: ScrubContext): string {
  let out = text
  // The project and home dirs sit inside the tmp dir, so they are replaced first.
  for (const [path, placeholder] of [
    [context.project, '<PROJECT>'],
    [context.home, '<HOME>'],
    [context.tmp, '<TMP>'],
  ] as const) {
    out = out.split(path).join(placeholder)
  }
  out = out.split(context.repoRoot).join('<REPO>')
  out = out.split(context.targetOrigin).join('http://127.0.0.1:<TARGET>')
  return out
    .replace(/\b(?:obs|[tshr])_[a-z0-9]+(?:-[a-z0-9]+){2,}/gi, '<ID>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
    .replace(/\b\d+m \d+(?:\.\d+)?s\b/g, '<DUR>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, '<DUR>')
    .replace(/\$\d+(?:\.\d+)?/g, '<COST>')
    .replace(/127\.0\.0\.1:\d{2,5}/g, '127.0.0.1:<PORT>')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
}

class CountingTarget {
  readonly hits: string[] = []
  private server: Server | undefined
  private originValue = ''

  async listen(): Promise<void> {
    const server = createServer((request, response) => {
      this.hits.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Example</title><p>Example</p>')
    })
    this.server = server
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    this.originValue = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    await new Promise<void>((closed) => server.close(() => closed()))
  }

  get origin(): string {
    return this.originValue
  }
}

// `--all` discovers two tests and one suite. The model points at the unbindable port 1, so every
// run starts, fails to reach the model and finishes without a planner request reaching the target.
// The seeded `version-check.json` keeps the update notice from making a network call.
function createParityFixture(origin: string): ParityFixture {
  const directTestId = generateTestId()
  const memberTestId = generateTestId()
  const suiteId = generateSuiteId()
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'run-parity-')))
  mkdirSync(join(project, 'tests'), { recursive: true })
  mkdirSync(join(project, 'suites'), { recursive: true })
  const home = join(project, 'home')
  mkdirSync(join(home, '.agent-qa'), { recursive: true })
  mkdirSync(join(project, 'no-browsers'), { recursive: true })
  writeFileSync(
    join(home, '.agent-qa', 'version-check.json'),
    JSON.stringify({ lastAttemptedAt: new Date().toISOString() }),
  )

  writeFileSync(
    join(project, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      "    - 'tests/**/*.yaml'",
      '  suiteMatch:',
      "    - 'suites/**/*.suite.yaml'",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'registry:',
      '  targets:',
      '    parity-thing:',
      '      platform: web',
      `      url: ${origin}/parity-thing`,
      '      environment: local',
      '  llms:',
      '    - name: unreachable',
      '      provider: openai-compatible',
      '      model: gpt-4o-mini',
      '      baseURL: http://127.0.0.1:1/v1',
      'use:',
      '  llm: unreachable',
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
  )
  writeFileSync(join(project, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(project, '.env'), '')
  writeFileSync(join(project, '.env.secrets.local'), '')

  writeFileSync(
    join(project, 'tests', 'direct.yaml'),
    [
      `test-id: ${directTestId}`,
      'name: the standalone test',
      'target: parity-thing',
      'steps:',
      '  - Verify the page says "Example"',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'tests', 'member.yaml'),
    [
      `test-id: ${memberTestId}`,
      'name: the suite member',
      'target: parity-thing',
      'steps:',
      '  - Verify the page says "Example"',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'suites', 'gate.suite.yaml'),
    [
      `suite-id: ${suiteId}`,
      'name: the parity suite',
      'target: parity-thing',
      'tests:',
      '  - test: tests/member.yaml',
      `    id: ${memberTestId}`,
      '',
    ].join('\n'),
  )

  return { project, home }
}

// An allowlist, so `CI`, `GITHUB_ACTIONS` and `AGENT_QA_*` from the caller never reach the child
// and the reading is the local one on every host. The empty browsers path makes the browser launch
// fail the same way everywhere.
function childEnv(fixture: ParityFixture, tmp: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    TMPDIR: tmp,
    NO_COLOR: '1',
    PLAYWRIGHT_BROWSERS_PATH: join(fixture.project, 'no-browsers'),
  }
  if (process.env.NODE_ENV !== undefined) env.NODE_ENV = process.env.NODE_ENV
  return env
}

async function runCli(
  fixture: ParityFixture,
  tmp: string,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI_ENTRY, 'run', ...args], {
    cwd: fixture.project,
    env: childEnv(fixture, tmp),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const status = await new Promise<number | null>((settle, fail) => {
    child.on('error', fail)
    child.on('close', (code) => settle(code))
  })
  return { status, stdout, stderr }
}

// Run ids are random, so `--all`'s two run dirs are ordered by creation time, not by name.
function runDirs(project: string): string[] {
  const runs = join(project, '.agent-qa', 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs)
    .map((entry) => join(runs, entry))
    .map((dir) => ({ dir, at: statSync(dir).birthtimeMs }))
    .sort((left, right) => left.at - right.at || left.dir.localeCompare(right.dir))
    .map((entry) => entry.dir)
}

function eventTypes(project: string): string[] {
  return runDirs(project).flatMap((dir) => {
    const path = join(dir, 'events.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { type: string }).type)
  })
}

function runDirFiles(project: string): string[] {
  return runDirs(project)
    .flatMap((dir) => readdirSync(dir))
    .sort()
}

async function captureInvocation(invocation: ParityInvocation): Promise<ParityReading> {
  const target = new CountingTarget()
  await target.listen()
  let fixture: ParityFixture | undefined
  try {
    fixture = createParityFixture(target.origin)
    const tmp = realpathSync(tmpdir())
    const result = await runCli(fixture, tmp, invocation.args)
    const context: ScrubContext = {
      project: fixture.project,
      home: fixture.home,
      tmp,
      repoRoot: realpathSync(REPO_ROOT),
      targetOrigin: target.origin,
    }
    return {
      id: invocation.id,
      args: invocation.args,
      exitCode: result.status,
      stdout: scrubTranscript(result.stdout, context),
      stderr: scrubTranscript(result.stderr, context),
      eventTypes: eventTypes(fixture.project),
      targetHits: [...target.hits],
      runDirFiles: runDirFiles(fixture.project),
    }
  } finally {
    await target.close()
    if (fixture !== undefined) rmSync(fixture.project, { recursive: true, force: true })
  }
}

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => {
  const freshness = buildFreshness()
  expect(freshness.missing, REBUILD_INSTRUCTION).toEqual([])
  expect(freshness.stale, REBUILD_INSTRUCTION).toEqual([])
  pinnedTmpdir = pinProcessTmpdir()
})
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

describe('agent-qa run output against its file snapshots', () => {
  for (const invocation of PARITY_INVOCATIONS) {
    it(
      `agent-qa run ${invocation.args.join(' ')} prints, records and requests what its snapshot holds`,
      async () => {
        const reading = await captureInvocation(invocation)
        expect(reading.stdout.trim(), 'the run printed nothing').not.toBe('')
        expect(reading.eventTypes, 'the run never started').toContain('runStarted')
        await expect(`${JSON.stringify(reading, null, 2)}\n`).toMatchFileSnapshot(
          `./__fixtures__/run-parity/${invocation.id}.json`,
        )
      },
      180_000,
    )
  }
})
