import { isDeepStrictEqual } from 'node:util'
import { findNodeAtLocation, parse, parseTree, printParseErrorCode } from 'jsonc-parser'
import type { Node, ParseError } from 'jsonc-parser'

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
const BOM = '﻿'

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

function withoutClaudeCodeEntry(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value[SERVERS])) return value
  const others = Object.fromEntries(
    Object.entries(value[SERVERS]).filter(([name]) => name !== AGENT_QA_MCP_SERVER_NAME),
  )
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== SERVERS))
  return Object.keys(others).length === 0 ? rest : { ...rest, [SERVERS]: others }
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

// The range that takes `property` out of `object` with its separating comma, or undefined when
// it is the object's only property.
function propertyCut(object: Node, property: Node): [number, number] | undefined {
  const siblings = object.children ?? []
  if (siblings.length <= 1) return undefined
  const at = siblings.indexOf(property)
  if (at > 0) {
    const previous = siblings[at - 1]!
    return [previous.offset + previous.length, property.offset + property.length]
  }
  return [property.offset, siblings[1]!.offset]
}

export function removeClaudeCodeMcpEntry(text: string | undefined): McpEntryRemoval {
  const { bom, body } = splitBom(text)
  if (body.trim() === '') return { text: undefined, previous: undefined }
  const tree = readMcpJson(body, bom.length)
  if ('refused' in tree) return tree
  if (tree.entry === undefined) return { text, previous: undefined }

  const previous = body.slice(tree.entry.offset, tree.entry.offset + tree.entry.length)
  const servers = tree.servers!
  const serversProperty = servers.parent!
  const cut =
    propertyCut(servers, tree.entry.parent!) ?? propertyCut(tree.root, serversProperty)
  if (cut === undefined) return { text: undefined, previous }
  const after = splice(body, cut[0], cut[1], '')
  if (!parsesCleanly(after)) return { refused: JSON_MISMATCH }
  if (!isDeepStrictEqual(withoutClaudeCodeEntry(jsonValue(body)), jsonValue(after))) {
    return { refused: JSON_MISMATCH }
  }
  return { text: `${bom}${after}`, previous }
}
