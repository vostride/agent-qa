import { join, relative } from 'node:path'
import { PromptCancelled } from '../composition/cli-refusal.js'
import type { ProjectHost, ProjectIo, RunResult } from './project-host.js'
import { nearestFile, type ProjectRange } from './project-range.js'

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun'

export const PACKAGE_MANAGERS: readonly PackageManagerName[] = ['npm', 'pnpm', 'yarn', 'bun']

// npm goes last: a stray package-lock.json is the common duplicate.
export const LOCKFILES: readonly { file: string; manager: PackageManagerName }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
]

export interface DetectedManager {
  name: PackageManagerName
  version?: string
  yarnLine?: 'classic' | 'berry'
  source: 'flag' | 'packageManager' | 'lockfile' | 'devEngines' | 'user-agent' | 'default'
}

interface Declared {
  name: PackageManagerName
  version?: string
}

type JsonObject = Record<string, unknown>

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const PACKAGE_MANAGER_FIELD = /^(npm|pnpm|yarn|bun)@([^+]+)/u

function isManager(value: unknown): value is PackageManagerName {
  return typeof value === 'string' && (PACKAGE_MANAGERS as readonly string[]).includes(value)
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function declared(name: PackageManagerName, version: unknown): Declared {
  return typeof version === 'string' && EXACT_SEMVER.test(version) ? { name, version } : { name }
}

function readManifest(folder: string, io: ProjectIo): JsonObject | undefined {
  const path = join(folder, 'package.json')
  if (!io.exists(path)) return undefined
  const text = io.readText(path)
  if (text === undefined) return undefined
  try {
    return asObject(JSON.parse(text))
  } catch {
    return undefined
  }
}

function fromPackageManagerField(manifest: JsonObject): Declared | undefined {
  const field = manifest.packageManager
  if (typeof field !== 'string') return undefined
  const match = PACKAGE_MANAGER_FIELD.exec(field)
  return match ? declared(match[1] as PackageManagerName, match[2]) : undefined
}

function fromDevEngines(manifest: JsonObject): Declared | undefined {
  const value = asObject(manifest.devEngines)?.packageManager
  const candidates = Array.isArray(value) ? value : [value]
  for (const candidate of candidates) {
    const entry = asObject(candidate)
    if (entry !== undefined && isManager(entry.name)) return declared(entry.name, entry.version)
  }
  return undefined
}

function firstDeclared(
  range: ProjectRange,
  io: ProjectIo,
  read: (manifest: JsonObject) => Declared | undefined,
): Declared | undefined {
  for (const folder of range.folders) {
    const manifest = readManifest(folder, io)
    const found = manifest === undefined ? undefined : read(manifest)
    if (found !== undefined) return found
  }
  return undefined
}

function fromLockfiles(range: ProjectRange, io: ProjectIo): PackageManagerName | undefined {
  for (const folder of range.folders) {
    const lockfile = LOCKFILES.find(({ file }) => io.exists(join(folder, file)))
    if (lockfile !== undefined) return lockfile.manager
  }
  return undefined
}

function fromUserAgent(env: NodeJS.ProcessEnv): PackageManagerName | undefined {
  const name = env.npm_config_user_agent?.split('/')[0]
  return isManager(name) ? name : undefined
}

function yarnLine(
  version: string | undefined,
  range: ProjectRange,
  io: ProjectIo,
): DetectedManager['yarnLine'] {
  if (version !== undefined) return Number(version.split('.')[0]) >= 2 ? 'berry' : 'classic'
  const lockfile = nearestFile(range, 'yarn.lock', io)
  const text = lockfile === undefined ? undefined : io.readText(lockfile)
  if (text !== undefined) {
    if (/^__metadata:/mu.test(text)) return 'berry'
    if (/^# yarn lockfile v1\s*$/mu.test(text)) return 'classic'
  }
  if (nearestFile(range, '.yarnrc.yml', io) !== undefined) return 'berry'
  if (nearestFile(range, '.yarnrc', io) !== undefined) return 'classic'
  return undefined
}

export function detectPackageManager(input: {
  range: ProjectRange
  env: NodeJS.ProcessEnv
  flag?: PackageManagerName
  io: ProjectIo
}): DetectedManager {
  const { range, env, flag, io } = input
  const packageManagerField = firstDeclared(range, io, fromPackageManagerField)
  let found: Omit<DetectedManager, 'yarnLine'>
  if (flag !== undefined) {
    const version = packageManagerField?.name === flag ? packageManagerField.version : undefined
    found = { name: flag, ...(version === undefined ? {} : { version }), source: 'flag' }
  } else if (packageManagerField !== undefined) {
    found = { ...packageManagerField, source: 'packageManager' }
  } else {
    const lockfile = fromLockfiles(range, io)
    const devEngines = lockfile === undefined ? firstDeclared(range, io, fromDevEngines) : undefined
    const userAgent = fromUserAgent(env)
    found =
      lockfile !== undefined
        ? { name: lockfile, source: 'lockfile' }
        : devEngines !== undefined
          ? { ...devEngines, source: 'devEngines' }
          : userAgent !== undefined
            ? { name: userAgent, source: 'user-agent' }
            : { name: 'npm', source: 'default' }
  }
  if (found.name !== 'yarn') return found
  const line = yarnLine(found.version, range, io)
  return line === undefined ? found : { ...found, yarnLine: line }
}

export function plainInstall(name: PackageManagerName): { command: string; args: string[] } {
  return { command: name, args: ['install'] }
}

export interface ResolvedCommand {
  command: string
  args: string[]
  via: 'path' | 'corepack' | 'npx'
}

type RunHost = Pick<ProjectHost, 'run' | 'env' | 'cwd'>

const DROPPED_KEYS = new Set([
  'node_env',
  'npm_command',
  'npm_execpath',
  'npm_node_execpath',
  'init_cwd',
  // npx sets these for its own run; every other npm_config_* carries the person's registry, proxy
  // and TLS settings, which pnpm, Yarn 1, Bun and an npx fallback all read.
  'npm_config_user_agent',
  'npm_config_local_prefix',
  'npm_config_global_prefix',
  'npm_config_node_gyp',
  'npm_config_npm_version',
  'npm_config_allow_scripts',
  'npm_config_package',
  'npm_config_call',
  'npm_config_yes',
])
const DROPPED_PREFIXES = ['npm_package_', 'npm_lifecycle_']

// npx, CI and the shell hand down variables that change what the manager installs: NODE_ENV
// skips devDependencies under npm and Yarn 1, and CI freezes the lockfile under pnpm and Yarn.
export function managerEnv(
  name: PackageManagerName,
  via: ResolvedCommand['via'],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const set: NodeJS.ProcessEnv = {}
  if (name === 'pnpm') {
    set.PNPM_CONFIG_FROZEN_LOCKFILE = 'false'
    set.npm_config_frozen_lockfile = 'false'
  }
  if (name === 'yarn') set.YARN_ENABLE_IMMUTABLE_INSTALLS = 'false'
  if (via === 'corepack') set.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  const overridden = new Set(Object.keys(set).map((key) => key.toLowerCase()))
  const kept: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase()
    if (DROPPED_KEYS.has(lower) || overridden.has(lower)) continue
    if (DROPPED_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue
    kept[key] = value
  }
  return { ...kept, ...set }
}

export function wasCancelled(result: RunResult): boolean {
  return result.cancelled === true || result.signal === 'SIGINT'
}

function majorOf(version: string): number | undefined {
  const match = /^v?(\d+)\./u.exec(version.trim())
  return match === null ? undefined : Number(match[1])
}

async function versionOf(
  command: string,
  env: NodeJS.ProcessEnv,
  host: RunHost,
): Promise<string | undefined> {
  const result = await host.run(command, ['--version'], { cwd: host.cwd, env, stdio: 'capture' })
  if (wasCancelled(result)) throw new PromptCancelled()
  if (result.missing === true || result.code !== 0) return undefined
  return result.output.split(/\r?\n/u)[0]?.trim() ?? ''
}

function npxPackage(manager: DetectedManager): string[] {
  const at = manager.version === undefined ? '' : `@${manager.version}`
  // The yarn package on npm is Yarn 1 only; Yarn 2 and later publish their CLI as cli-dist.
  if (manager.name === 'yarn' && manager.yarnLine === 'berry') {
    return ['-p', `@yarnpkg/cli-dist${at}`, 'yarn']
  }
  return [`${manager.name}${at}`]
}

// A manager on PATH at another major than the declared one counts as missing: Yarn 1 would
// install a Yarn 4 project as Yarn 1.
export async function resolveInstallCommand(
  manager: DetectedManager,
  host: RunHost,
): Promise<ResolvedCommand> {
  const { name, version } = manager
  const onPath = await versionOf(name, managerEnv(name, 'path', host.env), host)
  if (onPath !== undefined && (version === undefined || majorOf(onPath) === majorOf(version))) {
    return { command: name, args: ['install'], via: 'path' }
  }
  const corepack = name === 'bun' ? undefined : managerEnv(name, 'corepack', host.env)
  if (corepack !== undefined && (await versionOf('corepack', corepack, host)) !== undefined) {
    const pinned = version === undefined ? name : `${name}@${version}`
    return { command: 'corepack', args: [pinned, 'install'], via: 'corepack' }
  }
  return { command: 'npx', args: ['-y', ...npxPackage(manager), 'install'], via: 'npx' }
}

// A read-only registry lookup through the same command the install resolved, so it honours the
// project's registry settings. A Yarn whose line is unknown is asked as Yarn 1.
export function viewCommand(
  resolved: ResolvedCommand,
  manager: DetectedManager,
  spec: string,
): { command: string; args: string[] } {
  const lookup =
    manager.name === 'yarn'
      ? manager.yarnLine === 'berry'
        ? ['npm', 'info', spec, '--json']
        : ['info', spec, '--json']
      : manager.name === 'bun'
        ? ['pm', 'view', spec, '--json']
        : ['view', spec, '--json']
  const prefix = resolved.args.at(-1) === 'install' ? resolved.args.slice(0, -1) : resolved.args
  return { command: resolved.command, args: [...prefix, ...lookup] }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function unwrapView(value: unknown): JsonObject | undefined {
  const object = asObject(Array.isArray(value) ? value.at(-1) : value)
  return object?.type === 'inspect' ? asObject(object.data) : object
}

// Yarn 1 answers one JSON object per line, and a manager may print warnings before its answer.
export function parsePackageView(output: string): Record<string, unknown> | undefined {
  const whole = parseJson(output.trim())
  if (whole !== undefined) return unwrapView(whole)
  const lines = output.split(/\r?\n/u)
  for (const line of lines) {
    const value = parseJson(line.trim())
    if (asObject(value)?.type === 'inspect') return unwrapView(value)
  }
  for (const [index, line] of lines.entries()) {
    if (!/^\s*[[{]/u.test(line)) continue
    const value = parseJson(lines.slice(index).join('\n'))
    if (value !== undefined) return unwrapView(value)
  }
  return undefined
}

function shellWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/u.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellWord).join(' ')
}

export function runFromHere(line: string, packageDir: string, cwd: string): string {
  const path = relative(cwd, packageDir)
  return path === '' ? line : `cd ${shellWord(path)} && ${line}`
}
