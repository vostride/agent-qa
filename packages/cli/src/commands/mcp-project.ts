import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ProjectHost } from './project-host.js'
import { nearestFile, projectRange } from './project-range.js'

export interface McpConfigLocation {
  configPath: string
  projectDir: string
  found: boolean
}

function isAtOrBelow(folder: string, path: string): boolean {
  const fromFolder = relative(folder, path)
  return (
    fromFolder === '' ||
    (fromFolder !== '..' && !fromFolder.startsWith(`..${sep}`) && !isAbsolute(fromFolder))
  )
}

// npx moves the working folder up to a workspace member but keeps the folder it was started in as
// INIT_CWD. An INIT_CWD outside the working folder was inherited from some other npm process.
async function startFolder(
  env: NodeJS.ProcessEnv,
  cwd: string,
  io: ProjectHost['io'],
): Promise<string> {
  const initCwd = env.INIT_CWD
  if (env.npm_command !== 'exec' || initCwd === undefined || initCwd === '') return cwd
  const started = await io.realpath(resolve(cwd, initCwd))
  return isAtOrBelow(await io.realpath(cwd), started) ? started : cwd
}

export async function resolveMcpConfigPath(input: {
  config: string
  env: NodeJS.ProcessEnv
  cwd: string
  host: Pick<ProjectHost, 'homedir' | 'io'>
}): Promise<McpConfigLocation> {
  const { config, host } = input
  if (isAbsolute(config)) {
    return { configPath: config, projectDir: dirname(config), found: host.io.exists(config) }
  }
  const range = await projectRange(await startFolder(input.env, input.cwd, host.io), host)
  const atStart = join(range.start, config)
  if (host.io.exists(atStart)) {
    return { configPath: atStart, projectDir: dirname(atStart), found: true }
  }
  const nearest = nearestFile(range, config, host.io)
  if (nearest !== undefined) {
    return { configPath: nearest, projectDir: dirname(nearest), found: true }
  }
  return { configPath: atStart, projectDir: range.start, found: false }
}
