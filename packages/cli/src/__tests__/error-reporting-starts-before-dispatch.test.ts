// Reporting is decided and started in the root preAction hook, before the action runs, from the
// root --config. Help, version, a parse error and a group with no action never reach the hook.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AGENT_QA_SENTRY_DSN } from '@vostride/agent-qa-analytics'
import { Command, CommanderError } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultCliFailureDeps, runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { CliRefusal } from '../composition/cli-refusal.js'
import { startCliErrorReporting } from '../composition/error-reporting-start.js'
import {
  closeErrorReporting,
  errorReporter,
  startErrorReporting,
  type StartErrorReportingInput,
} from '../composition/error-reporting.js'
import { createAgentQaProgram, type StartReporting } from '../program.js'
import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from './error-report-recorder.js'
import type { RecordedEnvelope, RecordingReportTransport } from './error-report-recorder.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'

const folders: string[] = []

// No cell reads the auth store in the real home folder.
beforeEach(() => {
  const dataHome = mkdtempSync(join(tmpdir(), 'agent-qa-reporting-start-'))
  folders.push(dataHome)
  vi.stubEnv('XDG_DATA_HOME', dataHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await closeErrorReporting()
  removeReportProjects()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  process.exitCode = undefined
})

interface ProbeOptions {
  readonly startReporting?: StartReporting
  readonly action?: () => Promise<void>
}

interface ProbeProgram {
  readonly program: Command
  readonly probe: Command
  readonly written: string[]
}

// The real command tree, with one command that only runs its action and a group with no action
// of its own. Commander's own exits throw, and what it writes is kept.
function programWith(options: ProbeOptions = {}): ProbeProgram {
  const written: string[] = []
  const keep = (text: string) => {
    written.push(text)
  }
  const program = createAgentQaProgram(
    options.startReporting === undefined ? {} : { startReporting: options.startReporting },
  )
    .exitOverride()
    .configureOutput({ writeOut: keep, writeErr: keep })
  const probe = program.command('probe').action(options.action ?? (async () => {}))
  program.command('group').command('leaf').action(async () => {})
  return { program, probe, written }
}

interface Recorded {
  readonly events: string[]
  readonly printed: string[]
  readonly deps: CliFailureDeps
}

function recorded(): Recorded {
  const events: string[] = []
  const printed: string[] = []
  const deps: CliFailureDeps = {
    print: (text) => {
      printed.push(text)
    },
    printFixed: (line) => {
      printed.push(line)
    },
    mask: (text) => text,
    setExitCode: (code) => {
      events.push(`code ${code}`)
    },
    capture: () => {
      events.push('capture')
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
    env: {},
  }
  return { events, printed, deps }
}

// The real starter, whose start hands the reporter an invented DSN and the recording transport,
// since a source checkout bakes no DSN.
function reportingThrough(recorder: RecordingReportTransport): StartReporting {
  return (program, action) =>
    startCliErrorReporting(program, action, {
      start: (input) =>
        startErrorReporting({ ...input, dsn: INVENTED_DSN, transport: recorder.transport }),
    })
}

interface ReportedEvent {
  readonly exception?: { readonly values?: ReadonlyArray<{ readonly value?: string }> }
}

// Read back from the JSON text, as an envelope leaves the process. The thrown error is the last
// exception value, after any cause.
function reportedMessages(envelopes: readonly RecordedEnvelope[]): string[] {
  const parsed = JSON.parse(serializedEnvelopes(envelopes)) as Array<
    [unknown, Array<[{ readonly type?: string }, ReportedEvent]>]
  >
  return parsed
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === 'event')
    .map(([, event]) => event.exception?.values?.at(-1)?.value ?? '')
}

describe('the root preAction hook', () => {
  it('awaits the starter before the action runs, with the root program and the action command', async () => {
    const steps: string[] = []
    const seen: Array<readonly [Command, Command]> = []
    const { program, probe } = programWith({
      startReporting: async (root, action) => {
        seen.push([root, action])
        await new Promise((resolve) => setTimeout(resolve, 20))
        steps.push('started')
      },
      action: async () => {
        steps.push('action')
      },
    })

    await program.parseAsync(['node', 'agent-qa', 'probe'])

    expect(steps).toEqual(['started', 'action'])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.[0]).toBe(program)
    expect(seen[0]?.[1]).toBe(probe)
  })

  it('starts a reporter for a program built with a starter, and none for one built without', async () => {
    const recorder = recordingReportTransport()
    const { configPath } = projectWithPrivacy()
    const reporting: boolean[] = []
    const action = async () => {
      reporting.push(errorReporter() !== undefined)
    }
    const argv = ['node', 'agent-qa', '--config', configPath, 'probe']
    const without = programWith({ action }).program
    const withStarter = programWith({ startReporting: reportingThrough(recorder), action }).program

    await without.parseAsync(argv)
    await withStarter.parseAsync(argv)

    expect(reporting).toEqual([false, true])
  })

  it('runs the action and prints nothing when the starter throws or rejects', async () => {
    const throwing: StartReporting = () => {
      throw new Error('the starter threw')
    }
    const rejecting: StartReporting = async () => {
      throw new Error('the starter rejected')
    }
    for (const startReporting of [throwing, rejecting]) {
      const ran: string[] = []
      const { program } = programWith({
        startReporting,
        action: async () => {
          ran.push('action')
        },
      })
      const outcome = recorded()

      await runCli(program, ['node', 'agent-qa', 'probe'], outcome.deps)

      expect(ran).toEqual(['action'])
      expect(outcome.events).toEqual(['settle'])
      expect(outcome.printed).toEqual([])
    }
  })

  it('never calls the starter for --help, --version, an unknown option or a group with no action', async () => {
    const reached: string[] = []
    const startReporting: StartReporting = async (_root, action) => {
      reached.push(action.name())
    }

    for (const args of [['--help'], ['--version'], ['probe', '--unknown-flag'], ['group']]) {
      const { program } = programWith({ startReporting })
      await expect(program.parseAsync(['node', 'agent-qa', ...args])).rejects.toBeInstanceOf(
        CommanderError,
      )
    }
    await programWith({ startReporting }).program.parseAsync(['node', 'agent-qa', 'probe'])

    expect(reached).toEqual(['probe'])
  })
})

