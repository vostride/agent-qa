// Which package manager init uses: each source in order, within the project's range, on real folders.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  commandLine,
  detectPackageManager,
  plainInstall,
  runFromHere,
  type PackageManagerName,
} from '../commands/package-manager.js'
import { defaultProjectIo } from '../commands/project-host.js'
import { projectRange } from '../commands/project-range.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Project {
  above: string
  root: string
  app: string
  home: string
}

function project(): Project {
  const above = mkdtempSync(join(tmpdir(), 'agent-qa-package-manager-'))
  roots.push(above)
  const root = join(above, 'root')
  const app = join(root, 'qa')
  const home = join(above, 'home')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(app)
  mkdirSync(home)
  return { above, root, app, home }
}

function write(folder: string, file: string, content = ''): void {
  writeFileSync(join(folder, file), content)
}

function writeJson(folder: string, value: unknown): void {
  write(folder, 'package.json', `${JSON.stringify(value, null, 2)}\n`)
}

async function detect(
  start: string,
  home: string,
  options: { env?: NodeJS.ProcessEnv; flag?: PackageManagerName } = {},
) {
  const range = await projectRange(start, { homedir: home, io: defaultProjectIo })
  return detectPackageManager({
    range,
    env: options.env ?? {},
    io: defaultProjectIo,
    ...(options.flag === undefined ? {} : { flag: options.flag }),
  })
}

