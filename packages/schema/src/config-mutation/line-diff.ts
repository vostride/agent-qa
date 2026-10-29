// Vendored: `package-class.test.ts` allows only `zod` as a runtime dependency.

/** How many unchanged lines surround each hunk. Unified diff's own default. */
export const DIFF_CONTEXT_LINES = 3

// The LCS table is O(old × new) over caller bytes; past the cap the diff replaces the whole file.
export const MAX_DIFF_TABLE_CELLS = 4_000_000

export type LineOp = 'equal' | 'delete' | 'insert'

export interface LineEdit {
  readonly op: LineOp
  readonly text: string
}

/** One unified-diff hunk: its four coordinates and its prefixed lines. */
export interface UnifiedHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** Each line already carries its `' '`, `'-'` or `'+'` prefix. */
  readonly lines: readonly string[]
}

/**
 * Split text into lines, remembering whether the last one was terminated.
 *
 * The distinction is not cosmetic: a file that ends without a newline and one that ends with one
 * are different bytes, and a differ that collapsed them would render "no change" for a change, or
 * a change for none. Unified diff spells the difference `\ No newline at end of file`, and this is
 * where that marker's truth is decided.
 */
function splitLines(text: string): { lines: string[]; terminated: boolean } {
  if (text === '') return { lines: [], terminated: true }
  const terminated = text.endsWith('\n')
  const body = terminated ? text.slice(0, -1) : text
  return { lines: body.split('\n'), terminated }
}

/**
 * The edit script, as one flat list in output order.
 *
 * Deletes precede inserts at a given position, which is the order unified diff prints and the order
 * a reader expects: the line that was there, then the line that replaced it.
 */
