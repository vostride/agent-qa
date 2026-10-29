// Must fail `yaml.stringify(doc.toJS())` and `CST.stringify(documentToken)`, which change bytes.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseTestFile } from '../yaml-parser.js'

const CORPUS_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'cst-edit-corpus',
)

interface RenderedExpectation {
  kind: 'rendered'
  removedInputLines: number[]
  addedOutputLines: number[]
  bytesIdenticalInputLines?: number[]
  outputIdenticalToInput?: boolean
  outputEndsWithExactlyOneNewline?: boolean
  topLevelKeyLinesAfter?: number[]
  stepsAfter?: string[]
}

interface RefusalExpectation {
  kind: 'refusal'
  errorName: string
  refusedPointer?: string
  renderedBytes: 0
  documentUntouchedAfterRefusal?: boolean
}

interface CorpusRow {
  input: string
  patchSet: { thoughts: string; patches: unknown[] }
  expect: RenderedExpectation | RefusalExpectation
  rationale: string
  measured: string
  disclosure: string | null
}

const expectations = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'expectations.json'), 'utf8'),
) as { cases: Record<string, CorpusRow> }

const rows = Object.entries(expectations.cases)

/** The applier under test. Lazy on purpose — see the header. */
const applier = () => import('../cst-patch.js')

// ---------------------------------------------------------------------------------------------
// The diff instrument: an LCS alignment over per-line sha256 digests of the RAW BYTES.
//
// Byte-identity is the primitive here, never decoded-string equality: two different byte
// sequences can decode to the same text, and a corpus that compares strings would call a
// re-encoded file unchanged. A positional line comparison is also not enough — a removal shifts
// every following line, so a one-line delete would report the whole tail as changed and the
// vectors would stop meaning anything.
// ---------------------------------------------------------------------------------------------

interface Line {
  number: number
  bytes: Buffer
  sha: string
}

function linesOf(bytes: Buffer): Line[] {
  const out: Line[] = []
  let start = 0
  let number = 0
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      if (i === bytes.length && i === start) break
      const slice = bytes.subarray(start, i)
      number += 1
      out.push({ number, bytes: slice, sha: createHash('sha256').update(slice).digest('hex') })
      start = i + 1
    }
  }
  return out
}

interface LineDiff {
  removedInputLines: number[]
  addedOutputLines: number[]
  /** input line number -> output line number, for every line matched byte-for-byte. */
  matched: Map<number, number>
}

function diffLines(before: Line[], after: Line[]): LineDiff {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  )
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i]![j] =
        before[i]!.sha === after[j]!.sha
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const removedInputLines: number[] = []
  const addedOutputLines: number[] = []
  const matched = new Map<number, number>()
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i]!.sha === after[j]!.sha) {
      matched.set(before[i]!.number, after[j]!.number)
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      removedInputLines.push(before[i]!.number)
      i++
    } else {
      addedOutputLines.push(after[j]!.number)
      j++
    }
  }
  while (i < before.length) removedInputLines.push(before[i++]!.number)
  while (j < after.length) addedOutputLines.push(after[j++]!.number)

  return { removedInputLines, addedOutputLines, matched }
}

/** Top-level key lines in the output: column 0, not a comment, not a sequence item. */
function topLevelKeyLines(bytes: Buffer): number[] {
  return linesOf(bytes)
    .filter((line) => /^[A-Za-z]/.test(line.bytes.toString('utf8')))
    .map((line) => line.number)
}

interface CaseRun {
  inputBytes: Buffer
  inputPath: string
  output?: Buffer
  error?: Error
  /** Rendering the parsed document AFTER the run, which a refusal must leave untouched. */
  reRender?: Buffer
}

async function runCase(row: CorpusRow): Promise<CaseRun> {
  const {
    applyPatchSetToTestDoc,
    parseTestFileWithTokens,
    renderPatchedTestDoc,
  } = await applier()
  const { TestEditPatchSetSchema } = await import('@vostride/agent-qa-schema')

  const inputPath = join(CORPUS_DIR, row.input)
  const inputBytes = readFileSync(inputPath)
  const patchSet = TestEditPatchSetSchema.parse(row.patchSet)

  const parsed = parseTestFileWithTokens(inputBytes.toString('utf8'), inputPath)
  try {
    applyPatchSetToTestDoc(parsed, patchSet)
    return {
      inputBytes,
      inputPath,
      output: Buffer.from(renderPatchedTestDoc(parsed, inputPath), 'utf8'),
    }
  } catch (error) {
    let reRender: Buffer | undefined
    try {
      reRender = Buffer.from(renderPatchedTestDoc(parsed, inputPath), 'utf8')
    } catch {
      reRender = undefined
    }
    return { inputBytes, inputPath, error: error as Error, reRender }
  }
}

