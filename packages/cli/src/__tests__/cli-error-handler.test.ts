import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { reserveStdoutForData, type RunTextEnv } from '@vostride/agent-qa-core/run-text-output'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultCliFailureDeps, runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'

const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
const FRAME = /^\s+at /m
const SECRET = 'Hunter-42-zz'

const folders: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

interface Recorded {
  readonly events: string[]
  readonly printed: string[]
  readonly fixed: string[]
  readonly deps: CliFailureDeps
}

function recorded(env: RunTextEnv = {}): Recorded {
  const events: string[] = []
  const printed: string[] = []
  const fixed: string[] = []
  const deps: CliFailureDeps = {
    print: (text) => {
      printed.push(text)
    },
    printFixed: (line) => {
      fixed.push(line)
    },
    mask: (text) => text,
    setExitCode: (code) => {
      events.push(`code ${code}`)
    },
    flush: async () => {
      events.push('flush')
    },
    exit: (code) => {
      events.push(`exit ${code}`)
    },
    env,
  }
  return { events, printed, fixed, deps }
}

function programThrowing(thrown: () => unknown): Command {
  const program = new Command('agent-qa')
    .exitOverride()
    .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.command('boom').action(async () => {
    throw thrown()
  })
  program.command('fine').action(async () => {})
  return program
}

async function drive(
  program: Command,
  deps: CliFailureDeps,
  args: readonly string[] = ['boom'],
): Promise<void> {
  await runCli(program, ['node', 'agent-qa', ...args], deps)
}

function captured(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  return { stdout, stderr }
}

function projectWithSecret(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-cli-error-handler-'))
  folders.push(root)
  writeFileSync(
    join(root, 'agent-qa.config.yaml'),
    [
      'workspace:',
      "  testMatch: ['tests/**/*.yaml']",
      "  suiteMatch: ['suites/**/*.suite.yaml']",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      '',
    ].join('\n'),
  )
  writeFileSync(join(root, '.env.secrets.local'), `ACCOUNT_PASSWORD=${SECRET}\n`)
  return join(root, 'agent-qa.config.yaml')
}

