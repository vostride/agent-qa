import { dirname, relative } from 'node:path'
import { compareSemverVersions, semverRangeFloor } from '@vostride/agent-qa-core'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import { PromptCancelled } from '../composition/cli-refusal.js'
import type { PackageJsonEntry, PackageJsonPlan } from './package-json-plan.js'
import {
  commandLine,
  managerEnv,
  plainInstall,
  resolveInstallCommand,
  runFromHere,
  wasCancelled,
  withResolvedYarnLine,
  type DetectedManager,
} from './package-manager.js'
import { ignoredBuildNames, prepareManagerSettings } from './package-manager-settings.js'
import type { ProjectHost, ProjectIo } from './project-host.js'
import { nearestInstalledPackage, type ProjectRange } from './project-range.js'

export interface InstallStepInput {
  host: ProjectHost
  range: ProjectRange
  packageJson: PackageJsonPlan
  manager: DetectedManager
  mode: 'run' | 'none'
  print?: (line: string) => void
  mask?: InstallOutputMask
}

// Undefined when the declared secrets cannot be read to mask the text.
export type InstallOutputMask = (text: string) => Promise<string | undefined>

export interface InstallStepResult {
  outcome: 'installed' | 'skipped' | 'declared' | 'failed'
  command: string
  notes: string[]
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const FAILURE_OUTPUT_LINES = 20

export const OUTPUT_HIDDEN =
  "The manager's output is not shown: the declared secrets that would mask it could not be read."

// A config or secrets file that does not exist declares nothing; one that exists but cannot be read
// may, so the output is withheld rather than printed unmasked.
export function installOutputMask(configPath: string, io: ProjectIo): InstallOutputMask {
  return async (text) => {
    if (!io.exists(configPath)) return text
    const secrets = await import('../composition/declared-secrets.js')
    try {
      return secrets.createDeclaredSecretMask(configPath).mask(text)
    } catch (error) {
      const declaresNothing =
        error instanceof secrets.DeclaredSecretsUnavailableError &&
        (error.gap === 'required' || error.gap === 'missing')
      return declaresNothing ? text : undefined
    }
  }
}

// The last non-blank lines of captured output, masked and redacted, or the notice that hides them.
export async function shownOutput(
  output: string,
  mask: InstallOutputMask | undefined,
  count: number,
): Promise<string[]> {
  if (output.trim() === '') return []
  const masked = mask === undefined ? output : await mask(output)
  if (masked === undefined) return [OUTPUT_HIDDEN]
  return redactInstallOutput(masked)
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .slice(-count)
}

export function redactInstallOutput(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:)[^\s/@]+@/giu, '$1***@')
    .replace(/(_(?:authToken|auth|password)\s*=\s*)[^\s"']+/gu, '$1***')
    .replace(/(\bBearer\s+)[^\s"']+/giu, '$1***')
}

export function declaredList(entries: PackageJsonPlan['entries']): string {
  const items = entries.map((entry) =>
    entry.outcome === 'kept' ? `${entry.name} (${entry.spec})` : `${entry.name} ${entry.spec}`,
  )
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function installedVersion(
  input: Pick<InstallStepInput, 'host' | 'range' | 'packageJson'>,
  name: string,
): string | null | undefined {
  const { host, range, packageJson } = input
  const path = nearestInstalledPackage(range, dirname(packageJson.path), name, host.io)
  if (path === undefined) return undefined
  try {
    const version = (JSON.parse(host.io.readText(path) ?? '') as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

function isInstalled(
  input: Pick<InstallStepInput, 'host' | 'range' | 'packageJson'>,
  entry: PackageJsonEntry,
): boolean {
  const version = installedVersion(input, entry.name)
  if (version === undefined) return false
  if (entry.outcome === 'kept') return true
  if (version === null) return false
  if (EXACT_SEMVER.test(entry.spec)) return version === entry.spec
  const floor = semverRangeFloor(entry.spec)
  return floor !== undefined && (compareSemverVersions(version, floor) ?? -1) >= 0
}

export async function runInstallStep(input: InstallStepInput): Promise<InstallStepResult> {
  const { host, range, packageJson } = input
  let manager = input.manager
  const print = input.print ?? ((line: string) => console.log(line))
  const plain = plainInstall(manager.name)
  const packageDir = dirname(packageJson.path)
  const command = runFromHere(commandLine(plain.command, plain.args), packageDir, range.start)
  const where = relative(range.start, packageJson.path) || 'package.json'
  const list = declaredList(packageJson.entries)
  const prepare = (deny?: readonly string[]) =>
    prepareManagerSettings({ manager, range, packageDir, host, ...(deny ? { deny } : {}) })

  if (input.mode === 'none') {
    const settings = await prepare()
    const noted = settings.map((note) => `; ${note}`).join('')
    print(`Declared ${list} in ${where}. Install with: ${command}${noted}`)
    return { outcome: 'declared', command, notes: settings }
  }

  const notes: string[] = []
  if (packageDir !== range.start) notes.push(`declared in ${where}`)
  const unverified = (): PackageJsonEntry[] =>
    packageJson.entries.filter((entry) => !isInstalled(input, entry))

  if (!packageJson.changed && unverified().length === 0) {
    const verb = packageJson.entries.length === 1 ? 'is' : 'are'
    print(`✓ ${list} ${verb} already installed; nothing to install`)
    return { outcome: 'skipped', command, notes }
  }

  const resolved = await resolveInstallCommand(manager, { ...host, cwd: packageDir })
  manager = withResolvedYarnLine(manager, resolved)
  const settings = await prepare()
  print(`Installing ${list} with ${manager.name}…`)
  if (resolved.via !== 'path') notes.push(`through ${resolved.via}`)
  const env = managerEnv(manager.name, resolved.via, host.env)
  // A Ctrl-C leaves package.json declared for the next run: nothing is rolled back.
  const install = async (args: readonly string[]) => {
    const options = { cwd: packageDir, env, stdio: 'capture' } as const
    const result = await host.run(resolved.command, args, options)
    if (wasCancelled(result)) throw new PromptCancelled()
    return result
  }
  let args = resolved.args
  let result = await install(args)
  const peerConflict =
    manager.name === 'npm' &&
    result.code !== null &&
    result.code !== 0 &&
    /\bERESOLVE\b/u.test(result.output)
  if (peerConflict) {
    args = [...resolved.args, '--legacy-peer-deps']
    result = await install(args)
  }
  const ignoredBuilds =
    manager.name === 'pnpm' &&
    result.code !== null &&
    result.code !== 0 &&
    result.output.includes('ERR_PNPM_IGNORED_BUILDS')
  if (ignoredBuilds) {
    // A refused file yields an "add …" note rather than a denial; the later note replaces it.
    const again = await prepare(ignoredBuildNames(result.output))
    const written = (note: string) => note.startsWith('denied ')
    settings.splice(0, settings.length, ...settings.filter(written), ...again)
    if (again.some(written)) result = await install(args)
  }
  const ran = runFromHere(commandLine(resolved.command, args), packageDir, range.start)
  const missing = result.missing === true || result.code !== 0 ? [] : unverified()
  if (result.missing === true || result.code !== 0 || missing.length > 0) {
    const name = manager.name
    const notInstalled = `${declaredList(missing)} ${missing.length === 1 ? 'is' : 'are'}`
    const reason =
      result.missing === true
        ? `${resolved.command} was not found`
        : result.code === null
          ? `${name} stopped on ${result.signal ?? 'an unknown signal'}`
          : result.code !== 0
            ? `${name} exited ${result.code}`
            : `${name} exited 0, but ${notInstalled} not installed`
    print(`✗ Install failed: ${reason}${settings.map((note) => `; ${note}`).join('')}`)
    if (result.missing !== true && result.code !== 0) {
      const lines = await shownOutput(result.output, input.mask, FAILURE_OUTPUT_LINES)
      if (lines.length > 0) {
        printRunText(lines.map((line) => `  ${line}`).join('\n'), print, { env: host.env })
      }
    }
    print(`  Run: ${ran}`)
    return { outcome: 'failed', command: ran, notes: [...notes, ...settings] }
  }
  if (peerConflict) notes.push('installed with --legacy-peer-deps: npm found a peer conflict')
  notes.push(...settings)
  const noted = notes.map((note) => `; ${note}`).join('')
  print(`✓ Installed ${list} with ${manager.name}${noted}`)
  return { outcome: 'installed', command: ran, notes }
}
