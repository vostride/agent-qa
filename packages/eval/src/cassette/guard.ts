import {
  createVersionGuard,
  VersionGuardError,
  type MigrationRegistry,
} from '@vostride/agent-qa-schema'
import { CASSETTE_SCHEMA_VERSION, type Cassette } from './cassette'
import { cassetteSchema } from './schema'

/** Typed cassette-specific rejection for unsupported schema versions. */
export class CassetteVersionError extends VersionGuardError {
  constructor(found: number, supported: number) {
    super('Cassette', found, supported)
    this.name = 'CassetteVersionError'
  }
}

export const CASSETTE_MIGRATIONS: MigrationRegistry = {}

const guardCassetteVersion = createVersionGuard<Cassette>({
  name: 'Cassette',
  current: CASSETTE_SCHEMA_VERSION,
  migrations: CASSETTE_MIGRATIONS,
  error: CassetteVersionError,
})

function issuePath(path: PropertyKey[]): string {
  return path.length === 0 ? '<root>' : path.map(String).join('.')
}

/** Version-gates, then validates every cassette field. */
export function guardCassette(value: unknown): Cassette {
  const versioned = guardCassetteVersion(value)
  const parsed = cassetteSchema.safeParse(versioned)

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issuePath(issue.path)}: ${issue.message}`)
      .join('; ')
    throw new TypeError(`Cassette structural validation failed: ${issues}`)
  }

  return parsed.data as Cassette
}
