// The setup guard refuses a browser install through the default runner and fails the test.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { openDashboardUrl } from '../commands/dashboard.js'
import { systemBrowserOpener } from '../commands/open-url.js'
import { projectHost, spawnRunner } from '../commands/project-host.js'
import { runUpdateNotice } from '../version-notice.js'
import { spawnVersionRefresh } from '../version-refresh-spawn.js'
import { hermeticEnv } from './conformance/spawned-chat.js'
import { cleanupTempProjects, tempProject } from './project-fixtures.js'
import { assertNoGuardedCalls, takeGuardedCalls } from './test-side-effect-guard.js'

const spawned = vi.hoisted(() => [] as string[])

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const record =
    <T extends (...args: never[]) => unknown>(fn: T) =>
    (...args: Parameters<T>): ReturnType<T> => {
      spawned.push(args.flat().filter((arg) => typeof arg === 'string').join(' '))
      return fn(...args) as ReturnType<T>
    }
  return {
    ...real,
    spawn: record(real.spawn),
    spawnSync: record(real.spawnSync),
    exec: record(real.exec),
    execFile: record(real.execFile),
  }
})

const REFUSAL = 'A test reached the real browser install. Pass --no-browsers or inject host.run.'

function project(): { root: string; home: string; bin: string } {
  const { root, home } = tempProject('guard')
  const bin = join(root, 'cli.js')
  writeFileSync(bin, '')
  return { root, home, bin }
}

afterEach(() => {
  spawned.length = 0
  cleanupTempProjects()
})

describe('the default runner in a test', () => {
  it('refuses a browser install before any child starts and records it', async () => {
    const { root, home, bin } = project()

    await expect(
      projectHost({ homedir: home }).run(process.execPath, [bin, 'install-browsers', '--chromium'], {
        cwd: root,
        env: {},
        stdio: 'capture',
      }),
    ).rejects.toThrow(REFUSAL)

    const calls = takeGuardedCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('install-browsers --chromium')
    expect(spawned.filter((call) => call.includes('install-browsers'))).toEqual([])
  })

  it('the exported spawnRunner refuses the same call the same way', async () => {
    const { root, bin } = project()

    await expect(
      spawnRunner(process.execPath, [bin, 'install-browsers', '--chromium'], {
        cwd: root,
        env: {},
        stdio: 'capture',
      }),
    ).rejects.toThrow(REFUSAL)

    expect(takeGuardedCalls()).toEqual([`${process.execPath} ${bin} install-browsers --chromium`])
    expect(spawned.filter((call) => call.includes('install-browsers'))).toEqual([])
  })

  it('runs a call that names no install as before', async () => {
    const { root, home } = project()

    const result = await projectHost({ homedir: home }).run(
      process.execPath,
      ['-e', 'process.exit(0)'],
      { cwd: root, env: {}, stdio: 'capture' },
    )

    expect(result.code).toBe(0)
    expect(takeGuardedCalls()).toEqual([])
  })
})

describe('the check after each test', () => {
  it('throws naming the refused install and leaves the record empty', async () => {
    const { root, bin } = project()
    await spawnRunner(process.execPath, [bin, 'install-browsers', '--chromium'], {
      cwd: root,
      env: {},
      stdio: 'capture',
    }).catch(() => undefined)

    expect(() => assertNoGuardedCalls()).toThrow(
      new RegExp(
        '^1 real side effects reached from this test: .*install-browsers --chromium\\. ' +
          'Pass --no-browsers or inject host\\.run\\.$',
        'u',
      ),
    )
    expect(takeGuardedCalls()).toEqual([])
  })

  it('returns over an empty record', () => {
    expect(() => assertNoGuardedCalls()).not.toThrow()
  })
})

describe('the download host a test environment carries', () => {
  // Playwright takes a browser's own variable first, then the shared one.
  const HOSTS = [
    'PLAYWRIGHT_DOWNLOAD_HOST',
    'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST',
    'PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST',
    'PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST',
  ]

  it.each(HOSTS)(
    '%s points at a refusing loopback address, in this process and in a spawned child',
    (name) => {
      expect(process.env[name]).toBe('http://127.0.0.1:0')
      expect(hermeticEnv('/tmp/root')[name]).toBe('http://127.0.0.1:0')
    },
  )
})

describe('the default browser opener in a test', () => {
  const OPENER_REFUSAL =
    'A test reached the real browser opener. Pass an opener to createDashboardCommand.'
  const PAGE = 'http://localhost:3470/config/models'

  it("the dashboard command's opener is refused before any child starts and records it", () => {
    expect(() => openDashboardUrl(PAGE, systemBrowserOpener)).toThrow(OPENER_REFUSAL)

    expect(takeGuardedCalls()).toEqual(['open http://localhost:3470'])
    expect(spawned.filter((call) => /^(open|xdg-open|cmd)\b/u.test(call))).toEqual([])
  })
})

describe('the default registry refresh in a test', () => {
  const REFRESH_REFUSAL = 'A test reached a real registry refresh. Inject spawnRefresh.'

  it('refuses the default spawn before any child starts and records it', () => {
    const { home } = project()

    expect(() => spawnVersionRefresh(home)).toThrow(REFRESH_REFUSAL)

    expect(takeGuardedCalls()).toEqual(['refresh registry'])
    expect(spawned.filter((call) => call.includes('version-refresh'))).toEqual([])
  })

  it('an update notice with no spawn of its own reaches the refusal, and the check names it', async () => {
    const { home } = project()

    await runUpdateNotice({
      env: {},
      stdoutIsTTY: true,
      stderrIsTTY: true,
      json: false,
      homeDir: home,
      now: Date.now(),
      currentVersion: '0.0.0',
      write: () => undefined,
    })

    expect(spawned.filter((call) => call.includes('version-refresh'))).toEqual([])
    expect(() => assertNoGuardedCalls()).toThrow(
      /^1 real side effects reached from this test: refresh registry\. Inject spawnRefresh\.$/u,
    )
  })
})
