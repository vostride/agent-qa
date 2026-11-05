import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IOSHere, SimulatorHere } from '@vostride/agent-qa-core'

export type ListingExec = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>

export interface ListIOSSimulatorsHereOptions {
  exec?: ListingExec
  platform?: string
}

const LISTING_TIMEOUT_MS = 10_000

const execFileAsync = promisify(execFile)

const defaultExec: ListingExec = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { stdout }
}

type Outcome = { json: unknown } | { problem: string }

async function simctl(exec: ListingExec, what: 'devices' | 'runtimes'): Promise<Outcome> {
  let stdout: string
  try {
    const args = ['simctl', 'list', what, '--json']
    stdout = (await exec('xcrun', args, { timeout: LISTING_TIMEOUT_MS })).stdout
  } catch (error) {
    const err = error as { code?: unknown; killed?: unknown; stderr?: unknown; message?: unknown }
    if (err.code === 'ENOENT') return { problem: 'xcrun not found (install Xcode)' }
    if (err.killed === true || err.code === 'ETIMEDOUT') {
      return { problem: `xcrun simctl did not answer within ${LISTING_TIMEOUT_MS / 1000} s` }
    }
    const text = [err.stderr, err.message].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    )
    const line = text?.trim().split(/\r?\n/)[0] ?? 'unknown error'
    return { problem: `xcrun simctl failed: ${line.slice(0, 200)}` }
  }
  try {
    return { json: JSON.parse(stdout) }
  } catch {
    return { problem: `xcrun simctl list ${what} printed something other than JSON` }
  }
}

interface Runtime {
  identifier?: unknown
  version?: unknown
  platform?: unknown
}

interface Device {
  name?: unknown
  udid?: unknown
  state?: unknown
  isAvailable?: unknown
}

function iosRuntimeVersions(json: unknown): Map<string, string> {
  const runtimes = (json as { runtimes?: unknown } | null)?.runtimes
  const versions = new Map<string, string>()
  if (!Array.isArray(runtimes)) return versions
  for (const runtime of runtimes as Runtime[]) {
    if (runtime?.platform !== 'iOS') continue
    if (typeof runtime.identifier !== 'string' || typeof runtime.version !== 'string') continue
    versions.set(runtime.identifier, runtime.version)
  }
  return versions
}

function simulatorsOn(json: unknown, versions: Map<string, string>): SimulatorHere[] {
  const devices = (json as { devices?: unknown } | null)?.devices
  if (devices === null || typeof devices !== 'object') return []
  const simulators: SimulatorHere[] = []
  for (const [runtime, list] of Object.entries(devices as Record<string, unknown>)) {
    const os = versions.get(runtime)
    if (os === undefined || !Array.isArray(list)) continue
    for (const device of list as Device[]) {
      if (device?.isAvailable === false) continue
      if (typeof device.name !== 'string' || typeof device.udid !== 'string') continue
      simulators.push({
        name: device.name,
        udid: device.udid,
        os,
        state: typeof device.state === 'string' ? device.state : 'Unknown',
        available: true,
      })
    }
  }
  return simulators
}

export async function listIOSSimulatorsHere(
  options: ListIOSSimulatorsHereOptions = {},
): Promise<IOSHere> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return { simulators: [], problem: 'simulators need macOS' }
  const exec = options.exec ?? defaultExec
  const runtimes = await simctl(exec, 'runtimes')
  if ('problem' in runtimes) return { simulators: [], problem: runtimes.problem }
  const devices = await simctl(exec, 'devices')
  if ('problem' in devices) return { simulators: [], problem: devices.problem }
  return { simulators: simulatorsOn(devices.json, iosRuntimeVersions(runtimes.json)) }
}
