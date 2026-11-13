import {
  findDeviceHere,
  type AndroidHere,
  type DeviceFound,
  type IOSHere,
} from '@vostride/agent-qa-core'

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

type Platform = PickedDevice['profile']['platform']
type DeviceProfile = PickedDevice['profile']
type Listing = AndroidHere | IOSHere
type Identity = Pick<DeviceFound, 'avd' | 'udid'>

interface Candidate {
  entries: DeviceProfile[]
  // What the run's finder returns for this device as listed, and with nothing running.
  listed: Identity
  idle: Identity
}

function androidCandidates(listing: AndroidHere): Candidate[] {
  return listing.avds.map((avd): Candidate => {
    const serial = listing.attached.find(
      (device) => device.state === 'device' && device.avd === avd.name,
    )?.serial
    return {
      entries: [
        {
          platform: 'android',
          model: avd.displayName ?? avd.name,
          ...(avd.os === undefined ? {} : { os: avd.os }),
        },
      ],
      listed: serial === undefined ? { avd: avd.name } : { udid: serial },
      idle: { avd: avd.name },
    }
  })
}

function iosCandidates(listing: IOSHere): Candidate[] {
  return listing.simulators
    .filter((simulator) => simulator.available)
    .map((simulator): Candidate => ({
      entries: [{ platform: 'ios', model: simulator.name, os: simulator.os }],
      listed: { udid: simulator.udid },
      idle: { udid: simulator.udid },
    }))
}

function deviceName(profile: DeviceProfile): string {
  const type = profile.platform === 'android' ? 'emulator' : 'simulator'
  const model = profile.model.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const os = (profile.os ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, '-')
  return [profile.platform, type, model, os]
    .map((part) => part.replace(/^-|-$/g, ''))
    .filter((part) => part !== '')
    .join('-')
}

function nothingRunning(platform: Platform, listing: Listing): Listing {
  if (platform === 'android') return { ...(listing as AndroidHere), attached: [] }
  const ios = listing as IOSHere
  return {
    ...ios,
    simulators: ios.simulators.map((simulator) => ({ ...simulator, state: 'Shutdown' })),
  }
}

function finds(
  platform: Platform,
  listing: Listing,
  name: string,
  profile: DeviceProfile,
  want: Identity,
): boolean {
  const result = findDeviceHere({
    device: name,
    ...profile,
    ...(platform === 'ios' ? { ios: listing as IOSHere } : { android: listing as AndroidHere }),
  })
  return 'found' in result && result.found.avd === want.avd && result.found.udid === want.udid
}

export function pickDeviceHere(platform: Platform, listing: Listing): PickedDevice | undefined {
  const candidates =
    platform === 'ios'
      ? iosCandidates(listing as IOSHere)
      : androidCandidates(listing as AndroidHere)
  // A later run may find the device shut down, so the entry must resolve that way too.
  const idleListing = nothingRunning(platform, listing)
  for (const candidate of candidates) {
    for (const profile of candidate.entries) {
      const name = deviceName(profile)
      if (
        finds(platform, listing, name, profile, candidate.listed) &&
        finds(platform, idleListing, name, profile, candidate.idle)
      ) {
        return { name, profile }
      }
    }
  }
  return undefined
}
