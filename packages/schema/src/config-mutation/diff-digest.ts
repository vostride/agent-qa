// Digests take the caller's raw bytes; only rendering decodes, and paths sort by UTF-8 bytes.

import { sha256hexBytes } from '../determinism/sha256'
import type { FileChange, Hunk } from '../patch/patch'
import { DIFF_CONTEXT_LINES, toUnifiedHunks } from './line-diff'
import { utf8Decode, utf8Encode } from './utf8'

/** One file's before/after RAW bytes. Absent `oldBytes` is an add; absent `newBytes` is a delete. */
export interface ConfigDiffFileInput {
  readonly path: string
  readonly oldBytes?: Uint8Array
  readonly newBytes?: Uint8Array
}

/** What one file hashed to on each side. Absent where that side has no file at all. */
export interface ConfigFileDigest {
  readonly path: string
  readonly oldDigest?: string
  readonly newDigest?: string
}

/** What the primitive found: bytes that differ somewhere, or bytes that do not. */
export const CONFIG_DIFF_OUTCOMES = ['changed', 'unchanged'] as const

export type ConfigDiffOutcome = (typeof CONFIG_DIFF_OUTCOMES)[number]

export interface ConfigDiffChanged {
  readonly outcome: 'changed'
  /** The rendered unified diff, as the exact bytes a proposal stores and an apply compares. */
  readonly diffBytes: Uint8Array
  /** sha256 over exactly {@link ConfigDiffChanged.diffBytes}. */
  readonly diffDigest: string
  readonly perFileDigests: readonly ConfigFileDigest[]
  /** The same change in the reserved `patch/` vocabulary, for surfaces that read structure. */
  readonly changes: readonly FileChange[]
}

/**
 * Every file's two sides held the same bytes. There is nothing to show and nothing to decide.
 *
 * THE DIGESTS SURVIVE, THE DIFF DOES NOT. An apply that re-reads and finds no change still wants to
 * know what the files hashed to — that is how it says which file it looked at — but there is no
 * diff for it to compare against a stored one, and a zero-byte `diffBytes` here would be a value
 * whose digest an unwary caller could compare against a real proposal's and find unequal, reporting
 * a tampering refusal for a file nobody touched.
 */
export interface ConfigDiffUnchanged {
  readonly outcome: 'unchanged'
  readonly perFileDigests: readonly ConfigFileDigest[]
  readonly changes: readonly FileChange[]
}

export type ConfigDiffResult = ConfigDiffChanged | ConfigDiffUnchanged

/**
 * A file with no bytes on either side is not a change and must not be one.
 *
 * Refused BY NAME rather than rendered as an empty section: a caller that handed neither side is
 * either enumerating a file set it cannot read or has lost a byte payload somewhere upstream, and a
 * proposal listing a file with no content on either side would be a decision about nothing.
 */
export class EmptyConfigDiffFileError extends TypeError {
  constructor(readonly path: string) {
    super(
      `refusing to diff ${JSON.stringify(path)}: neither old nor new bytes were supplied, so there `
      + 'is no change to render and nothing to digest.',
    )
    this.name = 'EmptyConfigDiffFileError'
  }
}

