import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: 'capture' | 'inherit'
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
  missing?: boolean
  cancelled?: boolean
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>

// cmd.exe splits on spaces, so the command is one word only when quoted like its arguments.
export function windowsShellWord(word: string): string {
  return `"${word.replaceAll('"', '\\"')}"`
}

// On Windows the managers are .cmd shims that only a shell can start.
export const spawnRunner: CommandRunner = (command, args, options) => {
  const windows = process.platform === 'win32'
  const file = windows ? windowsShellWord(command) : command
  const child = spawn(file, windows ? args.map(windowsShellWord) : [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio === 'capture' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: windows,
  })
  let output = ''
  let cancelled = false
  const collect = (chunk: Buffer): void => {
    output += chunk.toString('utf8')
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const interrupt = (): void => {
    cancelled = true
    child.kill('SIGINT')
  }
  process.on('SIGINT', interrupt)
  return new Promise<RunResult>((settle, fail) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      process.off('SIGINT', interrupt)
      if (error.code === 'ENOENT') settle({ code: null, signal: null, output: '', missing: true })
      else fail(error)
    })
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt)
      settle({ code, signal, output, ...(cancelled ? { cancelled: true } : {}) })
    })
  })
}

export interface ProjectHost {
  cwd: string
  env: NodeJS.ProcessEnv
  homedir: string
  io: ProjectIo
  run: CommandRunner
  argv: readonly string[]
  execPath: string
  runningPackageDir: string
}

function namesAgentQa(packageJson: string): boolean {
  try {
    return (
      (JSON.parse(readFileSync(packageJson, 'utf-8')) as { name?: unknown }).name === 'agent-qa'
    )
  } catch {
    return false
  }
}

function findRunningPackageDir(): string {
  const own = dirname(fileURLToPath(import.meta.url))
  let folder = own
  while (true) {
    const packageJson = join(folder, 'package.json')
    if (existsSync(packageJson) && namesAgentQa(packageJson)) return folder
    const parent = dirname(folder)
    if (parent === folder) return own
    folder = parent
  }
}

// runningPackageDir is found on first read, so a suite that mocks node:fs never walks for it.
export function projectHost(overrides: Partial<ProjectHost> = {}): ProjectHost {
  let runningPackageDir = overrides.runningPackageDir
  const host = {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    homedir: overrides.homedir ?? homedir(),
    io: overrides.io ?? defaultProjectIo,
    run: overrides.run ?? spawnRunner,
    argv: overrides.argv ?? process.argv.slice(2),
    execPath: overrides.execPath ?? process.execPath,
  }
  return Object.defineProperty(host, 'runningPackageDir', {
    enumerable: true,
    get: () => (runningPackageDir ??= findRunningPackageDir()),
  }) as ProjectHost
}
