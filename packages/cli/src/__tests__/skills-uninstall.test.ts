// agent-qa skills uninstall removes only what the manifest lists and leaves a person's bytes alone.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'

import { installAgentSetup, type CodingAgent } from '../commands/agent-setup.js'
import { createSkillsCommand } from '../commands/skills.js'
import {
  cleanupTempProjects,
  fakeRunner,
  skillFolderFiles,
  tempProject,
  writeInstalledPackage,
} from './project-fixtures.js'

const VERSION = '1.4.2'
const MANIFEST = '.agents/agent-qa-skills.json'
const BOTH: CodingAgent[] = ['claude-code', 'codex']

const PERSON_MCP_JSON = [
  '{',
  '  "mcpServers": {',
  '    "other": { "command": "other-server" }',
  '  }',
  '}',
  '',
].join('\n')
const PERSON_AGENTS_MD = '# Team notes\n\nBe kind to the build.\n'
const PERSON_SKILL = '---\nname: my-skill\ndescription: Mine.\n---\n\n# Mine\n'

type Project = { root: string; home: string }

afterEach(() => {
  cleanupTempProjects()
})

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf-8')
}

function writeConfig(root: string): void {
  write(
    root,
    'agent-qa.config.yaml',
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

function installAgentQa(root: string): void {
  writeInstalledPackage(root, 'agent-qa', VERSION, {
    packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
    files: { 'dist/cli.js': '', ...skillFolderFiles('agent-qa-alpha') },
  })
}

async function setup(project: Project, agents: CodingAgent[] = BOTH): Promise<void> {
  await installAgentSetup({
    projectDir: project.root,
    agents,
    host: { cwd: project.root, homedir: project.home, env: {}, run: fakeRunner() },
  })
}

function newProject(label: string): Project {
  const project = tempProject(label)
  installAgentQa(project.root)
  writeConfig(project.root)
  return project
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

function listedFiles(root: string): string[] {
  return (JSON.parse(read(root, MANIFEST)) as { files: { path: string }[] }).files.map(
    (file) => file.path,
  )
}

async function skills(
  cwd: string,
  args: readonly string[],
  config: string | undefined = join(cwd, 'agent-qa.config.yaml'),
): Promise<string> {
  let stdout = ''
  const program = new Command()
  program.exitOverride()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(
    createSkillsCommand({
      cwd,
      stdout: {
        write: (chunk: string | Uint8Array) => {
          stdout += String(chunk)
          return true
        },
      },
    }),
  )
  const global = config === undefined ? [] : ['--config', config]
  await program.parseAsync(['node', 'agent-qa', ...global, 'skills', ...args])
  return stripVTControlCharacters(stdout)
}

// A project set up for both agents beside a person's own skill, server, prose and notes.
async function sharedProject(
  label: string,
): Promise<{ project: Project; before: Map<string, string> }> {
  const project = newProject(label)
  const { root } = project
  write(root, '.claude/skills/my-skill/SKILL.md', PERSON_SKILL)
  write(root, '.mcp.json', PERSON_MCP_JSON)
  write(root, 'AGENTS.md', PERSON_AGENTS_MD)
  const before = snapshot(root)
  await setup(project)
  write(root, '.agents/skills/agent-qa-alpha/my-notes.md', 'my own notes\n')
  const skill = '.claude/skills/agent-qa-alpha/SKILL.md'
  write(root, skill, `${read(root, skill)}\nA line of my own.\n`)
  return { project, before }
}

describe('agent-qa skills uninstall', () => {
  it("removes agent-qa's files, entries, block and manifest and keeps every byte of the person's", async () => {
    const { project, before } = await sharedProject('uninstall-all')
    const { root } = project
    const listed = listedFiles(root)

    await skills(root, ['uninstall'])

    for (const path of listed) expect(existsSync(join(root, path)), path).toBe(false)
    expect(readdirSync(join(root, '.agents/skills/agent-qa-alpha'))).toEqual(['my-notes.md'])
    expect(read(root, '.mcp.json')).toBe(PERSON_MCP_JSON)
    expect(existsSync(join(root, '.codex'))).toBe(false)
    expect(read(root, 'AGENTS.md')).toBe(PERSON_AGENTS_MD)
    expect(existsSync(join(root, MANIFEST))).toBe(false)
    const expected = new Map(before)
    expected.set('.agents', 'folder')
    expected.set('.agents/skills', 'folder')
    expected.set('.agents/skills/agent-qa-alpha', 'folder')
    expected.set(
      '.agents/skills/agent-qa-alpha/my-notes.md',
      Buffer.from('my own notes\n').toString('base64'),
    )
    expect(snapshot(root)).toEqual(expected)
  })

  it('prints one line per agent, one for AGENTS.md, and names the edited file', async () => {
    const { project } = await sharedProject('uninstall-lines')

    const output = await skills(project.root, ['uninstall'])

    expect(output.split('\n')).toEqual([
      '✓ Claude Code: removed 1 skill from .claude/skills and the agent-qa entry from .mcp.json',
      '  Removed your edit: .claude/skills/agent-qa-alpha/SKILL.md',
      '✓ Codex: removed 1 skill from .agents/skills and the agent-qa entry from .codex/config.toml',
      '✓ AGENTS.md: removed the agent-qa block',
      '',
    ])
  })

  it('prints one JSON result with the agents, files, entries, block and manifest outcomes', async () => {
    const { project } = await sharedProject('uninstall-json')
    const listed = listedFiles(project.root)

    const output = await skills(project.root, ['uninstall', '--json'])

    const result = JSON.parse(output) as {
      dryRun: boolean
      removed: {
        agent: string
        files: { path: string; outcome: string; edited: boolean }[]
        entries: { file: string; key: string; outcome: string; edited: boolean }[]
      }[]
      block: { outcome: string; edited: boolean }
      manifest: string
    }
    expect(result.dryRun).toBe(false)
    expect(result.removed.map((report) => report.agent)).toEqual(BOTH)
    const files = result.removed.flatMap((report) => report.files)
    expect(files.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual(
      [...listed].sort().map((path) => ({
        path,
        outcome: 'removed',
        edited: path === '.claude/skills/agent-qa-alpha/SKILL.md',
      })),
    )
    expect(result.removed.flatMap((report) => report.entries)).toEqual([
      { file: '.mcp.json', key: 'mcpServers.agent-qa', outcome: 'removed', edited: false },
      {
        file: '.codex/config.toml',
        key: 'mcp_servers.agent-qa',
        outcome: 'removed',
        edited: false,
      },
    ])
    expect(result.block).toEqual({ outcome: 'removed', edited: false })
    expect(result.manifest).toBe('removed')
  })
})
