// C432-CLI-ONE-CALL: every CLI door completes an explicit call in ONE call (Phase 432 plan 13).
//
// D-01/D-14: nothing asks y/n. `agent-qa runs mark`, `agent-qa fn`, `agent-qa ask` and the
// `agent-qa chat` REPL run what they were told, in CI with a non-TTY stdin and at a terminal alike,
// and print what they did. D-04/D-05: a mark lands its fix and a config change is written in that
// same call, with no follow-up command.
//
// THE INSTRUMENT IS STDIN ITSELF. Every cell replaces `process.stdin` with a stream whose listener,
// resume and read members record the attempt and throw, so an approval prompt anywhere on the path
// fails the cell by name instead of answering itself. Chat keeps reading its own typed lines from
// the stream the REPL was handed; only a decision prompt would be a second reader.
//
// Every fixture lives in a temporary directory: the mark fixture, the in-process run fixture and
// the config file each cell writes to.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { RunsMarkOutcomeSchema } from '@vostride/agent-qa-schema'
import type { RunStartAcknowledgement } from '@vostride/agent-qa-schema'

import { createAskCommand } from '../commands/ask.js'
import { createChatCommand } from '../commands/chat.js'
import { createFnCommand } from '../commands/fn.js'
import { createRunsCommand } from '../commands/runs.js'
import { markFixture } from '../gates/__tests__/feedback-fixture.js'
import {
  CountingTarget,
  buildOrdinalsExist,
  createInProcessFixture,
  eventTypes,
  removeInProcessFixtures,
} from '../composition/__tests__/in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

type DoorMode = 'ci' | 'tty'

/** The prompt wording a retired approval would print. None of it may reach a person. */
const APPROVAL_PROMPT = /\[y\/N\]|\[y\/a\/N\]|needs your approval|Proceed\?/

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterAll(() => { removeInProcessFixtures() })

/**
 * Run `body` at a door: CI with non-TTY streams, or a terminal with no CI marker.
 *
 * `process.stdin` is replaced for the whole call. Its reading members record and throw, so the
 * returned `stdinReads` is empty exactly when nothing on the path tried to read an answer.
 */
