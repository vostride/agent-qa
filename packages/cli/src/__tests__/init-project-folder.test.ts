import { posix, win32, type PlatformPath } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initFolderRefusal, type InitFolderIo } from '../commands/init-project-folder.js'

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
