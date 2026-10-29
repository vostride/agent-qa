// Read ports only; implementations live in eval-local.

/**
 * Content-addressed artifact bytes. Absence is legitimate and is classified by
 * cassette completeness; eval-local supplies `absentArtifactSource` and
 * `DirArtifactSource` implementations.
 */
export interface ArtifactSource {
  getBlob(sha: string): Uint8Array | undefined
}
