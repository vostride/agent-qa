import pc from 'picocolors'

import type { LogColors } from '../logging/log-line.js'
import { yamlParseFailureMessage } from '../validation/yaml-fault.js'

export interface ParseError {
  file: string
  line: number
  column: number
  message: string
  severity: 'error' | 'warning'
  source: string
  suggestion?: string
}

interface FormatOptions {
  noColor?: boolean
  colors?: Pick<LogColors, 'red' | 'bold' | 'blue' | 'yellow'>
}

function shouldUseColor(opts?: FormatOptions): boolean {
  if (opts?.noColor) return false
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  return true
}

export function formatParseError(
  error: ParseError,
  opts?: FormatOptions,
): string {
  const handed = opts?.noColor ? undefined : opts?.colors
  const color = handed === undefined && shouldUseColor(opts)
  const lineNum = String(error.line)
  const pad = ' '.repeat(lineNum.length)

  const plain = (s: string) => s
  const red = handed?.red ?? (color ? pc.red : plain)
  const bold = handed?.bold ?? (color ? pc.bold : plain)
  const blue = handed?.blue ?? (color ? pc.blue : plain)
  const yellow = handed?.yellow ?? pc.yellow
  const boldRed = (s: string) => bold(red(s))
  const boldBlue = (s: string) => bold(blue(s))

  const severity =
    error.severity === 'error' ? boldRed('error') : bold(yellow('warning'))

  let output = ''
  output += `${severity}: ${error.message}\n`
  output += `  ${boldBlue('-->')} ${error.file}:${error.line}:${error.column}\n`
  // `formatYamlError` returns an empty `source`, so the excerpt block is skipped.
  if (error.source) {
    output += `  ${boldBlue(`${pad} |`)}\n`
    output += `  ${boldBlue(`${lineNum} |`)} ${error.source}\n`
    output += `  ${boldBlue(`${pad} |`)} ${' '.repeat(Math.max(0, error.column - 1))}${boldRed('^')}\n`
  }

  if (error.suggestion) {
    output += `  ${boldBlue(`${pad} =`)} ${bold('help')}: ${error.suggestion}\n`
  }

  return output
}

function getSourceLine(content: string, line: number): string {
  const lines = content.split('\n')
  if (line < 1 || line > lines.length) return ''
  return lines[line - 1] ?? ''
}

// Reports the fault's line and column only: yaml's pretty message quotes unvalidated source bytes.
export function formatYamlError(
  err: { message: string; pos?: [number, number] },
  linePos: { line: number; col: number } | undefined,
  content: string,
  filePath: string,
): ParseError {
  const line = linePos?.line ?? 1
  const col = linePos?.col ?? 1

  return {
    file: filePath,
    line,
    column: col,
    message: yamlParseFailureMessage(err),
    severity: 'error',
    source: '',
    suggestion: undefined,
  }
}

function zodPathToSuggestion(
  code: string,
  path: (string | number)[],
  message: string,
): string | undefined {
  const field = path[path.length - 1]
  if (code === 'invalid_type') {
    if (typeof field === 'string') {
      return `check that '${field}' has the correct type`
    }
    return `check the value type at this position`
  }
  if (code === 'too_small') {
    if (typeof field === 'string' && field === 'steps') {
      return 'tests must have at least one step'
    }
    return message
  }
  if (code === 'invalid_union') {
    return 'steps must be strings like "Click the login button" or objects like { step: "...", timeout: "30s" }'
  }
  if (code === 'unrecognized_keys') {
    return message
  }
  if (typeof field === 'string') {
    return `did you forget to add '${field}'?`
  }
  return undefined
}

interface YamlNode {
  range?: [number, number, number]
  items?: YamlNode[]
  key?: YamlNode
  value?: YamlNode | null
  srcToken?: unknown
}

interface YamlDoc {
  contents: YamlNode | null
}

interface LineCounterLike {
  linePos(offset: number): { line: number; col: number }
}

interface ZodIssue {
  path: PropertyKey[]
  message: string
  code: string
}

function resolveNodeAtPath(
  doc: YamlDoc,
  path: (string | number)[],
): YamlNode | null {
  let current: YamlNode | null = doc.contents
  if (!current) return null

  for (const segment of path) {
    if (!current) return null

    if (typeof segment === 'number') {
      // Array index — current should be a sequence node with items
      const items: YamlNode[] | undefined = current.items
      if (items && items[segment]) {
        current = items[segment]
      } else {
        return current
      }
    } else {
      // Object key — current should be a mapping node with items
      const items: YamlNode[] | undefined = current.items
      if (!items) return current

      let found = false
      for (const pair of items as YamlNode[]) {
        const keyNode: YamlNode | undefined = pair.key
        if (keyNode && 'value' in keyNode && keyNode.value === segment) {
          current = pair.value ?? null
          found = true
          break
        }
        // Sometimes keyNode is the scalar itself
        if (keyNode && 'source' in keyNode && (keyNode as { source?: string }).source === segment) {
          current = pair.value ?? null
          found = true
          break
        }
      }
      if (!found) return current
    }
  }

  return current
}

export function formatZodErrors(
  zodError: { issues: ZodIssue[] },
  doc: YamlDoc,
  lineCounter: LineCounterLike,
  content: string,
  filePath: string,
): ParseError[] {
  const errors: ParseError[] = []

  for (const issue of zodError.issues) {
    let line = 1
    let col = 1

    // Try to resolve the node at the Zod error path
    const issuePath = issue.path.filter((segment): segment is string | number => (
      typeof segment === 'string' || typeof segment === 'number'
    ))
    const node = resolveNodeAtPath(doc, issuePath)
    if (node?.range) {
      const pos = lineCounter.linePos(node.range[0])
      line = pos.line
      col = pos.col
    } else if (doc.contents?.range) {
      const pos = lineCounter.linePos(doc.contents.range[0])
      line = pos.line
      col = pos.col
    }

    const suggestion = zodPathToSuggestion(issue.code, issuePath, issue.message)

    errors.push({
      file: filePath,
      line,
      column: col,
      message: issuePath.length > 0
        ? `${issuePath.join('.')}: ${issue.message}`
        : issue.message,
      severity: 'error',
      source: getSourceLine(content, line),
      suggestion,
    })
  }

  return errors
}
