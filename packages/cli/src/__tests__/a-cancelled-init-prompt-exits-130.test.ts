import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@inquirer/checkbox', () => ({ default: vi.fn() }))

import checkbox from '@inquirer/checkbox'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'

const mockCheckbox = vi.mocked(checkbox)

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('a cancelled init prompt', () => {
  it('Ctrl-C at the platform prompt prints Cancelled., exits 130 and writes nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-qa-init-cancel-'))
    mockCheckbox.mockRejectedValue(
      Object.assign(new Error('User force closed the prompt with SIGINT'), {
        name: 'ExitPromptError',
      }),
    )
    const program = new Command('agent-qa')
      .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
      .addCommand(createInitCommand({ isTTY: true }))
    const print = vi.fn<(text: string) => void>()
    const printFixed = vi.fn<(line: string) => void>()
    const setExitCode = vi.fn<(code: number) => void>()
    const flush = vi.fn(async () => {})
    const exit = vi.fn<(code: number) => void>()
    const deps: CliFailureDeps = {
      print,
      printFixed,
      mask: (text) => text,
      setExitCode,
      flush,
      exit,
      env: {},
    }

    await runCli(program, ['node', 'agent-qa', 'init', '--dir', dir], deps)

    expect(mockCheckbox).toHaveBeenCalledTimes(1)
    expect(printFixed.mock.calls).toEqual([['Cancelled.']])
    expect(print).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(130)
    expect(exit).toHaveBeenCalledWith(130)
    expect(readdirSync(dir)).toEqual([])
  })
})
