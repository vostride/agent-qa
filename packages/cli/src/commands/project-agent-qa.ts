import { dirname, relative, resolve } from 'node:path'
import pc from 'picocolors'
import { compareSemverVersions, isPathInsideDir } from '@vostride/agent-qa-core'
import { CliRefusal } from '../composition/cli-refusal.js'
import { wasCancelled } from './package-manager.js'
import type { ProjectHost, ProjectIo } from './project-host.js'
import { nearestInstalledPackage, type ProjectRange } from './project-range.js'

export const HANDED_OFF_ENV = 'AGENT_QA_HANDED_OFF'

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

export interface ProjectAgentQa {
  dir: string
  realDir: string
  version: string
  bin: string
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function parsed(text: string | undefined): JsonObject | undefined {
  try {
    return asObject(JSON.parse(text ?? ''))
  } catch {
    return undefined
  }
}

// A copy counts only when it is named agent-qa, has an exact version and its bin stays inside it.
export async function findProjectAgentQa(
  range: ProjectRange,
  fromDir: string,
  io: ProjectIo,
): Promise<ProjectAgentQa | undefined> {
  const manifest = nearestInstalledPackage(range, fromDir, 'agent-qa', io)
  if (manifest === undefined) return undefined
  const pkg = parsed(io.readText(manifest))
  if (pkg?.name !== 'agent-qa') return undefined
  const version = pkg.version
  if (typeof version !== 'string' || !EXACT_SEMVER.test(version)) return undefined
  const binPath = typeof pkg.bin === 'string' ? pkg.bin : asObject(pkg.bin)?.['agent-qa']
  if (typeof binPath !== 'string' || binPath === '') return undefined
  const dir = dirname(manifest)
  const realDir = await io.realpath(dir)
  const bin = await io.realpath(resolve(dir, binPath))
  if (!isPathInsideDir(bin, realDir) || !io.exists(bin)) return undefined
  return { dir, realDir, version, bin }
}

export async function runAsProjectAgentQa(
  copy: ProjectAgentQa,
  host: ProjectHost,
  line: string,
): Promise<void> {
  console.log(line)
  const result = await host.run(host.execPath, [copy.bin, ...host.argv], {
    cwd: host.cwd,
    env: { ...host.env, [HANDED_OFF_ENV]: '1' },
    stdio: 'inherit',
  })
  if (wasCancelled(result)) throw new CliRefusal([], 130)
  if (result.missing === true) {
    throw new CliRefusal([pc.red(`${host.execPath} was not found to run ${copy.bin}.`)], 1)
  }
  if (result.code === 0) return
  throw new CliRefusal([], result.code ?? 1)
}

function isNewer(version: string, than: string): boolean {
  return compareSemverVersions(version, than) === 1
}

function handOffLine(copy: ProjectAgentQa, range: ProjectRange, runningVersion: string): string {
  const where = relative(range.start, copy.dir) || '.'
  return (
    `Handing over to the project's agent-qa ${copy.version} (${where}), ` +
    `which is newer than this one (${runningVersion}).`
  )
}

export async function handOffToProjectAgentQa(input: {
  host: ProjectHost
  range: ProjectRange
  packageJson: { path: string; text: string | undefined }
  runningVersion: string
  pm: string | undefined
  install: () => Promise<boolean>
}): Promise<boolean> {
  const { host, range, packageJson, runningVersion } = input
  if ((host.env[HANDED_OFF_ENV] ?? '') !== '') return false
  const fromDir = packageJson.text === undefined ? range.start : dirname(packageJson.path)
  const copy = await findProjectAgentQa(range, fromDir, host.io)
  if (copy === undefined || !isNewer(copy.version, runningVersion)) return false
  await runAsProjectAgentQa(copy, host, handOffLine(copy, range, runningVersion))
  return true
}
