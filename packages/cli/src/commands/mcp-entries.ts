import { isDeepStrictEqual } from 'node:util'
import {
  createScanner,
  findNodeAtLocation,
  parse,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser'
import type { Node, ParseError } from 'jsonc-parser'
import { getStaticTOMLValue, ParseError as TomlParseError, parseTOML } from 'toml-eslint-parser'
import type { AST } from 'toml-eslint-parser'

export const AGENT_QA_MCP_SERVER_NAME = 'agent-qa'
export const CODING_AGENT_MCP_COMMAND = 'npx'
export const CODING_AGENT_MCP_ARGS = [
  '--no',
  '--',
  'agent-qa',
  '--config',
  'agent-qa.config.yaml',
  'mcp',
] as const
export const CLAUDE_CODE_MCP_TIMEOUT_MS = 6000000
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 6000

export type McpEntryEdit =
  | { text: string; previous: string | undefined; entry: string }
  | { refused: string }

export type McpEntryRemoval =
  | { text: string | undefined; previous: string | undefined }
  | { refused: string }

const MCP_JSON = '.mcp.json'
const SERVERS = 'mcpServers'
const BOM = '\uFEFF'

const CLAUDE_CODE_ENTRY = {
  type: 'stdio',
  command: CODING_AGENT_MCP_COMMAND,
  args: [...CODING_AGENT_MCP_ARGS],
  timeout: CLAUDE_CODE_MCP_TIMEOUT_MS,
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function splice(text: string, start: number, end: number, insert: string): string {
  return `${text.slice(0, start)}${insert}${text.slice(end)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function splitBom(text: string | undefined): { bom: string; body: string } {
  const whole = text ?? ''
  return whole.startsWith(BOM) ? { bom: BOM, body: whole.slice(1) } : { bom: '', body: whole }
}

function jsonUnit(text: string): string {
  return /^[ \t]+(?=")/mu.exec(text)?.[0] ?? '  '
}

// The whitespace before `offset` when nothing else precedes it on its line.
function lineIndent(text: string, offset: number): string | undefined {
  const lead = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset)
  return /^[ \t]*$/u.test(lead) ? lead : undefined
}

function claudeCodeValue(inner: string, close: string, eol: string): string {
  const args = CODING_AGENT_MCP_ARGS.map((arg) => JSON.stringify(arg)).join(', ')
  return [
    '{',
    `${inner}"type": "stdio",`,
    `${inner}"command": ${JSON.stringify(CODING_AGENT_MCP_COMMAND)},`,
    `${inner}"args": [${args}],`,
    `${inner}"timeout": ${CLAUDE_CODE_MCP_TIMEOUT_MS}`,
    `${close}}`,
  ].join(eol)
}

type McpJsonTree = { root: Node; servers: Node | undefined; entry: Node | undefined }

function readMcpJson(text: string, shift: number): McpJsonTree | { refused: string } {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: false })
  const error = errors[0]
  if (error !== undefined) {
    const code = printParseErrorCode(error.error)
    return { refused: `Refusing malformed ${MCP_JSON}: ${code} at offset ${error.offset + shift}.` }
  }
  if (root?.type !== 'object') {
    return { refused: `Refusing malformed ${MCP_JSON}: its root is not an object.` }
  }
  const servers = findNodeAtLocation(root, [SERVERS])
  if (servers !== undefined && servers.type !== 'object') {
    return { refused: `Refusing malformed ${MCP_JSON}: ${SERVERS} is not an object.` }
  }
  const entry =
    servers === undefined
      ? undefined
      : findNodeAtLocation(root, [SERVERS, AGENT_QA_MCP_SERVER_NAME])
  return { root, servers, entry }
}

function jsonValue(text: string): unknown {
  return text.trim() === '' ? {} : parse(text, [], { allowTrailingComma: false })
}

// `value` without agent-qa's server, and without a servers table that is left empty.
function withoutAgentQaServer(value: unknown, serversKey: string): unknown {
  if (!isRecord(value) || !isRecord(value[serversKey])) return value
  const others = Object.fromEntries(
    Object.entries(value[serversKey]).filter(([name]) => name !== AGENT_QA_MCP_SERVER_NAME),
  )
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== serversKey))
  return Object.keys(others).length === 0 ? rest : { ...rest, [serversKey]: others }
}

function withoutClaudeCodeEntry(value: unknown): unknown {
  return withoutAgentQaServer(value, SERVERS)
}

function parsesCleanly(text: string): boolean {
  if (text.trim() === '') return true
  const errors: ParseError[] = []
  parseTree(text, errors, { allowTrailingComma: false })
  return errors.length === 0
}

const JSON_MISMATCH =
  `Refusing to edit ${MCP_JSON}: the edit would change more than agent-qa's entry.`

function checkedJsonUpsert(
  before: string,
  after: string,
  bom: string,
  previous: string | undefined,
  entry: string,
): McpEntryEdit {
  if (!parsesCleanly(after)) return { refused: JSON_MISMATCH }
  const value = jsonValue(after)
  const servers = isRecord(value) ? value[SERVERS] : undefined
  const written = isRecord(servers) ? servers[AGENT_QA_MCP_SERVER_NAME] : undefined
  if (!isDeepStrictEqual(written, CLAUDE_CODE_ENTRY)) return { refused: JSON_MISMATCH }
  const kept = withoutClaudeCodeEntry(jsonValue(before))
  if (!isDeepStrictEqual(kept, withoutClaudeCodeEntry(value))) return { refused: JSON_MISMATCH }
  return { text: `${bom}${after}`, previous, entry }
}

function newMcpJson(unit: string, eol: string): { text: string; entry: string } {
  const entry = claudeCodeValue(unit.repeat(3), unit.repeat(2), eol)
  const name = JSON.stringify(AGENT_QA_MCP_SERVER_NAME)
  const servers = `"${SERVERS}": {${eol}${unit}${unit}${name}: ${entry}${eol}${unit}}`
  const text = `{${eol}${unit}${servers}${eol}}${eol}`
  return { text, entry }
}

// Inserts `member` into an object node, after its last property or into its empty braces.
function insertMember(
  text: string,
  object: Node,
  member: (indent: string) => string,
  fallbackIndent: string,
  objectIndent: string,
  eol: string,
): string {
  const last = object.children?.at(-1)
  if (last !== undefined) {
    const indent = lineIndent(text, last.offset) ?? fallbackIndent
    const end = last.offset + last.length
    return splice(text, end, end, `,${eol}${indent}${member(indent)}`)
  }
  const open = object.offset + 1
  const close = object.offset + object.length - 1
  const inside = text.slice(open, close)
  const indent = fallbackIndent
  const body = `${eol}${indent}${member(indent)}${eol}${objectIndent}`
  return inside.trim() === '' ? splice(text, open, close, body) : splice(text, open, open, body)
}

export function upsertClaudeCodeMcpEntry(text: string | undefined): McpEntryEdit {
  const { bom, body } = splitBom(text)
  const unit = jsonUnit(body)
  const eol = eolOf(body)
  const name = JSON.stringify(AGENT_QA_MCP_SERVER_NAME)
  if (body.trim() === '') {
    const created = newMcpJson(unit, eol)
    return checkedJsonUpsert(body, created.text, bom, undefined, created.entry)
  }
  const tree = readMcpJson(body, bom.length)
  if ('refused' in tree) return tree

  if (tree.entry !== undefined) {
    const property = tree.entry.parent!
    const keyIndent = lineIndent(body, property.offset) ?? unit.repeat(2)
    const first = tree.entry.type === 'object' ? tree.entry.children?.[0] : undefined
    const firstIndent = first === undefined ? undefined : lineIndent(body, first.offset)
    const inner = firstIndent ?? keyIndent + unit
    const entry = claudeCodeValue(inner, keyIndent, eol)
    const start = tree.entry.offset
    const end = start + tree.entry.length
    const previous = body.slice(start, end)
    return checkedJsonUpsert(body, splice(body, start, end, entry), bom, previous, entry)
  }

  let entry = ''
  const entryMember = (indent: string): string => {
    entry = claudeCodeValue(indent + unit, indent, eol)
    return `${name}: ${entry}`
  }
  if (tree.servers !== undefined) {
    const serversIndent = lineIndent(body, tree.servers.parent!.offset) ?? unit
    const keyIndent = serversIndent + unit
    const after = insertMember(body, tree.servers, entryMember, keyIndent, serversIndent, eol)
    return checkedJsonUpsert(body, after, bom, undefined, entry)
  }
  const serversMember = (indent: string): string => {
    const inner = entryMember(indent + unit)
    return `"${SERVERS}": {${eol}${indent}${unit}${inner}${eol}${indent}}`
  }
  const after = insertMember(body, tree.root, serversMember, unit, '', eol)
  return checkedJsonUpsert(body, after, bom, undefined, entry)
}

interface Lexeme {
  kind: 'comment' | 'comma' | 'space' | 'break' | 'other'
  start: number
  end: number
}

function lexemes(text: string): Lexeme[] {
  const scanner = createScanner(text, false)
  const found: Lexeme[] = []
  while (scanner.getPosition() < text.length) {
    scanner.scan()
    const start = scanner.getTokenOffset()
    const end = start + scanner.getTokenLength()
    const token = text.slice(start, end)
    const kind = token.startsWith('//') || token.startsWith('/*')
      ? 'comment'
      : token === ','
        ? 'comma'
        : /^[\r\n]+$/u.test(token)
          ? 'break'
          : /^\s+$/u.test(token)
            ? 'space'
            : 'other'
    found.push({ kind, start, end })
  }
  return found
}

// Where the indentation and line break in front of `offset` begin, so its line goes with it.
function leadingSpace(lex: readonly Lexeme[], offset: number): number {
  let at = lex.findIndex((lexeme) => lexeme.start === offset) - 1
  while (lex[at]?.kind === 'space') at -= 1
  if (lex[at]?.kind === 'break') at -= 1
  return lex[at + 1]?.start ?? offset
}

// Where the space after `offset` ends, through one line break and the next line's indentation.
function trailingSpace(lex: readonly Lexeme[], offset: number): number {
  let at = lex.findIndex((lexeme) => lexeme.start === offset)
  if (at === -1) return offset
  while (lex[at]?.kind === 'space') at += 1
  if (lex[at]?.kind === 'break') {
    at += 1
    while (lex[at]?.kind === 'space') at += 1
  }
  return lex[at]?.start ?? offset
}

function withoutRanges(text: string, ranges: readonly (readonly [number, number])[]): string {
  const sorted = [...ranges].filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0])
  let kept = ''
  let from = 0
  for (const [start, end] of sorted) {
    if (start > from) kept += text.slice(from, start)
    from = Math.max(from, end)
  }
  return kept + text.slice(from)
}

