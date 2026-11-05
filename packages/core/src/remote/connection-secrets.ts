import type { SecretStore } from '@vostride/agent-qa-runner'
import {
  configConnectionSecretNames,
  connectionSecretNames,
  remoteLabel,
  secretReferenceNames,
} from '@vostride/agent-qa-schema'
import type { RemoteEntryLike } from '@vostride/agent-qa-schema'

export type RemoteConnectionFields = Pick<
  RemoteEntryLike,
  'name' | 'protocol' | 'url' | 'query' | 'headers' | 'basicAuth'
>

export interface ConnectionSecretSplit {
  // Everything a step, a hook, a target url or the planner may reach.
  readonly stepStore: SecretStore
  // Every name a remote, a device's capabilities or a target's app.ref references.
  readonly connectionNames: ReadonlySet<string>
}

export function splitConnectionSecrets(store: SecretStore, config: unknown): ConnectionSecretSplit {
  const connectionNames = new Set(configConnectionSecretNames(config))
  return { stepStore: store.without(connectionNames), connectionNames }
}

export interface MissingRemoteSecret<R extends RemoteConnectionFields = RemoteConnectionFields> {
  readonly remote: R
  readonly name: string
}

export function missingRemoteSecrets<R extends RemoteConnectionFields>(
  remotes: readonly R[],
  store: { has(name: string): boolean },
): MissingRemoteSecret<R>[] {
  const missing: MissingRemoteSecret<R>[] = []
  const seen = new Set<string>()
  for (const remote of remotes) {
    if (seen.has(remote.name)) continue
    seen.add(remote.name)
    for (const name of connectionSecretNames([remote])) {
      if (!store.has(name)) missing.push({ remote, name })
    }
  }
  return missing
}

export function missingRemoteSecretSentence(
  missing: MissingRemoteSecret,
  secretsFile: string | undefined,
): string {
  const file = secretsFile ?? 'workspace.secretsFile'
  return `Remote ${remoteLabel(missing.remote)} needs ${missing.name}, which ${file} does not declare. Add it there.`
}

export interface DeviceUse {
  readonly device: string
  // Absent for a device here, whose capabilities still resolve their references at connect.
  readonly remote?: RemoteConnectionFields | undefined
  // The app.ref of a target the device runs; a remote device's server installs from it.
  readonly appRef?: string | undefined
}

export interface MissingDeviceSecret {
  readonly device: string
  readonly remote?: RemoteConnectionFields | undefined
  readonly name: string
}

// What a used device's connection needs: its remote's values, if any, its own capabilities and,
// on a remote, the app.ref of each target it runs.
export function missingDeviceSecrets(
  used: readonly DeviceUse[],
  devices: Readonly<Record<string, { readonly capabilities?: unknown }>>,
  store: { has(name: string): boolean },
): MissingDeviceSecret[] {
  const uses = new Map<string, { remote?: RemoteConnectionFields | undefined; appRefs: string[] }>()
  for (const { device, remote, appRef } of used) {
    const use = uses.get(device) ?? { remote, appRefs: [] }
    if (appRef !== undefined) use.appRefs.push(appRef)
    uses.set(device, use)
  }
  const missing: MissingDeviceSecret[] = []
  for (const [device, { remote, appRefs }] of uses) {
    const capabilities = Object.hasOwn(devices, device) ? devices[device]?.capabilities : undefined
    const names = new Set([
      ...(remote === undefined ? [] : connectionSecretNames([remote])),
      ...secretReferenceNames(JSON.stringify(capabilities ?? {})),
      ...(remote === undefined ? [] : appRefs.flatMap(secretReferenceNames)),
    ])
    for (const name of names) {
      if (!store.has(name)) missing.push({ device, remote, name })
    }
  }
  return missing
}

export function missingDeviceSecretSentence(
  missing: MissingDeviceSecret,
  secretsFile: string | undefined,
): string {
  const file = secretsFile ?? 'workspace.secretsFile'
  const where = missing.remote === undefined ? '' : ` on remote ${remoteLabel(missing.remote)}`
  return `Device ${missing.device}${where} needs ${missing.name}, which ${file} does not declare. Add it there.`
}

export interface ConnectionSecretMisuseInput {
  readonly names: ReadonlySet<string>
  // The file the sentence names, as the run and validate print it.
  readonly file: string
  readonly steps: readonly unknown[]
  // A url held outside the config; a config target url is refused by the config's own parse.
  readonly target?: string
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringLeaves)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringLeaves)
  return []
}

function misusedNames(texts: readonly string[], names: ReadonlySet<string>): string[] {
  const used = new Set<string>()
  for (const text of texts) {
    for (const name of secretReferenceNames(text)) if (names.has(name)) used.add(name)
  }
  return [...used]
}

export function connectionSecretMisuse(input: ConnectionSecretMisuseInput): string[] {
  if (input.names.size === 0) return []
  const sentence = (name: string, place: string): string =>
    `${name} is a remote's or device's credential and only connects to it; ${input.file} uses it in ${place}. Use another secret there.`
  return [
    ...misusedNames(input.steps.flatMap(stringLeaves), input.names).map((name) =>
      sentence(name, 'a step'),
    ),
    ...misusedNames(input.target === undefined ? [] : [input.target], input.names).map((name) =>
      sentence(name, 'its target url'),
    ),
  ]
}