async function atDoor<T>(
  mode: DoorMode,
  body: () => Promise<T>,
): Promise<{ value: T; stdinReads: string[] }> {
  const stdinReads: string[] = []
  const forbidden = new Readable({ read() {} }) as Readable & { isTTY?: boolean }
  forbidden.isTTY = mode === 'tty'
  const refuse = (member: string) => (...args: unknown[]): never => {
    stdinReads.push(`${member}(${typeof args[0] === 'string' ? args[0] : ''})`)
    throw new Error(`432-13: an approval read reached stdin through ${member}`)
  }
  for (const member of [
    'on', 'once', 'addListener', 'prependListener', 'prependOnceListener', 'resume', 'read', 'setRawMode',
  ]) {
    Object.defineProperty(forbidden, member, { value: refuse(member), configurable: true })
  }

  const savedEnv = { CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS }
  if (mode === 'ci') process.env.CI = 'true'
  else delete process.env.CI
  delete process.env.GITHUB_ACTIONS

  const realStdin = process.stdin
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process, 'stdin', { value: forbidden, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', {
    value: mode === 'tty',
    configurable: true,
    writable: true,
  })
  try {
    return { value: await body(), stdinReads }
  } finally {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
    if (stdoutTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
    else Object.defineProperty(process.stdout, 'isTTY', stdoutTty)
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

interface Printed {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | string | undefined
}

/** The shipped command factories under one Commander program, as `agent-qa` registers them. */
async function agentQa(configPath: string, args: readonly string[]): Promise<Printed> {
  const stdout: string[] = []
  const stderr: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  process.exitCode = undefined
  const runs = createRunsCommand().exitOverride().configureOutput({ writeErr: () => {} })
  for (const sub of runs.commands) sub.exitOverride().configureOutput({ writeErr: () => {} })
  const program = new Command()
    .exitOverride()
    .option('--config <path>', 'config file path')
    .addCommand(createFnCommand())
    .addCommand(createAskCommand())
    .addCommand(runs)
  await program.parseAsync(['node', 'agent-qa', '--config', configPath, ...args])
  const printed = { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: process.exitCode }
  vi.mocked(console.log).mockRestore()
  vi.mocked(console.error).mockRestore()
  return printed
}

/** The mark fixture, registered for cleanup. */
function markProject(): ReturnType<typeof markFixture> {
  const fixture = markFixture()
  roots.push(fixture.root)
  // 2026-10-14 (441-06, E3): ask and chat refuse a project whose secrets file is missing.
  writeFileSync(join(fixture.root, '.env.secrets.local'), '', 'utf8')
  return fixture
}

function markLines(runDir: string): string[] {
  const path = join(runDir, 'marks.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []
}

describe('C432-CLI-ONE-CALL — runs mark applies its fix in the one call (432-13)', () => {
  it.each(['ci', 'tty'] as const)(
    'C432-CLI-ONE-CALL: runs mark (%s) applies the knowledge fix once, renders the receipt and reads no stdin',
    async (mode) => {
      const fixture = markProject()

      const { value: printed, stdinReads } = await atDoor(mode, () => agentQa(fixture.configPath, [
        'runs', 'mark', fixture.handoff.runId, '--kind', 'false-fail', '--json',
      ]))

      expect(stdinReads).toEqual([])
      expect(printed.stderr).toBe('')
      expect(printed.exitCode).toBeUndefined()
      const outcome = RunsMarkOutcomeSchema.parse(JSON.parse(printed.stdout))
      expect(outcome).toMatchObject({
        kind: 'marked',
        receipt: { ordinal: 1, disposition: { kind: 'applied', fix: 'fact', change: { kind: 'knowledge' } } },
      })
      if (outcome.kind !== 'marked' || outcome.receipt.disposition.kind !== 'applied') {
        throw new Error('unreachable')
      }
      const change = outcome.receipt.disposition.change
      expect(change.kind === 'knowledge' && change.recordIds.length).toBeGreaterThan(0)
      expect(markLines(fixture.runDir)).toHaveLength(1)
      expect(printed.stdout).not.toMatch(APPROVAL_PROMPT)
    },
  )

  it('C432-CLI-ONE-CALL: the human render names what the mark changed, with no follow-up command', async () => {
    const fixture = markProject()

    const { value: printed, stdinReads } = await atDoor('ci', () => agentQa(fixture.configPath, [
      'runs', 'mark', fixture.handoff.runId, '--kind', 'false-fail',
    ]))

    expect(stdinReads).toEqual([])
    expect(printed.stdout).toMatch(/^marked false-fail on .* · applied fact: changed \S+ · receipt mark_/)
    // The run id is minted from a word list, so it can spell `accept` by chance (432-17 gate run 4
    // drew `r_usage-heat-accept-…`). The follow-up check reads the render with the id taken out.
    expect(printed.stdout.split(fixture.handoff.runId).join('<run>'))
      .not.toMatch(/proposal|accept|apply it|--yes/i)
  })
})

describe('C432-CLI-ONE-CALL — fn completes a direct call in one call (432-13)', () => {
  it.each(['ci', 'tty'] as const)(
    'C432-CLI-ONE-CALL: fn runs.start (%s) starts a non-production run once and acknowledges it',
    async (mode) => {
      const target = new CountingTarget()
      await target.listen()
      // 2026-10-03 (quick-261003-tsr, IN-15): the pin is put back when the cell ends, so later
      // cells in this worker do not inherit a path afterEach has deleted.
      const savedBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH
      try {
        const fixture = createInProcessFixture({ origin: target.origin })
        roots.push(fixture.project)
        const browsers = join(fixture.project, 'no-browsers')
        mkdirSync(browsers, { recursive: true })
        process.env.PLAYWRIGHT_BROWSERS_PATH = browsers

        const { value: printed, stdinReads } = await atDoor(mode, () => agentQa(fixture.configPath, [
          'fn', 'runs.start', '--input', JSON.stringify({ patterns: [fixture.testPattern] }), '--json',
        ]))

        expect(stdinReads).toEqual([])
        expect(printed.exitCode).toBeUndefined()
        const ack = JSON.parse(printed.stdout) as RunStartAcknowledgement
        expect(ack.testCount).toBe(1)
        expect(eventTypes(fixture as never)[0]).toBe('runStarted')
        expect(buildOrdinalsExist(fixture as never)).toBe(true)
        expect(target.hits).toEqual(['/in-process-thing'])
        expect(printed.stderr).not.toMatch(/Denied|fail-closed/)
      } finally {
        if (savedBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
        else process.env.PLAYWRIGHT_BROWSERS_PATH = savedBrowsers
        await target.close()
      }
    },
    120_000,
  )

  it('C432-CLI-ONE-CALL: fn config.field.set (ci) writes the change in the call and answers applied', async () => {
    const fixture = markProject()

    const { value: printed, stdinReads } = await atDoor('ci', () => agentQa(fixture.configPath, [
      'fn', 'config.field.set', '--input', JSON.stringify({ path: 'use.workers', value: 2 }), '--json',
    ]))

    expect(stdinReads).toEqual([])
    expect(printed.exitCode).toBeUndefined()
    expect(JSON.parse(printed.stdout)).toMatchObject({ outcome: 'applied', fields: ['use.workers'] })
    expect(readFileSync(fixture.configPath, 'utf8')).toContain('workers: 2')
  })
})

describe('C432-CLI-ONE-CALL — ask and chat carry a mark out in the turn (432-13)', () => {
  it('C432-CLI-ONE-CALL: ask (ci) executes a /fn runs.mark clause once, with no approval', async () => {
    const fixture = markProject()
    const clause = `/fn runs.mark ${JSON.stringify({ runId: fixture.handoff.runId, kind: 'false-fail' })}`

    const { value: printed, stdinReads } = await atDoor('ci', () => agentQa(fixture.configPath, [
      'ask', clause,
    ]))

    expect(stdinReads).toEqual([])
    expect(printed.stderr).toBe('')
    expect(printed.exitCode).toBeUndefined()
    expect(printed.stdout).toContain('runs.mark')
    expect(printed.stdout).toContain('executed')
    expect(printed.stdout).not.toMatch(APPROVAL_PROMPT)
    expect(markLines(fixture.runDir)).toHaveLength(1)
  })

  it('C432-CLI-ONE-CALL: chat at a terminal executes a typed mark once and prints no decision prompt', async () => {
    const fixture = markProject()
    const clause = `/fn runs.mark ${JSON.stringify({ runId: fixture.handoff.runId, kind: 'false-fail' })}`
    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk: Buffer | string) => { written += String(chunk) })

    const { value: printed, stdinReads } = await atDoor('tty', async () => {
      const stdout: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
        stdout.push(values.map(String).join(' '))
      })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const program = new Command()
        .exitOverride()
        .option('--config <path>', 'config file path')
        .addCommand(createChatCommand({
          input,
          output,
          chatCapabilities: async () => undefined,
        }))
      const parsed = program.parseAsync(['node', 'agent-qa', '--config', fixture.configPath, 'chat'])
      await Promise.resolve()
      input.write(`${clause}\n`)
      input.write('/quit\n')
      input.end()
      // A REPL that waited on a decision would never settle; that is an answer, not a timeout.
      let waiting: ReturnType<typeof setTimeout> | undefined
      const settled = await Promise.race([
        parsed.then(() => 'settled' as const),
        new Promise<'waiting'>((resolve) => { waiting = setTimeout(() => resolve('waiting'), 15_000) }),
      ]).finally(() => { clearTimeout(waiting) })
      return { settled, stdout: stdout.join('\n') }
    })

    expect(printed.settled).toBe('settled')
    expect(stdinReads).toEqual([])
    expect(`${printed.stdout}\n${written}`).not.toMatch(APPROVAL_PROMPT)
    expect(printed.stdout).toContain('runs.mark')
    expect(printed.stdout).toContain('executed')
    expect(markLines(fixture.runDir)).toHaveLength(1)
  }, 30_000)
})
