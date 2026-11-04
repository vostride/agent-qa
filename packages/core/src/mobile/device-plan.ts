import type { MobilePlatform } from './launch-resolver.js'

export const W3C_STANDARD_CAPABILITIES: readonly string[] = [
  'browserName',
  'browserVersion',
  'platformName',
  'acceptInsecureCerts',
  'pageLoadStrategy',
  'proxy',
  'setWindowRect',
  'timeouts',
  'strictFileInteractability',
  'unhandledPromptBehavior',
  'userAgent',
  'webSocketUrl',
]

export type CapabilityMap = Record<string, unknown>

const APPIUM_OPTIONS = 'appium:options'
const ANDROID_DRIVERS = ['uiautomator2', 'espresso']
const IOS_DRIVERS = ['xcuitest']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function setKey(target: CapabilityMap, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function copyValue(value: unknown): unknown {
  if (isPlainObject(value)) return mergeLayer({}, value)
  if (Array.isArray(value)) return [...value]
  return value
}

function mergeLayer(base: CapabilityMap, layer: CapabilityMap): CapabilityMap {
  const out: CapabilityMap = {}
  for (const [key, value] of Object.entries(base)) setKey(out, key, value)
  for (const [key, value] of Object.entries(layer)) {
    if (value === null) {
      delete out[key]
      continue
    }
    const current = Object.hasOwn(out, key) ? out[key] : undefined
    const merged =
      isPlainObject(current) && isPlainObject(value) ? mergeLayer(current, value) : copyValue(value)
    setKey(out, key, merged)
  }
  return out
}

export function mergeCapabilities(...layers: (CapabilityMap | undefined)[]): CapabilityMap {
  let merged: CapabilityMap = {}
  for (const layer of layers) if (layer !== undefined) merged = mergeLayer(merged, layer)
  return merged
}

interface CapabilityEntry {
  key: string
  value: unknown
}

// Appium promotes appium:options children to appium: keys, overwriting a top-level one.
function capabilityEntry(caps: CapabilityMap, name: string): CapabilityEntry | undefined {
  if (W3C_STANDARD_CAPABILITIES.includes(name)) {
    return Object.hasOwn(caps, name) ? { key: name, value: caps[name] } : undefined
  }
  const options = Object.hasOwn(caps, APPIUM_OPTIONS) ? caps[APPIUM_OPTIONS] : undefined
  if (isPlainObject(options) && Object.hasOwn(options, name)) {
    return { key: `${APPIUM_OPTIONS}.${name}`, value: options[name] }
  }
  const prefixed = `appium:${name}`
  return Object.hasOwn(caps, prefixed) ? { key: prefixed, value: caps[prefixed] } : undefined
}

export function capabilityValue(caps: CapabilityMap, name: string): unknown {
  return capabilityEntry(caps, name)?.value
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function shown(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`
  if (value === null || typeof value !== 'object') return String(value)
  return JSON.stringify(value)
}

function differs(value: unknown, stated: string, caseless = false): boolean {
  const text = asText(value)
  if (text === undefined) return true
  return caseless ? text.toLowerCase() !== stated.toLowerCase() : text !== stated
}

interface CapabilityLayer {
  owner: string
  // How the second half of a refusal names the device: "its" or "device <d>".
  device: string
  capabilities: CapabilityMap
}

function layersOf(input: {
  device: string
  remote?: { name: string; capabilities?: CapabilityMap }
  capabilities?: CapabilityMap
}): CapabilityLayer[] {
  const layers: CapabilityLayer[] = []
  if (input.remote?.capabilities !== undefined) {
    layers.push({
      owner: `Remote ${input.remote.name}`,
      device: `device ${input.device}`,
      capabilities: input.remote.capabilities,
    })
  }
  if (input.capabilities !== undefined) {
    layers.push({
      owner: `Device ${input.device}`,
      device: 'the device',
      capabilities: input.capabilities,
    })
  }
  return layers
}

function sets(layer: CapabilityLayer, entry: CapabilityEntry): string {
  return `${layer.owner} sets ${entry.key} ${shown(entry.value)} in its capabilities`
}

function possessive(layer: CapabilityLayer): string {
  return layer.device === 'the device' ? 'its' : `${layer.device}'s`
}

function driverPlatform(driver: unknown): MobilePlatform | undefined {
  const text = asText(driver)?.toLowerCase()
  if (text === undefined) return undefined
  if (ANDROID_DRIVERS.includes(text)) return 'android'
  if (IOS_DRIVERS.includes(text)) return 'ios'
  return undefined
}

export interface StaticCapabilityInput {
  device: string
  platform: MobilePlatform
  model?: string
  os?: string
  id?: string
  remote?: { name: string; capabilities?: CapabilityMap }
  capabilities?: CapabilityMap
}

export function staticCapabilityContradictions(input: StaticCapabilityInput): string[] {
  const found: string[] = []
  const stated: [string, 'model' | 'os' | 'id', string | undefined][] = [
    ['deviceName', 'model', input.model],
    ['platformVersion', 'os', input.os],
    ['udid', 'id', input.id],
  ]
  for (const layer of layersOf(input)) {
    for (const key of Object.keys(layer.capabilities)) {
      if (!key.includes(':') && !W3C_STANDARD_CAPABILITIES.includes(key)) {
        const fix = `needs a vendor prefix, such as appium:${key}.`
        found.push(`${layer.owner} capabilities "${key}" ${fix}`)
      }
    }

    const platformName = capabilityEntry(layer.capabilities, 'platformName')
    if (platformName && differs(platformName.value, input.platform, true)) {
      found.push(`${sets(layer, platformName)}; ${layer.device} is ${input.platform}.`)
    }

    const driver = capabilityEntry(layer.capabilities, 'automationName')
    const serves = driver ? driverPlatform(driver.value) : undefined
    if (driver && serves !== undefined && serves !== input.platform) {
      const platform = `${layer.device} is ${input.platform}`
      found.push(`${sets(layer, driver)}; that driver serves ${serves}, and ${platform}.`)
    }

    for (const [name, field, value] of stated) {
      const statedValue = value?.trim()
      if (statedValue === undefined || statedValue === '') continue
      const entry = capabilityEntry(layer.capabilities, name)
      if (entry && differs(entry.value, statedValue)) {
        found.push(`${sets(layer, entry)}; ${possessive(layer)} ${field} is ${statedValue}.`)
      }
    }
  }
  return found
}

export interface RunStartCapabilityInput {
  device: string
  target: { name: string; appPackage?: string; appActivity?: string; bundleId?: string }
  appState: 'preserve' | 'reset'
  browserMode: boolean
  remote?: { name: string; capabilities?: CapabilityMap }
  capabilities?: CapabilityMap
}

const APP_ID_FIELDS = ['appPackage', 'appActivity', 'bundleId'] as const

export function runStartCapabilityContradictions(input: RunStartCapabilityInput): string[] {
  const found: string[] = []
  const noReset = input.appState === 'preserve'
  const appState = `use.mobile.appState is ${input.appState}`
  for (const layer of layersOf(input)) {
    for (const field of APP_ID_FIELDS) {
      const stated = input.target[field]?.trim()
      if (stated === undefined || stated === '') continue
      const entry = capabilityEntry(layer.capabilities, field)
      if (entry && differs(entry.value, stated)) {
        found.push(`${sets(layer, entry)}; target ${input.target.name} has ${field} ${stated}.`)
      }
    }

    if (input.browserMode) continue
    const noResetEntry = capabilityEntry(layer.capabilities, 'noReset')
    if (noResetEntry && differs(noResetEntry.value, String(noReset), true)) {
      found.push(`${sets(layer, noResetEntry)}; ${appState}.`)
    }
    const fullReset = capabilityEntry(layer.capabilities, 'fullReset')
    if (fullReset && noReset && asText(fullReset.value)?.toLowerCase() === 'true') {
      found.push(`${sets(layer, fullReset)}; ${appState}.`)
    }
  }
  return found
}

export interface RemoteAppInput {
  device: string
  remote: string
  target: string
  appRef?: string
  appPath?: string
  // The merged capabilities the session would send.
  capabilities: CapabilityMap
}

export type RemoteAppResult = { app?: string } | { refusal: string }

export function remoteAppCapability(input: RemoteAppInput): RemoteAppResult {
  if (capabilityEntry(input.capabilities, 'app') !== undefined) return {}
  const appRef = input.appRef?.trim()
  if (appRef) return { app: appRef }
  if (input.appPath?.trim()) {
    return {
      refusal: `Device ${input.device} runs on remote ${input.remote}, and target ${input.target} has only app.path. Set app.ref to the app the server installs.`,
    }
  }
  return {}
}

export function remoteDerivedIdentity(input: {
  model?: string
  os?: string
  id?: string
}): CapabilityMap {
  const identity: CapabilityMap = {}
  if (input.model !== undefined) identity['appium:deviceName'] = input.model
  if (input.os !== undefined) identity['appium:platformVersion'] = input.os
  if (input.id !== undefined) identity['appium:udid'] = input.id
  return identity
}
