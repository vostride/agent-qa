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

export interface RemoteDeviceUse {
  readonly device: string
  readonly remote: RemoteConnectionFields
}

export interface MissingDeviceSecret extends RemoteDeviceUse {
  readonly name: string
}

// What a used remote device's connection needs: its remote's values and its own capabilities.
export function missingDeviceSecrets(
  used: readonly RemoteDeviceUse[],
  devices: Readonly<Record<string, { readonly capabilities?: unknown }>>,
  store: { has(name: string): boolean },
): MissingDeviceSecret[] {
  const missing: MissingDeviceSecret[] = []
  const seen = new Set<string>()
  for (const { device, remote } of used) {
    if (seen.has(device)) continue
    seen.add(device)
    const capabilities = Object.hasOwn(devices, device) ? devices[device]?.capabilities : undefined
    const names = new Set([
      ...connectionSecretNames([remote]),
      ...secretReferenceNames(JSON.stringify(capabilities ?? {})),
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
  return `Device ${missing.device} on remote ${remoteLabel(missing.remote)} needs ${missing.name}, which ${file} does not declare. Add it there.`
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