describe('the CLI failure handler', () => {
  it('a refusal prints its lines with no stack frame and exits with its own code, never 0', async () => {
    const withLines = recorded()
    await drive(
      programThrowing(
        () => new CliRefusal(['\u001B[31mNo tests matched.\u001B[39m', 'Add one.'], 2),
      ),
      withLines.deps,
    )
    expect(withLines.printed).toEqual(['\u001B[31mNo tests matched.\u001B[39m\nAdd one.'])
    expect(withLines.printed.join('\n')).not.toMatch(FRAME)
    expect(withLines.events).toEqual(['code 2', 'flush', 'exit 2'])

    const silent = recorded()
    await drive(
      programThrowing(() => new CliRefusal([], 2)),
      silent.deps,
    )
    expect(silent.printed).toEqual([])
    expect(silent.events).toEqual(['code 2', 'flush', 'exit 2'])

    const zero = recorded()
    await drive(
      programThrowing(() => new CliRefusal(['Refused.'], 0)),
      zero.deps,
    )
    expect(zero.events).toEqual(['code 1', 'flush', 'exit 1'])
  })

  it('a bug prints Unexpected error with its stack frames and exits 1, and a thrown value prints as text', async () => {
    const bug = recorded()
    await drive(
      programThrowing(() => new TypeError("Cannot read properties of undefined (reading 'x')")),
      bug.deps,
    )
    expect(bug.printed).toHaveLength(1)
    const [first, ...rest] = bug.printed[0]!.split('\n')
    expect(first).toBe("Unexpected error: Cannot read properties of undefined (reading 'x')")
    expect(rest.length).toBeGreaterThan(0)
    for (const line of rest) expect(line).toMatch(FRAME)
    expect(bug.events).toEqual(['code 1', 'flush', 'exit 1'])

    const text = recorded()
    await drive(
      programThrowing(() => 'plain words'),
      text.deps,
    )
    expect(text.printed).toEqual(['Unexpected error: plain words'])
    expect(text.events).toEqual(['code 1', 'flush', 'exit 1'])
  })

  it('a cancelled prompt prints Cancelled. and exits 130', async () => {
    for (const cancel of [
      () =>
        Object.assign(new Error('User force closed the prompt with SIGINT'), {
          name: 'ExitPromptError',
        }),
      () => new PromptCancelled(),
    ]) {
      const outcome = recorded()
      await drive(programThrowing(cancel), outcome.deps)
      expect(outcome.fixed).toEqual(['Cancelled.'])
      expect(outcome.printed).toEqual([])
      expect(outcome.events).toEqual(['code 130', 'flush', 'exit 130'])
    }
  })

  it('the exit code is set before the flush and the exit follows it, and a command that resolves reaches none of them', async () => {
    const failing = recorded()
    await drive(
      programThrowing(() => new CliRefusal(['Refused.'], 3)),
      failing.deps,
    )
    expect(failing.events).toEqual(['code 3', 'flush', 'exit 3'])

    const passing = recorded()
    await drive(
      programThrowing(() => new Error('unused')),
      passing.deps,
      ['fine'],
    )
    expect(passing.events).toEqual([])
    expect(passing.printed).toEqual([])
    expect(passing.fixed).toEqual([])
  })

  it('under GitHub Actions a block gets one stop-commands pair on stdout, on stderr when stdout is reserved, and prints unchanged without it', async () => {
    const quoted = new CliRefusal(['The page said ::set-output name=x::y'], 2)

    const actions = recorded({ GITHUB_ACTIONS: 'true' })
    let output = captured()
    try {
      await drive(
        programThrowing(() => quoted),
        actions.deps,
      )
    } finally {
      vi.restoreAllMocks()
    }
    expect(output.stdout).toHaveLength(1)
    expect(output.stdout[0]).toMatch(PAIR)
    expect(output.stdout[0]).toContain('::set-output name=x::y')
    expect(output.stderr).toEqual([])
    expect(actions.printed).toEqual([])

    const reserved = recorded({ GITHUB_ACTIONS: 'true' })
    const release = reserveStdoutForData()
    output = captured()
    try {
      await drive(
        programThrowing(() => quoted),
        reserved.deps,
      )
    } finally {
      vi.restoreAllMocks()
      release()
    }
    expect(output.stdout).toEqual([])
    expect(output.stderr).toHaveLength(1)
    expect(output.stderr[0]).toMatch(PAIR)

    const local = recorded({})
    await drive(
      programThrowing(() => quoted),
      local.deps,
    )
    expect(local.printed).toEqual(['The page said ::set-output name=x::y'])
  })

  it('a refusal or a bug quoting a declared secret prints it masked, and with no config the text prints unmasked', async () => {
    const configPath = projectWithSecret()
    for (const thrown of [
      () => new CliRefusal([`Login failed for ${SECRET}.`], 2),
      () => new Error(`Login failed for ${SECRET}.`),
    ]) {
      const program = programThrowing(thrown)
      const outcome = recorded()
      const { mask: _unused, ...recorders } = outcome.deps
      await drive(program, { ...defaultCliFailureDeps(program), ...recorders }, [
        '--config',
        configPath,
        'boom',
      ])
      expect(outcome.printed).toHaveLength(1)
      expect(outcome.printed[0]).toContain('[secret:ACCOUNT_PASSWORD]')
      expect(outcome.printed[0]).not.toContain(SECRET)
    }

    const missing = join(mkdtempSync(join(tmpdir(), 'agent-qa-cli-error-handler-')), 'absent.yaml')
    folders.push(join(missing, '..'))
    const program = programThrowing(() => new CliRefusal([`Login failed for ${SECRET}.`], 2))
    const outcome = recorded()
    const { mask: _unused, ...recorders } = outcome.deps
    await drive(program, { ...defaultCliFailureDeps(program), ...recorders }, [
      '--config',
      missing,
      'boom',
    ])
    expect(outcome.printed).toEqual([`Login failed for ${SECRET}.`])
  })
})
