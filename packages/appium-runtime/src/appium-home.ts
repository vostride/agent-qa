import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// A fresh folder has no extension manifest yet, so Appium scans its node_modules and finds the
// linked drivers at every start. A junction needs no administrator rights on Windows; elsewhere
// it is an ordinary symlink.
export async function prepareAppiumHome(driverFolders: readonly string[]): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-qa-appium-')))
  await mkdir(join(home, 'node_modules'))
  for (const folder of driverFolders) {
    await symlink(folder, join(home, 'node_modules', basename(folder)), 'junction')
  }
  return home
}

// Removing a link never descends into the folder it points at.
export async function removeAppiumHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true })
}
