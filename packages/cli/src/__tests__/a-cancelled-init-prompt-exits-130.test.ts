import { readdirSync } from 'node:fs'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import { KEY, answeringTerminal, clackStreams, type ClackStreams } from './clack-keys.js'
import { cleanupTempProjects, fakeRunner, tempProject } from './project-fixtures.js'

const PLATFORM_QUESTION = 'What platform will you test?'
const MODEL_QUESTION = 'Which model should agent-qa use?'

function failureDeps() {
  const deps = {
    print: vi.fn<(text: string) => void>(),
    printFixed: vi.fn<(line: string) => void>(),
    mask: (text: string) => text,
    setExitCode: vi.fn<(code: number) => void>(),
    capture: vi.fn<(error: unknown) => void>(),
    settle: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    exit: vi.fn<(code: number) => void>(),
    env: {},
  } satisfies CliFailureDeps
  return deps
}

async function cancelAtQuestion(
  question: string,
  flags: readonly string[],
  stop: (streams: ClackStreams) => Promise<void>,
): Promise<{ root: string; deps: ReturnType<typeof failureDeps>; streams: ClackStreams }> {
  const { root, home } = tempProject('init-cancel')
  const streams = clackStreams()
  const program = new Command('agent-qa')
    .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
    .addCommand(
      createInitCommand({
        cwd: root,
        host: { homedir: home, env: {}, run: fakeRunner() },
        isTTY: true,
        terminal: answeringTerminal().port,
        rail: { input: streams.input, output: streams.output },
      }),
    )
  const deps = failureDeps()

  const done = runCli(program, ['node', 'agent-qa', 'init', ...flags, '--pm', 'none'], deps)
  await streams.waitFor(question)
  await stop(streams)
  await done

  return { root, deps, streams }
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempProjects()
})

const STOPS = [
  { name: 'Ctrl-C', stop: (streams: ClackStreams) => streams.press(KEY.ctrlC) },
  { name: 'Esc', stop: (streams: ClackStreams) => streams.press(KEY.escape) },
  {
    name: 'a closed input',
    stop: async (streams: ClackStreams) => {
      streams.input.end()
    },
  },
]

const QUESTIONS = [
  { where: 'the platform question', question: PLATFORM_QUESTION, flags: [] },
  { where: 'the model question', question: MODEL_QUESTION, flags: ['--platform', 'web'] },
]

describe('a cancelled init prompt', () => {
  it.each(QUESTIONS.flatMap((question) => STOPS.map((stop) => ({ ...question, ...stop }))))(
    '$name at $where prints Cancelled., is not reported, exits 130 and writes nothing',
    async ({ question, flags, stop }) => {
      const { root, deps } = await cancelAtQuestion(question, flags, stop)

      expect(deps.printFixed.mock.calls).toEqual([['Cancelled.']])
      expect(deps.print).not.toHaveBeenCalled()
      expect(deps.capture).not.toHaveBeenCalled()
      expect(deps.setExitCode).toHaveBeenCalledWith(130)
      expect(deps.exit).toHaveBeenCalledWith(130)
      expect(readdirSync(root)).toEqual(['.git'])
    },
  )
})
