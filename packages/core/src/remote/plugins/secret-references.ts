import { RemoteRefusalError } from '@vostride/agent-qa-runner'
import type { SecretResolver } from '@vostride/agent-qa-runner'
import { SECRET_REFERENCE_PATTERN } from '@vostride/agent-qa-schema'

function resolveReferences(
  value: unknown,
  secrets: SecretResolver | undefined,
  secretsFile: string,
): unknown {
  if (typeof value === 'string') {
    const pattern = new RegExp(SECRET_REFERENCE_PATTERN.source, 'g')
    return value.replace(pattern, (_found, name: string) => {
      if (secrets?.has(name) !== true) {
        throw new RemoteRefusalError(
          `A plugin value needs ${name}, which ${secretsFile} does not declare. Add it there.`,
          { kind: 'auth' },
        )
      }
      return secrets.require(name)
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, secrets, secretsFile))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReferences(item, secrets, secretsFile),
      ]),
    )
  }
  return value
}

// Resolves `{{secret:NAME}}` in plugin options and remote settings against declared secrets only.
export function pluginSecretResolver(
  secrets: SecretResolver | undefined,
  secretsFile: string,
): (value: Record<string, unknown>) => Record<string, unknown> {
  return (value) => resolveReferences(value, secrets, secretsFile) as Record<string, unknown>
}
