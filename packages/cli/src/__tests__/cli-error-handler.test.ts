import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { reserveStdoutForData, type RunTextEnv } from '@vostride/agent-qa-core/run-text-output'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createGlobalFailureHandler,
  defaultCliFailureDeps,
  installGlobalFailureHandlers,
  runCli,
  type CliFailureDeps,
} from '../cli-error-handler.js'
import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'
import { closeErrorReporting, startErrorReporting } from '../composition/error-reporting.js'
import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from './error-report-recorder.js'
import type { RecordedEnvelope, RecordingReportTransport } from './error-report-recorder.js'

const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
const FRAME = /^\s+at /m
const SECRET = 'Hunter-42-zz'
const INVENTED_DSN = 'http://key@127.0.0.1:9/1'

const folders: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await closeErrorReporting()
  removeReportProjects()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

interface Recorded {
  readonly events: string[]
  readonly printed: string[]
  readonly fixed: string[]
  readonly captured: unknown[]
  readonly deps: CliFailureDeps
}

function recorded(env: RunTextEnv = {}): Recorded {
  const events: string[] = []
  const printed: string[] = []
  const fixed: string[] = []
  const captured: unknown[] = []
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
    capture: (error) => {
      events.push('capture')
      captured.push(error)
    },
    settle: async () => {
      events.push('settle')
    },
    flush: async () => {
      events.push('flush')
    },
    exit: (code) => {
      events.push(`exit ${code}`)
    },
    env,
  }
  return { events, printed, fixed, captured, deps }
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
    expect(withLines.events).toEqual(['code 2', 'capture', 'settle', 'flush', 'exit 2'])

    const silent = recorded()
    await drive(
      programThrowing(() => new CliRefusal([], 2)),
      silent.deps,
    )
    expect(silent.printed).toEqual([])
    expect(silent.events).toEqual(['code 2', 'capture', 'settle', 'flush', 'exit 2'])

    const zero = recorded()
    await drive(
      programThrowing(() => new CliRefusal(['Refused.'], 0)),
      zero.deps,
    )
    expect(zero.events).toEqual(['code 1', 'capture', 'settle', 'flush', 'exit 1'])
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
    expect(bug.events).toEqual(['code 1', 'capture', 'settle', 'flush', 'exit 1'])

    const text = recorded()
    await drive(
      programThrowing(() => 'plain words'),
      text.deps,
    )
    expect(text.printed).toEqual(['Unexpected error: plain words'])
    expect(text.events).toEqual(['code 1', 'capture', 'settle', 'flush', 'exit 1'])
  })

  it('a cancelled prompt prints Cancelled., is not captured, and exits 130', async () => {
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
      expect(outcome.events).toEqual(['code 130', 'settle', 'flush', 'exit 130'])
      expect(outcome.captured).toEqual([])
    }
  })

  it('a refusal that exits 130 prints its lines and is not captured', async () => {
    const outcome = recorded()
    await drive(
      programThrowing(() => new CliRefusal(['Stopped by a signal.'], 130)),
      outcome.deps,
    )
    expect(outcome.printed).toEqual(['Stopped by a signal.'])
    expect(outcome.events).toEqual(['code 130', 'settle', 'flush', 'exit 130'])
    expect(outcome.captured).toEqual([])
  })

  it('the exit code is set first, then the thrown error itself is captured and settled, and the exit follows the flush', async () => {
    for (const [thrown, code] of [
      [new CliRefusal(['Refused.'], 3), 3],
      [new TypeError('a bug'), 1],
    ] as const) {
      const failing = recorded()
      await drive(
        programThrowing(() => thrown),
        failing.deps,
      )
      expect(failing.events).toEqual([`code ${code}`, 'capture', 'settle', 'flush', `exit ${code}`])
      expect(failing.captured).toHaveLength(1)
      expect(failing.captured[0]).toBe(thrown)
    }
  })

  it('a command that resolves settles once and is neither flushed nor exited', async () => {
    const passing = recorded()
    await drive(
      programThrowing(() => new Error('unused')),
      passing.deps,
      ['fine'],
    )
    expect(passing.events).toEqual(['settle'])
    expect(passing.printed).toEqual([])
    expect(passing.fixed).toEqual([])
    expect(passing.captured).toEqual([])
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

function failureListeners() {
  return {
    uncaughtException: process.listeners('uncaughtException'),
    unhandledRejection: process.listeners('unhandledRejection'),
  }
}

function addedTo<T>(before: readonly T[], after: readonly T[]): T[] {
  return after.filter((listener) => !before.includes(listener))
}

// No cell emits either event on the worker's own process: each calls the handler, or a listener
// the installer added, with recorded deps.
describe("agent-qa's own global failure handlers", () => {
  it('print an error as one masked Unexpected error block with its stack frames, then set 1, capture, settle, flush and exit 1', async () => {
    const configPath = projectWithSecret()
    const program = programThrowing(() => new Error('unused'))
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'fine'])
    const outcome = recorded()
    const { mask: _unused, ...recorders } = outcome.deps
    const error = new Error(`Login failed for ${SECRET}.`)

    await createGlobalFailureHandler({ ...defaultCliFailureDeps(program), ...recorders })(error)

    expect(outcome.printed).toHaveLength(1)
    const [first, ...frames] = outcome.printed[0]!.split('\n')
    expect(first).toBe('Unexpected error: Login failed for [secret:ACCOUNT_PASSWORD].')
    expect(frames.length).toBeGreaterThan(0)
    for (const line of frames) expect(line).toMatch(FRAME)
    expect(outcome.printed[0]).not.toContain(SECRET)
    expect(outcome.events).toEqual(['code 1', 'capture', 'settle', 'flush', 'exit 1'])
    expect(outcome.captured).toHaveLength(1)
    expect(outcome.captured[0]).toBe(error)
  })

  it('print a rejection reason that is not an Error as text and take the same path', async () => {
    const outcome = recorded()

    await createGlobalFailureHandler(outcome.deps)('plain words')

    expect(outcome.printed).toEqual(['Unexpected error: plain words'])
    expect(outcome.events).toEqual(['code 1', 'capture', 'settle', 'flush', 'exit 1'])
    expect(outcome.captured).toEqual(['plain words'])
  })

  it('print a prompt cancel and exit 1 without capturing it', async () => {
    for (const cancel of [
      Object.assign(new Error('User force closed the prompt with SIGINT'), {
        name: 'ExitPromptError',
      }),
      new PromptCancelled(),
    ]) {
      const outcome = recorded()

      await createGlobalFailureHandler(outcome.deps)(cancel)

      expect(outcome.printed).toHaveLength(1)
      expect(outcome.printed[0]?.split('\n')[0]).toBe(`Unexpected error: ${cancel.message}`)
      expect(outcome.events).toEqual(['code 1', 'settle', 'flush', 'exit 1'])
      expect(outcome.captured).toEqual([])
    }
  })

  it('exit 1 at once, settling nothing, for a second error while the first is still settling', async () => {
    const outcome = recorded()
    let finishSettling = () => {}
    const settling = new Promise<void>((resolve) => {
      finishSettling = resolve
    })
    const handle = createGlobalFailureHandler({
      ...outcome.deps,
      settle: async () => {
        outcome.events.push('settle')
        await settling
      },
    })

    const first = handle(new Error('the first error'))
    await handle(new Error('the second error'))
    const atSecond = [...outcome.events]
    finishSettling()
    await first

    expect(atSecond).toEqual(['code 1', 'capture', 'settle', 'exit 1'])
    expect(outcome.events).toEqual(['code 1', 'capture', 'settle', 'exit 1', 'flush', 'exit 1'])
    expect(outcome.printed).toHaveLength(1)
    expect(outcome.captured).toHaveLength(1)
  })

  it('still exit 1 when a step throws, and never reject', async () => {
    const outcome = recorded()
    const handle = createGlobalFailureHandler({
      ...outcome.deps,
      settle: async () => {
        outcome.events.push('settle')
        throw new Error('the settle failed')
      },
    })

    await expect(handle(new Error('a bug'))).resolves.toBeUndefined()

    expect(outcome.events).toEqual(['code 1', 'capture', 'settle', 'exit 1'])
  })

  it('are installed as one listener for each event, both running the one handler, and removed together', async () => {
    const before = failureListeners()
    const outcome = recorded()

    const uninstall = installGlobalFailureHandlers(outcome.deps)
    const during = failureListeners()
    uninstall()
    const after = failureListeners()

    const onRejection = addedTo(before.unhandledRejection, during.unhandledRejection)
    const onException = addedTo(before.uncaughtException, during.uncaughtException)
    expect(onRejection).toHaveLength(1)
    expect(onException).toHaveLength(1)
    expect(after).toEqual(before)

    onRejection[0]?.('a rejection nobody handled', Promise.resolve())
    await vi.waitFor(() => expect(outcome.events).toContain('exit 1'))
    onException[0]?.(new Error('an error nobody caught'), 'uncaughtException')

    expect(outcome.printed).toEqual(['Unexpected error: a rejection nobody handled'])
    expect(outcome.events).toEqual(['code 1', 'capture', 'settle', 'flush', 'exit 1', 'exit 1'])
  })
})

