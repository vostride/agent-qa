import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
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

// cmd.exe does not read \" as an escape and expands %NAME% inside quotes, so a word holding a
// character cmd.exe acts on is refused rather than quoted.
const CMD_ACTIVE = /["%^&|<>!\r\n]/u

export function windowsShellWord(word: string): string {
  if (CMD_ACTIVE.test(word)) {
    throw new Error(
      `Refusing to pass ${JSON.stringify(word)} through cmd.exe: it holds a character cmd.exe ` +
        'would act on.',
    )
  }
  return `"${word}"`
}

function isWindowsExecutable(command: string): boolean {
  return win32.isAbsolute(command) && win32.extname(command).toLowerCase() === '.exe'
}

// On Windows the managers are .cmd shims that only a shell can start; an .exe such as node.exe
// starts directly, so the arguments it is handed never meet cmd.exe. The shell gets one command
// line, which keeps Node from warning about arguments passed with a shell.
// The platform and spawn are read on each run, not when this module loads.
export function createSpawnRunner(
  given: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn } = {},
): CommandRunner {
  return (command, args, options) => {
    const platform = given.platform ?? process.platform
    const spawn = given.spawn ?? nodeSpawn
    const shell = platform === 'win32' && !isWindowsExecutable(command)
    let line: string | undefined
    try {
      line = shell ? [command, ...args].map(windowsShellWord).join(' ') : undefined
    } catch (error) {
      return Promise.reject(error)
    }
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio === 'capture' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell,
    }
    const child =
      line === undefined ? spawn(command, [...args], spawnOptions) : spawn(line, spawnOptions)
    let output = ''
    let cancelled = false
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    // Windows' kill is a forced end, and a child on this console already got its own Ctrl-C, so
    // it is left to shut down by itself.
    const forwards = platform !== 'win32' || options.stdio === 'capture'
    const interrupt = (): void => {
      cancelled = true
      if (forwards) child.kill('SIGINT')
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
}

export const spawnRunner: CommandRunner = createSpawnRunner()

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
