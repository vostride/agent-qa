import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import { afterEach, expect, it, vi } from 'vitest'

import { createAgentQaProgram } from '../program.js'

const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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

async function parse(args: readonly string[]): Promise<void> {
  const priorExit = process.exitCode
  captured()
  try {
    await createAgentQaProgram().exitOverride().parseAsync(['node', 'agent-qa', ...args])
  } finally {
    process.exitCode = priorExit
    vi.restoreAllMocks()
  }
}

function printLater(): { stdout: string[]; stderr: string[] } {
  const output = captured()
  try {
    printRunText('late ::add-mask::x', (text) => process.stderr.write(`${text}\n`))
  } finally {
    vi.restoreAllMocks()
  }
  return output
}

// The hold lasts for the life of the process, so one cell checks both orders.
it('a --json action keeps stdout for data after it returns, and a plain action does not', async () => {
  vi.stubEnv('GITHUB_ACTIONS', 'true')

  await parse(['skills'])
  const afterPlain = printLater()
  expect(afterPlain.stderr).toEqual([])
  expect(afterPlain.stdout).toHaveLength(1)
  expect(afterPlain.stdout[0]).toMatch(PAIR)

  await parse(['skills', '--json'])
  const afterJson = printLater()
  expect(afterJson.stdout).toEqual([])
  expect(afterJson.stderr).toHaveLength(1)
  expect(afterJson.stderr[0]).toMatch(PAIR)
  expect(afterJson.stderr[0]).toContain('late ::add-mask::x')
})
