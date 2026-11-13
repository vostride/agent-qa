import {
  findDeviceHere,
  type AndroidHere,
  type DeviceFound,
  type IOSHere,
} from '@vostride/agent-qa-core'

import { machineText } from './machine-text.js'
import { PLAYGROUND_APP_PIN, type PlaygroundAppPin } from './playground-app-pin.js'
import type { DevicesHereLister } from './run.js'
import { PLAYGROUND_TARGETS } from './scaffold-content.js'

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
        // The pinned Playground build is for iPhones; an iPad simulator runs it scaled.
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

// An OS that is not a version is kept: nothing shows it is too old.
function olderThan(os: string | undefined, minOs: string): boolean {
  if (os === undefined || !/^\d+(\.|$)/.test(os.trim())) return false
  return newerOsFirst(os, minOs) > 0
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

export function pickDeviceHere(
  platform: Platform,
  listing: Listing,
  minOs: string = PLAYGROUND_APP_PIN[platform].minOs,
): PickedDevice | undefined {
  const listed =
    platform === 'ios'
      ? iosCandidates(listing as IOSHere)
      : androidCandidates(listing as AndroidHere)
  // The pinned Playground build does not install below its floor, running or not.
  const candidates = listed.filter((candidate) => !olderThan(candidate.os, minOs))
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

interface InitDevices {
  devices: Partial<Record<Platform, PickedDevice>>
  // One line per runtime, in the order given.
  lines: string[]
}

const RUNTIME_NAMES = { android: 'Android', ios: 'iOS' } as const

const CREATE_ONE = {
  android: "Create an emulator in Android Studio's Device Manager",
  ios: 'Create a simulator in Xcode',
} as const

function bindingAdvice(platform: Platform): string {
  const target = PLAYGROUND_TARGETS[platform]
  return `under registry.devices and set device on registry.targets.${target}`
}

function pickedLine(platform: Platform, picked: PickedDevice): string {
  const runtime = RUNTIME_NAMES[platform]
  const { model, os } = picked.profile
  const shownOs = os === undefined ? '' : ` (${runtime} ${machineText(os)})`
  return `${runtime} device: ${machineText(model)}${shownOs} as ${picked.name}`
}

function noneFoundLine(platform: Platform, reason: string | undefined): string {
  const runtime = RUNTIME_NAMES[platform]
  if (reason === undefined) {
    return (
      `${runtime} device: none found. ` +
      `${CREATE_ONE[platform]}, then describe it ${bindingAdvice(platform)}.`
    )
  }
  return (
    `${runtime} device: none found (${machineText(reason)}). ` +
    `Describe one ${bindingAdvice(platform)} once this machine has one.`
  )
}

// The machine lists emulators or simulators, so a line saying none was found would be untrue.
function nonePickedLine(platform: Platform): string {
  const kind = platform === 'android' ? 'emulators' : 'simulators'
  return (
    `${RUNTIME_NAMES[platform]} device: none of this machine's ${kind} could be picked. ` +
    `Describe one ${bindingAdvice(platform)}.`
  )
}

function listsAny(platform: Platform, listing: Listing): boolean {
  return platform === 'android'
    ? (listing as AndroidHere).avds.length > 0
    : (listing as IOSHere).simulators.length > 0
}

// A lister that throws leaves its runtime without a device, and init carries on.
export async function findInitDevices(
  runtimes: readonly Platform[],
  list: DevicesHereLister,
  pin: PlaygroundAppPin = PLAYGROUND_APP_PIN,
): Promise<InitDevices> {
  const devices: InitDevices['devices'] = {}
  const lines: string[] = []
  for (const platform of runtimes) {
    let listing: Listing
    try {
      listing = await list(platform)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lines.push(noneFoundLine(platform, `could not list this machine's devices: ${message}`))
      continue
    }
    const picked = pickDeviceHere(platform, listing, pin[platform].minOs)
    if (picked !== undefined) {
      devices[platform] = picked
      lines.push(pickedLine(platform, picked))
    } else if (listsAny(platform, listing)) {
      lines.push(nonePickedLine(platform))
    } else {
      lines.push(noneFoundLine(platform, listing.problem))
    }
  }
  return { devices, lines }
}