describe('package manager detection', () => {
  it('packageManager wins over a lockfile beside it and drops the hash from the version', async () => {
    const { app, home } = project()
    writeJson(app, { packageManager: 'pnpm@12.17.0+sha512.abc' })
    write(app, 'yarn.lock')

    expect(await detect(app, home)).toEqual({
      name: 'pnpm',
      version: '12.17.0',
      source: 'packageManager',
    })
  })

  it('a lockfile in a folder above the current one names the manager', async () => {
    const { root, app, home } = project()
    write(root, 'pnpm-lock.yaml')

    expect(await detect(app, home)).toEqual({ name: 'pnpm', source: 'lockfile' })
  })

  it.each([
    [['pnpm-lock.yaml', 'package-lock.json'], 'pnpm'],
    [['yarn.lock', 'package-lock.json'], 'yarn'],
    [['bun.lock', 'package-lock.json'], 'bun'],
    [['bun.lockb'], 'bun'],
    [['npm-shrinkwrap.json'], 'npm'],
  ] as const)('lockfiles %j in one folder give %s', async (files, manager) => {
    const { app, home } = project()
    for (const file of files) write(app, file)

    expect(await detect(app, home)).toMatchObject({ name: manager, source: 'lockfile' })
  })

  it('devEngines.packageManager as an object names the manager and its exact version', async () => {
    const { app, home } = project()
    writeJson(app, { devEngines: { packageManager: { name: 'yarn', version: '4.18.1' } } })

    expect(await detect(app, home)).toEqual({
      name: 'yarn',
      version: '4.18.1',
      yarnLine: 'berry',
      source: 'devEngines',
    })
  })

  it('devEngines.packageManager as an array names its first known manager', async () => {
    const { app, home } = project()
    writeJson(app, { devEngines: { packageManager: [{ name: 'deno' }, { name: 'bun' }] } })

    expect(await detect(app, home)).toEqual({ name: 'bun', source: 'devEngines' })
  })

  it('a devEngines range is not kept as the version', async () => {
    const { app, home } = project()
    writeJson(app, { devEngines: { packageManager: { name: 'pnpm', version: '^12.0.0' } } })

    expect(await detect(app, home)).toEqual({ name: 'pnpm', source: 'devEngines' })
  })

  it.each([
    ['pnpm/12.16.1 npm/? node/? darwin arm64', 'pnpm'],
    ['yarn/4.18.1 npm/? node/v24.22.2 darwin arm64', 'yarn'],
    ['bun/1.3.14 npm/? node/v24.3.0 darwin arm64', 'bun'],
    ['npm/11.19.1 node/v24.22.2 darwin arm64 workspaces/false', 'npm'],
  ] as const)('the user agent %s names %s', async (userAgent, manager) => {
    const { app, home } = project()

    expect(await detect(app, home, { env: { npm_config_user_agent: userAgent } })).toMatchObject({
      name: manager,
      source: 'user-agent',
    })
  })

  it('with no signal the manager is npm', async () => {
    const { app, home } = project()

    expect(await detect(app, home)).toEqual({ name: 'npm', source: 'default' })
  })

  it('a manager outside the four, in any source, is skipped', async () => {
    const { app, home } = project()
    writeJson(app, {
      packageManager: 'deno@2.0.0',
      devEngines: { packageManager: { name: 'deno', version: '2.0.0' } },
    })

    expect(
      await detect(app, home, { env: { npm_config_user_agent: 'deno/2.0.0 node/v24.0.0' } }),
    ).toEqual({ name: 'npm', source: 'default' })
  })

  it('a package.json that does not parse is skipped and the walk goes on', async () => {
    const { root, app, home } = project()
    write(app, 'package.json', '{ not json')
    writeJson(root, { packageManager: 'bun@1.3.14' })

    expect(await detect(app, home)).toEqual({
      name: 'bun',
      version: '1.3.14',
      source: 'packageManager',
    })
  })

  it('the flag wins over packageManager naming another manager', async () => {
    const { app, home } = project()
    writeJson(app, { packageManager: 'pnpm@12.17.0' })

    expect(await detect(app, home, { flag: 'bun' })).toEqual({ name: 'bun', source: 'flag' })
  })

  it('the flag keeps the version packageManager declares for the same manager', async () => {
    const { app, home } = project()
    writeJson(app, { packageManager: 'pnpm@12.17.0' })

    expect(await detect(app, home, { flag: 'pnpm' })).toEqual({
      name: 'pnpm',
      version: '12.17.0',
      source: 'flag',
    })
  })

  it('a lockfile above the folder holding .git is never read', async () => {
    const { above, app, home } = project()
    write(above, 'pnpm-lock.yaml')
    writeJson(above, { packageManager: 'pnpm@12.17.0' })

    expect(await detect(app, home)).toEqual({ name: 'npm', source: 'default' })
  })

  it("the home folder's package.json is never read", async () => {
    const { home } = project()
    const app = join(home, 'work', 'qa')
    mkdirSync(app, { recursive: true })
    writeJson(home, { packageManager: 'pnpm@12.17.0' })
    write(home, 'yarn.lock')

    expect(await detect(app, home)).toEqual({ name: 'npm', source: 'default' })
  })

  describe("Yarn's line", () => {
    it.each([
      ['yarn@4.18.1', 'berry'],
      ['yarn@1.22.19', 'classic'],
    ] as const)('packageManager %s is %s', async (field, line) => {
      const { app, home } = project()
      writeJson(app, { packageManager: field })

      expect(await detect(app, home)).toMatchObject({ name: 'yarn', yarnLine: line })
    })

    it.each([
      ['# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n', 'berry'],
      ['# yarn lockfile v1\n\n\nleft-pad@^1.3.0:\n  version "1.3.0"\n', 'classic'],
    ] as const)('a yarn.lock reading %j is %s', async (content, line) => {
      const { app, home } = project()
      write(app, 'yarn.lock', content)

      expect(await detect(app, home)).toEqual({ name: 'yarn', yarnLine: line, source: 'lockfile' })
    })

    it.each([
      ['.yarnrc.yml', 'berry'],
      ['.yarnrc', 'classic'],
    ] as const)('a %s in range is %s', async (file, line) => {
      const { root, app, home } = project()
      write(app, 'yarn.lock')
      write(root, file)

      expect(await detect(app, home)).toEqual({ name: 'yarn', yarnLine: line, source: 'lockfile' })
    })
  })
})

describe('the printed install', () => {
  it("is the manager's plain install", () => {
    expect(plainInstall('pnpm')).toEqual({ command: 'pnpm', args: ['install'] })
    expect(commandLine('yarn', ['install'])).toBe('yarn install')
  })

  it('quotes a word the shell would split', () => {
    expect(commandLine('npm', ['install', "it's mine", '@scope/pkg@1.0.0'])).toBe(
      "npm install 'it'\\''s mine' @scope/pkg@1.0.0",
    )
  })

  it('runs from the current folder when package.json is there', () => {
    expect(runFromHere('npm install', '/work/app', '/work/app')).toBe('npm install')
  })

  it('changes to the package.json folder above the current one', () => {
    expect(runFromHere('pnpm install', '/work/root', '/work/root/qa')).toBe('cd .. && pnpm install')
  })

  it('quotes a folder name with a space', () => {
    expect(runFromHere('npm install', '/work/my app', '/work/my app/qa/e2e')).toBe(
      'cd ../.. && npm install',
    )
    expect(runFromHere('npm install', '/work/my app', '/work')).toBe("cd 'my app' && npm install")
  })
})