// Takes `property` out of `object` with its separating comma and its own line; no comment goes.
function withoutMember(text: string, lex: readonly Lexeme[], object: Node, property: Node): string {
  const siblings = object.children ?? []
  const at = siblings.indexOf(property)
  const start = property.offset
  const end = start + property.length
  const ranges: [number, number][] = [[start, end]]
  const previous = siblings[at - 1]
  const next = siblings[at + 1]
  if (previous !== undefined) {
    const from = previous.offset + previous.length
    const comma = lex.find((l) => l.kind === 'comma' && l.start >= from && l.end <= start)
    if (comma !== undefined) ranges.push([comma.start, comma.end])
    ranges.push([leadingSpace(lex, start), start])
  } else if (next !== undefined) {
    const comma = lex.find((l) => l.kind === 'comma' && l.start >= end && l.end <= next.offset)
    if (comma !== undefined) ranges.push([comma.start, trailingSpace(lex, comma.end)])
  } else {
    ranges.push([leadingSpace(lex, start), start])
  }
  return withoutRanges(text, ranges)
}

function commentsOf(text: string, lex: readonly Lexeme[] = lexemes(text)): string[] {
  return lex.filter((l) => l.kind === 'comment').map((l) => text.slice(l.start, l.end))
}

function hasClaudeCodeEntry(value: unknown): boolean {
  const servers = isRecord(value) ? value[SERVERS] : undefined
  return isRecord(servers) && Object.hasOwn(servers, AGENT_QA_MCP_SERVER_NAME)
}

