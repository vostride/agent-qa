import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findRemovedNodeEnvFileArg,
  findRemovedTopLevelCommandArg,
  findTopLevelCommandArg,
  rejectRemovedCliSurface,
} from '../removed-cli-surface.js'

describe('removed CLI surface guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects Node-stripped --env-file arguments', () => {
    expect(findRemovedNodeEnvFileArg(['--env-file', '.env.local'])).toBe('--env-file')
    expect(findRemovedNodeEnvFileArg(['--env-file=.env.local'])).toBe('--env-file')
  })

  it('does not block unrelated Node arguments', () => {
    expect(findRemovedNodeEnvFileArg(['--inspect', '--env-file-if-exists', '.env.local'])).toBeNull()
  })

  it('finds the top-level command after global options', () => {
    expect(findTopLevelCommandArg(['--config', 'custom.yaml', '--verbose', 'run'])).toBe('run')
    expect(findTopLevelCommandArg(['--log-level=debug', 'doctor'])).toBe('doctor')
    expect(findTopLevelCommandArg(['--', 'connect'])).toBe('connect')
  })

  it('detects removed top-level commands before Commander handles help', () => {
    expect(findRemovedTopLevelCommandArg(['connect'])).toBe('connect')
    expect(findRemovedTopLevelCommandArg(['--config', 'custom.yaml', 'connect', '--help'])).toBe('connect')
  })

  it('leaves active and unknown-option surfaces to Commander', () => {
    expect(findRemovedTopLevelCommandArg(['run'])).toBeNull()
    expect(findRemovedTopLevelCommandArg(['--unknown', 'connect'])).toBeNull()
  })

  it('exits before Commander can turn removed command help into global help', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    expect(() => rejectRemovedCliSurface({ execArgv: [], argv: ['connect', '--help'] })).toThrow('process.exit')

    expect(errorSpy).toHaveBeenCalledWith("error: unknown command 'connect'")
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits when Node strips removed run --env-file into execArgv', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    expect(() => rejectRemovedCliSurface({ execArgv: ['--env-file', '.env.local'], argv: ['run'] })).toThrow('process.exit')

    expect(errorSpy).toHaveBeenCalledWith("error: unknown option '--env-file'")
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
