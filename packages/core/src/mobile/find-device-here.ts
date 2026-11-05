export interface AttachedAndroid {
  serial: string
  state: string
  model?: string
  os?: string
  // A running emulator's AVD name.
  avd?: string
}

export interface AvdHere {
  name: string
  // The AVD's device profile, `hw.device.name` (for example `pixel_10_pro`).
  profile?: string
  displayName?: string
  os?: string
  apiLevel?: string
}

export interface AndroidHere {
  attached: AttachedAndroid[]
  avds: AvdHere[]
  problem?: string
}

export interface SimulatorHere {
  name: string
  udid: string
  os: string
  state: string
  available: boolean
}

export interface IOSHere {
  simulators: SimulatorHere[]
  problem?: string
}

export interface DeviceFound {
  udid?: string
  avd?: string
  name?: string
  os?: string
  running: boolean
  description: string
}

export interface FindDeviceHereInput {
  device: string
  platform: 'android' | 'ios'
  model?: string
  os?: string
  id?: string
  android?: AndroidHere
  ios?: IOSHere
}

export type FindDeviceHereResult = { found: DeviceFound } | { refusal: string }

type CandidateKind = 'phone' | 'emulator' | 'avd' | 'simulator'

interface Candidate {
  kind: CandidateKind
  names: string[]
  id?: string
  model?: string
  os?: string
  running: boolean
  label: string
  found: DeviceFound
}

export function normalizeDeviceText(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, ' ').trim()
}

function osParts(os: string): string[] {
  return os.trim().split('.')
}

function partsEqual(want: string, have: string): boolean {
  if (/^\d+$/.test(want) && /^\d+$/.test(have)) return Number(want) === Number(have)
  return want.toLowerCase() === have.toLowerCase()
}

// `18` matches `18.2`, `18.4` matches `18.4.1` but not `18.40`, `8.1` matches `8.1.0`.
export function osMatches(want: string, have: string | undefined): boolean {
  if (have === undefined) return false
  const wanted = osParts(want)
  const had = osParts(have)
  return wanted.every((part, index) => {
    const other = had[index]
    return other === undefined ? /^0+$/.test(part) : partsEqual(part, other)
  })
}