// An emptied mcpServers goes too unless it holds a comment; the file goes only when nothing does.
export function removeClaudeCodeMcpEntry(text: string | undefined): McpEntryRemoval {
  const { bom, body } = splitBom(text)
  if (body.trim() === '') return { text: undefined, previous: undefined }
  const tree = readMcpJson(body, bom.length)
  if ('refused' in tree) return tree
  if (tree.entry === undefined) return { text, previous: undefined }

  const previous = body.slice(tree.entry.offset, tree.entry.offset + tree.entry.length)
  const servers = tree.servers!
  const serversProperty = servers.parent!
  const entryProperty = tree.entry.parent!
  const lex = lexemes(body)
  const entryEnd = entryProperty.offset + entryProperty.length
  const kept = lex.filter(
    (l) => l.kind === 'comment' && (l.end <= entryProperty.offset || l.start >= entryEnd),
  )
  const keptIn = (node: Node): boolean =>
    kept.some((l) => l.start >= node.offset && l.end <= node.offset + node.length)
  let after: string
  if (servers.children?.length === 1 && !keptIn(serversProperty)) {
    if (tree.root.children?.length === 1 && kept.length === 0) return { text: undefined, previous }
    after = withoutMember(body, lex, tree.root, serversProperty)
  } else {
    after = withoutMember(body, lex, servers, entryProperty)
  }
  if (!parsesCleanly(after)) return { refused: JSON_MISMATCH }
  const keptComments = kept.map((l) => body.slice(l.start, l.end))
  if (!isDeepStrictEqual(commentsOf(after), keptComments)) return { refused: JSON_MISMATCH }
  const value = jsonValue(after)
  if (
    hasClaudeCodeEntry(value)
    || !isDeepStrictEqual(withoutClaudeCodeEntry(jsonValue(body)), withoutClaudeCodeEntry(value))
  ) {
    return { refused: JSON_MISMATCH }
  }
  return { text: `${bom}${after}`, previous }
}

