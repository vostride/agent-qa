import { describe, expect, it } from 'vitest'
import {
  formatAppiumInstallGuidance,
  localAppiumBinaryNames,
  resolveAppiumExecutable,
} from '../appium-executable.js'

describe('resolveAppiumExecutable', () => {
  it('prefers a local POSIX appium binary in the workspace', () => {
    const local = '/repo/app/node_modules/.bin/appium'
    const result = resolveAppiumExecutable({
      cwd: '/repo/app',
      platform: 'darwin',
      exists: (path) => path === local,
    })

    expect(result).toEqual({ command: local, source: 'local' })
  })

  it('walks parent directories before falling back to PATH', () => {
    const local = '/repo/node_modules/.bin/appium'
    const result = resolveAppiumExecutable({
      cwd: '/repo/apps/demo/tests/mobile',
      platform: 'linux',
      exists: (path) => path === local,
    })

    expect(result).toEqual({ command: local, source: 'local' })
  })

  it('checks the Windows appium.cmd shim before other local names', () => {
    const local = '/repo/app/node_modules/.bin/appium.cmd'
    const seen: string[] = []
    const result = resolveAppiumExecutable({
      cwd: '/repo/app',
      platform: 'win32',
      exists: (path) => {
        seen.push(path)
        return path === local
      },
    })

    expect(result).toEqual({ command: local, source: 'local' })
    expect(seen[0]).toBe(local)
    expect(localAppiumBinaryNames('win32')[0]).toBe('appium.cmd')
  })

  it('falls back to the global appium command on PATH', () => {
    const result = resolveAppiumExecutable({
      cwd: '/repo/app',
      exists: () => false,
    })

    expect(result).toEqual({ command: 'appium', source: 'path' })
  })
})

describe('formatAppiumInstallGuidance', () => {
  it('mentions local install first and keeps the global fallback visible', () => {
    const guidance = formatAppiumInstallGuidance()

    expect(guidance).toContain('npm install -D appium')
    expect(guidance).toContain('pnpm add -D appium')
    expect(guidance).toContain('yarn add -D appium')
    expect(guidance).toContain('npm install -g appium')
  })
})