describe('the reporting starter', () => {
  it('hands its start the root --config, and agent-qa.config.yaml when none was typed', async () => {
    const inputs: StartErrorReportingInput[] = []
    const start = async (input: StartErrorReportingInput) => {
      inputs.push(input)
      return undefined
    }
    const startReporting: StartReporting = (program, action) =>
      startCliErrorReporting(program, action, { start })

    await programWith({ startReporting }).program.parseAsync([
      'node',
      'agent-qa',
      '--config',
      'elsewhere/project.yaml',
      'probe',
    ])
    await programWith({ startReporting }).program.parseAsync(['node', 'agent-qa', 'probe'])
    const bare = new Command('bare')
    await startCliErrorReporting(bare, bare, { start })

    expect(inputs).toEqual([
      { configPath: 'elsewhere/project.yaml' },
      { configPath: 'agent-qa.config.yaml' },
      { configPath: 'agent-qa.config.yaml' },
    ])
  })

  it('leaves reporting off, and the command runs, when its start throws or rejects', async () => {
    const throwing: typeof startErrorReporting = () => {
      throw new Error('the start threw')
    }
    const rejecting: typeof startErrorReporting = async () => {
      throw new Error('the start rejected')
    }
    for (const start of [throwing, rejecting]) {
      const bare = new Command('bare')
      await expect(startCliErrorReporting(bare, bare, { start })).resolves.toBeUndefined()

      const reporting: boolean[] = []
      const { program } = programWith({
        startReporting: (root, action) => startCliErrorReporting(root, action, { start }),
        action: async () => {
          reporting.push(errorReporter() !== undefined)
        },
      })
      await program.parseAsync(['node', 'agent-qa', 'probe'])

      expect(reporting).toEqual([false])
    }
  })
})

describe('reporting through the starter and the CLI failure handler', () => {
  it('sends a refusal thrown by a command and exits 2, and sends nothing and still exits 2 for a project with analytics.privacy true', async () => {
    const recorder = recordingReportTransport()
    const refusedIn = async (configPath: string) => {
      const { program } = programWith({
        startReporting: reportingThrough(recorder),
        action: async () => {
          throw new CliRefusal(['nope'], 2)
        },
      })
      const outcome = recorded()
      const { print, setExitCode, flush, exit } = outcome.deps
      const before = recorder.envelopes.length
      await runCli(program, ['node', 'agent-qa', '--config', configPath, 'probe'], {
        ...defaultCliFailureDeps(program),
        print,
        setExitCode,
        flush,
        exit,
      })
      await closeErrorReporting()
      return { ...outcome, envelopes: recorder.envelopes.slice(before) }
    }

    const optedOut = await refusedIn(projectWithPrivacy({ privacy: true }).configPath)
    const reporting = await refusedIn(projectWithPrivacy().configPath)

    expect(reportedMessages(reporting.envelopes)).toEqual(['nope'])
    expect(optedOut.envelopes).toEqual([])
    for (const arm of [optedOut, reporting]) {
      expect(arm.events).toEqual(['code 2', 'flush', 'exit 2'])
      expect(arm.printed).toEqual(['nope'])
    }
  })

  it('starts no reporter with the default start, which reads the blank DSN of a source checkout', async () => {
    expect(AGENT_QA_SENTRY_DSN.trim(), 'a source checkout bakes no DSN').toBe('')
    const recorder = recordingReportTransport()
    const { configPath } = projectWithPrivacy()
    const reporting: boolean[] = []
    const action = async () => {
      reporting.push(errorReporter() !== undefined)
    }
    const argv = ['node', 'agent-qa', '--config', configPath, 'probe']
    const byDefault = programWith({ startReporting: startCliErrorReporting, action }).program
    const throughSeam = programWith({ startReporting: reportingThrough(recorder), action }).program

    await byDefault.parseAsync(argv)
    await throughSeam.parseAsync(argv)

    expect(reporting).toEqual([false, true])
  })
})
