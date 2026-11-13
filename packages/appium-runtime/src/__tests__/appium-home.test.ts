import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { prepareAppiumHome, removeAppiumHome } from '../appium-home'

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

// A plain folder with one file, standing in for an installed driver.
function driverFolder(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'appium-home-test-'))
  folders.push(parent)
  const folder = join(parent, name)
  mkdirSync(folder)
  writeFileSync(join(folder, 'package.json'), '{}')
  return folder
}

// The homes in the temporary directory that link the given folder, whichever test made the rest.
function homesLinking(folder: string): string[] {
  const temp = realpathSync(tmpdir())
  return readdirSync(temp)
    .filter((entry) => entry.startsWith('agent-qa-appium-'))
    .map((entry) => join(temp, entry))
    .filter((home) => {
      try {
        return realpathSync(join(home, 'node_modules', basename(folder))) === realpathSync(folder)
      } catch {
        return false
      }
    })
}

describe('the prepared Appium home', () => {
  it('is a fresh folder in the temporary directory whose node_modules links each given folder by its name', async () => {
    const given = [driverFolder('first-driver'), driverFolder('second-driver')]

    const home = await prepareAppiumHome(given)
    folders.push(home)

    expect(dirname(home)).toBe(realpathSync(tmpdir()))
    expect(basename(home)).toMatch(/^agent-qa-appium-/u)
    expect(readdirSync(join(home, 'node_modules')).sort()).toEqual([
      'first-driver',
      'second-driver',
    ])
    for (const folder of given) {
      const link = join(home, 'node_modules', basename(folder))
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(realpathSync(link)).toBe(realpathSync(folder))
    }
    expect(existsSync(join(home, 'package.json'))).toBe(false)
  })

  it('is removed with its links, and the folders it linked keep their files', async () => {
    const given = [driverFolder('first-driver'), driverFolder('second-driver')]
    const home = await prepareAppiumHome(given)
    folders.push(home)

    await removeAppiumHome(home)

    expect(existsSync(home)).toBe(false)
    for (const folder of given) expect(existsSync(join(folder, 'package.json'))).toBe(true)
  })

  it('is removed again when one of its links cannot be made, and the prepare rejects with that error', async () => {
    const first = driverFolder('same-driver')
    const second = driverFolder('same-driver')
    const home = await prepareAppiumHome([first])
    folders.push(home)
    expect(homesLinking(first)).toEqual([home])

    await expect(prepareAppiumHome([first, second])).rejects.toMatchObject({ code: 'EEXIST' })

    expect(homesLinking(first)).toEqual([home])
    expect(existsSync(join(first, 'package.json'))).toBe(true)
  })
})
