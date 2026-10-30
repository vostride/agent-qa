// RFC 6902 patches applied to the CST in place; `doc.toJS()` would reformat untouched lines.

import {
  Composer,
  CST,
  Document,
  Parser,
  isMap,
  isScalar,
  isSeq,
} from 'yaml'
import type { Node, Scalar, YAMLSeq } from 'yaml'

import {
  EDITABLE_POINTER_ROOTS,
  isEditablePointer,
  parseJsonPointer,
} from '@vostride/agent-qa-schema'
import type { PatchOp, TestEditPatchSet } from '@vostride/agent-qa-schema'

import { parseTestFile } from './yaml-parser.js'

/**
 * A test document parsed so that BOTH halves survive: the composed model a pointer resolves
 * against, and the token array the render concatenates.
 *
 * The two are not redundant. Pointer resolution needs the model (`getIn`-shaped navigation over
 * maps and sequences); byte preservation needs the tokens. Handing a caller only one of them would
 * force it to re-parse to get the other, and a second parse is a second opinion about the source.
 */
export interface ParsedTestDocument {
  readonly source: string
  readonly filePath: string
  readonly tokens: CST.Token[]
  readonly doc: Document
}

// ---- Refusals -------------------------------------------------------------------------------
//
// Separate classes, never one error carrying a `kind`. A caller legitimately distinguishes "you
// addressed a region you may not edit" (a boundary violation worth reporting) from "your pointer
// does not resolve" (a stale or hallucinated path, worth retrying against a fresh read) from
// "your edit produced a document this project cannot run" (worth repairing) from "that op cannot
// be applied to that kind of node" (worth re-planning the edit). One class with a discriminator
// would make every one of those `catch` blocks read a string.

/** A pointer addressed a document root outside `EDITABLE_POINTER_ROOTS`. */
export class PatchPointerOutsideEditableRegionError extends Error {
  constructor(readonly pointer: string) {
    super(
      `cst-patch: the pointer ${pointer} addresses a region no patch may edit; `
        + `only ${EDITABLE_POINTER_ROOTS.join(', ')} are editable, because a patch that can reach `
        + 'the identity fields can silently change which app the test drives',
    )
    this.name = 'PatchPointerOutsideEditableRegionError'
  }
}

/** A pointer named a node the document does not have. */
export class PatchPointerUnresolvableError extends Error {
  constructor(readonly pointer: string, readonly detail: string) {
    super(
      `cst-patch: the pointer ${pointer} does not resolve against this document (${detail}); `
        + 'a patch is applied to the document it was written against, never to a guess',
    )
    this.name = 'PatchPointerUnresolvableError'
  }
}

// `add` and `remove` act on block-sequence items only; a key change is a shape change.
export class PatchOpUnsupportedTargetError extends Error {
  constructor(readonly pointer: string, readonly detail: string) {
    super(`cst-patch: the pointer ${pointer} cannot carry this op: ${detail}`)
    this.name = 'PatchOpUnsupportedTargetError'
  }
}

/**
 * A document this project cannot run — checked on the SOURCE before anything is applied and on the
 * RENDERED bytes before anything may be written.
 *
 * Both directions matter. Validating only the render would let a pre-existing invalidity be
 * blamed on the patch; validating only the source would let a CST mutation that produced
 * structurally broken YAML reach a file. Same predicate, same evidence, two call sites.
 */
export class PatchedDocumentInvalidError extends Error {
  constructor(readonly phase: 'source' | 'rendered', readonly detail: string) {
    super(
      `cst-patch: the ${phase} document is not a valid test: ${detail}; `
        + 'a patched document is schema-validated before any caller may write it',
    )
    this.name = 'PatchedDocumentInvalidError'
  }
}

// ---- Parse ----------------------------------------------------------------------------------

/**
 * Parse a test file retaining the CST token array beside the composed document.
 *
 * The composer is given `keepSourceTokens` so every node carries a `srcToken` back-reference; that
 * back-reference is the entire bridge between a pointer (which addresses the model) and a mutation
 * (which must land on the syntax).
 */
export function parseTestFileWithTokens(source: string, filePath: string): ParsedTestDocument {
  const tokens = [...new Parser().parse(source)]
  const docs = [...new Composer({ keepSourceTokens: true }).compose(tokens)]

  if (docs.length !== 1) {
    throw new PatchedDocumentInvalidError(
      'source',
      `expected exactly one YAML document, found ${docs.length}`,
    )
  }
  const doc = docs[0]!
  if (doc.errors.length > 0) {
    throw new PatchedDocumentInvalidError(
      'source',
      doc.errors.map((error) => error.message).join('; '),
    )
  }

  assertRunnable('source', source, filePath)

  return { source, filePath, tokens, doc }
}

