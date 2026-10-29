// Eval-owned read ports. CRITICAL: provider-neutral and storage-neutral.
// Implementations live in eval-local; this package only consumes in-memory values.

/**
 * Content-addressed artifact bytes. Absence is legitimate and is classified by
 * cassette completeness; eval-local supplies `absentArtifactSource` and
 * `DirArtifactSource` implementations.
 */
export interface ArtifactSource {
  getBlob(sha: string): Uint8Array | undefined
}