// Undecodable bytes render as U+FFFD, so a real change can show as an empty diff; refuse it.
export class UnrenderableConfigDiffError extends TypeError {
  constructor(readonly paths: readonly string[]) {
    super(
      `refusing to render a change to ${paths.map((path) => JSON.stringify(path)).join(', ')}: the `
      + 'bytes differ but the unified diff of them is empty, which means the difference is in byte '
      + 'sequences that are not text and a person would be asked to approve a blank page. Nothing '
      + 'has been proposed.',
    )
    this.name = 'UnrenderableConfigDiffError'
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Byte-wise on the UTF-8 encoding of the path — see the file header for why not `<`. */
function comparePaths(left: string, right: string): number {
  const leftBytes = utf8Encode(left)
  const rightBytes = utf8Encode(right)
  const shared = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < shared; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

function changeKindFor(file: ConfigDiffFileInput): FileChange['changeKind'] {
  if (file.oldBytes === undefined && file.newBytes === undefined) {
    throw new EmptyConfigDiffFileError(file.path)
  }
  if (file.oldBytes === undefined) return 'add'
  if (file.newBytes === undefined) return 'delete'
  return 'modify'
}

function hunksFor(file: ConfigDiffFileInput, context: number): Hunk[] {
  const oldText = file.oldBytes === undefined ? '' : utf8Decode(file.oldBytes)
  const newText = file.newBytes === undefined ? '' : utf8Decode(file.newBytes)
  return toUnifiedHunks(oldText, newText, context).map((hunk) => ({
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    lines: [...hunk.lines],
  }))
}

/**
 * The `---`/`+++` pair, with `/dev/null` on the side that has no file — git's own spelling.
 *
 * The prefixes are `a/` and `b/` for the same reason: the bytes this renders are what a person
 * reviews in a chat window before saying yes, and a diff that did not look like a diff would be a
 * new artifact class for them to learn.
 */
function fileHeaderLines(file: ConfigDiffFileInput, changeKind: FileChange['changeKind']): string[] {
  return [
    changeKind === 'add' ? '--- /dev/null' : `--- a/${file.path}`,
    changeKind === 'delete' ? '+++ /dev/null' : `+++ b/${file.path}`,
  ]
}

/**
 * Render the diff and take the digests, for one file set, in one pass.
 *
 * The `perFileDigests` and the `diffBytes` come out of the SAME call because they are one claim:
 * "this diff is what these bytes produce". A caller that could ask for one without the other would
 * be able to store a digest taken at one moment beside a diff rendered at another, which is the
 * disagreement the whole freshness contract exists to make impossible.
 */
export function renderConfigDiff(
  files: readonly ConfigDiffFileInput[],
  options: { readonly context?: number } = {},
): ConfigDiffResult {
  const context = options.context ?? DIFF_CONTEXT_LINES
  const ordered = [...files].sort((left, right) => comparePaths(left.path, right.path))

  const changes: FileChange[] = []
  const perFileDigests: ConfigFileDigest[] = []
  const lines: string[] = []
  // DECIDED FROM THE BYTES, ONE FILE AT A TIME, and collected rather than short-circuited so the
  // refusal below can name every path it applies to instead of the first one it met.
  const changedButUnrendered: string[] = []
  let anyBytesDiffer = false

  for (const file of ordered) {
    const changeKind = changeKindFor(file)
    const hunks = hunksFor(file, context)
    changes.push({ path: file.path, changeKind, hunks })
    perFileDigests.push({
      path: file.path,
      // RAW BYTES, NEVER THE DECODING ABOVE. The decode two lines up feeds the render and nothing
      // else; these two digests are the values an apply re-checks against a file on disk.
      ...(file.oldBytes === undefined ? {} : { oldDigest: sha256hexBytes(file.oldBytes) }),
      ...(file.newBytes === undefined ? {} : { newDigest: sha256hexBytes(file.newBytes) }),
    })

    const bytesDiffer = file.oldBytes === undefined
      || file.newBytes === undefined
      || !bytesEqual(file.oldBytes, file.newBytes)
    if (bytesDiffer) anyBytesDiffer = true
    if (bytesDiffer && hunks.length === 0) changedButUnrendered.push(file.path)

    if (hunks.length === 0) continue
    lines.push(...fileHeaderLines(file, changeKind))
    for (const hunk of hunks) {
      lines.push(hunk.header)
      lines.push(...hunk.lines)
    }
  }

  if (changedButUnrendered.length > 0) throw new UnrenderableConfigDiffError(changedButUnrendered)

  if (!anyBytesDiffer) return { outcome: 'unchanged', perFileDigests, changes }

  // A trailing newline closes the last line, which every line before it already has. The zero-line
  // case cannot reach here: no byte differs (answered above) or the difference did not render
  // (refused above), so an empty rendering is never something this function returns.
  const diffBytes = utf8Encode(`${lines.join('\n')}\n`)

  return {
    outcome: 'changed',
    diffBytes,
    diffDigest: sha256hexBytes(diffBytes),
    perFileDigests,
    changes,
  }
}