function assertRunnable(phase: 'source' | 'rendered', content: string, filePath: string): void {
  const { tests, errors } = parseTestFile(content, filePath)
  if (errors.length > 0) {
    throw new PatchedDocumentInvalidError(phase, errors.map((error) => error.message).join('; '))
  }
  if (tests.length !== 1) {
    throw new PatchedDocumentInvalidError(
      phase,
      `expected exactly one test definition, found ${tests.length}`,
    )
  }
}

// ---- Apply ----------------------------------------------------------------------------------

/**
 * Apply a patch set in document order, mutating `parsed.doc` and its tokens in place.
 *
 * TWO PROPERTIES THE ORDER BUYS. First, the fence runs over the WHOLE set before any mutation, so
 * a set mixing a legitimate op with an out-of-region one leaves nothing behind — a per-op check
 * would have already rewritten the legitimate target by the time it refused. Second, each pointer
 * resolves against the document as PRIOR ops left it, which is what RFC-6902 means by a sequence
 * of operations: an `add` earlier in an array shifts every later index, and resolving every
 * pointer against the original document would edit a plausible, schema-valid, wrong step.
 */
export function applyPatchSetToTestDoc(
  parsed: ParsedTestDocument,
  patchSet: TestEditPatchSet,
): void {
  for (const op of patchSet.patches) {
    if (!isEditablePointer(op.path)) throw new PatchPointerOutsideEditableRegionError(op.path)
  }
  for (const op of patchSet.patches) {
    applyOne(parsed.doc, op)
  }
}

function applyOne(doc: Document, op: PatchOp): void {
  const segments = parseJsonPointer(op.path)

  switch (op.op) {
    case 'replace': {
      const node = resolveNode(doc, segments)
      if (node === undefined) {
        throw new PatchPointerUnresolvableError(op.path, 'no node at that path')
      }
      if (!isScalar(node) || node.srcToken === undefined) {
        throw new PatchOpUnsupportedTargetError(
          op.path,
          'replace writes one scalar token, and that path is a collection',
        )
      }
      CST.setScalarValue(node.srcToken, op.value)
      return
    }

    case 'add': {
      const { seqToken, index } = resolveSeqSlot(doc, op.path, segments, 'add')
      if (index > seqToken.items.length) {
        throw new PatchPointerUnresolvableError(
          op.path,
          `index ${index} is past the end of a ${seqToken.items.length}-item sequence`,
        )
      }
      if (index > 0) terminateItem(seqToken.items[index - 1])
      seqToken.items.splice(index, 0, newSeqItem(seqToken, op.value))
      normalizeItemStarts(seqToken)
      resyncSeqNode(doc, segments.slice(0, -1))
      return
    }

    case 'remove': {
      const { seqToken, index } = resolveSeqSlot(doc, op.path, segments, 'remove')
      if (index >= seqToken.items.length) {
        throw new PatchPointerUnresolvableError(
          op.path,
          `index ${index} is past the end of a ${seqToken.items.length}-item sequence`,
        )
      }
      seqToken.items.splice(index, 1)
      normalizeItemStarts(seqToken)
      resyncSeqNode(doc, segments.slice(0, -1))
      return
    }
  }
}

interface SeqSlot {
  seqToken: CST.BlockSequence
  index: number
}

/** Resolve `<parent>/<index|->` to the parent's block-sequence token and a slot in it. */
function resolveSeqSlot(
  doc: Document,
  pointer: string,
  segments: string[],
  op: 'add' | 'remove',
): SeqSlot {
  if (segments.length < 2) {
    throw new PatchOpUnsupportedTargetError(
      pointer,
      `${op} operates on a sequence item, and that path names a top-level key; `
        + 'adding or removing a key is a document rewrite, not a patch',
    )
  }

  const parent = resolveNode(doc, segments.slice(0, -1))
  if (parent === undefined) {
    throw new PatchPointerUnresolvableError(pointer, 'the parent collection does not resolve')
  }
  if (!isSeq(parent)) {
    throw new PatchOpUnsupportedTargetError(
      pointer,
      `${op} operates on a sequence item, and the parent at that path is not a sequence`,
    )
  }

  const seqToken = (parent as YAMLSeq).srcToken
  if (seqToken === undefined || seqToken.type !== 'block-seq') {
    throw new PatchOpUnsupportedTargetError(
      pointer,
      `${op} rebuilds block-sequence indentation, and that sequence is written in flow style`,
    )
  }

  const last = segments[segments.length - 1]!
  if (op === 'add' && last === '-') return { seqToken, index: seqToken.items.length }

  const index = asIndex(last)
  if (index === undefined) {
    throw new PatchPointerUnresolvableError(pointer, `${last} is not a sequence index`)
  }
  return { seqToken, index }
}

function asIndex(segment: string): number | undefined {
  return /^(?:0|[1-9]\d*)$/.test(segment) ? Number(segment) : undefined
}