export function diffLines(oldText: string, newText: string): readonly LineEdit[] {
  const oldSide = splitLines(oldText).lines
  const newSide = splitLines(newText).lines

  let prefix = 0
  while (prefix < oldSide.length && prefix < newSide.length && oldSide[prefix] === newSide[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < oldSide.length - prefix
    && suffix < newSide.length - prefix
    && oldSide[oldSide.length - 1 - suffix] === newSide[newSide.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldMiddle = oldSide.slice(prefix, oldSide.length - suffix)
  const newMiddle = newSide.slice(prefix, newSide.length - suffix)

  const edits: LineEdit[] = []
  for (let index = 0; index < prefix; index++) edits.push({ op: 'equal', text: oldSide[index]! })
  edits.push(...middleEdits(oldMiddle, newMiddle))
  for (let index = oldSide.length - suffix; index < oldSide.length; index++) {
    edits.push({ op: 'equal', text: oldSide[index]! })
  }
  return edits
}

function middleEdits(oldSide: readonly string[], newSide: readonly string[]): LineEdit[] {
  if (oldSide.length === 0 && newSide.length === 0) return []
  if (oldSide.length === 0) return newSide.map((text) => ({ op: 'insert' as const, text }))
  if (newSide.length === 0) return oldSide.map((text) => ({ op: 'delete' as const, text }))

  if ((oldSide.length + 1) * (newSide.length + 1) > MAX_DIFF_TABLE_CELLS) {
    // The honest fallback: the whole middle replaced. See MAX_DIFF_TABLE_CELLS.
    return [
      ...oldSide.map((text) => ({ op: 'delete' as const, text })),
      ...newSide.map((text) => ({ op: 'insert' as const, text })),
    ]
  }

  // Longest common subsequence by length table, then one backward walk. The table is
  // `lengths[i][j]` = LCS of `oldSide[i..]` and `newSide[j..]`, which makes the walk forward and
  // therefore the output order the printing order.
  const rows = oldSide.length + 1
  const columns = newSide.length + 1
  const lengths = new Uint32Array(rows * columns)

  for (let i = oldSide.length - 1; i >= 0; i--) {
    for (let j = newSide.length - 1; j >= 0; j--) {
      lengths[i * columns + j] = oldSide[i] === newSide[j]
        ? lengths[(i + 1) * columns + (j + 1)]! + 1
        : Math.max(lengths[(i + 1) * columns + j]!, lengths[i * columns + (j + 1)]!)
    }
  }

  const edits: LineEdit[] = []
  let i = 0
  let j = 0
  while (i < oldSide.length && j < newSide.length) {
    if (oldSide[i] === newSide[j]) {
      edits.push({ op: 'equal', text: oldSide[i]! })
      i++
      j++
    } else if (lengths[(i + 1) * columns + j]! >= lengths[i * columns + (j + 1)]!) {
      edits.push({ op: 'delete', text: oldSide[i]! })
      i++
    } else {
      edits.push({ op: 'insert', text: newSide[j]! })
      j++
    }
  }
  while (i < oldSide.length) edits.push({ op: 'delete', text: oldSide[i++]! })
  while (j < newSide.length) edits.push({ op: 'insert', text: newSide[j++]! })
  return edits
}

const NO_NEWLINE_MARKER = '\\ No newline at end of file'

/**
 * Group the edit script into unified-diff hunks with {@link DIFF_CONTEXT_LINES} of context.
 *
 * Two changes closer together than twice the context share a hunk rather than producing two that
 * overlap — overlapping hunks are the classic hand-rolled-diff defect, and a patch carrying them
 * cannot be applied by anything that reads unified diff.
 */
export function toUnifiedHunks(
  oldText: string,
  newText: string,
  context: number = DIFF_CONTEXT_LINES,
): readonly UnifiedHunk[] {
  const edits = diffLines(oldText, newText)
  if (!edits.some((edit) => edit.op !== 'equal')) return []

  const oldTerminated = splitLines(oldText).terminated
  const newTerminated = splitLines(newText).terminated

  const changedIndexes = edits.flatMap((edit, index) => (edit.op === 'equal' ? [] : [index]))
  const groups: { start: number; end: number }[] = []
  for (const index of changedIndexes) {
    const start = Math.max(0, index - context)
    const end = Math.min(edits.length - 1, index + context)
    const last = groups[groups.length - 1]
    if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end)
    else groups.push({ start, end })
  }

  // Line numbers are 1-based and counted over the SIDES, not over the edit script, so they are
  // accumulated as the script is walked rather than derived from an index.
  const oldLineAt: number[] = []
  const newLineAt: number[] = []
  let oldCursor = 1
  let newCursor = 1
  for (const edit of edits) {
    oldLineAt.push(oldCursor)
    newLineAt.push(newCursor)
    if (edit.op !== 'insert') oldCursor++
    if (edit.op !== 'delete') newCursor++
  }

  const lastOldIndex = edits.reduce((found, edit, index) => (edit.op === 'insert' ? found : index), -1)
  const lastNewIndex = edits.reduce((found, edit, index) => (edit.op === 'delete' ? found : index), -1)

  return groups.map((group) => {
    const lines: string[] = []
    let oldCount = 0
    let newCount = 0

    for (let index = group.start; index <= group.end; index++) {
      const edit = edits[index]!
      const prefix = edit.op === 'equal' ? ' ' : edit.op === 'delete' ? '-' : '+'
      lines.push(`${prefix}${edit.text}`)
      if (edit.op !== 'insert') oldCount++
      if (edit.op !== 'delete') newCount++
      if (index === lastOldIndex && !oldTerminated && edit.op !== 'insert') {
        lines.push(NO_NEWLINE_MARKER)
      } else if (index === lastNewIndex && !newTerminated && edit.op === 'insert') {
        lines.push(NO_NEWLINE_MARKER)
      }
    }

    return {
      // A zero-length side starts at 0, which is what unified diff means by "before the first line".
      oldStart: oldCount === 0 ? 0 : oldLineAt[group.start]!,
      oldLines: oldCount,
      newStart: newCount === 0 ? 0 : newLineAt[group.start]!,
      newLines: newCount,
      lines,
    }
  })
}

/**
 * Rebuild both sides from the emitted hunk lines — the differ's own acceptance bar.
 *
 * It exists so the corpus can assert the rendered diff describes the change it was rendered from,
 * rather than asserting that a differ produced some plausible-looking text. What reds it: a dropped
 * line, a prefix on the wrong side, a hunk whose header disagrees with its content, a group whose
 * context ran off an end. Only usable where the hunks cover the whole file (context = Infinity),
 * which is exactly how the corpus drives it.
 */
export function reconstructSides(hunks: readonly UnifiedHunk[]): { oldText: string; newText: string } {
  const oldLines: string[] = []
  const newLines: string[] = []
  let oldTerminated = true
  let newTerminated = true

  for (const hunk of hunks) {
    let previous: string | undefined
    for (const line of hunk.lines) {
      if (line === NO_NEWLINE_MARKER) {
        if (previous?.startsWith('+') === true) newTerminated = false
        else if (previous?.startsWith('-') === true) oldTerminated = false
        else {
          oldTerminated = false
          newTerminated = false
        }
        continue
      }
      const body = line.slice(1)
      if (line.startsWith(' ')) {
        oldLines.push(body)
        newLines.push(body)
      } else if (line.startsWith('-')) {
        oldLines.push(body)
      } else if (line.startsWith('+')) {
        newLines.push(body)
      }
      previous = line
    }
  }

  const join = (lines: readonly string[], terminated: boolean): string =>
    lines.length === 0 ? '' : `${lines.join('\n')}${terminated ? '\n' : ''}`

  return { oldText: join(oldLines, oldTerminated), newText: join(newLines, newTerminated) }
}
