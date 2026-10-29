// Every byte outside the two markers is returned as it arrived; the block is sliced in place.

export type ManagedBlockCommentSyntax = 'hash' | 'html'

export interface ManagedBlockDescriptor {
  readonly owner: string
  readonly blockName: string
  readonly syntax: ManagedBlockCommentSyntax
}

export interface ManagedBlockContent {
  readonly descriptor: ManagedBlockDescriptor
  /** The owned lines between the markers, without terminators. */
  readonly body: readonly string[]
  /** Names the file in refusals, e.g. `target .gitignore`. */
  readonly target: string
}

export type ManagedBlockRefusalReason = 'ambiguous-marker' | 'unbalanced' | 'duplicate' | 'inverted'

export class ManagedBlockRefusal extends Error {
  readonly reason: ManagedBlockRefusalReason

  constructor(reason: ManagedBlockRefusalReason, message: string) {
    super(message)
    this.name = 'ManagedBlockRefusal'
    this.reason = reason
  }
}

export const AGENT_QA_INIT_GITIGNORE_BLOCK: ManagedBlockDescriptor = {
  owner: 'agent-qa',
  blockName: 'init',
  syntax: 'hash',
}

export const AGENT_QA_INIT_MARKDOWN_BLOCK: ManagedBlockDescriptor = {
  owner: 'agent-qa',
  blockName: 'init',
  syntax: 'html',
}

function markerToken(descriptor: ManagedBlockDescriptor, edge: 'start' | 'end'): string {
  return `${descriptor.owner} ${descriptor.blockName}:${edge}`
}

export function managedBlockMarkers(
  descriptor: ManagedBlockDescriptor,
): { readonly start: string, readonly end: string } {
  const start = markerToken(descriptor, 'start')
  const end = markerToken(descriptor, 'end')
  return descriptor.syntax === 'hash'
    ? { start: `# ${start}`, end: `# ${end}` }
    : { start: `<!-- ${start} -->`, end: `<!-- ${end} -->` }
}

/** The block as it is written: markers and body joined by LF, with no trailing terminator. */
export function renderManagedBlock(content: ManagedBlockContent): string {
  const { start, end } = managedBlockMarkers(content.descriptor)
  return [start, ...content.body, end].join('\n')
}

/** Offsets of an existing block: its start marker's first byte, and the byte after its end marker's text. */
export interface ManagedBlockSpan {
  readonly start: number
  readonly end: number
}

function refuse(
  content: ManagedBlockContent,
  reason: ManagedBlockRefusalReason,
  detail: string,
): never {
  throw new ManagedBlockRefusal(reason, `Refusing malformed ${content.target}: ${detail}`)
}

/**
 * Finds the block in `existing`, or `undefined` when there is none. A marker counts only as a
 * whole line (a CR before the LF is the line's terminator, not its text). Any other line naming
 * the block's start or end token — indented, trailing text, the other comment syntax — makes the
 * file ambiguous, and it refuses rather than guessing which bytes it owns.
 */
export function locateManagedBlock(
  existing: string,
  content: ManagedBlockContent,
): ManagedBlockSpan | undefined {
  const { descriptor } = content
  const markers = managedBlockMarkers(descriptor)
  const tokens = [markerToken(descriptor, 'start'), markerToken(descriptor, 'end')]
  const label = `${descriptor.owner} ${descriptor.blockName}`
  const starts: number[] = []
  const ends: number[] = []

  let offset = 0
  let lineNumber = 1
  for (;;) {
    const newline = existing.indexOf('\n', offset)
    const lineEnd = newline === -1 ? existing.length : newline
    const textEnd = newline !== -1 && lineEnd > offset && existing[lineEnd - 1] === '\r'
      ? lineEnd - 1
      : lineEnd
    const line = existing.slice(offset, textEnd)
    if (line === markers.start) starts.push(offset)
    else if (line === markers.end) ends.push(textEnd)
    else if (tokens.some(token => line.includes(token))) {
      refuse(
        content,
        'ambiguous-marker',
        `line ${lineNumber} mentions the ${label} managed block but is not exactly one of its `
        + `marker lines (${markers.start} / ${markers.end})`,
      )
    }
    if (newline === -1) break
    offset = newline + 1
    lineNumber += 1
  }

  if (starts.length !== ends.length || starts.length > 1) {
    refuse(
      content,
      starts.length !== ends.length ? 'unbalanced' : 'duplicate',
      `expected at most one complete ${label} managed block`,
    )
  }
  if (starts.length === 0) return undefined
  if (ends[0]! < starts[0]!) {
    refuse(content, 'inverted', `the ${label} managed end marker precedes its start marker`)
  }
  return { start: starts[0]!, end: ends[0]! }
}

function appendAtEof(existing: string, block: string): string {
  if (existing.length === 0) return block
  const separator = existing.endsWith('\n\n')
    ? ''
    : existing.endsWith('\n')
      ? '\n'
      : '\n\n'
  return `${existing}${separator}${block}`
}

/**
 * What a file holding `existing` holds after the block is upserted. An existing block's span is
 * replaced in situ; an absent block is appended after a separator, so `existing` is an exact
 * prefix of the result. Composing the result again returns it unchanged.
 */
export function composeManagedBlock(existing: string, content: ManagedBlockContent): string {
  const tokens = [markerToken(content.descriptor, 'start'), markerToken(content.descriptor, 'end')]
  if (content.body.some(line => tokens.some(token => line.includes(token)))) {
    refuse(
      content,
      'ambiguous-marker',
      'the managed block body names its own marker, so the written file would refuse its next run',
    )
  }
  const block = renderManagedBlock(content)
  const span = locateManagedBlock(existing, content)
  if (span === undefined) return appendAtEof(existing, `${block}\n`)
  return `${existing.slice(0, span.start)}${block}${existing.slice(span.end)}`
}
