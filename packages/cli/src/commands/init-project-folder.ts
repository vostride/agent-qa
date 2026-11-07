import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import type { PlatformPath } from 'node:path'
import type { Command } from 'commander'

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
    return `agent-qa init does not set up the filesystem root (${real}). Run it in the project's folder.`
  }
  const home = io.homedir()
  const realHome = await realPathIfPresent(io, home)
  if (real === realHome) {
    return `agent-qa init does not set up your home folder (${home}). Run it in the project's folder.`
  }
  return undefined
}

function given(command: Command, option: string): boolean {
  const source = command.getOptionValueSource(option)
  return source !== undefined && source !== 'default'
}

function rootCommand(command: Command): Command {
  let node: Command = command
  while (node.parent) node = node.parent
  return node
}

export function initFolderOptionRefusal(
  command: Command,
  opts: { dir?: string; config?: string },
): string | undefined {
  if (opts.dir !== undefined) {
    return "agent-qa init sets up the folder it runs in and takes no --dir. Run it in the project's folder."
  }
  if (opts.config !== undefined || given(rootCommand(command), 'config')) {
    return "agent-qa init sets up the folder it runs in and takes no --config. Run it in the project's folder."
  }
  return undefined
}