/** Walk the composed model one reference token at a time. */
function resolveNode(doc: Document, segments: string[]): Node | undefined {
  let node: unknown = doc.contents
  for (const segment of segments) {
    if (isSeq(node)) {
      const index = asIndex(segment)
      if (index === undefined || index >= node.items.length) return undefined
      node = node.items[index]
    } else if (isMap(node)) {
      const pair = node.items.find(
        (candidate) => isScalar(candidate.key) && String((candidate.key as Scalar).value) === segment,
      )
      if (pair === undefined) return undefined
      node = pair.value
    } else {
      return undefined
    }
  }
  return (node ?? undefined) as Node | undefined
}

/**
 * Re-compose the sequence NODE after its token items changed.
 *
 * The composed model and the CST are two views of one document, and a structural edit moves them
 * out of step: splicing `srcToken.items` changes what the file says while `seq.items` still
 * describes what it said. Every later pointer in the same set resolves against the MODEL, so
 * leaving it stale is exactly how the second op of a two-op set lands on the wrong index.
 */
function resyncSeqNode(doc: Document, parentSegments: string[]): void {
  const parent = resolveNode(doc, parentSegments)
  if (!isSeq(parent)) return

  const seqToken = (parent as YAMLSeq).srcToken
  if (seqToken === undefined || seqToken.type !== 'block-seq') return

  const rebuilt = [
    ...new Composer({ keepSourceTokens: true }).compose([
      { type: 'document', offset: 0, start: [], value: seqToken },
    ]),
  ]
  const contents = rebuilt[0]?.contents
  if (!isSeq(contents)) return

  const seq = parent as YAMLSeq
  seq.items = contents.items
}

// `createScalarToken` adds its own newline; without it an appended item joins the previous line.
function newSeqItem(seqToken: CST.BlockSequence, value: string): CST.BlockSequence['items'][number] {
  return {
    start: [
      { type: 'seq-item-ind', offset: -1, indent: seqToken.indent, source: '-' },
      { type: 'space', offset: -1, indent: seqToken.indent + 1, source: ' ' },
    ],
    value: CST.createScalarToken(value, { indent: seqToken.indent + 2 }),
  }
}

/**
 * Give an item a trailing newline if it has none, so the next item starts on its own line.
 *
 * The absence of a terminator is expressed as an ABSENT `end` key, not an empty array: a file whose
 * last line has no newline yields a scalar token with no `end` property at all. Probing for the
 * key and returning early therefore skips exactly the case this function exists for — which is how
 * an append onto an unterminated last item produces two steps concatenated on one line. A
 * block-scalar carries its own terminator inside `source` and is left alone.
 */
function terminateItem(item: CST.BlockSequence['items'][number] | undefined): void {
  const value = item?.value
  if (value === undefined || !CST.isScalar(value) || value.type === 'block-scalar') return
  const end = (value.end ??= [])
  if (end.some((token) => token.type === 'newline')) return
  end.push({ type: 'newline', offset: -1, indent: 0, source: '\n' })
}

/**
 * Restore the one positional invariant of a block sequence after items moved.
 *
 * Item 0 alone does NOT carry its own leading whitespace — the indentation before the first `-`
 * belongs to the parent mapping item's separator tokens, while items 1..n each carry a `space`
 * token of their own. So an insert at index 0, or a removal of index 0, silently produces a
 * document where one line's indentation is wrong. Only items whose position-0-ness actually
 * changed are touched; every other item's `start` array is left exactly as parsed, which is what
 * keeps `remove` from re-indenting lines nobody addressed.
 */
function normalizeItemStarts(seqToken: CST.BlockSequence): void {
  const pad = ' '.repeat(seqToken.indent)
  seqToken.items.forEach((item, index) => {
    const start = item.start
    const leadsWithSpace = start[0]?.type === 'space'
    if (index === 0 && leadsWithSpace) start.shift()
    if (index > 0 && !leadsWithSpace) {
      start.unshift({ type: 'space', offset: -1, indent: 0, source: pad })
    }
  })
}

// ---- Render ---------------------------------------------------------------------------------

/**
 * Concatenate the whole token array back to bytes, then refuse anything unrunnable.
 *
 * THE RENDER IS OVER `parsed.tokens`, NEVER OVER THE DOCUMENT TOKEN ALONE. `CST.stringify`'s own
 * doc comment states it "applies no validation whatsoever, and simply concatenates the sources in
 * their logical order" — that concatenation IS the byte-preservation guarantee. A file's leading
 * comment is a separate token in the parser's output stream, positioned BEFORE the document token,
 * so `CST.stringify(documentToken)` drops it. That is the one genuinely non-obvious line here, it
 * was measured rather than reasoned about, and the frozen corpus's untouched-round-trip row is
 * the cell that catches a regression to it.
 */
export function renderPatchedTestDoc(parsed: ParsedTestDocument, filePath?: string): string {
  const rendered = parsed.tokens.map((token) => CST.stringify(token)).join('')
  assertRunnable('rendered', rendered, filePath ?? parsed.filePath)
  return rendered
}
