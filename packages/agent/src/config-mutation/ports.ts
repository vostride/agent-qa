// Host ports for what this package cannot touch: file bytes, the `yaml` edit and `core` validation.

import type {
  ConfigChange,
  ConfigPathSegment,
  ConfigWriteIssue,
  ConfigWriteRefusal,
} from '@vostride/agent-qa-schema'

/** A dotted config path's new value. The three scalar shapes a config field can hold. */
export type ConfigFieldValue = string | number | boolean

// The yaml format's own vocabulary, so a map or sequence entry is one edit, not several parses.
export type ConfigStructuredValue =
  | ConfigFieldValue
  | readonly ConfigStructuredValue[]
  | { readonly [key: string]: ConfigStructuredValue }

// Answers container shape, never values, so it is no back door to an unmasked config reader.
export interface ConfigPathFacts {
  /** The dotted path this fact is about, echoed so a caller reading several cannot misalign them. */
  readonly path: string
  readonly present: boolean
  /** Absent when the path holds nothing. */
  readonly kind?: 'scalar' | 'map' | 'sequence'
  /** A map's keys, in document order. The names a disambiguation refusal lists. */
  readonly keys?: readonly string[]
  /** A sequence's length. What an append writes at. */
  readonly length?: number
}

/** One member of the pinned config SET, with the bytes it holds right now. */
export interface ConfigFileBytes {
  /** Workspace-relative, as the host's identity mint spells it. */
  readonly path: string
  /** Absent means the file is not there — a fact, never a zero-length stand-in for one. */
  readonly bytes?: Uint8Array
}

// An enumerated set, not a glob, so every reader agrees on which files are config.
export interface ConfigFileSet {
  /** Which member of {@link ConfigFileSet.files} is the config yaml a field edit addresses. */
  readonly configFile: string
  // Named by the host from `workspace.hooksFile`, because the hooks file can have any name.
  readonly hooksFile: string
  readonly files: readonly ConfigFileBytes[]
}

// `previousValue` comes from the same parse as the edit; absent means no scalar was there.
export interface ConfigFieldSetResult {
  readonly bytes: Uint8Array
  readonly previousValue?: ConfigFieldValue
}

export interface ConfigFilesPortLike {
  // Re-read the committed set when the change is made.
  read(): Promise<ConfigFileSet>
  // Takes the bytes the caller just digested, so the edit is of the version the digest is about.
  setField(input: {
    readonly bytes?: Uint8Array
    readonly path: string
    readonly value: ConfigStructuredValue
  }): Promise<ConfigFieldSetResult>
  // Every path in one call, so every answer comes from one parse.
  inspect(input: {
    readonly bytes?: Uint8Array
    readonly paths: readonly string[]
  }): Promise<readonly ConfigPathFacts[]>
  // Minted by the host: the canonical id needs `@vostride/agent-qa-ids` and randomness.
  mintHookId(): string
}

// The validator's own words plus the file they are about, so the blocked record names that file.
export interface ConfigValidationIssue {
  /** The config-set member the issue is about — never a dotted config path. */
  readonly path: string
  // May hold a dotted config path, never a value: a `yaml` parse error excerpts the source line.
  readonly message: string
}

/**
 * What whole-config validation said about the candidate config.
 */
export type ConfigValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ConfigValidationIssue[] }

export interface ConfigValidatePortLike {
  // The whole candidate file set: a hook edit changes only the hooks file; absent files are legal.
  validate(input: {
    readonly configFile: string
    /** The hooks file member, so the validator picks a schema by NAME rather than by extension. */
    readonly hooksFile: string
    /** Every member of the pinned set, with the bytes it would hold if this proposal applied. */
    readonly files: readonly ConfigFileBytes[]
  }): Promise<ConfigValidation>
}

// `applied` names the revision merged onto, including any outside edit; a refusal wrote nothing.
export type ConfigFieldWriteOutcome =
  | {
    readonly kind: 'applied'
    /** The config member, workspace-relative. */
    readonly file: string
    readonly revision: string
    readonly baseRevision: string
  }
  | {
    readonly kind: 'refused'
    readonly file: string
    readonly error: Exclude<ConfigWriteRefusal, 'write_failed'>
    readonly issues?: readonly ConfigWriteIssue[]
    /** The field an `expect` found changed. */
    readonly path?: readonly ConfigPathSegment[]
  }

/** One whole file a generated change replaces or creates, and the bytes it was built from. */
export interface ConfigFilePublication {
  /** Workspace-relative, as the host's identity mint spells it. */
  readonly path: string
  /** sha256 of the bytes the change was built from; absent means the file must not exist. */
  readonly baseDigest?: string
  readonly bytes: Uint8Array
}

// `refused` is decided before any write; `written` names exactly the files with new bytes.
export type ConfigFilePublishOutcome =
  | { readonly kind: 'published'; readonly written: readonly string[] }
  | {
    readonly kind: 'refused'
    readonly reason:
      | 'no-files'
      | 'outside-workspace'
      | 'duplicate-path'
      | 'file-changed'
      | 'marker_written_back'
    readonly path?: string
    readonly written: readonly []
  }
  | {
    readonly kind: 'interrupted'
    readonly written: readonly string[]
    readonly failed: {
      readonly path: string
      readonly reason: 'file-changed' | 'write-failed'
      readonly message?: string
    }
    readonly unwritten: readonly string[]
  }

// Field changes merge in the path's write turn; whole files are digest-checked, written atomically.
export interface ConfigWritePortLike {
  applyFields(request: { readonly changes: readonly ConfigChange[] }): Promise<ConfigFieldWriteOutcome>
  publishFiles(request: {
    readonly files: readonly ConfigFilePublication[]
  }): Promise<ConfigFilePublishOutcome>
}

// Rendered in `cli`, which owns the one scaffold producer; it takes the derivation, not the token.
export interface ConfigScaffoldContentPortLike {
  render(input: {
    readonly targetName: string
    readonly baseUrl: string
    readonly existingGitignore?: Uint8Array
    readonly existingConfig?: ConfigScaffoldMergeTarget
  }): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]>
}

/**
 * The person's committed configuration, and where this scaffold's other members belong beside it.
 *
 * THE PATHS ARE CARRIED RATHER THAN DEFAULTED, on `ConfigFileSet.hooksFile`'s reasoning one contract
 * over. From zero the producer knows both names because it is inventing them; in a project that
 * already has a configuration it knows neither — `workspace.hooksFile` can name anything, and the
 * config member's own identity is whatever the pinned set spells. A scaffold that rendered
 * `hooks.yaml` into a project whose config names something else would be proposing a file OUTSIDE
 * the pinned set: flagged `out-of-set-path` and then refused by an apply that cannot scope to it.
 */
export interface ConfigScaffoldMergeTarget {
  /** Which member of the pinned set these bytes are — never assumed to be the default name. */
  readonly path: string
  /** The committed configuration this scaffold inserts exactly one target entry into. */
  readonly bytes: Uint8Array
  /** Where a hooks file belongs — the name the configuration itself declares. */
  readonly hooksPath: string
  /**
   * True when that file already exists, in which case the scaffold renders NO hooks at all.
   *
   * NOT AN OVERWRITE AND NOT A MERGE. The scaffold's hooks template is content for a project that
   * has none; composing it into a hooks file a person wrote would be the widest silent overwrite
   * this op could still make after the target-registry narrowing — the same overwrite
   * `already-configured` refuses for the config yaml, one file over.
   */
  readonly hooksPresent: boolean
}
