// The installer writes agent-qa's MCP server into the project folder's .mcp.json and
// .codex/config.toml, records each entry with its hash, and never runs a host CLI.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'jsonc-parser'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'
import { afterEach, describe, expect, it } from 'vitest'

import { installAgentSetup, type CodingAgent } from '../commands/agent-setup.js'
import {
  cleanupTempProjects,
  fakeRunner,
  skillFolderFiles,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
} from './project-fixtures.js'

const VERSION = '1.4.2'
const MANIFEST = '.agents/agent-qa-skills.json'
const BOTH: CodingAgent[] = ['claude-code', 'codex']
const ARGS = ['--no', '--', 'agent-qa', '--config', 'agent-qa.config.yaml', 'mcp']
const START = '<!-- agent-qa init:start -->'
const END = '<!-- agent-qa init:end -->'

const CLAUDE_CODE_ENTRY = [
  '{',
  '      "type": "stdio",',
  '      "command": "npx",',
  '      "args": ["--no", "--", "agent-qa", "--config", "agent-qa.config.yaml", "mcp"],',
  '      "timeout": 6000000',
  '    }',
].join('\n')

const CODEX_ENTRY = [
  '[mcp_servers.agent-qa]',
  'command = "npx"',
  'args = ["--no", "--", "agent-qa", "--config", "agent-qa.config.yaml", "mcp"]',
  'tool_timeout_sec = 6000',
].join('\n')

type Project = { root: string; home: string }

afterEach(() => {
  cleanupTempProjects()
})

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function installAgentQa(root: string): void {
  writeInstalledPackage(root, 'agent-qa', VERSION, {
    packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
    files: { 'dist/cli.js': '', ...skillFolderFiles('agent-qa-alpha') },
  })
}

function read(project: Project, path: string): string {
  return readFileSync(join(project.root, path), 'utf-8')
}

function write(project: Project, path: string, text: string): void {
  mkdirSync(join(project.root, path, '..'), { recursive: true })
  writeFileSync(join(project.root, path), text)
}

function manifestEntries(project: Project): { file: string; key: string; sha256: string }[] {
  return (JSON.parse(read(project, MANIFEST)) as { entries: [] }).entries
}

function agentsMdBlock(project: Project): string {
  const text = read(project, 'AGENTS.md')
  return text.slice(text.indexOf(START), text.indexOf(END) + END.length)
}

function outcomeOf(result: { files: { path: string; outcome: string }[] }, path: string) {
  return result.files.find((file) => file.path === path)?.outcome
}

// What `after` holds beyond `before` when it only inserts at one place; undefined otherwise.
function insertedText(before: string, after: string): string | undefined {
  let start = 0
  while (start < before.length && before[start] === after[start]) start += 1
  let tail = 0
  while (
    tail < before.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }
  return start + tail === before.length ? after.slice(start, after.length - tail) : undefined
}

async function setup(project: Project, runner: FakeRunner = fakeRunner()) {
  return await installAgentSetup({
    projectDir: project.root,
    agents: BOTH,
    host: { cwd: project.root, homedir: project.home, env: {}, run: runner },
  })
}

describe('the MCP entries the installer writes', () => {
  it("creates both host files holding agent-qa's stdio server pinned to the project", async () => {
    const project = tempProject('mcp-created')
    installAgentQa(project.root)
    const runner = fakeRunner()

    const result = await setup(project, runner)

    expect(result.parts).toEqual({
      skills: { outcome: 'done' },
      'agents-md': { outcome: 'done' },
      mcp: { outcome: 'done' },
    })
    expect(outcomeOf(result, '.mcp.json')).toBe('created')
    expect(outcomeOf(result, '.codex/config.toml')).toBe('created')
    const mcpJson = read(project, '.mcp.json')
    expect(mcpJson).toBe(`{\n  "mcpServers": {\n    "agent-qa": ${CLAUDE_CODE_ENTRY}\n  }\n}\n`)
    expect(parse(mcpJson)).toEqual({
      mcpServers: {
        'agent-qa': { type: 'stdio', command: 'npx', args: ARGS, timeout: 6000000 },
      },
    })
    const config = read(project, '.codex/config.toml')
    expect(config).toBe(`${CODEX_ENTRY}\n`)
    expect(getStaticTOMLValue(parseTOML(config))).toEqual({
      mcp_servers: { 'agent-qa': { command: 'npx', args: ARGS, tool_timeout_sec: 6000 } },
    })
    expect(runner.calls).toEqual([])
  })

  it("splices each entry into a person's commented files and changes no other byte", async () => {
    const project = tempProject('mcp-kept')
    installAgentQa(project.root)
    const mcpJson = [
      '{',
      '  // Servers we share with the team',
      '  "mcpServers": {',
      '    "other": { "command": "other-server" } // keep this one',
      '  }',
      '}',
      '',
    ].join('\n')
    const config = [
      '# Codex settings for this repository',
      '[model]',
      'name = "gpt-5" # the default',
      '',
      '# more settings may follow',
      '',
    ].join('\n')
    write(project, '.mcp.json', mcpJson)
    write(project, '.codex/config.toml', config)
    const runner = fakeRunner()

    const result = await setup(project, runner)

    expect(result.parts.mcp).toEqual({ outcome: 'done' })
    expect(outcomeOf(result, '.mcp.json')).toBe('created')
    expect(outcomeOf(result, '.codex/config.toml')).toBe('created')
    expect(insertedText(mcpJson, read(project, '.mcp.json'))).toContain('"agent-qa": {')
    expect(parse(read(project, '.mcp.json'))).toEqual({
      mcpServers: {
        other: { command: 'other-server' },
        'agent-qa': { type: 'stdio', command: 'npx', args: ARGS, timeout: 6000000 },
      },
    })
    expect(insertedText(config, read(project, '.codex/config.toml'))).toBe(`\n${CODEX_ENTRY}\n`)
    expect(runner.calls).toEqual([])
  })

  it('records each entry with the hash of the text written, beside the block', async () => {
    const project = tempProject('mcp-recorded')
    installAgentQa(project.root)
    const runner = fakeRunner()

    await setup(project, runner)

    expect(manifestEntries(project)).toEqual([
      { file: 'AGENTS.md', key: 'agent-qa init block', sha256: sha256(agentsMdBlock(project)) },
      { file: '.mcp.json', key: 'mcpServers.agent-qa', sha256: sha256(CLAUDE_CODE_ENTRY) },
      { file: '.codex/config.toml', key: 'mcp_servers.agent-qa', sha256: sha256(CODEX_ENTRY) },
    ])
    expect(runner.calls).toEqual([])
  })

  it('leaves both host files unchanged on the next run', async () => {
    const project = tempProject('mcp-unchanged')
    installAgentQa(project.root)
    await setup(project)
    const mcpJson = read(project, '.mcp.json')
    const config = read(project, '.codex/config.toml')

    const again = await setup(project)

    expect(outcomeOf(again, '.mcp.json')).toBe('unchanged')
    expect(outcomeOf(again, '.codex/config.toml')).toBe('unchanged')
    expect(again.notes).toEqual([])
    expect(read(project, '.mcp.json')).toBe(mcpJson)
    expect(read(project, '.codex/config.toml')).toBe(config)
  })
})
