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
