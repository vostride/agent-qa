import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

const require = createRequire(import.meta.url)

type BetterSqlite3Constructor = typeof BetterSqlite3

interface RebuildCommand {
  command: string
  args: string[]
}

let sqliteConstructor: BetterSqlite3Constructor | null = null
let rebuildAttempted = false
let rebuildFailureMessage: string | null = null

function getBetterSqlite3ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isBetterSqlite3AbiMismatch(error: unknown): boolean {
  const message = getBetterSqlite3ErrorMessage(error)
  return (
    message.includes('better_sqlite3.node')
    && message.includes('compiled against a different Node.js version')
    && message.includes('NODE_MODULE_VERSION')
  )
}

function isBetterSqlite3MissingBindings(error: unknown): boolean {
  const message = getBetterSqlite3ErrorMessage(error)
  return (
    message.includes('better_sqlite3.node')
    && (
      message.includes('Could not locate the bindings file')
      || message.includes('Cannot find module')
      || (
        message.includes('dlopen(')
        && message.includes('no such file')
      )
    )
  )
}

export function isBetterSqlite3NativeModuleError(error: unknown): boolean {
  return isBetterSqlite3AbiMismatch(error) || isBetterSqlite3MissingBindings(error)
}

export function isBetterSqlite3NodeGypSymlinkConflict(error: unknown): boolean {
  const message = getBetterSqlite3ErrorMessage(error)
  return (
    message.includes('node_gyp_bins/python3')
    && message.includes('EEXIST')
  )
}

function resolveCurrentRuntimeNpmCliPath(): string | null {
  const nodeInstallRoot = dirname(dirname(process.execPath))
  const npmCliPath = join(nodeInstallRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(npmCliPath) ? npmCliPath : null
}

function resolveCurrentRuntimeNodeDir(): string | null {
  const nodeInstallRoot = dirname(dirname(process.execPath))
  const nodeHeaderPath = join(nodeInstallRoot, 'include', 'node', 'node.h')
  return existsSync(nodeHeaderPath) ? nodeInstallRoot : null
}

export function resolveBetterSqliteRebuildCommand(): RebuildCommand {
  const npmCliPath = resolveCurrentRuntimeNpmCliPath()
  if (npmCliPath) {
    return { command: process.execPath, args: [npmCliPath, 'run', 'build-release'] }
  }

  return { command: 'npm', args: ['run', 'build-release'] }
}

function clearBetterSqlite3Cache(): void {
  for (const cacheKey of Object.keys(require.cache)) {
    if (cacheKey.includes('better-sqlite3')) {
      delete require.cache[cacheKey]
    }
  }
  sqliteConstructor = null
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function waitForBetterSqlite3BuildOutput(installRoot: string, timeoutMs = 30_000): boolean {
  const bindingPath = join(installRoot, 'build', 'Release', 'better_sqlite3.node')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (existsSync(bindingPath)) {
      return true
    }
    sleepSync(200)
  }

  return existsSync(bindingPath)
}

function acquireBetterSqlite3RebuildLock(installRoot: string): () => void {
  const lockRoot = join(tmpdir(), 'agent-qa-better-sqlite3-rebuild-locks')
  const lockKey = createHash('sha256')
    .update(`${installRoot}\0${process.version}`)
    .digest('hex')
  const lockDir = join(lockRoot, lockKey)
  const deadline = Date.now() + 120_000

  mkdirSync(lockRoot, { recursive: true })

  while (true) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'owner'), `${process.pid}\n${new Date().toISOString()}\n${installRoot}\n`)
      return () => {
        rmSync(lockDir, { recursive: true, force: true })
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
      if (code !== 'EEXIST') {
        throw error
      }
      if (Date.now() > deadline) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      sleepSync(200)
    }
  }
}

function rebuildBetterSqlite3ForCurrentRuntime(originalError: unknown): void {
  if (rebuildAttempted) {
    if (rebuildFailureMessage) {
      throw new Error(rebuildFailureMessage)
    }
    throw originalError
  }
  rebuildAttempted = true

  const packageJsonPath = require.resolve('better-sqlite3/package.json')
  const installRoot = dirname(packageJsonPath)
  const rebuildCommand = resolveBetterSqliteRebuildCommand()
  const nodeGypDevDir = join(tmpdir(), 'agent-qa-node-gyp', process.version.replace(/^v/, ''))
  const npmCacheDir = join(tmpdir(), 'agent-qa-npm-cache')
  const nodeDir = resolveCurrentRuntimeNodeDir()
  const nodeGypBinsPath = join(installRoot, 'build', 'node_gyp_bins')
  const buildRoot = join(installRoot, 'build')

  const releaseLock = acquireBetterSqlite3RebuildLock(installRoot)
  try {
    clearBetterSqlite3Cache()
    try {
      sqliteConstructor = require('better-sqlite3') as BetterSqlite3Constructor
      rebuildFailureMessage = null
      return
    } catch (error) {
      if (!isBetterSqlite3NativeModuleError(error)) {
        throw error
      }
    }

    mkdirSync(nodeGypDevDir, { recursive: true })
    mkdirSync(npmCacheDir, { recursive: true })
    rmSync(buildRoot, { recursive: true, force: true })
    rmSync(nodeGypBinsPath, { recursive: true, force: true })

    if (!process.env.VITEST) {
      console.warn(`[agent-qa] Rebuilding better-sqlite3 for Node ${process.version} in ${installRoot}`)
    }

    try {
      execFileSync(rebuildCommand.command, rebuildCommand.args, {
        cwd: installRoot,
        stdio: 'pipe',
        env: {
          ...process.env,
          npm_config_devdir: nodeGypDevDir,
          npm_config_cache: npmCacheDir,
          ...(nodeDir ? { npm_config_nodedir: nodeDir } : {}),
        },
      })
      rebuildFailureMessage = null
    } catch (rebuildError) {
      if (isBetterSqlite3NodeGypSymlinkConflict(rebuildError) && waitForBetterSqlite3BuildOutput(installRoot)) {
        rebuildFailureMessage = null
        clearBetterSqlite3Cache()
        return
      }

      const stderr = rebuildError instanceof Error && 'stderr' in rebuildError
        ? String((rebuildError as { stderr?: string | Buffer }).stderr ?? '')
        : ''
      rebuildFailureMessage = (
        `Failed to rebuild better-sqlite3 for Node ${process.version}.\n${stderr || String(rebuildError)}`
      )
      throw new Error(rebuildFailureMessage)
    }
  } finally {
    releaseLock()
  }

  clearBetterSqlite3Cache()
}

function loadBetterSqlite3(): BetterSqlite3Constructor {
  if (sqliteConstructor) {
    return sqliteConstructor
  }

  sqliteConstructor = require('better-sqlite3') as BetterSqlite3Constructor
  return sqliteConstructor
}

export type BetterSqlite3Database = import('better-sqlite3').Database

function openBetterSqlite3Database(path: string): BetterSqlite3Database {
  const Database = loadBetterSqlite3()
  return new Database(path)
}

export function createBetterSqlite3Database(path: string): BetterSqlite3Database {
  try {
    return openBetterSqlite3Database(path)
  } catch (error) {
    if (!isBetterSqlite3NativeModuleError(error)) {
      throw error
    }

    rebuildBetterSqlite3ForCurrentRuntime(error)
    return openBetterSqlite3Database(path)
  }
}
