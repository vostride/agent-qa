// agent-qa's MCP entries go into a person's .mcp.json and come out again without changing any
// other byte of the file.
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'

import {
  removeClaudeCodeMcpEntry,
  upsertClaudeCodeMcpEntry,
  type McpEntryEdit,
  type McpEntryRemoval,
} from '../commands/mcp-entries.js'

const CLAUDE_CODE_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['--no', '--', 'agent-qa', '--config', 'agent-qa.config.yaml', 'mcp'],
  timeout: 6000000,
}

function edited(result: McpEntryEdit): Exclude<McpEntryEdit, { refused: string }> {
  if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
  return result
}

function removed(result: McpEntryRemoval): Exclude<McpEntryRemoval, { refused: string }> {
  if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
  return result
}

function refusal(result: McpEntryEdit | McpEntryRemoval): string {
  if (!('refused' in result)) throw new Error('expected a refusal')
  return result.refused
}

// The one range in which `after` differs from `before`; every byte outside it is identical.
function changedRange(before: string, after: string) {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let tail = 0
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  return {
    start,
    removed: before.slice(start, before.length - tail),
    inserted: after.slice(start, after.length - tail),
    prefix: before.slice(0, start),
    suffix: before.slice(before.length - tail),
  }
}

function expectOnlyInserted(before: string, after: string): string {
  const range = changedRange(before, after)
  expect(range.removed).toBe('')
  expect(`${range.prefix}${range.suffix}`).toBe(before)
  return range.inserted
}

