import { readdirSync } from 'node:fs'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import { KEY, answeringTerminal, clackStreams, type ClackStreams } from './clack-keys.js'
import { cleanupTempProjects, fakeRunner, tempProject } from './project-fixtures.js'

const PLATFORM_QUESTION = 'What platform will you test?'

function failureDeps() {
  const deps = {
    print: vi.fn<(text: string) => void>(),
    printFixed: vi.fn<(line: string) => void>(),
    mask: (text: string) => text,
    setExitCode: vi.fn<(code: number) => void>(),
    flush: vi.fn(async () => {}),
    exit: vi.fn<(code: number) => void>(),
    env: {},
  } satisfies CliFailureDeps
  return deps
}

async function cancelAtThePlatformQuestion(
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

  const done = runCli(program, ['node', 'agent-qa', 'init', '--pm', 'none'], deps)
  await streams.waitFor(PLATFORM_QUESTION)
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

describe('a cancelled init prompt', () => {
  it.each([
    { name: 'Ctrl-C', stop: (streams: ClackStreams) => streams.press(KEY.ctrlC) },
    { name: 'Esc', stop: (streams: ClackStreams) => streams.press(KEY.escape) },
    {
      name: 'a closed input',
      stop: async (streams: ClackStreams) => {
        streams.input.end()
      },
    },
  ])(
    '$name at the platform question prints Cancelled., exits 130 and writes nothing',
    async ({ stop }) => {
      const { root, deps } = await cancelAtThePlatformQuestion(stop)

      expect(deps.printFixed.mock.calls).toEqual([['Cancelled.']])
      expect(deps.print).not.toHaveBeenCalled()
      expect(deps.setExitCode).toHaveBeenCalledWith(130)
      expect(deps.exit).toHaveBeenCalledWith(130)
      expect(readdirSync(root)).toEqual(['.git'])
    },
  )
})
