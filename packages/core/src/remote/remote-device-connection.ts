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

export interface RemoteDeviceConnection {
  readonly protocol: 'http' | 'https'
  readonly hostname: string
  readonly port: number
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
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
  const protocol = url.protocol === 'https:' ? 'https' : 'http'
  const headers: Record<string, string> = resolveSecretTemplatesInValue(
    { ...remote.headers },
    secrets,
  )
  if (remote.basicAuth !== undefined) {
    const { user, password } = resolveSecretTemplatesInValue(remote.basicAuth, secrets)
    headers.Authorization = `Basic ${basicAuthorizationValue(user, password)}`
  }
  return {
    protocol,
    hostname: url.hostname,
    port: url.port === '' ? (protocol === 'https' ? 443 : 80) : Number(url.port),
    path: url.pathname === '' ? '/' : url.pathname,
    headers,
  }
}
