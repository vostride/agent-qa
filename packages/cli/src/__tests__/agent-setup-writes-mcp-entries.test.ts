// The installer writes agent-qa's MCP server into the project folder's .mcp.json and
// .codex/config.toml, records each entry with its hash, never runs a host CLI, and sets up each
// project in a repository on its own.
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

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

async function setup(
  project: Project,
  agents: CodingAgent[] = BOTH,
  runner: FakeRunner = fakeRunner(),
) {
  return await installAgentSetup({
    projectDir: project.root,
    agents,
    host: { cwd: project.root, homedir: project.home, env: {}, run: runner },
  })
}

// Every path under `folder` with its bytes, a symlink's target, or a marker for a folder.
function snapshot(folder: string, skip: readonly string[] = []): Map<string, string> {
  const seen = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const key = relative(folder, path)
      if (skip.includes(key)) continue
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) seen.set(key, `link ${readlinkSync(path)}`)
      else if (stat.isDirectory()) {
        seen.set(key, 'folder')
        walk(path)
      } else seen.set(key, readFileSync(path).toString('base64'))
    }
  }
  walk(folder)
  return seen
}

function writeConfig(folder: string): void {
  writeFileSync(
    join(folder, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      '    - tests/**/*.yaml',
      '  suiteMatch:',
      '    - suites/**/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      '',
    ].join('\n'),
  )
}

