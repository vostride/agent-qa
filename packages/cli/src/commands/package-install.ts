import { dirname, relative } from 'node:path'
import type { PackageJsonPlan } from './package-json-plan.js'
import { commandLine, plainInstall, runFromHere, type DetectedManager } from './package-manager.js'
import type { ProjectHost } from './project-host.js'
import type { ProjectRange } from './project-range.js'

export interface InstallStepInput {
  host: ProjectHost
  range: ProjectRange
  packageJson: PackageJsonPlan
  manager: DetectedManager
  mode: 'none'
  print?: (line: string) => void
}

export interface InstallStepResult {
  outcome: 'declared'
  command: string
  notes: string[]
}

export function declaredList(entries: PackageJsonPlan['entries']): string {
  const items = entries.map((entry) =>
    entry.outcome === 'kept' ? `${entry.name} (${entry.spec})` : `${entry.name} ${entry.spec}`,
  )
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

export async function runInstallStep(input: InstallStepInput): Promise<InstallStepResult> {
  const { range, packageJson, manager } = input
  const print = input.print ?? ((line: string) => console.log(line))
  const plain = plainInstall(manager.name)
  const command = runFromHere(
    commandLine(plain.command, plain.args),
    dirname(packageJson.path),
    range.start,
  )
  const where = relative(range.start, packageJson.path) || 'package.json'
  print(`Declared ${declaredList(packageJson.entries)} in ${where}. Install with: ${command}`)
  return { outcome: 'declared', command, notes: [] }
}