const CODEX_CONFIG = '.codex/config.toml'
const CODEX_SERVERS = 'mcp_servers'

const CODEX_ENTRY = {
  command: CODING_AGENT_MCP_COMMAND,
  args: [...CODING_AGENT_MCP_ARGS],
  tool_timeout_sec: CODEX_MCP_TOOL_TIMEOUT_SEC,
}

function codexTable(eol: string): string {
  const args = CODING_AGENT_MCP_ARGS.map((arg) => JSON.stringify(arg)).join(', ')
  return [
    `[${CODEX_SERVERS}.${AGENT_QA_MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(CODING_AGENT_MCP_COMMAND)}`,
    `args = [${args}]`,
    'tool_timeout_sec = 6000',
  ].join(eol)
}

type CodexRange = { start: number; end: number; table: boolean }

type CodexDefinitions = {
  ranges: CodexRange[]
  inlineServers: boolean
  hasEntry: boolean
}

function keyPath(key: AST.TOMLKey): string[] {
  return getStaticTOMLValue(key)
}

// Every definition of agent-qa's server: its tables and sub-tables, a dotted key at the root, and
// a key under [mcp_servers].
function readCodexConfig(text: string): CodexDefinitions | { refused: string } {
  let ast: AST.TOMLProgram
  try {
    ast = parseTOML(text)
  } catch (error) {
    if (!(error instanceof TomlParseError)) throw error
    const message = error.message.replace(/\s+/gu, ' ')
    const at = `line ${error.lineNumber}, column ${error.column}`
    return { refused: `Refusing malformed ${CODEX_CONFIG}: ${message} at ${at}.` }
  }
  const servers = (getStaticTOMLValue(ast) as Record<string, unknown>)[CODEX_SERVERS]
  if (servers !== undefined && !isRecord(servers)) {
    return { refused: `Refusing malformed ${CODEX_CONFIG}: ${CODEX_SERVERS} is not a table.` }
  }
  if (isRecord(servers) && Array.isArray(servers[AGENT_QA_MCP_SERVER_NAME])) {
    const header = `[[${CODEX_SERVERS}.${AGENT_QA_MCP_SERVER_NAME}]]`
    return {
      refused: `Refusing malformed ${CODEX_CONFIG}: ${header} is an array of tables, which Codex cannot read.`,
    }
  }
  const ranges: CodexRange[] = []
  let inlineServers = false
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLTable') {
      const [first, second] = node.resolvedKey
      if (first !== CODEX_SERVERS) continue
      if (second === AGENT_QA_MCP_SERVER_NAME) {
        ranges.push({ start: node.range[0], end: node.range[1], table: true })
      } else if (node.resolvedKey.length === 1) {
        for (const pair of node.body) {
          if (keyPath(pair.key)[0] !== AGENT_QA_MCP_SERVER_NAME) continue
          ranges.push({ start: pair.range[0], end: pair.range[1], table: false })
        }
      }
      continue
    }
    const path = keyPath(node.key)
    if (path[0] !== CODEX_SERVERS) continue
    if (path.length === 1) inlineServers = true
    else if (path[1] === AGENT_QA_MCP_SERVER_NAME) {
      ranges.push({ start: node.range[0], end: node.range[1], table: false })
    }
  }
  const hasEntry = isRecord(servers) && servers[AGENT_QA_MCP_SERVER_NAME] !== undefined
  return { ranges: ranges.sort((a, b) => a.start - b.start), inlineServers, hasEntry }
}

function lineStart(text: string, offset: number): number {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*$/u.test(text.slice(start, offset)) ? start : offset
}

