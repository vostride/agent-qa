import type { AgentQaConfig } from '@vostride/agent-qa-core'

import type { CheckResult, DoctorCheck } from './doctor.js'
import type { DevicePlaceView, DevicesHereLister } from './run.js'

export interface DeviceChecksInput {
  config: Record<string, unknown> | null
  listDevicesHere?: DevicesHereLister
}

const DEVICE_FIX =
  '`npx agent-qa devices` lists what this machine has; connect a phone, start an emulator or boot a simulator that matches.'

// The run module is large, so doctor reaches it only when a device row runs.
const listDevicesHereByDefault: DevicesHereLister = async (platform) =>
  await (await import('./run.js')).listDevicesHereByDefault(platform)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function profileNames(config: Record<string, unknown> | null): string[] {
  const registry = config?.registry
  const devices = isRecord(registry) ? registry.devices : undefined
  return isRecord(devices) ? Object.keys(devices) : []
}

function placeResult(place: DevicePlaceView, text: string): CheckResult {
  if ('notHere' in place) return { status: 'warn', message: text, fix: DEVICE_FIX }
  return { status: 'pass', message: text }
}

async function placeResults(
  config: AgentQaConfig,
  names: readonly string[],
  list: DevicesHereLister,
): Promise<Map<string, CheckResult>> {
  try {
    const { describeDevices, placeText } = await import('./run.js')
    const view = await describeDevices(config, { listDevicesHere: list })
    return new Map(view.devices.map((place) => [place.name, placeResult(place, placeText(place))]))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const result: CheckResult = {
      status: 'warn',
      message: `could not list this machine's devices: ${reason}`,
      fix: DEVICE_FIX,
    }
    return new Map(names.map((name) => [name, result]))
  }
}

// One row per profile, as `agent-qa devices` sees it; every row shares one listing.
export function createDeviceChecks(input: DeviceChecksInput): DoctorCheck[] {
  const names = profileNames(input.config)
  if (names.length === 0) return []
  const list = input.listDevicesHere ?? listDevicesHereByDefault
  let results: Promise<Map<string, CheckResult>> | undefined
  const shared = () =>
    (results ??= placeResults(input.config as unknown as AgentQaConfig, names, list))
  return names.map((name) => ({
    name: `Device ${name}`,
    fixInstructions: DEVICE_FIX,
    check: async () =>
      (await shared()).get(name) ?? { status: 'skip', message: 'not in the device listing' },
  }))
}
