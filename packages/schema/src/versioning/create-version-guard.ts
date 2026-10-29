/** A source-version keyed sequence of one-version-at-a-time migrations. */
export type MigrationRegistry = Record<number, (doc: unknown) => unknown>

export interface VersionGuardConfig<T> {
  name: string
  current: number
  migrations: MigrationRegistry
  error?: new (found: number, supported: number) => Error
  /**
   * Fail-closed structural check applied after the migration walk. `schemaVersion`
   * states which contract a document claims; this hook verifies that the migrated
   * document structurally honors the current contract before consumers traverse it.
   */
  shape?: (migrated: unknown) => boolean
}

/** Typed rejection shared by every schema-versioned document guard. */
export class VersionGuardError extends Error {
  readonly documentName: string
  readonly foundVersion: number
  readonly supportedVersion: number

  constructor(documentName: string, found: number, supported: number) {
    super(
      `${documentName} schemaVersion ${found} is not supported (this build supports ${supported})`,
    )
    this.name = 'VersionGuardError'
    this.documentName = documentName
    this.foundVersion = found
    this.supportedVersion = supported
  }
}

// Parse, reject newer, walk migrations, then cast.
export function createVersionGuard<T>(config: VersionGuardConfig<T>): (value: unknown) => T {
  const versionError = (found: number): Error =>
    config.error === undefined
      ? new VersionGuardError(config.name, found, config.current)
      : new config.error(found, config.current)

  return (value: unknown): T => {
    if (value === null || typeof value !== 'object') {
      throw new TypeError(`${config.name} must be an object`)
    }

    const version = (value as { schemaVersion?: unknown }).schemaVersion
    if (typeof version !== 'number' || !Number.isFinite(version)) {
      throw new TypeError(`${config.name} requires a numeric schemaVersion`)
    }

    if (version > config.current) {
      throw versionError(version)
    }

    let migrated: unknown = value
    for (let from = version; from < config.current; from++) {
      const migrate = config.migrations[from]
      if (migrate === undefined) {
        throw versionError(version)
      }
      migrated = migrate(migrated)
    }

    if (config.shape !== undefined && !config.shape(migrated)) {
      throw new TypeError(`${config.name} failed structural validation`)
    }

    return migrated as T
  }
}
