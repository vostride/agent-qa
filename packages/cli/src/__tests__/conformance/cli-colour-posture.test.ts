// Where the shipped bin colours its output: in CI and with FORCE_COLOR, not in a plain pipe or
// with NO_COLOR, and for each stream by whether that stream is a terminal. The env comes from
// `hermeticEnv`.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ANCHORED_BUILDS,
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  hermeticEnv,
  trackTempRoot,
} from './spawned-chat.js'

const MISSING_TEST_LINE = 'Error: Workspace test file not found: tests/missing.yaml'
const COLOUR_CODE = '\x1b['
const RED = '\x1b[31m'
const BOLD_RED = '\x1b[1m\x1b[31m'
const BOLD_BLUE = '\x1b[1m\x1b[34m'
const BOLD_END = '\x1b[39m\x1b[22m'

interface BinOutcome {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

afterEach(() => {
  cleanupTempRoots()
})

function missingTestProject(): { root: string; configPath: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-ci-colour-')))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    [
      'workspace:',
      '  testMatch:',
      "    - 'tests/**/*.yaml'",
      '  suiteMatch:',
      "    - 'suites/**/*.suite.yaml'",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'use:',
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  return { root, configPath }
}

type ColourEnv = Readonly<Partial<Record<'CI' | 'NO_COLOR' | 'FORCE_COLOR', string>>>
type Terminal = 'stdout' | 'stderr'

// Both of the child's streams are pipes. The bin reads `isTTY` to tell a terminal from a file, so
// a preload sets it on the one stream a case calls a terminal.
function terminalPreload(root: string, terminal: Terminal): string[] {
  const path = join(root, 'terminal.cjs')
  writeFileSync(path, `Object.defineProperty(process.${terminal}, 'isTTY', { value: true })\n`)
  return ['--require', path]
}

async function runBin(
  project: { root: string; configPath: string },
  command: readonly string[],
  colourEnv: ColourEnv,
  terminal?: Terminal,
): Promise<BinOutcome> {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  const freshness = buildFreshness(ANCHORED_BUILDS)
  expect(
    { missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
  ).toEqual({ missing: [], stale: [] })
  const env: NodeJS.ProcessEnv = { ...hermeticEnv(project.root) }
  delete env.CI
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  Object.assign(env, colourEnv)
  const child = spawn(
    process.execPath,
    [
      ...(terminal === undefined ? [] : terminalPreload(project.root, terminal)),
      CLI_ENTRY,
      '--config',
      project.configPath,
      ...command,
    ],
    { cwd: project.root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, 60_000)
  try {
    const status = await new Promise<number | null>((settle, fail) => {
      child.once('error', fail)
      child.once('close', (code) => settle(code))
    })
    return { status, stdout, stderr }
  } finally {
    clearTimeout(budget)
  }
}

async function runMissingTest(colourEnv: ColourEnv, terminal?: Terminal): Promise<BinOutcome> {
  return await runBin(missingTestProject(), ['run', 'tests/missing.yaml'], colourEnv, terminal)
}

// The daemon command and its subcommands read the config before they start anything and print
// the failure on stderr.
async function runDaemonOnUnreadableConfig(
  subcommand: readonly string[],
  terminal: Terminal,
): Promise<BinOutcome> {
  const project = missingTestProject()
  writeFileSync(project.configPath, 'workspace: [\n', 'utf8')
  return await runBin(project, ['daemon', ...subcommand], {}, terminal)
}

const PARSE_ERROR_HEADING = 'Found 2 parse error(s):'

// A single-test run of a file that does not parse prints a heading and core's parse-error block
// on stderr. `block` is that output without its colour codes.
async function runMalformedTest(
  terminal: Terminal,
): Promise<{ outcome: BinOutcome; block: string }> {
  const project = missingTestProject()
  const file = join(project.root, 'tests', 'malformed.yaml')
  mkdirSync(join(project.root, 'tests'), { recursive: true })
  writeFileSync(file, 'name: Malformed\ntarget: shop\nsteps: "not an array"\n', 'utf8')
  const block = [
    PARSE_ERROR_HEADING,
    '',
    'error: test-id: Invalid input: expected string, received undefined',
    `  --> ${file}:1:1`,
    '    |',
    '  1 | name: Malformed',
    '    | ^',
    "    = help: check that 'test-id' has the correct type",
    '',
    'error: steps: Invalid input: expected array, received string',
    `  --> ${file}:3:8`,
    '    |',
    '  3 | steps: "not an array"',
    '    |        ^',
    "    = help: check that 'steps' has the correct type",
    '',
    '',
  ].join('\n')
  const outcome = await runBin(project, ['run', 'tests/malformed.yaml'], {}, terminal)
  return { outcome, block }
}

function withoutColourCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

// Lines the run and daemon commands colour themselves and print on stderr.
const COMMAND_ERROR_LINES: readonly {
  readonly name: string
  readonly line: string
  readonly run: (terminal: Terminal) => Promise<BinOutcome>
}[] = [
  {
    name: "a refused run's error line",
    line: MISSING_TEST_LINE,
    run: (terminal) => runMissingTest({}, terminal),
  },
  {
    name: "the run command's own usage error",
    line: 'Error: --test, --suite, and --all are mutually exclusive.',
    run: (terminal) => runBin(missingTestProject(), ['run', '--suite', '--all'], {}, terminal),
  },
  {
    name: "the daemon status command's error line",
    line: 'Daemon status error: ',
    run: (terminal) => runDaemonOnUnreadableConfig(['status'], terminal),
  },
]

describe('the shipped bin\'s colour posture', () => {
  it('the shipped bin under CI=true with stdout and stderr piped prints colour codes', async () => {
    const outcome = await runMissingTest({ CI: 'true' })
    expect(outcome.stderr, JSON.stringify(outcome)).toContain(MISSING_TEST_LINE)
    expect(outcome.status, JSON.stringify(outcome)).toBe(1)
    expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(true)
  }, 90_000)

  it('the shipped bin with a pipe and no CI prints no colour code', async () => {
    const outcome = await runMissingTest({})
    expect(outcome.stderr, JSON.stringify(outcome)).toContain(MISSING_TEST_LINE)
    expect(outcome.status, JSON.stringify(outcome)).toBe(1)
    expect(outcome.stdout.includes(COLOUR_CODE), JSON.stringify(outcome.stdout)).toBe(false)
    expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(false)
  }, 90_000)

  it('the shipped bin under CI=true with NO_COLOR=1 prints no colour code', async () => {
    const outcome = await runMissingTest({ CI: 'true', NO_COLOR: '1' })
    expect(outcome.stderr, JSON.stringify(outcome)).toContain(MISSING_TEST_LINE)
    expect(outcome.status, JSON.stringify(outcome)).toBe(1)
    expect(outcome.stdout.includes(COLOUR_CODE), JSON.stringify(outcome.stdout)).toBe(false)
    expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(false)
  }, 90_000)

  it('the shipped bin with a pipe, no CI and FORCE_COLOR=1 prints colour codes', async () => {
    const outcome = await runMissingTest({ FORCE_COLOR: '1' })
    expect(outcome.stderr, JSON.stringify(outcome)).toContain(MISSING_TEST_LINE)
    expect(outcome.status, JSON.stringify(outcome)).toBe(1)
    expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(true)
  }, 90_000)

  it('with stdout piped and stderr a terminal, a log line on stderr is coloured', async () => {
    const outcome = await runDaemonOnUnreadableConfig([], 'stderr')
    expect(outcome.status, JSON.stringify(outcome)).toBe(1)
    expect(outcome.stderr, JSON.stringify(outcome)).toContain(`${RED}Daemon error: `)
    expect(outcome.stdout.includes(COLOUR_CODE), JSON.stringify(outcome.stdout)).toBe(false)
  }, 90_000)

  it('with stdout a terminal and stderr piped, a log line on stderr has no colour', async () => {
    const outcome = await runDaemonOnUnreadableConfig([], 'stdout')
    expect(outcome.status, JSON.stringify(outcome)).toBe(1)
    expect(outcome.stderr, JSON.stringify(outcome)).toContain('Daemon error: ')
    expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(false)
  }, 90_000)

  it.each(COMMAND_ERROR_LINES)(
    'with stdout piped and stderr a terminal, $name is red',
    async ({ line, run }) => {
      const outcome = await run('stderr')
      expect(outcome.stderr, JSON.stringify(outcome)).toContain(`${RED}${line}`)
      expect(outcome.stdout.includes(COLOUR_CODE), JSON.stringify(outcome.stdout)).toBe(false)
    },
    90_000,
  )

  it.each(COMMAND_ERROR_LINES)(
    'with stdout a terminal and stderr piped, $name has no colour',
    async ({ line, run }) => {
      const outcome = await run('stdout')
      expect(outcome.stderr, JSON.stringify(outcome)).toContain(line)
      expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(false)
    },
    90_000,
  )

  it(
    'with stdout piped and stderr a terminal, the parse errors of a single-test run are coloured',
    async () => {
      const { outcome, block } = await runMalformedTest('stderr')
      expect(outcome.status, JSON.stringify(outcome)).toBe(2)
      expect(outcome.stderr, JSON.stringify(outcome)).toContain(`${RED}${PARSE_ERROR_HEADING}`)
      expect(outcome.stderr, JSON.stringify(outcome)).toContain(
        `${BOLD_RED}error${BOLD_END}: steps: `,
      )
      expect(outcome.stderr, JSON.stringify(outcome)).toContain(`${BOLD_BLUE}-->${BOLD_END} `)
      expect(outcome.stderr, JSON.stringify(outcome)).toContain(`${BOLD_RED}^${BOLD_END}`)
      expect(withoutColourCodes(outcome.stderr), JSON.stringify(outcome)).toContain(block)
      expect(outcome.stdout.includes(COLOUR_CODE), JSON.stringify(outcome.stdout)).toBe(false)
    },
    90_000,
  )

  it(
    'with stdout a terminal and stderr piped, the parse errors of a single-test run have no colour',
    async () => {
      const { outcome, block } = await runMalformedTest('stdout')
      expect(outcome.status, JSON.stringify(outcome)).toBe(2)
      expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(false)
      expect(outcome.stderr, JSON.stringify(outcome)).toContain(block)
    },
    90_000,
  )
})
