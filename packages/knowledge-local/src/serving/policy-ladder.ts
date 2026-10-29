import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { slugBranch } from '@vostride/agent-qa-schema'

/**
 * Provisional authored-policy warning threshold. This is an operator
 * signal only, never a serving budget or user-facing configuration key.
 */
const POLICY_SIZE_WARNING_CHARACTERS = 16_000

export interface OversizedPolicy {
  file: string
  approxTokens: number
}

export interface PolicyLadder {
  text: string
  files: string[]
  oversized: OversizedPolicy[]
}

interface PolicyRung {
  file: string
  text: string
}

export type MalformedPolicyCommentReason =
  | 'nested-opener'
  | 'stray-closer'
  | 'unclosed-comment'

export class MalformedPolicyCommentError extends SyntaxError {
  readonly sourceFile: string
  readonly reason: MalformedPolicyCommentReason
  readonly line: number
  readonly column: number

  constructor(
    sourceFile: string,
    reason: MalformedPolicyCommentReason,
    line: number,
    column: number,
  ) {
    super(`Malformed HTML comment in ${sourceFile} at ${line}:${column} (${reason})`)
    this.name = 'MalformedPolicyCommentError'
    this.sourceFile = sourceFile
    this.reason = reason
    this.line = line
    this.column = column
  }
}

/**
 * Remove authored HTML comment regions without changing any active byte.
 * `sourceFile` is the already-sanitized policy-relative label used for diagnostics.
 */
export function stripPolicyHtmlComments(text: string, sourceFile: string): string {
  let index = 0
  let line = 1
  let column = 1
  let activeStart = 0
  let rendered = ''

  const advance = (characters: number): void => {
    const end = index + characters
    while (index < end) {
      if (text[index] === '\n') {
        line += 1
        column = 1
      } else {
        column += 1
      }
      index += 1
    }
  }

  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      rendered += text.slice(activeStart, index)
      const commentStart = { line, column }
      advance(4)

      let closed = false
      while (index < text.length) {
        if (text.startsWith('<!--', index)) {
          throw new MalformedPolicyCommentError(
            sourceFile,
            'nested-opener',
            line,
            column,
          )
        }
        if (text.startsWith('-->', index)) {
          advance(3)
          activeStart = index
          closed = true
          break
        }
        advance(1)
      }

      if (!closed) {
        throw new MalformedPolicyCommentError(
          sourceFile,
          'unclosed-comment',
          commentStart.line,
          commentStart.column,
        )
      }
      continue
    }

    if (text.startsWith('-->', index)) {
      throw new MalformedPolicyCommentError(
        sourceFile,
        'stray-closer',
        line,
        column,
      )
    }
    advance(1)
  }

  return rendered + text.slice(activeStart)
}

function readOptionalPolicy(knowledgeRoot: string, file: string): PolicyRung | undefined {
  try {
    const text = stripPolicyHtmlComments(
      readFileSync(join(knowledgeRoot, ...file.split('/')), 'utf8'),
      file,
    )
    if (text.trim().length === 0) return undefined
    return {
      file,
      text,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function renderPolicyLadder(rungs: readonly PolicyRung[]): string {
  if (rungs.length === 0) return ''

  let rendered = rungs[0]!.text
  for (const rung of rungs.slice(1)) {
    const leadingNewline = rendered.length > 0 && !rendered.endsWith('\n') ? '\n' : ''
    rendered += `${leadingNewline}--- POLICY SOURCE: ${rung.file} ---\n${rung.text}`
  }
  return rendered
}

export function readPolicyLadder(
  knowledgeRoot: string,
  product?: string,
): PolicyLadder {
  // The ladder is deliberately closed at two rungs, general before specific.
  const requestedFiles = ['policies/global.md']
  if (product !== undefined && product.length > 0) {
    // Product identity is data, not a caller-controlled path. Reuse the shared
    // path-segment sanitizer so a product cannot escape the authored shelf.
    requestedFiles.push(`policies/${slugBranch(product)}.md`)
  }

  const rungs = requestedFiles.flatMap((file) => {
    const rung = readOptionalPolicy(knowledgeRoot, file)
    return rung === undefined ? [] : [rung]
  })

  return {
    // Validated active policy bytes are concatenated whole. Labels frame
    // sources but no active text is summarized, truncated, normalized, or reflowed.
    text: renderPolicyLadder(rungs),
    files: rungs.map(({ file }) => file),
    oversized: rungs.flatMap(({ file, text }) =>
      text.length > POLICY_SIZE_WARNING_CHARACTERS
        ? [{ file, approxTokens: Math.ceil(text.length / 4) }]
        : [],
    ),
  }
}