const renderedRows = rows.filter(([, row]) => row.expect.kind === 'rendered')
const refusalRows = rows.filter(([, row]) => row.expect.kind === 'refusal')

describe('the frozen edit corpus — the diff is confined to the lines the pointers address', () => {
  it.each(renderedRows)('%s', async (id, row) => {
    const expected = row.expect as RenderedExpectation
    const run = await runCase(row)

    expect(run.error, `${id} refused: ${run.error?.message}`).toBeUndefined()
    const output = run.output!

    const diff = diffLines(linesOf(run.inputBytes), linesOf(output))
    expect(diff.removedInputLines, `${id} removed input lines`).toEqual(expected.removedInputLines)
    expect(diff.addedOutputLines, `${id} added output lines`).toEqual(expected.addedOutputLines)

    for (const lineNumber of expected.bytesIdenticalInputLines ?? []) {
      const inputLine = linesOf(run.inputBytes).find((line) => line.number === lineNumber)!
      const outputLineNumber = diff.matched.get(lineNumber)
      expect(
        outputLineNumber,
        `${id} input line ${lineNumber} (${JSON.stringify(inputLine.bytes.toString('utf8'))}) `
          + 'has no byte-identical counterpart in the output',
      ).toBeDefined()
      const outputLine = linesOf(output).find((line) => line.number === outputLineNumber)!
      expect(outputLine.sha, `${id} line ${lineNumber} sha256`).toBe(inputLine.sha)
      expect(inputLine.bytes.equals(outputLine.bytes)).toBe(true)
    }

    if (expected.outputIdenticalToInput === true) {
      expect(createHash('sha256').update(output).digest('hex')).toBe(
        createHash('sha256').update(run.inputBytes).digest('hex'),
      )
    }

    if (expected.outputEndsWithExactlyOneNewline === true) {
      const text = output.toString('utf8')
      expect(text.endsWith('\n'), `${id} output has no trailing newline`).toBe(true)
      expect(text.endsWith('\n\n'), `${id} output ends with a blank line`).toBe(false)
    }

    if (expected.topLevelKeyLinesAfter !== undefined) {
      expect(topLevelKeyLines(output), `${id} top-level key line positions`).toEqual(
        expected.topLevelKeyLinesAfter,
      )
    }

    if (expected.stepsAfter !== undefined) {
      const reparsed = parseTestFile(output.toString('utf8'), run.inputPath)
      expect(reparsed.errors.map((error) => error.message)).toEqual([])
      expect(reparsed.tests[0]!.steps, `${id} steps after the patch set`).toEqual(
        expected.stepsAfter,
      )
    }
  })
})

describe('the frozen edit corpus — refusals name themselves and write nothing', () => {
  it.each(refusalRows)('%s', async (id, row) => {
    const expected = row.expect as RefusalExpectation
    const run = await runCase(row)

    expect(run.output, `${id} rendered ${run.output?.length ?? 0} bytes instead of refusing`)
      .toBeUndefined()
    expect(run.error, `${id} did not throw`).toBeDefined()
    expect(run.error!.name, `${id} refusal class`).toBe(expected.errorName)

    if (expected.refusedPointer !== undefined) {
      expect(
        run.error!.message,
        `${id} refusal message does not name the pointer it refused`,
      ).toContain(expected.refusedPointer)
      expect((run.error as unknown as { pointer?: string }).pointer).toBe(expected.refusedPointer)
    }

    if (expected.documentUntouchedAfterRefusal === true) {
      // The set carried a legitimate op ahead of the refused one. If the fence ran per-op instead
      // of up front, that legitimate op would already have mutated the document, and re-rendering
      // the parsed document after the throw would no longer match the input bytes.
      expect(run.reRender, `${id} could not be re-rendered after the refusal`).toBeDefined()
      expect(
        createHash('sha256').update(run.reRender!).digest('hex'),
        `${id} the refused set left a partial mutation behind`,
      ).toBe(createHash('sha256').update(run.inputBytes).digest('hex'))
    }
  })
})