describe('the MCP entries the installer writes', () => {
  it("creates both host files holding agent-qa's stdio server pinned to the project", async () => {
    const project = tempProject('mcp-created')
    installAgentQa(project.root)
    const runner = fakeRunner()

    const result = await setup(project, BOTH, runner)

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

    const result = await setup(project, BOTH, runner)

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

    await setup(project, BOTH, runner)

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

  it('rewrites an edited entry and names it, and writes a deleted one again', async () => {
    const project = tempProject('mcp-edited')
    installAgentQa(project.root)
    await setup(project)
    const mcpJson = read(project, '.mcp.json')
    write(project, '.mcp.json', mcpJson.replace('"timeout": 6000000', '"timeout": 60000'))
    write(project, '.codex/config.toml', '# only our own settings now\n')

    const result = await setup(project)

    expect(outcomeOf(result, '.mcp.json')).toBe('replaced')
    expect(outcomeOf(result, '.codex/config.toml')).toBe('created')
    expect(result.notes).toEqual(['Replaced your edit: the agent-qa entry in .mcp.json'])
    expect(read(project, '.mcp.json')).toBe(mcpJson)
    expect(read(project, '.codex/config.toml')).toBe(
      `# only our own settings now\n\n${CODEX_ENTRY}\n`,
    )
    expect(result.parts.mcp).toEqual({ outcome: 'done' })
  })

  it('replaces an agent-qa entry that was there before any install and names it', async () => {
    const project = tempProject('mcp-foreign')
    installAgentQa(project.root)
    const http = '{ "type": "http", "url": "http://localhost:4100/mcp" }'
    write(project, '.mcp.json', `{\n  "mcpServers": {\n    "agent-qa": ${http}\n  }\n}\n`)

    const result = await setup(project, ['claude-code'])

    expect(outcomeOf(result, '.mcp.json')).toBe('replaced')
    expect(result.notes).toEqual([
      "Replaced the agent-qa entry in .mcp.json, which differed from agent-qa's",
    ])
    expect(parse(read(project, '.mcp.json'))).toEqual({
      mcpServers: {
        'agent-qa': { type: 'stdio', command: 'npx', args: ARGS, timeout: 6000000 },
      },
    })
  })

  it("leaves the other agent's host file and its record as they were", async () => {
    const project = tempProject('mcp-one-agent')
    installAgentQa(project.root)
    await setup(project)
    const mcpJson = readFileSync(join(project.root, '.mcp.json'))
    const claudeCodeEntry = manifestEntries(project).find((entry) => entry.file === '.mcp.json')
    write(project, '.codex/config.toml', '')

    const result = await setup(project, ['codex'])

    expect(outcomeOf(result, '.mcp.json')).toBeUndefined()
    expect(outcomeOf(result, '.codex/config.toml')).toBe('created')
    expect(readFileSync(join(project.root, '.mcp.json')).equals(mcpJson)).toBe(true)
    expect(manifestEntries(project)).toContainEqual(claudeCodeEntry)
  })

  it('fails only the MCP part on a malformed .mcp.json and leaves the file as it was', async () => {
    const project = tempProject('mcp-malformed')
    installAgentQa(project.root)
    const text = 'mcpServers: this is not JSON\n'
    write(project, '.mcp.json', text)

    const result = await setup(project)

    expect(result.parts.mcp?.outcome).toBe('failed')
    expect(result.parts.mcp?.reason).toMatch(/^Refusing malformed \.mcp\.json: [^\n]+$/u)
    expect(result.parts.skills).toEqual({ outcome: 'done' })
    expect(result.parts['agents-md']).toEqual({ outcome: 'done' })
    expect(outcomeOf(result, '.mcp.json')).toBeUndefined()
    expect(read(project, '.mcp.json')).toBe(text)
    expect(manifestEntries(project).map((entry) => entry.file)).toEqual([
      'AGENTS.md',
      '.codex/config.toml',
    ])
  })

  it('fails the MCP part and writes nothing through a symlinked .codex folder', async () => {
    const project = tempProject('mcp-symlink')
    const outside = tempProject('mcp-symlink-outside')
    installAgentQa(project.root)
    writeFileSync(join(outside.root, 'config.toml'), 'model = "theirs"\n')
    const before = snapshot(outside.root)
    symlinkSync(outside.root, join(project.root, '.codex'), 'dir')

    const result = await setup(project)

    expect(result.parts.mcp?.outcome).toBe('failed')
    expect(result.parts.mcp?.reason).toMatch(/^Refusing init destination [^\n]+$/u)
    expect(result.parts.skills).toEqual({ outcome: 'done' })
    expect(result.parts['agents-md']).toEqual({ outcome: 'done' })
    expect(outcomeOf(result, '.mcp.json')).toBe('created')
    expect(snapshot(outside.root)).toEqual(before)
    expect(manifestEntries(project).map((entry) => entry.file)).toEqual([
      'AGENTS.md',
      '.mcp.json',
    ])
  })
})

describe('two agent-qa projects in one repository', () => {
  it("sets up each project in its own folder and leaves the other's bytes alone", async () => {
    const repo = tempProject('mcp-two-projects')
    installAgentQa(repo.root)
    const a = { root: join(repo.root, 'a'), home: repo.home }
    const b = { root: join(repo.root, 'b'), home: repo.home }
    mkdirSync(a.root)
    mkdirSync(b.root)
    writeConfig(a.root)
    writeConfig(b.root)
    const outside = snapshot(repo.root, ['a', 'b'])
    const runner = fakeRunner()

    const second = await setup(b, BOTH, runner)
    const afterB = snapshot(b.root)
    const first = await setup(a, BOTH, runner)

    expect(second.source).toBe('project')
    expect(first.source).toBe('project')
    expect(first.parts).toEqual(second.parts)
    expect(snapshot(b.root)).toEqual(afterB)
    expect(snapshot(repo.root, ['a', 'b'])).toEqual(outside)
    for (const project of [a, b]) {
      expect(read(project, '.codex/config.toml')).toBe(`${CODEX_ENTRY}\n`)
      expect(parse(read(project, '.mcp.json'))).toEqual({
        mcpServers: {
          'agent-qa': { type: 'stdio', command: 'npx', args: ARGS, timeout: 6000000 },
        },
      })
      expect(manifestEntries(project).map((entry) => entry.file)).toEqual([
        'AGENTS.md',
        '.mcp.json',
        '.codex/config.toml',
      ])
    }
    expect(runner.calls).toEqual([])
  })
})