interface ReportedEvent {
  readonly exception?: {
    readonly values?: ReadonlyArray<{
      readonly value?: string
      readonly stacktrace?: { readonly frames?: readonly unknown[] }
    }>
  }
}

// Read back from the JSON text, as an envelope leaves the process. The thrown error is the last
// exception value, after any cause.
function reportedErrors(
  envelopes: readonly RecordedEnvelope[],
): Array<{ readonly message: string; readonly frames: number }> {
  const parsed = JSON.parse(serializedEnvelopes(envelopes)) as Array<
    [unknown, Array<[{ readonly type?: string }, ReportedEvent]>]
  >
  return parsed
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === 'event')
    .map(([, event]) => event.exception?.values?.at(-1))
    .map((thrown) => ({
      message: thrown?.value ?? '',
      frames: thrown?.stacktrace?.frames?.length ?? 0,
    }))
}

describe('reporting from the CLI failure handler', () => {
  // No cell reads the auth store in the real home folder.
  beforeEach(() => {
    const dataHome = mkdtempSync(join(tmpdir(), 'agent-qa-cli-error-handler-'))
    folders.push(dataHome)
    vi.stubEnv('XDG_DATA_HOME', dataHome)
  })

  // The handler's own capture and settle, with only the printer and the process effects recorded.
  async function runFailing(
    thrown: () => unknown,
    options: { readonly recorder: RecordingReportTransport; readonly reporting: boolean },
  ) {
    const { configPath } = projectWithPrivacy()
    if (options.reporting) {
      await startErrorReporting({
        configPath,
        dsn: INVENTED_DSN,
        transport: options.recorder.transport,
      })
    }
    const program = programThrowing(thrown)
    const outcome = recorded()
    const { print, setExitCode, flush, exit } = outcome.deps
    const before = options.recorder.envelopes.length
    await drive(program, { ...defaultCliFailureDeps(program), print, setExitCode, flush, exit }, [
      '--config',
      configPath,
      'boom',
    ])
    await closeErrorReporting()
    return { ...outcome, envelopes: options.recorder.envelopes.slice(before) }
  }

  it('sends a refusal thrown by a command with its message and stack when a reporter is started, and exits 2 with and without one', async () => {
    const recorder = recordingReportTransport()

    const off = await runFailing(() => new CliRefusal(['nope'], 2), { recorder, reporting: false })
    const on = await runFailing(() => new CliRefusal(['nope'], 2), { recorder, reporting: true })

    const reported = reportedErrors(on.envelopes)
    expect(reported.map((error) => error.message)).toEqual(['nope'])
    expect(reported[0]?.frames ?? 0).toBeGreaterThan(0)
    expect(off.envelopes).toEqual([])
    for (const arm of [off, on]) {
      expect(arm.events).toEqual(['code 2', 'flush', 'exit 2'])
      expect(arm.printed).toEqual(['nope'])
      expect(arm.fixed).toEqual([])
    }
  })

  it('prints the same lines for a refusal and for a bug with a reporter started as with none, and writes nothing else', async () => {
    const recorder = recordingReportTransport()
    const refusal = new CliRefusal(['nope'], 2)
    const bug = new Error('a bug')
    const linesByArm: string[][] = []
    const output = captured()
    try {
      for (const reporting of [false, true]) {
        const lines: string[] = []
        for (const thrown of [refusal, bug]) {
          const outcome = await runFailing(() => thrown, { recorder, reporting })
          lines.push(...outcome.printed, ...outcome.fixed)
        }
        linesByArm.push(lines)
      }
    } finally {
      vi.restoreAllMocks()
    }

    expect(reportedErrors(recorder.envelopes).map((error) => error.message)).toEqual([
      'nope',
      'a bug',
    ])
    const [off, on] = linesByArm
    expect(on).toEqual(off)
    const [refused, failed] = off ?? []
    expect(refused).toBe('nope')
    const [first, ...frames] = (failed ?? '').split('\n')
    expect(first).toBe('Unexpected error: a bug')
    expect(frames.length).toBeGreaterThan(0)
    for (const line of frames) expect(line).toMatch(FRAME)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual([])
  })
})
