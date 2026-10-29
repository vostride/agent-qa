// The vendored line differ.
//
// VENDORED RATHER THAN DEPENDED ON, and the reason is a running test rather than a preference.
// `__tests__/package-class.test.ts` allow-lists this package's runtime dependencies at exactly
// `{zod}`, and `__tests__/module-discipline.test.ts` refuses host APIs — the same law that made
// `determinism/sha256.ts` a vendored implementation instead of a Web Crypto call. Adding `diff`
// (jsdiff) here was the plan's written route and it reds `package-class.test.ts`; widening that
// allow-list to admit the dependency would have resolved the refusal by opening the boundary the
// refusal is about. 395-RESEARCH named this alternative as the house pattern: more work here, zero
// new supply-chain surface, and T-395-SC ceases to exist.
//
// WHAT IT MUST NOT DO, because a hand-rolled diff's failure mode is silent: render a diff that
// disagrees with the change it describes. So the OBLIGATION is checkable rather than claimed —
// {@link reconstructSides} rebuilds both sides from the emitted lines, and the corpus asserts the
// rebuild equals the inputs. A dropped line, a wrong hunk header or an off-by-one start reds there
// rather than reaching a person as a diff that reads correctly and is not what would be committed.
//
// COMMON PREFIX/SUFFIX FIRST, THEN LCS ON WHAT IS LEFT. A config edit changes one or two lines in a
// file of a hundred, so the trimmed middle is nearly always tiny and the table below is nearly
// always trivial. The cap exists for the case that is not.

/** How many unchanged lines surround each hunk. Unified diff's own default. */
export const DIFF_CONTEXT_LINES = 3

/**
 * The largest LCS table this differ will build, in cells.
 *
 * raise it if a real config file set is being rendered as one whole-file replacement when a
 * line-level diff would have been reviewable. It exists because the table is O(old × new) and the
 * inputs are caller-supplied bytes: 4,000,000 cells is roughly a 2,000-line change against a
 * 2,000-line file, which is far outside anything the pinned config SET can be, and beyond it a
 * reviewer is not reading a line diff anyway. The fallback is honest rather than degraded — every
 * old line removed and every new line added, which is exactly what the change is.
 */
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
