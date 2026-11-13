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
  running: boolean
  os: string | undefined
  iphone: boolean
  listedName: string
  udid?: string
  // Tried in turn; the first one the run's finder resolves to this device is written.
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
    const os = avd.os === undefined ? {} : { os: avd.os }
    const entries: DeviceProfile[] = [
      { platform: 'android', model: avd.displayName ?? avd.name, ...os },
    ]
    // What the finder's own tie refusal tells a person to set.
    if (avd.displayName !== undefined) entries.push({ platform: 'android', model: avd.name, ...os })
    return {
      running: serial !== undefined,
      os: avd.os,
      iphone: false,
      listedName: avd.name,
      entries,
      listed: serial === undefined ? { avd: avd.name } : { udid: serial },
      idle: { avd: avd.name },
    }
  })
}

function iosCandidates(listing: IOSHere): Candidate[] {
  return listing.simulators
    .filter((simulator) => simulator.available)
    .map((simulator): Candidate => {
      const profile: DeviceProfile = { platform: 'ios', model: simulator.name, os: simulator.os }
      return {
        running: simulator.state === 'Booted',
        os: simulator.os,
        // The pinned Playground build runs on iPhones only.
        iphone: simulator.name.startsWith('iPhone'),
        listedName: simulator.name,
        udid: simulator.udid,
        entries: [profile, { ...profile, id: simulator.udid }],
        listed: { udid: simulator.udid },
        idle: { udid: simulator.udid },
      }
    })
}

function osNumbers(os: string): number[] {
  return os
    .trim()
    .split('.')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0))
}

// Newer first, and an unknown OS after every known one.
function newerOsFirst(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  const left = osNumbers(a)
  const right = osNumbers(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (right[index] ?? 0) - (left[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function preferred(a: Candidate, b: Candidate): number {
  return (
    Number(b.running) - Number(a.running) ||
    newerOsFirst(a.os, b.os) ||
    Number(b.iphone) - Number(a.iphone) ||
    byText(a.listedName, b.listedName) ||
    byText(a.udid ?? '', b.udid ?? '')
  )
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
  for (const candidate of candidates.sort(preferred)) {
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
