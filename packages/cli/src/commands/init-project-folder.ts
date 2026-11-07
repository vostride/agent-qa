import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import type { PlatformPath } from 'node:path'

export interface InitFolderIo {
  homedir(): string
  realpath(path: string): Promise<string>
  path: PlatformPath
}

export const defaultInitFolderIo: InitFolderIo = { homedir, realpath, path: nodePath }

async function realPathIfPresent(io: InitFolderIo, path: string): Promise<string | undefined> {
  try {
    return await io.realpath(path)
  } catch (error) {
    // A folder that does not exist yet is neither the home folder nor a filesystem root.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

export async function initFolderRefusal(
  projectDir: string,
  io: InitFolderIo = defaultInitFolderIo,
): Promise<string | undefined> {
  const real = await realPathIfPresent(io, projectDir)
  if (real === undefined) return undefined
  if (io.path.dirname(real) === real) {
    return `agent-qa init does not set up the filesystem root (${real}). Run it in the project's folder, or pass --dir <folder>.`
  }
  const home = io.homedir()
  const realHome = await realPathIfPresent(io, home)
  if (real === realHome) {
    return `agent-qa init does not set up your home folder (${home}). Run it in the project's folder, or pass --dir <folder>.`
  }
  return undefined
}