function compareOs(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
  const left = osParts(a).map((part) => Number.parseInt(part, 10) || 0)
  const right = osParts(b).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function joinParts(parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(', ')
}

function avdDetail(avd: AvdHere): string {
  const version =
    avd.os !== undefined
      ? `Android ${avd.os}`
      : avd.apiLevel !== undefined
        ? `API ${avd.apiLevel}`
        : undefined
  return joinParts([avd.displayName ?? avd.profile, version])
}

function avdLabel(avd: AvdHere): string {
  const detail = avdDetail(avd)
  return detail === '' ? avd.name : `${avd.name} (${detail})`
}

function isEmulator(device: AttachedAndroid): boolean {
  return device.avd !== undefined || device.serial.startsWith('emulator-')
}

function attachedLabel(device: AttachedAndroid): string {
  const kind = isEmulator(device) ? 'emulator' : 'phone'
  const head = isEmulator(device) ? (device.avd ?? device.model) : device.model
  const detail = joinParts([
    device.os === undefined ? undefined : `Android ${device.os}`,
    device.state === 'device' ? undefined : device.state,
  ])
  const base = head === undefined ? `${kind} ${device.serial}` : `${head} ${kind} ${device.serial}`
  return detail === '' ? base : `${base} (${detail})`
}

function simulatorLabel(simulator: SimulatorHere): string {
  return `${simulator.name} (${simulator.os})`
}

function androidCandidates(listing: AndroidHere): Candidate[] {
  const avds = new Map(listing.avds.map((avd) => [avd.name, avd]))
  const runningAvds = new Set(
    listing.attached.flatMap((device) => (device.avd === undefined ? [] : [device.avd])),
  )
  const attached = listing.attached
    .filter((device) => device.state === 'device')
    .map((device): Candidate => {
      const avd = device.avd === undefined ? undefined : avds.get(device.avd)
      const os = device.os ?? avd?.os
      const kind = isEmulator(device) ? 'emulator' : 'phone'
      const head = (kind === 'emulator' ? device.avd : undefined) ?? device.model ?? 'device'
      return {
        kind,
        names: [device.model, device.avd, avd?.profile, avd?.displayName].filter(
          (name): name is string => name !== undefined,
        ),
        id: device.serial,
        model: device.model ?? avd?.displayName ?? device.avd,
        os,
        running: true,
        label: attachedLabel(device),
        found: {
          udid: device.serial,
          ...(os === undefined ? {} : { os }),
          running: true,
          description: `${head} ${kind} ${device.serial}`,
        },
      }
    })
  const idle = listing.avds
    .filter((avd) => !runningAvds.has(avd.name))
    .map(
      (avd): Candidate => ({
        kind: 'avd',
        names: [avd.name, avd.profile, avd.displayName].filter(
          (name): name is string => name !== undefined,
        ),
        model: avd.displayName ?? avd.name,
        os: avd.os,
        running: false,
        label: avdLabel(avd),
        found: {
          avd: avd.name,
          ...(avd.os === undefined ? {} : { os: avd.os }),
          running: false,
          description: `${avdLabel(avd)}, not running`,
        },
      }),
    )
  return [...attached, ...idle]
}

function iosCandidates(listing: IOSHere): Candidate[] {
  return listing.simulators
    .filter((simulator) => simulator.available)
    .map((simulator): Candidate => {
      const running = simulator.state === 'Booted'
      return {
        kind: 'simulator',
        names: [simulator.name],
        id: simulator.udid,
        model: simulator.name,
        os: simulator.os,
        running,
        label: simulatorLabel(simulator),
        found: {
          udid: simulator.udid,
          name: simulator.name,
          os: simulator.os,
          running,
          description: `${simulatorLabel(simulator)}, ${running ? 'booted' : 'shut down'}`,
        },
      }
    })
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

function countWord(count: number): string {
  return ['', 'one', 'two', 'three', 'four', 'five'][count] ?? String(count)
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// What the machine has, written to sit after a semicolon.
function machineHas(platform: 'android' | 'ios', problem: string | undefined, labels: string[]) {
  const ios = platform === 'ios'
  if (problem !== undefined) {
    const lister = ios ? "this Mac's simulators" : "this machine's Android devices"
    return `${lister} cannot be listed: ${problem}`
  }
  if (labels.length === 0) {
    return ios ? 'this Mac has no simulators' : 'this machine has no Android devices or AVDs'
  }
  return `${ios ? 'this Mac' : 'this machine'} has: ${labels.join(', ')}`
}

function tieNoun(kinds: Set<CandidateKind>): string {
  if (kinds.size !== 1) return 'devices'
  const [kind] = [...kinds]
  if (kind === 'phone') return 'attached phones'
  if (kind === 'emulator') return 'running emulators'
  if (kind === 'avd') return 'AVDs'
  return 'simulators'
}

function refuseTie(input: FindDeviceHereInput, tied: Candidate[]): string {
  const first = tied[0] as Candidate
  const kinds = new Set(tied.map((candidate) => candidate.kind))
  const names = tied.map((candidate) =>
    candidate.kind === 'avd' ? (candidate.found.avd as string) : (candidate.id as string),
  )
  const system = input.platform === 'ios' ? 'iOS' : 'Android'
  const version = first.os === undefined ? undefined : `${system} ${first.os}`
  const detail = joinParts([first.model, version])
  const remedy = kinds.has('avd')
    ? `Set model in registry.devices.${input.device} to one AVD's name.`
    : `Set id in registry.devices.${input.device} to pick one.`
  return (
    `Device ${input.device} matches ${countWord(tied.length)} ${tieNoun(kinds)}, ` +
    `${listWords(names)}${detail === '' ? '' : ` (${detail})`}. ${remedy}`
  )
}

function pick(input: FindDeviceHereInput, matches: Candidate[]): FindDeviceHereResult {
  const ranked = [...matches].sort(
    (a, b) => compareOs(b.os, a.os) || Number(b.running) - Number(a.running),
  )
  const best = ranked[0] as Candidate
  const tied = ranked.filter(
    (candidate) => compareOs(candidate.os, best.os) === 0 && candidate.running === best.running,
  )
  if (tied.length > 1) return { refusal: refuseTie(input, tied) }
  return { found: best.found }
}

function refuseNoModel(
  input: FindDeviceHereInput,
  running: Candidate[],
  labels: string[],
  problem: string | undefined,
): string {
  const ios = input.platform === 'ios'
  const where = ios ? 'this Mac' : 'this machine'
  const what = ios ? 'iOS simulator' : 'Android device'
  if (running.length === 0) {
    return (
      `Device ${input.device} names no model, and ${where} runs no ${what}. ` +
      `Start one, or set model in registry.devices.${input.device}. ` +
      `${capitalize(machineHas(input.platform, problem, labels))}.`
    )
  }
  const named = running.map((candidate) => candidate.label).join(', ')
  return (
    `Device ${input.device} names no model, and ${where} runs ` +
    `${countWord(running.length)} ${what}s: ${named}. ` +
    `Set model in registry.devices.${input.device}.`
  )
}

function refuseNoMatch(
  input: FindDeviceHereInput,
  labels: string[],
  problem: string | undefined,
): string {
  const model = input.model as string
  const ios = input.platform === 'ios'
  const wants = ios
    ? `${article(model)} ${model} simulator${input.os === undefined ? '' : ` on iOS ${input.os}`}`
    : `${article(model)} ${model}${input.os === undefined ? '' : ` on Android ${input.os}`}`
  const unit = input.id === undefined ? '' : ` with ${ios ? 'udid' : 'serial'} ${input.id}`
  return (
    `Device ${input.device} wants ${wants}${unit}; ` +
    `${machineHas(input.platform, problem, labels)}. ` +
    `Set model or os in registry.devices.${input.device}.`
  )
}

export function findDeviceHere(input: FindDeviceHereInput): FindDeviceHereResult {
  const ios = input.platform === 'ios'
  const listing = ios ? input.ios : input.android
  const problem = listing?.problem
  const candidates = ios
    ? iosCandidates(input.ios ?? { simulators: [] })
    : androidCandidates(input.android ?? { attached: [], avds: [] })
  const labels = ios
    ? candidates.map((candidate) => candidate.label)
    : [
        ...(input.android?.attached ?? []).map(attachedLabel),
        ...candidates.filter((candidate) => candidate.kind === 'avd').map((c) => c.label),
      ]
  const narrowed = candidates.filter(
    (candidate) =>
      (input.id === undefined || candidate.id === input.id) &&
      (input.os === undefined || osMatches(input.os, candidate.os)),
  )
  if (input.model === undefined) {
    const running = narrowed.filter((candidate) => candidate.running)
    if (running.length !== 1) return { refusal: refuseNoModel(input, running, labels, problem) }
    return { found: (running[0] as Candidate).found }
  }
  const wanted = normalizeDeviceText(input.model)
  const matches = narrowed.filter((candidate) =>
    candidate.names.some((name) => normalizeDeviceText(name) === wanted),
  )
  if (matches.length === 0) return { refusal: refuseNoMatch(input, labels, problem) }
  return pick(input, matches)
}

const LABEL_WIDTH = 12

function labelled(label: string, rows: string[]): string[] {
  const indent = ' '.repeat(LABEL_WIDTH)
  return rows.map((row, index) => `${index === 0 ? label.padEnd(LABEL_WIDTH) : indent}${row}`)
}

function columns(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)),
    [],
  )
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

// The Attached and Emulators lines of `agent-qa devices`.
export function describeAndroidHere(listing: AndroidHere): string[] {
  const phones = listing.attached.filter((device) => !isEmulator(device))
  const attached =
    listing.problem !== undefined
      ? [listing.problem]
      : phones.length === 0
        ? ['none']
        : columns(
            phones.map((device) => [
              device.model ?? '',
              device.os === undefined ? '' : `Android ${device.os}`,
              device.state === 'device' ? device.serial : `${device.serial} ${device.state}`,
            ]),
          )
  const avds = new Map(listing.avds.map((avd) => [avd.name, avd]))
  const running = listing.attached.filter(isEmulator).map((device) => {
    const avd = device.avd === undefined ? undefined : avds.get(device.avd)
    const name = device.avd ?? device.serial
    const os = device.os ?? avd?.os
    const detail = joinParts([
      avd?.displayName ?? avd?.profile,
      os === undefined ? undefined : `Android ${os}`,
      device.state === 'device' ? `running ${device.serial}` : `${device.state} ${device.serial}`,
    ])
    return `${name} (${detail})`
  })
  const runningNames = new Set(listing.attached.flatMap((device) => device.avd ?? []))
  const idle = listing.avds.filter((avd) => !runningNames.has(avd.name)).map(avdLabel)
  const emulators = [...running, ...idle]
  return [
    ...labelled('Attached:', attached),
    ...labelled('Emulators:', [emulators.length === 0 ? 'none' : emulators.join(', ')]),
  ]
}

// The Simulators line of `agent-qa devices`.
export function describeIOSHere(listing: IOSHere): string[] {
  if (listing.problem !== undefined) return labelled('Simulators:', [listing.problem])
  const simulators = listing.simulators
    .filter((simulator) => simulator.available)
    .map((simulator) =>
      simulator.state === 'Booted'
        ? `${simulator.name} (${simulator.os}, booted)`
        : simulatorLabel(simulator),
    )
  return labelled('Simulators:', [simulators.length === 0 ? 'none' : simulators.join(', ')])
}
