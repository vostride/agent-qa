import type { AndroidHere, IOSHere } from '@vostride/agent-qa-core'

export interface PickedDevice {
  // The key under registry.devices.
  name: string
  profile: {
    platform: 'android' | 'ios'
    model: string
    os?: string
    id?: string
  }
}

export function pickDeviceHere(
  platform: 'android' | 'ios',
  listing: AndroidHere | IOSHere,
): PickedDevice | undefined {
  return undefined
}
