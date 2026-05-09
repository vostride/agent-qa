import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { isCanonicalTestId } from '@vostride/agent-qa-ids'
import { createIdsCommand } from '../commands/ids.js'

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
let originalExitCode: typeof process.exitCode

beforeEach(() => {
  originalExitCode = process.exitCode
  process.exitCode = undefined
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
  process.exitCode = originalExitCode
})

describe('createIdsCommand', () => {
  it('generates canonical IDs for an entity type', async () => {
    const program = new Command()
    program.addCommand(createIdsCommand())

    await program.parseAsync(['node', 'agent-qa', 'ids', 'generate', 'test'])

    const id = String(logSpy.mock.calls[0][0])
    expect(isCanonicalTestId(id)).toBe(true)
    expect(process.exitCode).toBeUndefined()
  })

  it('validates canonical IDs with structured output', async () => {
    const program = new Command()
    program.addCommand(createIdsCommand())
    const id = 't_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'

    await program.parseAsync(['node', 'agent-qa', 'ids', 'validate', 'test', id, '--json'])

    const result = JSON.parse(String(logSpy.mock.calls[0][0]))
    expect(result).toMatchObject({
      valid: true,
      id,
      type: 'test',
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('rejects invalid IDs with the expected contract', async () => {
    const program = new Command()
    program.addCommand(createIdsCommand())

    await program.parseAsync(['node', 'agent-qa', 'ids', 'validate', 'suite', 't_bad-id', '--json'])

    const result = JSON.parse(String(logSpy.mock.calls[0][0]))
    expect(result.valid).toBe(false)
    expect(result.contract.prefixWithSeparator).toBe('s_')
    expect(process.exitCode).toBe(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