// Past the rest of the line: trailing blanks, a comment and the line terminator.
function pastLineEnd(text: string, offset: number): number {
  const rest = /^[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/u.exec(text.slice(offset))
  return offset + (rest?.[0].length ?? 0)
}

function pastBlankLines(text: string, offset: number): number {
  const blank = /^(?:[ \t]*\r?\n)*(?:[ \t]+$)?/u.exec(text.slice(offset))
  return offset + (blank?.[0].length ?? 0)
}

function appendedAtEof(existing: string, block: string, eol: string): string {
  if (existing.trim() === '') return block
  const separator = existing.endsWith(`${eol}${eol}`)
    ? ''
    : existing.endsWith('\n')
      ? eol
      : eol + eol
  return `${existing}${separator}${block}`
}

function tomlValue(text: string): Record<string, unknown> | undefined {
  try {
    return getStaticTOMLValue(parseTOML(text)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function withoutCodexEntry(value: unknown): unknown {
  return withoutAgentQaServer(value, CODEX_SERVERS)
}

const TOML_MISMATCH =
  `Refusing to edit ${CODEX_CONFIG}: the edit would change more than agent-qa's entry.`

const INLINE_SERVERS =
  `Refusing to edit ${CODEX_CONFIG}: ${CODEX_SERVERS} is an inline table, so agent-qa cannot ` +
  `write its own [${CODEX_SERVERS}.${AGENT_QA_MCP_SERVER_NAME}] table.`

export function upsertCodexMcpEntry(text: string | undefined): McpEntryEdit {
  const before = text ?? ''
  const eol = eolOf(before)
  const entry = codexTable(eol)
  let after: string
  let previous: string | undefined
  if (before.trim() === '') {
    after = `${entry}${eol}`
  } else {
    const definitions = readCodexConfig(before)
    if ('refused' in definitions) return definitions
    if (definitions.inlineServers) return { refused: INLINE_SERVERS }
    const { ranges } = definitions
    if (ranges.length > 0) {
      previous = ranges.map((range) => before.slice(range.start, range.end)).join(eol)
    }
    const firstTable = ranges.find((range) => range.table)
    let kept = ''
    let cursor = 0
    for (const range of ranges) {
      const start = lineStart(before, range.start)
      let end = pastLineEnd(before, range.end)
      kept += before.slice(cursor, start)
      if (range === firstTable) kept += `${entry}${eol}`
      else if (range.table) end = pastBlankLines(before, end)
      cursor = end
    }
    kept += before.slice(cursor)
    after = firstTable === undefined ? appendedAtEof(kept, `${entry}${eol}`, eol) : kept
  }
  const value = tomlValue(after)
  const servers = value?.[CODEX_SERVERS]
  const written = isRecord(servers) ? servers[AGENT_QA_MCP_SERVER_NAME] : undefined
  if (value === undefined || !isDeepStrictEqual(written, CODEX_ENTRY)) {
    return { refused: TOML_MISMATCH }
  }
  if (!isDeepStrictEqual(withoutCodexEntry(tomlValue(before)), withoutCodexEntry(value))) {
    return { refused: TOML_MISMATCH }
  }
  return { text: after, previous, entry }
}

export function removeCodexMcpEntry(text: string | undefined): McpEntryRemoval {
  if (text === undefined || text.trim() === '') return { text: undefined, previous: undefined }
  const definitions = readCodexConfig(text)
  if ('refused' in definitions) return definitions
  if (definitions.inlineServers && definitions.hasEntry) return { refused: INLINE_SERVERS }
  const { ranges } = definitions
  if (ranges.length === 0) return { text, previous: undefined }

  const eol = eolOf(text)
  const previous = ranges.map((range) => text.slice(range.start, range.end)).join(eol)
  let kept = ''
  let cursor = 0
  for (const range of ranges) {
    const start = lineStart(text, range.start)
    const end = pastLineEnd(text, range.end)
    kept += text.slice(cursor, start)
    cursor = range.table ? pastBlankLines(text, end) : end
  }
  kept += text.slice(cursor)
  if (cursor === text.length) kept = kept.replace(/(\r?\n)(?:[ \t]*\r?\n)+$/u, '$1')
  if (kept.trim() === '') return { text: undefined, previous }
  const value = tomlValue(kept)
  if (value === undefined) return { refused: TOML_MISMATCH }
  if (!isDeepStrictEqual(withoutCodexEntry(tomlValue(text)), withoutCodexEntry(value))) {
    return { refused: TOML_MISMATCH }
  }
  return { text: kept, previous }
}