describe('the applier exports the refusal vocabulary the corpus scores against', () => {
  it('names all four refusals as separate classes, never one error with a discriminator', async () => {
    const module = await applier()
    for (const name of [
      'PatchPointerOutsideEditableRegionError',
      'PatchPointerUnresolvableError',
      'PatchedDocumentInvalidError',
      'PatchOpUnsupportedTargetError',
    ] as const) {
      expect(typeof module[name], `${name} is not exported`).toBe('function')
      expect(module[name].prototype).toBeInstanceOf(Error)
    }
  })

  it('refuses a pointer that resolves to nothing, separately from one outside the fence', async () => {
    const { applyPatchSetToTestDoc, parseTestFileWithTokens } = await applier()
    const inputPath = join(CORPUS_DIR, '01-untouched-round-trip.yaml')
    const parsed = parseTestFileWithTokens(readFileSync(inputPath, 'utf8'), inputPath)

    expect(() =>
      applyPatchSetToTestDoc(parsed, {
        thoughts: '',
        patches: [{ op: 'replace', path: '/steps/97', value: 'Click the Submit button' }],
      }),
    ).toThrow(/PatchPointerUnresolvable|does not resolve/)
  })

  // The nine frozen rows do NOT exercise index-0 displacement, and a mutation differential proved
  // it: deleting the `index === 0` branch of the start-token normaliser left all twelve cells
  // green. That branch exists because item 0 alone does not carry its own leading whitespace, so
  // an insert or a removal at index 0 is the one edit that can silently re-indent a line. These
  // two cells are NOT corpus members — the frozen denominator is not being widened to re-score —
  // they are ordinary contract assertions covering a hole the differential named. Both were
  // observed RED against the mutated normaliser before this comment was written.
  it.each([
    ['insert at index 0', { op: 'add', path: '/steps/0', value: 'Open the sign-in page' }],
    ['remove index 0', { op: 'remove', path: '/steps/0' }],
  ] as const)('%s keeps every sequence item at its original indent', async (_label, op) => {
    const { applyPatchSetToTestDoc, parseTestFileWithTokens, renderPatchedTestDoc } =
      await applier()
    const inputPath = join(CORPUS_DIR, '05-two-ops-adjacent-indices.yaml')
    const parsed = parseTestFileWithTokens(readFileSync(inputPath, 'utf8'), inputPath)

    applyPatchSetToTestDoc(parsed, { thoughts: '', patches: [op] })
    const output = renderPatchedTestDoc(parsed, inputPath)

    const itemLines = output.split('\n').filter((line) => line.trimStart().startsWith('- '))
    expect(itemLines.length).toBeGreaterThan(1)
    for (const line of itemLines) {
      expect(line, 'a sequence item lost or gained indentation').toMatch(/^ {2}- \S/)
    }
  })

  // Also not a corpus member, and also a hole a differential named: every frozen input ends with a
  // newline (the preflight asserts it), so none of the nine exercises appending after an item that
  // has no line terminator. The 394 research probe hit exactly that and produced `- two  - three`
  // on one line. The source here is the corpus fixture with its final newline stripped, so the
  // input is still something the real parser accepts rather than a hand-built shape.
  it('appends after an unterminated last item without gluing the two onto one line', async () => {
    const { applyPatchSetToTestDoc, parseTestFileWithTokens, renderPatchedTestDoc } =
      await applier()
    const inputPath = join(CORPUS_DIR, '05-two-ops-adjacent-indices.yaml')
    const source = readFileSync(inputPath, 'utf8').replace(/\n$/, '')
    expect(source.endsWith('\n')).toBe(false)

    const parsed = parseTestFileWithTokens(source, inputPath)
    applyPatchSetToTestDoc(parsed, {
      thoughts: '',
      patches: [{ op: 'add', path: '/steps/-', value: 'Verify the Logout button is visible' }],
    })
    const output = renderPatchedTestDoc(parsed, inputPath)

    expect(output).toContain('  - Verify the page says "Received!"\n')
    expect(output.split('\n').filter((line) => line.trimStart().startsWith('- '))).toHaveLength(4)
  })

  it('round-trips the untouched parse: the whole token array stringifies back to the source', async () => {
    const { parseTestFileWithTokens, renderPatchedTestDoc } = await applier()
    const inputPath = join(CORPUS_DIR, '07-key-order-preserved.yaml')
    const source = readFileSync(inputPath, 'utf8')
    const parsed = parseTestFileWithTokens(source, inputPath)
    expect(renderPatchedTestDoc(parsed, inputPath)).toBe(source)
  })
})
