import {
  DEFAULT_REMOTE_CONNECT_TIMEOUT_MS,
  type RemoteDeviceConfig,
} from '@vostride/agent-qa-runner'
import type { RemoteEntry } from '../schema/remote-schema.js'

export type DevicePlace =
  { kind: 'local'; device: string } | { kind: 'remote'; device: string; remote: RemoteDeviceConfig }

export interface SelectDevicePlaceInput {
  devices: Record<string, { remote?: string }>
  remotes: readonly RemoteEntry[]
  device: string
  // The file the device name came from, named in the refusal.
  file?: string
}

export type SelectDevicePlaceResult = { place: DevicePlace } | { refusal: string }

export function toRemoteDeviceConfig(entry: RemoteEntry): RemoteDeviceConfig {
  return {
    name: entry.name,
    protocol: 'appium',
    url: entry.url,
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.basicAuth ? { basicAuth: entry.basicAuth } : {}),
    connectTimeoutMs: entry.connectTimeout ?? DEFAULT_REMOTE_CONNECT_TIMEOUT_MS,
  }
}

export function selectDevicePlace(input: SelectDevicePlaceInput): SelectDevicePlaceResult {
  const { device } = input
  const profile = Object.hasOwn(input.devices, device) ? input.devices[device] : undefined
  if (profile === undefined) {
    const names = Object.keys(input.devices)
    const listed =
      names.length === 0
        ? 'registry.devices lists no devices.'
        : `registry.devices lists: ${names.join(', ')}.`
    const from = input.file === undefined ? '' : ` in ${input.file}`
    return { refusal: `Unknown device "${device}"${from}. ${listed}` }
  }
  if (profile.remote === undefined) return { place: { kind: 'local', device } }
  const entry = input.remotes.find((remote) => remote.name === profile.remote)
  if (!entry) {
    const listed =
      input.remotes.length === 0
        ? 'registry.remotes lists no remotes.'
        : `registry.remotes lists: ${input.remotes.map((remote) => remote.name).join(', ')}.`
    return {
      refusal: `Device ${device} names remote "${profile.remote}", which registry.remotes does not list. ${listed}`,
    }
  }
  if (entry.protocol !== 'appium') {
    return {
      refusal: `Device ${device} names remote ${entry.name}, a ${entry.protocol} remote; a device's remote needs protocol: appium.`,
    }
  }
  return { place: { kind: 'remote', device, remote: toRemoteDeviceConfig(entry) } }
}

export type DeviceProfiles = Record<string, { platform?: string; remote?: string }>

export interface DeviceTarget {
  name: string
  platform: string
  device?: string
}

export interface SelectTestDeviceInput {
  devices: DeviceProfiles
  remotes: readonly RemoteEntry[]
  target: DeviceTarget
  // The `--device` value.
  flag?: string
  // The test's `use.device`.
  test?: string
  // The test file, named when its pick is refused.
  file?: string
}

const FLAG = '--device'

// `--device` wins, then the test's pick, then its target's device.
export function selectTestDevice(input: SelectTestDeviceInput): SelectDevicePlaceResult {
  const { devices, remotes, target } = input
  if (input.flag !== undefined) {
    return placeDevice({ devices, remotes, targets: [target], device: input.flag, from: FLAG })
  }
  if (input.test !== undefined) {
    return placeDevice({
      devices,
      remotes,
      targets: [target],
      device: input.test,
      from: input.file,
    })
  }
  if (target.device !== undefined) {
    return placeDevice({
      devices,
      remotes,
      targets: [target],
      device: target.device,
      from: targetSource(target),
    })
  }
  return {
    refusal:
      `No device specified for mobile target "${target.name}". ` +
      `Set device on registry.targets.${target.name}, or use.device in the test or its suite.`,
  }
}

function placeDevice(input: {
  devices: DeviceProfiles
  remotes: readonly RemoteEntry[]
  targets: readonly DeviceTarget[]
  device: string
  from?: string
}): SelectDevicePlaceResult {
  const { devices, remotes, device } = input
  const profile = Object.hasOwn(devices, device) ? devices[device] : undefined
  if (profile !== undefined) {
    if (input.from === FLAG && profile.remote !== undefined) {
      return {
        refusal:
          `Device ${device} runs on remote ${profile.remote}; --device picks a device on this machine. ` +
          `Set use.device: ${device} in a suite or test to run there.`,
      }
    }
    const platform = profile.platform
    const other = input.targets.find(
      (target) => platform !== undefined && target.platform !== platform,
    )
    if (other !== undefined) {
      return {
        refusal: `Device "${device}" is ${platform}, but target "${other.name}" is ${other.platform}.`,
      }
    }
  }
  return selectDevicePlace({
    devices,
    remotes,
    device,
    ...(input.from === undefined ? {} : { file: input.from }),
  })
}

function targetSource(target: DeviceTarget): string {
  return `registry.targets.${target.name}`
}
