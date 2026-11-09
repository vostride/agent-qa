import { Command } from 'commander'
import { vi, type MockInstance } from 'vitest'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { createInitCommand, type InitCommandHooks } from '../commands/init.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { createPlainUi } from '../init-ui/plain-ui.js'
import { fakeInitUi, type FakeInitUiEntry } from './fake-init-ui.js'
import { fakeRunner, tempProject, type FakeRunner } from './project-fixtures.js'

const NODE = '/fake/node'

export interface InitializedProject {
  root: string
  home: string
}

export interface RerunResult {
  exit: number
  stdout: string
  stderr: string
  entries: FakeInitUiEntry[]
}

export interface RerunOptions {
  run?: FakeRunner
  // Draws through the plain renderer on stderr instead of recording entries.
  plain?: boolean
  // The fake UI's answers, by question; unanswered questions take their defaults.
  answers?: Record<string, unknown>
  hooks?: InitCommandHooks
}

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-rerun', runtimeContext: 'user' }),
  })

function capture(stream: NodeJS.WriteStream): { text(): string; release(): void } {
  const mocked = vi.isMockFunction(stream.write)
  if (!mocked) vi.spyOn(stream, 'write').mockImplementation(() => true)
  const spy = stream.write as unknown as MockInstance<(chunk: unknown) => boolean>
  const start = spy.mock.calls.length
  return {
    text: () =>
      spy.mock.calls
        .slice(start)
        .map((call) => String(call[0]))
        .join(''),
    release: () => {
      if (!mocked) spy.mockRestore()
    },
  }
}

async function runInit(
  project: InitializedProject,
  args: readonly string[],
  options: RerunOptions,
): Promise<RerunResult> {
  const ui = fakeInitUi(options.answers)
  const out = capture(process.stdout)
  const err = capture(process.stderr)
  const handler: string[] = []
  let exit = 0
  try {
    const program = new Command('agent-qa')
      .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
      .addCommand(
        createInitCommand({
          cwd: project.root,
          isTTY: false,
          composeAnalytics: silentAnalytics,
          ui: options.plain === true ? createPlainUi() : ui,
          ...options.hooks,
          host: {
            homedir: project.home,
            env: {},
            run: options.run ?? fakeRunner(),
            argv: ['init', ...args],
            execPath: NODE,
            ...options.hooks?.host,
          },
        }),
      )
    const deps: CliFailureDeps = {
      print: (text) => handler.push(`${text}\n`),
      printFixed: (line) => handler.push(`${line}\n`),
      mask: (text) => text,
      setExitCode: () => {},
      flush: async () => {},
      exit: (code) => {
        exit = code
      },
      env: {},
    }
    await runCli(program, ['node', 'agent-qa', 'init', ...args], deps)
    return {
      exit,
      stdout: out.text(),
      stderr: err.text() + handler.join(''),
      entries: ui.entries,
    }
  } finally {
    out.release()
    err.release()
  }
}

export async function initializedProject(label: string): Promise<InitializedProject> {
  const project = tempProject(label)
  const fresh = await runInit(
    project,
    ['--yes', '--pm', 'none', '--no-browsers', '--agents', 'none', '--llm', 'gemini'],
    {},
  )
  if (fresh.exit !== 0) {
    throw new Error(`the fresh init exited ${fresh.exit}:\n${fresh.stderr}`)
  }
  return project
}

export async function rerun(
  project: InitializedProject,
  args: readonly string[] = [],
  options: RerunOptions = {},
): Promise<RerunResult> {
  return await runInit(project, args, options)
}
