import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import type { PlatformPath } from 'node:path'
import type { Command } from 'commander'
import pc from 'picocolors'

import { CliRefusal } from '../composition/cli-refusal.js'

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

const DEFAULT_CONFIG_FILE = 'agent-qa.config.yaml'

export interface InitProject {
  readonly projectDir: string
  readonly configPath: string
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

async function sameFolder(io: InitFolderIo, left: string, right: string): Promise<boolean> {
  if (left === right) return true
  const [realLeft, realRight] = await Promise.all([
    realPathIfPresent(io, left),
    realPathIfPresent(io, right),
  ])
  return (realLeft ?? left) === (realRight ?? right)
}

// An explicit `--config` names the config file and its folder is the project; parents are never read.
export async function resolveInitProject(
  command: Command,
  dirOption: string,
  io: InitFolderIo = defaultInitFolderIo,
): Promise<InitProject> {
  const root = rootCommand(command)
  const supplied = root.opts<{ config?: string }>().config
  if (supplied === undefined || !given(root, 'config')) {
    const projectDir = io.path.resolve(dirOption)
    return { projectDir, configPath: io.path.join(projectDir, DEFAULT_CONFIG_FILE) }
  }
  const configPath = io.path.resolve(supplied)
  const projectDir = io.path.dirname(configPath)
  if (given(command, 'dir')) {
    const dir = io.path.resolve(dirOption)
    if (!(await sameFolder(io, dir, projectDir))) {
      const line = `agent-qa init does not take --dir ${dir} with --config ${configPath}, which is in another folder. Pass --config alone, or put the --config file directly in --dir.`
      throw new CliRefusal([pc.red(line)], 2)
    }
  }
  return { projectDir, configPath }
}
