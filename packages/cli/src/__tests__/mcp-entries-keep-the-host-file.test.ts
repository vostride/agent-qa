// agent-qa's MCP entries go into a person's .mcp.json and .codex/config.toml and come out again
// without changing any other byte of the file.
import { parse } from 'jsonc-parser'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'
import { describe, expect, it } from 'vitest'

import {
  removeClaudeCodeMcpEntry,
  removeCodexMcpEntry,
  upsertClaudeCodeMcpEntry,
  upsertCodexMcpEntry,
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

const CODEX_ENTRY = {
  command: 'npx',
  args: ['--no', '--', 'agent-qa', '--config', 'agent-qa.config.yaml', 'mcp'],
  tool_timeout_sec: 6000,
}

const CODEX_TABLE =
  '[mcp_servers.agent-qa]\ncommand = "npx"\nargs = ["--no", "--", "agent-qa", "--config", "agent-qa.config.yaml", "mcp"]\ntool_timeout_sec = 6000'

function toml(text: string): unknown {
  return getStaticTOMLValue(parseTOML(text))
}

describe("agent-qa's Codex entry in .codex/config.toml", () => {
  it.each([
    ['a missing file', undefined],
    ['an empty file', ''],
  ])('%s becomes the entry table alone', (_label, before) => {
    const result = edited(upsertCodexMcpEntry(before))

    expect(result.text).toBe(`${CODEX_TABLE}\n`)
    expect(result.previous).toBeUndefined()
    expect(result.entry).toBe(CODEX_TABLE)
    expect(toml(result.text)).toEqual({ mcp_servers: { 'agent-qa': CODEX_ENTRY } })
  })

  it('a file with comments and other tables gets the entry appended after a blank line', () => {
    const before =
      '# Codex settings\napproval_policy = "never"\n\n[model]\nname = "o3" # mine\n\n[mcp_servers.other]\ncommand = "x"\n'

    const result = edited(upsertCodexMcpEntry(before))

    expect(result.text).toBe(`${before}\n${CODEX_TABLE}\n`)
    expect(result.previous).toBeUndefined()
  })

  it('an existing entry and its sub-table are replaced where the first one was', () => {
    const old = '[mcp_servers.agent-qa]\ncommand = "agent-qa"\nstartup_timeout_sec = 20'
    const env = '[mcp_servers.agent-qa.env]\nA = "1"'
    const head = '[model]\nname = "o3"\n\n'
    const tail = '[mcp_servers.other]\ncommand = "x"\n'
    const before = `${head}${old}\n\n${env}\n\n${tail}`

    const result = edited(upsertCodexMcpEntry(before))

    expect(result.text).toBe(`${head}${CODEX_TABLE}\n\n${tail}`)
    expect(result.previous).toBe(`${old}\n${env}`)
    expect(toml(result.text)).toEqual({
      model: { name: 'o3' },
      mcp_servers: { 'agent-qa': CODEX_ENTRY, other: { command: 'x' } },
    })
  })

  it('a CRLF file keeps CRLF and a multi-line string that quotes the table is left alone', () => {
    const before = '[notes]\r\ntext = """\r\n[mcp_servers.agent-qa]\r\ncommand = "old"\r\n"""\r\n'

    const result = edited(upsertCodexMcpEntry(before))

    expect(result.text).toBe(`${before}\r\n${CODEX_TABLE.replace(/\n/gu, '\r\n')}\r\n`)
    expect(result.previous).toBeUndefined()
    expect(result.text.replace(/\r\n/gu, '')).not.toContain('\n')
    expect(toml(result.text)).toEqual({
      notes: { text: '[mcp_servers.agent-qa]\ncommand = "old"\n' },
      mcp_servers: { 'agent-qa': CODEX_ENTRY },
    })
  })

  it('a dotted key at the root is removed and the entry table is written', () => {
    const before = 'model = "o3"\nmcp_servers.agent-qa.command = "x"\n'

    const result = edited(upsertCodexMcpEntry(before))

    expect(result.text).toBe(`model = "o3"\n\n${CODEX_TABLE}\n`)
    expect(result.previous).toBe('mcp_servers.agent-qa.command = "x"')
  })

  it('an inline definition under [mcp_servers] is removed and the entry table is written', () => {
    const before = '[mcp_servers]\nagent-qa = { command = "x" }\nother = { command = "y" }\n'

    const result = edited(upsertCodexMcpEntry(before))

    expect(result.text).toBe(`[mcp_servers]\nother = { command = "y" }\n\n${CODEX_TABLE}\n`)
    expect(toml(result.text)).toEqual({
      mcp_servers: { 'agent-qa': CODEX_ENTRY, other: { command: 'y' } },
    })
  })

  it.each([
    ['a missing file', undefined],
    ['a file with other tables', '# mine\n[model]\nname = "o3"\n'],
    ['a CRLF file', '[model]\r\nname = "o3"\r\n'],
    ['a replaced entry', '[mcp_servers.agent-qa]\ncommand = "x"\n\n[model]\nname = "o3"\n'],
  ])('upserting its own output again changes nothing for %s', (_label, before) => {
    const first = edited(upsertCodexMcpEntry(before))

    const second = edited(upsertCodexMcpEntry(first.text))

    expect(second.text).toBe(first.text)
    expect(second.previous).toBe(second.entry)
  })

  it.each([
    [
      'a file with comments and tables',
      '# mine\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n',
    ],
    ['a file whose last key has a comment', '[model]\nname = "o3" # mine\n'],
    ['a CRLF file', '[model]\r\nname = "o3"\r\n'],
  ])('removing an appended entry gives back the original bytes: %s', (_label, before) => {
    const upserted = edited(upsertCodexMcpEntry(before))

    const result = removed(removeCodexMcpEntry(upserted.text))

    expect(result.text).toBe(before)
    expect(result.previous).toBe(upserted.entry)
  })

  it('removing an entry between tables leaves the tables around it as they were', () => {
    const before = `[model]\nname = "o3"\n\n${CODEX_TABLE}\n\n[mcp_servers.other]\ncommand = "x"\n`

    const result = removed(removeCodexMcpEntry(before))

    expect(result.text).toBe('[model]\nname = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n')
  })

  it('a file that holds nothing but the entry reports that nothing else is left', () => {
    const upserted = edited(upsertCodexMcpEntry(undefined))

    const result = removed(removeCodexMcpEntry(`${upserted.text}\n\n`))

    expect(result.text).toBeUndefined()
    expect(result.previous).toBe(CODEX_TABLE)
  })

  it('a file without the entry is returned unchanged', () => {
    const before = '[mcp_servers.other]\ncommand = "x"\n'

    expect(removed(removeCodexMcpEntry(before))).toEqual({ text: before, previous: undefined })
  })

  it.each([
    ['an array of agent-qa tables', '[[mcp_servers.agent-qa]]\ncommand = "x"\n'],
    ['malformed TOML', '[mcp_servers.agent-qa\ncommand = "x"\n'],
    ['an mcp_servers that is not a table', 'mcp_servers = "agent-qa"\n'],
  ])('%s is refused with one line', (_label, before) => {
    for (const result of [upsertCodexMcpEntry(before), removeCodexMcpEntry(before)]) {
      const message = refusal(result)
      expect(message.startsWith('Refusing malformed .codex/config.toml:')).toBe(true)
      expect(message).not.toContain('\n')
    }
  })

  it('an inline mcp_servers table is refused, as the entry table cannot be added beside it', () => {
    const before = 'mcp_servers = { agent-qa = { command = "x" } }\n'

    for (const result of [upsertCodexMcpEntry(before), removeCodexMcpEntry(before)]) {
      expect(refusal(result)).toContain('mcp_servers is an inline table')
    }
  })
})
