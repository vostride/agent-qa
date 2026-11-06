import {
  basicAuthorizationValue,
  RemoteRefusalError,
  resolveSecretTemplatesInValue,
} from '@vostride/agent-qa-runner'
import type { RemoteDeviceConfig, SecretResolver } from '@vostride/agent-qa-runner'
import {
  connectionSecretNames,
  remoteLabel,
  SECRET_REFERENCE_PATTERN,
} from '@vostride/agent-qa-schema'

export interface RemoteDeviceEndpoint {
  readonly protocol: 'http' | 'https'
  readonly hostname: string
  readonly port: number
  readonly path: string
  // Sent on every request; a key the url repeats keeps its last value.
  readonly query?: Readonly<Record<string, string>>
}

export interface RemoteDeviceConnection extends RemoteDeviceEndpoint {
  readonly headers: Readonly<Record<string, string>>
}

// Undefined for a url that is neither http nor https.
export function remoteDeviceEndpoint(url: URL): RemoteDeviceEndpoint | undefined {
  const protocol =
    url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : undefined
  if (protocol === undefined) return undefined
  const query = Object.fromEntries(url.searchParams)
  return {
    protocol,
    hostname: url.hostname,
    port: url.port === '' ? (protocol === 'https' ? 443 : 80) : Number(url.port),
    path: url.pathname === '' ? '/' : url.pathname,
    ...(Object.keys(query).length === 0 ? {} : { query }),
  }
}

export interface RemoteDeviceConnectionInput {
  readonly remote: RemoteDeviceConfig
  readonly device: string
  readonly secrets?: SecretResolver | undefined
  readonly secretsFile?: string | undefined
}

// Resolved at connect into fresh values; the remote config keeps its references.
export function resolveRemoteDeviceConnection(
  input: RemoteDeviceConnectionInput,
): RemoteDeviceConnection {
  const { remote, device, secrets } = input
  const label = remoteLabel(remote)
  const missing = connectionSecretNames([remote]).find((name) => secrets?.has(name) !== true)
  if (missing !== undefined) {
    const secretsFile = input.secretsFile ?? 'workspace.secretsFile'
    throw new RemoteRefusalError(
      `Device ${device} on remote ${label} needs ${missing}, which ${secretsFile} does not declare. Add it there.`,
      { remote: label },
    )
  }
  const pattern = new RegExp(SECRET_REFERENCE_PATTERN.source, 'g')
  const url = new URL(
    secrets === undefined
      ? remote.url
      : remote.url.replace(pattern, (_found, name: string) =>
          encodeURIComponent(secrets.require(name)),
        ),
  )
  const endpoint = remoteDeviceEndpoint(url)
  if (endpoint === undefined) {
    throw new RemoteRefusalError(
      `Device ${device} on remote ${label}: an appium url starts with http:// or https://.`,
      { remote: label },
    )
  }
  const headers: Record<string, string> = resolveSecretTemplatesInValue(
    { ...remote.headers },
    secrets,
  )
  if (remote.basicAuth !== undefined) {
    const { user, password } = resolveSecretTemplatesInValue(remote.basicAuth, secrets)
    headers.Authorization = `Basic ${basicAuthorizationValue(user, password)}`
  }
  return { ...endpoint, headers }
}
