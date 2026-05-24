import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pc from 'picocolors'
import { getAgentQaUpdateStatus } from '@vostride/agent-qa-core'

export type AgentQaUpdateNoticeReporterSelection = {
  console: boolean
  stdoutLive: boolean
  junit?: boolean
  dashboard?: boolean
}

export type AgentQaUpdateNoticeContext = {
  reporterSelection: AgentQaUpdateNoticeReporterSelection
  effectiveLogLevel: string
  liveEvents?: string
  cwd?: string
  log?: (line?: string) => void
}

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

const RELEASES_URL = 'https://github.com/vostride/agent-qa/releases'
const UPDATE_COMMANDS: Record<PackageManager, string> = {
  pnpm: 'pnpm add -D agent-qa@latest',
  npm: 'npm install --save-dev agent-qa@latest',
  yarn: 'yarn add --dev agent-qa@latest',
  bun: 'bun add --dev agent-qa@latest',
}

const LOCKFILES: Array<{ file: string; packageManager: PackageManager }> = [
  { file: 'pnpm-lock.yaml', packageManager: 'pnpm' },
  { file: 'package-lock.json', packageManager: 'npm' },
  { file: 'npm-shrinkwrap.json', packageManager: 'npm' },
  { file: 'yarn.lock', packageManager: 'yarn' },
  { file: 'bun.lock', packageManager: 'bun' },
  { file: 'bun.lockb', packageManager: 'bun' },
]

export function shouldPrintAgentQaUpdateNotice(context: AgentQaUpdateNoticeContext): boolean {
  return Boolean(
    context.reporterSelection.console &&
      !context.reporterSelection.stdoutLive &&
      context.liveEvents !== 'true' &&
      context.effectiveLogLevel !== 'quiet' &&
      context.effectiveLogLevel !== 'silent',
  )
}

export function inferAgentQaDevDependencyUpdateCommand(cwd = process.cwd()): string | undefined {
  try {
    const packageJsonPath = join(cwd, 'package.json')
    if (!existsSync(packageJsonPath)) return undefined

    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as unknown
    if (!isRecord(manifest) || !hasAgentQaDevDependency(manifest)) return undefined

    const packageManager = inferPackageManager(manifest, cwd)
    return packageManager ? UPDATE_COMMANDS[packageManager] : undefined
  } catch {
    return undefined
  }
}

export async function printAgentQaUpdateNoticeIfNeeded(
  context: AgentQaUpdateNoticeContext,
): Promise<void> {
  try {
    if (!shouldPrintAgentQaUpdateNotice(context)) return

    const status = await getAgentQaUpdateStatus()
    const installedVersion = status.installedVersion.trim()
    const latestVersion = typeof status.latestVersion === 'string'
      ? status.latestVersion.trim()
      : ''
    if (!status.updateAvailable || !latestVersion) return

    const command = inferAgentQaDevDependencyUpdateCommand(context.cwd)
    const log = context.log ?? console.log

    log()
    log(`${pc.bold('Update available:')} agent-qa v${latestVersion}`)
    if (installedVersion) {
      log(pc.dim(`Current version: v${installedVersion}`))
    }
    log(`Releases: ${pc.cyan(RELEASES_URL)}`)
    if (command) {
      log(`Update: ${pc.cyan(command)}`)
    }
  } catch {
    // Update notices are optional and must never change CLI run outcomes.
  }
}

function hasAgentQaDevDependency(manifest: Record<string, unknown>): boolean {
  const devDependencies = manifest.devDependencies
  return (
    isRecord(devDependencies) &&
    Object.prototype.hasOwnProperty.call(devDependencies, 'agent-qa')
  )
}

function inferPackageManager(
  manifest: Record<string, unknown>,
  cwd: string,
): PackageManager | undefined {
  if (typeof manifest.packageManager === 'string') {
    return packageManagerFromSpecifier(manifest.packageManager)
  }

  const matchingLockfiles = LOCKFILES.filter(({ file }) => existsSync(join(cwd, file)))
  return matchingLockfiles.length === 1 ? matchingLockfiles[0].packageManager : undefined
}

function packageManagerFromSpecifier(specifier: string): PackageManager | undefined {
  const name = specifier.split('@')[0]
  if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') {
    return name
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
