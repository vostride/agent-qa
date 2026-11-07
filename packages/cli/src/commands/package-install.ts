import { dirname, relative } from 'node:path'
import { compareSemverVersions, semverRangeFloor } from '@vostride/agent-qa-core'
import type { PackageJsonEntry, PackageJsonPlan } from './package-json-plan.js'
import { commandLine, plainInstall, runFromHere, type DetectedManager } from './package-manager.js'
import type { ProjectHost } from './project-host.js'
import { nearestInstalledPackage, type ProjectRange } from './project-range.js'

export interface InstallStepInput {
  host: ProjectHost
  range: ProjectRange
  packageJson: PackageJsonPlan
  manager: DetectedManager
  mode: 'run' | 'none'
  print?: (line: string) => void
  mask?: (text: string) => string
}

export interface InstallStepResult {
  outcome: 'installed' | 'skipped' | 'declared' | 'failed'
  command: string
  notes: string[]
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

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
  const { host, range, packageJson, manager } = input
  const print = input.print ?? ((line: string) => console.log(line))
  const plain = plainInstall(manager.name)
  const packageDir = dirname(packageJson.path)
  const command = runFromHere(commandLine(plain.command, plain.args), packageDir, range.start)
  const where = relative(range.start, packageJson.path) || 'package.json'
  const list = declaredList(packageJson.entries)

  if (input.mode === 'none') {
    print(`Declared ${list} in ${where}. Install with: ${command}`)
    return { outcome: 'declared', command, notes: [] }
  }

  const notes: string[] = []
  if (packageDir !== range.start) notes.push(`declared in ${where}`)
  const suffix = notes.map((note) => `; ${note}`).join('')
  const allInstalled = (): boolean =>
    packageJson.entries.every((entry) => isInstalled(input, entry))

  if (!packageJson.changed && allInstalled()) {
    const verb = packageJson.entries.length === 1 ? 'is' : 'are'
    print(`✓ ${list} ${verb} already installed; nothing to install`)
    return { outcome: 'skipped', command, notes }
  }

  print(`Installing ${list} with ${manager.name}…`)
  const result = await host.run(plain.command, plain.args, {
    cwd: packageDir,
    env: host.env,
    stdio: 'capture',
  })
  if (result.missing === true || result.code !== 0 || !allInstalled()) {
    const reason =
      result.missing === true
        ? `${manager.name} was not found`
        : `${manager.name} exited ${result.code ?? result.signal}`
    print(`✗ Install failed: ${reason}`)
    return { outcome: 'failed', command, notes }
  }
  print(`✓ Installed ${list} with ${manager.name}${suffix}`)
  return { outcome: 'installed', command, notes }
}
