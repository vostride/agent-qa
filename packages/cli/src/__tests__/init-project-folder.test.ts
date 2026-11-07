import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32, type PlatformPath } from 'node:path'

import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'

import {
  initFolderRefusal,
  resolveInitProject,
  type InitFolderIo,
  type InitProject,
} from '../commands/init-project-folder.js'
import { CliRefusal } from '../composition/cli-refusal.js'

function homeLine(home: string): string {
  return `agent-qa init does not set up your home folder (${home}). Run it in the project's folder, or pass --dir <folder>.`
}

function rootLine(root: string): string {
  return `agent-qa init does not set up the filesystem root (${root}). Run it in the project's folder, or pass --dir <folder>.`
}

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: realpath failed`), { code })
}

function fakeIo(options: {
  home: string
  path: PlatformPath
  real?: Readonly<Record<string, string>>
  failing?: Readonly<Record<string, string>>
}): InitFolderIo {
  return {
    homedir: () => options.home,
    realpath: async (path) => {
      const code = options.failing?.[path]
      if (code !== undefined) throw failure(code)
      return options.real?.[path] ?? path
    },
    path: options.path,
  }
}

describe('the project folder init refuses', () => {
  it('the posix root is a filesystem root', async () => {
    const io = fakeIo({ home: '/home/you', path: posix })
    expect(await initFolderRefusal('/', io)).toBe(rootLine('/'))
  })

  it('a Windows drive root is a filesystem root', async () => {
    const io = fakeIo({ home: 'C:\\Users\\y', path: win32 })
    expect(await initFolderRefusal('C:\\', io)).toBe(rootLine('C:\\'))
  })

  it('a Windows share root is a filesystem root', async () => {
    const io = fakeIo({ home: 'C:\\Users\\y', path: win32 })
    expect(await initFolderRefusal('\\\\server\\share\\', io)).toBe(rootLine('\\\\server\\share\\'))
  })

  it("another user's Windows folder is neither the home folder nor a root", async () => {
    const io = fakeIo({ home: 'C:\\Users\\y', path: win32 })
    expect(await initFolderRefusal('C:\\Users\\x', io)).toBeUndefined()
  })

  it('the home folder is refused', async () => {
    const io = fakeIo({ home: '/home/you', path: posix })
    expect(await initFolderRefusal('/home/you', io)).toBe(homeLine('/home/you'))
  })

  it('the home folder spelled with a trailing slash is refused', async () => {
    const io = fakeIo({ home: '/home/you', path: posix, real: { '/home/you/': '/home/you' } })
    expect(await initFolderRefusal('/home/you/', io)).toBe(homeLine('/home/you'))
  })

  it('a link to the home folder is refused', async () => {
    const io = fakeIo({ home: '/home/you', path: posix, real: { '/work/link': '/home/you' } })
    expect(await initFolderRefusal('/work/link', io)).toBe(homeLine('/home/you'))
  })

  it('the home folder spelled in another case is refused where the filesystem ignores case', async () => {
    const io = fakeIo({ home: '/Users/you', path: posix, real: { '/users/YOU': '/Users/you' } })
    expect(await initFolderRefusal('/users/YOU', io)).toBe(homeLine('/Users/you'))
  })

  it('a project folder that does not exist yet passes', async () => {
    const io = fakeIo({ home: '/home/you', path: posix, failing: { '/home/you/new': 'ENOENT' } })
    expect(await initFolderRefusal('/home/you/new', io)).toBeUndefined()
  })

  it('a missing home folder leaves nothing to compare', async () => {
    const io = fakeIo({ home: '/home/gone', path: posix, failing: { '/home/gone': 'ENOENT' } })
    expect(await initFolderRefusal('/work/app', io)).toBeUndefined()
  })

  it('a realpath failure other than a missing folder is not swallowed', async () => {
    const io = fakeIo({ home: '/home/you', path: posix, failing: { '/work/locked': 'EACCES' } })
    await expect(initFolderRefusal('/work/locked', io)).rejects.toMatchObject({ code: 'EACCES' })
  })
})

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-init-project-'))
  roots.push(root)
  return root
}

async function resolveFrom(
  args: readonly string[],
  options: { cwd: string; rootConfigOption?: boolean },
): Promise<InitProject> {
  const root = new Command().enablePositionalOptions().exitOverride()
  if (options.rootConfigOption !== false) {
    root.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  }
  let resolved: InitProject | undefined
  root
    .command('init')
    .option('--dir <path>', 'target directory', options.cwd)
    .action(async (opts: { dir: string }, command: Command) => {
      resolved = await resolveInitProject(command, opts.dir)
    })
  await root.parseAsync([...args], { from: 'user' })
  if (resolved === undefined) throw new Error('init did not run')
  return resolved
}

describe('the project folder and config init resolve', () => {
  it('with no --config the config is agent-qa.config.yaml in --dir', async () => {
    const root = tempRoot()
    const dir = join(root, 'app')
    expect(await resolveFrom(['init'], { cwd: root })).toEqual({
      projectDir: root,
      configPath: join(root, 'agent-qa.config.yaml'),
    })
    expect(
      await resolveFrom(['init', '--dir', dir], { cwd: root, rootConfigOption: false }),
    ).toEqual({ projectDir: dir, configPath: join(dir, 'agent-qa.config.yaml') })
  })

  it('a --config left at its default does not name the config', async () => {
    const root = tempRoot()
    const dir = join(root, 'app')
    expect(await resolveFrom(['init', '--dir', dir], { cwd: root })).toEqual({
      projectDir: dir,
      configPath: join(dir, 'agent-qa.config.yaml'),
    })
  })

  it('--config names the config file and its folder is the project folder', async () => {
    const root = tempRoot()
    const config = join(root, 'sub', 'custom.yaml')
    expect(await resolveFrom(['--config', config, 'init'], { cwd: root })).toEqual({
      projectDir: join(root, 'sub'),
      configPath: config,
    })
  })

  it("--dir naming another folder than the --config file's folder is refused with both paths", async () => {
    const root = tempRoot()
    const config = join(root, 'custom.yaml')
    const dir = join(root, 'e2e')
    const refused = resolveFrom(['--config', config, 'init', '--dir', dir], { cwd: root })
    await expect(refused).rejects.toBeInstanceOf(CliRefusal)
    await expect(refused).rejects.toMatchObject({
      exitCode: 2,
      message: `agent-qa init does not take --dir ${dir} with --config ${config}, which is in another folder. Pass --config alone, or a --config path inside --dir.`,
    })
  })

  it("--dir naming the --config file's folder is accepted, with a trailing slash too", async () => {
    const root = tempRoot()
    const sub = join(root, 'sub')
    mkdirSync(sub)
    symlinkSync(sub, join(root, 'link'), 'dir')
    const config = join(sub, 'custom.yaml')
    const expected = { projectDir: sub, configPath: config }
    for (const dir of [sub, `${sub}/`, join(root, 'link')]) {
      expect(await resolveFrom(['--config', config, 'init', '--dir', dir], { cwd: root })).toEqual(
        expected,
      )
    }
  })
})
