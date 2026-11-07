import { existsSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'

export interface ProjectIo {
  exists(path: string): boolean
  readText(path: string): string | undefined
  realpath(path: string): Promise<string>
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export const defaultProjectIo: ProjectIo = {
  exists: (path) => existsSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf-8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  },
  realpath: async (path) => {
    try {
      return await realpath(path)
    } catch (error) {
      if (isMissing(error)) return path
      throw error
    }
  },
}

export interface ProjectHost {
  cwd: string
  env: NodeJS.ProcessEnv
  homedir: string
  io: ProjectIo
}

export function projectHost(overrides: Partial<ProjectHost> = {}): ProjectHost {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    homedir: overrides.homedir ?? homedir(),
    io: overrides.io ?? defaultProjectIo,
  }
}
