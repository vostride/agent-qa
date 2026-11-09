import {
  AgentQaConfigSchema,
  type AgentQaConfig,
  type AndroidHere,
  type IOSHere,
} from '@vostride/agent-qa-core'

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

const NOTHING_LISTED: { readonly android: AndroidHere; readonly ios: IOSHere } = {
  android: { attached: [], avds: [] },
  ios: { simulators: [] },
}

// A platform no local profile runs on answers its empty listing, so its tools are never asked.
function listingOnlyWhereNeeded(config: AgentQaConfig, list: DevicesHereLister): DevicesHereLister {
  const needed = new Set(
    Object.values(config.registry?.devices ?? {})
      .filter((profile) => profile.remote === undefined)
      .map((profile) => profile.platform),
  )
  return async (platform) =>
    needed.has(platform) ? await list(platform) : NOTHING_LISTED[platform]
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
    const view = await describeDevices(config, {
      listDevicesHere: listingOnlyWhereNeeded(config, list),
    })
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
  const parsed = AgentQaConfigSchema.safeParse(input.config)
  if (!parsed.success) {
    return [
      {
        name: 'Devices',
        fixInstructions: DEVICE_FIX,
        check: async () => ({ status: 'skip', message: 'the config is not valid' }),
      },
    ]
  }
  const config = parsed.data as AgentQaConfig
  const list = input.listDevicesHere ?? listDevicesHereByDefault
  let results: Promise<Map<string, CheckResult>> | undefined
  const shared = () => (results ??= placeResults(config, names, list))
  return names.map((name) => ({
    name: `Device ${name}`,
    fixInstructions: DEVICE_FIX,
    check: async () =>
      (await shared()).get(name) ?? { status: 'skip', message: 'not in the device listing' },
  }))
}