describe("agent-qa's Claude Code entry in .mcp.json", () => {
  it('a missing file becomes an mcpServers object holding only the entry', () => {
    const result = edited(upsertClaudeCodeMcpEntry(undefined))

    expect(result.previous).toBeUndefined()
    expect(result.text).toBe(
      '{\n  "mcpServers": {\n    "agent-qa": {\n      "type": "stdio",\n      "command": "npx",\n      "args": ["--no", "--", "agent-qa", "--config", "agent-qa.config.yaml", "mcp"],\n      "timeout": 6000000\n    }\n  }\n}\n',
    )
    expect(parse(result.entry)).toEqual(CLAUDE_CODE_ENTRY)
    expect(parse(result.text)).toEqual({ mcpServers: { 'agent-qa': CLAUDE_CODE_ENTRY } })
  })

  it('an empty file is written the same way as a missing one', () => {
    expect(edited(upsertClaudeCodeMcpEntry('')).text).toBe(
      edited(upsertClaudeCodeMcpEntry(undefined)).text,
    )
  })

  it('a one-line file without a final newline keeps every byte around the inserted entry', () => {
    const before = '{"mcpServers": {"other": {"command": "x"}}}'

    const result = edited(upsertClaudeCodeMcpEntry(before))

    const range = changedRange(before, result.text)
    expect(range.prefix).toBe('{"mcpServers": {"other": {"command": "x"}')
    expect(range.suffix).toBe('}}')
    expect(range.removed).toBe('')
    expect(result.text.endsWith('}}')).toBe(true)
    expect(parse(result.text).mcpServers.other).toEqual({ command: 'x' })
    expect(parse(result.text).mcpServers['agent-qa']).toEqual(CLAUDE_CODE_ENTRY)
  })

  it('a tab-indented CRLF file gets tabs and CRLF in the inserted lines', () => {
    const before =
      '{\r\n\t"mcpServers": {\r\n\t\t"other": {\r\n\t\t\t"command": "x"\r\n\t\t}\r\n\t}\r\n}\r\n'

    const result = edited(upsertClaudeCodeMcpEntry(before))

    const inserted = expectOnlyInserted(before, result.text)
    expect(inserted).toBe(
      ',\r\n\t\t"agent-qa": {\r\n\t\t\t"type": "stdio",\r\n\t\t\t"command": "npx",\r\n\t\t\t"args": ["--no", "--", "agent-qa", "--config", "agent-qa.config.yaml", "mcp"],\r\n\t\t\t"timeout": 6000000\r\n\t\t}',
    )
    expect(result.text.replace(/\r\n/gu, '')).not.toContain('\n')
  })

  it('a file with line and block comments keeps them', () => {
    const before =
      '// project servers\n{\n  /* shared */\n  "mcpServers": {\n    "other": { "command": "x" } // mine\n  }\n}\n'

    const result = edited(upsertClaudeCodeMcpEntry(before))

    expectOnlyInserted(before, result.text)
    expect(result.text).toContain('// project servers\n')
    expect(result.text).toContain('/* shared */')
    expect(result.text).toContain('// mine')
    expect(parse(result.text).mcpServers['agent-qa']).toEqual(CLAUDE_CODE_ENTRY)
  })

  it('a root without mcpServers gains an mcpServers member after its last property', () => {
    const before = '{\n  "name": "shop",\n  "debug": true\n}\n'

    const result = edited(upsertClaudeCodeMcpEntry(before))

    const inserted = expectOnlyInserted(before, result.text)
    expect(inserted.startsWith(',\n  "mcpServers": {\n    "agent-qa": {\n')).toBe(true)
    expect(changedRange(before, result.text).prefix).toBe('{\n  "name": "shop",\n  "debug": true')
    expect(parse(result.text)).toEqual({
      name: 'shop',
      debug: true,
      mcpServers: { 'agent-qa': CLAUDE_CODE_ENTRY },
    })
  })

  it('an empty mcpServers object gets the entry inside its braces', () => {
    const before = '{\n  "mcpServers": {}\n}\n'

    const result = edited(upsertClaudeCodeMcpEntry(before))

    expect(parse(result.text)).toEqual({ mcpServers: { 'agent-qa': CLAUDE_CODE_ENTRY } })
    expect(result.text).toBe(edited(upsertClaudeCodeMcpEntry(undefined)).text)
  })

  it('an existing entry that differs is replaced in place and its old value is returned', () => {
    const old = '{\n      "type": "stdio",\n      "command": "npx",\n      "timeout": 60\n    }'
    const before =
      `{\n  "mcpServers": {\n    "agent-qa": ${old},\n    "other": { "command": "x" }\n  }\n}\n`

    const result = edited(upsertClaudeCodeMcpEntry(before))

    const range = changedRange(before, result.text)
    expect(range.prefix.startsWith('{\n  "mcpServers": {\n    "agent-qa": {\n')).toBe(true)
    expect(range.suffix.endsWith(',\n    "other": { "command": "x" }\n  }\n}\n')).toBe(true)
    expect(result.previous).toBe(old)
    expect(result.text).toBe(before.replace(old, result.entry))
    expect(parse(result.text).mcpServers['agent-qa']).toEqual(CLAUDE_CODE_ENTRY)
    expect(parse(result.text).mcpServers.other).toEqual({ command: 'x' })
  })

  it.each([
    ['a missing file', undefined],
    ['a one-line file', '{"mcpServers": {"other": {"command": "x"}}}'],
    ['a tab-indented CRLF file', '{\r\n\t"mcpServers": {\r\n\t\t"other": {}\r\n\t}\r\n}\r\n'],
    ['a root without mcpServers', '{\n  "name": "shop"\n}'],
  ])('upserting its own output again changes nothing for %s', (_label, before) => {
    const first = edited(upsertClaudeCodeMcpEntry(before))

    const second = edited(upsertClaudeCodeMcpEntry(first.text))

    expect(second.text).toBe(first.text)
    expect(second.previous).toBe(second.entry)
  })

  it.each([
    ['a one-line file', '{"mcpServers": {"other": {"command": "x"}}}'],
    ['a tab-indented CRLF file', '{\r\n\t"mcpServers": {\r\n\t\t"other": {}\r\n\t}\r\n}\r\n'],
    [
      'a commented file',
      '{\n  // mine\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n',
    ],
    ['a root without mcpServers', '{\n  "name": "shop",\n  "debug": true\n}\n'],
  ])('removing the entry from an upserted file gives back the original bytes: %s', (_l, before) => {
    const upserted = edited(upsertClaudeCodeMcpEntry(before))

    const result = removed(removeClaudeCodeMcpEntry(upserted.text))

    expect(result.text).toBe(before)
    expect(result.previous).toBe(upserted.entry)
  })

  it('removing the first of several servers takes its separator with it', () => {
    const before =
      '{\n  "mcpServers": {\n    "agent-qa": { "command": "npx" },\n    "other": { "command": "x" }\n  }\n}\n'

    const result = removed(removeClaudeCodeMcpEntry(before))

    expect(result.text).toBe('{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n')
    expect(result.previous).toBe('{ "command": "npx" }')
  })

  it('an mcpServers left empty goes with the entry, and the root keeps its other keys', () => {
    const before =
      '{\n  "name": "shop",\n  "mcpServers": {\n    "agent-qa": { "command": "npx" }\n  }\n}\n'

    const result = removed(removeClaudeCodeMcpEntry(before))

    expect(result.text).toBe('{\n  "name": "shop"\n}\n')
  })

  it('a file that holds nothing but the entry reports that nothing else is left', () => {
    const upserted = edited(upsertClaudeCodeMcpEntry(undefined))

    const result = removed(removeClaudeCodeMcpEntry(upserted.text))

    expect(result.text).toBeUndefined()
    expect(result.previous).toBe(upserted.entry)
  })

  it('a file without the entry is returned unchanged', () => {
    const before = '{"mcpServers": {"other": {"command": "x"}}}'

    expect(removed(removeClaudeCodeMcpEntry(before))).toEqual({ text: before, previous: undefined })
  })

  it.each([
    ['malformed JSON', '{"mcpServers": {'],
    ['a trailing comma', '{"mcpServers": {"other": {}},}'],
    ['a root that is not an object', '["agent-qa"]'],
    ['an mcpServers that is not an object', '{"mcpServers": ["agent-qa"]}'],
  ])('%s is refused with one line', (_label, before) => {
    for (const result of [upsertClaudeCodeMcpEntry(before), removeClaudeCodeMcpEntry(before)]) {
      const message = refusal(result)
      expect(message.startsWith('Refusing malformed .mcp.json:')).toBe(true)
      expect(message).not.toContain('\n')
    }
  })
})
