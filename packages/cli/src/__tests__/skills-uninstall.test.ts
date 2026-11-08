// agent-qa skills uninstall removes only what the manifest lists and leaves a person's bytes alone.
import {
  chmodSync,
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

import { Command, type CommanderError } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installAgentSetup, type CodingAgent } from '../commands/agent-setup.js'
import {
  createSkillsCommand,
  listAgentQaSkills,
  resolveAgentQaSkillsDirectory,
} from '../commands/skills.js'
import { CliRefusal } from '../composition/cli-refusal.js'
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
  vi.restoreAllMocks()
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

async function refusal(promise: Promise<unknown>): Promise<CliRefusal> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(CliRefusal)
  return error as CliRefusal
}

function plainLines(error: CliRefusal): string[] {
  return error.lines.map((line) => stripVTControlCharacters(line))
}

interface Manifest {
  agents: string[]
  files: { path: string; sha256: string }[]
  entries: { file: string; key: string; sha256: string }[]
}

function manifestOf(root: string): Manifest {
  return JSON.parse(read(root, MANIFEST)) as Manifest
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

describe('agent-qa skills uninstall for one agent', () => {
  it("removes Codex's share, keeps Claude Code's and the block, and the last agent takes the rest", async () => {
    const project = newProject('uninstall-codex')
    const { root } = project
    const pristine = snapshot(root)
    await setup(project)
    const claude = snapshot(join(root, '.claude'))
    const mcpJson = readFileSync(join(root, '.mcp.json'))
    const agentsMd = readFileSync(join(root, 'AGENTS.md'))
    const before = manifestOf(root)

    const first = await skills(root, ['uninstall', '--agents', 'codex'])

    expect(first).toBe(
      '✓ Codex: removed 1 skill from .agents/skills and the agent-qa entry from .codex/config.toml\n',
    )
    expect(existsSync(join(root, '.agents/skills'))).toBe(false)
    expect(existsSync(join(root, '.codex'))).toBe(false)
    expect(snapshot(join(root, '.claude'))).toEqual(claude)
    expect(readFileSync(join(root, '.mcp.json')).equals(mcpJson)).toBe(true)
    expect(readFileSync(join(root, 'AGENTS.md')).equals(agentsMd)).toBe(true)
    expect(manifestOf(root)).toEqual({
      ...before,
      agents: ['claude-code'],
      files: before.files.filter((file) => file.path.startsWith('.claude/skills/')),
      entries: before.entries.filter((entry) => entry.file !== '.codex/config.toml'),
    })

    const last = await skills(root, ['uninstall', '--agents', 'claude-code'])

    expect(last.split('\n')).toEqual([
      '✓ Claude Code: removed 1 skill from .claude/skills and the agent-qa entry from .mcp.json',
      '✓ AGENTS.md: removed the agent-qa block',
      '',
    ])
    expect(snapshot(root)).toEqual(pristine)
  })

  it('treats --agents all as every agent', async () => {
    const all = newProject('uninstall-agents-all')
    const plain = newProject('uninstall-agents-default')
    await setup(all)
    await setup(plain)

    const withAll = await skills(all.root, ['uninstall', '--agents', 'all'])
    const withNone = await skills(plain.root, ['uninstall'])

    expect(withAll).toBe(withNone)
    expect(snapshot(all.root)).toEqual(snapshot(plain.root))
    expect(existsSync(join(all.root, MANIFEST))).toBe(false)
  })

  it('says an agent that is not in the manifest is not installed and changes nothing', async () => {
    const project = newProject('uninstall-not-installed')
    await setup(project, ['claude-code'])
    const before = snapshot(project.root)

    const output = await skills(project.root, ['uninstall', '--agents', 'codex'])

    expect(output).toBe('- Codex: not installed here\n')
    expect(snapshot(project.root)).toEqual(before)
  })
})

describe('agent-qa skills uninstall --dry-run', () => {
  it('prints what it would remove and leaves every byte of the project as it was', async () => {
    const { project } = await sharedProject('uninstall-dry-run')
    const before = snapshot(project.root)

    const output = await skills(project.root, ['uninstall', '--dry-run'])

    expect(output.split('\n')).toEqual([
      '- Claude Code: would remove 1 skill from .claude/skills and the agent-qa entry from .mcp.json',
      '  Would remove your edit: .claude/skills/agent-qa-alpha/SKILL.md',
      '- Codex: would remove 1 skill from .agents/skills and the agent-qa entry from .codex/config.toml',
      '- AGENTS.md: would remove the agent-qa block',
      '',
    ])
    expect(snapshot(project.root)).toEqual(before)
  })
})

describe('agent-qa skills uninstall refusals', () => {
  it('says nothing is installed when the folder has no manifest', async () => {
    const project = newProject('uninstall-nothing')
    const before = snapshot(project.root)

    const output = await skills(project.root, ['uninstall'])

    expect(output).toBe(`agent-qa's skills and MCP entries are not installed in ${project.root}.\n`)
    expect(snapshot(project.root)).toEqual(before)
  })

  it.each([
    {
      name: 'a manifest that is not JSON',
      path: MANIFEST,
      change: () => 'not\njson\n',
      line: /^Refusing malformed \.agents\/agent-qa-skills\.json: it is not valid JSON/u,
    },
    {
      name: 'a .mcp.json that is not JSON',
      path: '.mcp.json',
      change: () => 'mcpServers: this is not JSON\n',
      line: /^Refusing malformed \.mcp\.json: /u,
    },
    {
      name: 'a .codex/config.toml that does not parse',
      path: '.codex/config.toml',
      change: () => '[mcp_servers.agent-qa\ncommand = "npx"\n',
      line: /^Refusing malformed \.codex\/config\.toml: /u,
    },
    {
      name: 'an AGENTS.md with an unbalanced marker',
      path: 'AGENTS.md',
      change: (text: string) => `${text}\n<!-- agent-qa init:start -->\n`,
      line: /^Refusing malformed AGENTS\.md: /u,
    },
  ])('exits 2 in one line and writes nothing for $name', async ({ path, change, line }) => {
    const project = newProject('uninstall-malformed')
    await setup(project)
    write(project.root, path, change(read(project.root, path)))
    const before = snapshot(project.root)

    const error = await refusal(skills(project.root, ['uninstall']))

    expect(error.exitCode).toBe(2)
    expect(plainLines(error)).toHaveLength(1)
    expect(plainLines(error)[0]).toMatch(line)
    expect(plainLines(error)[0]).not.toContain('\n')
    expect(snapshot(project.root)).toEqual(before)
  })

  it('exits 2 for an unknown coding agent', async () => {
    const project = newProject('uninstall-unknown-agent')
    await setup(project)
    const before = snapshot(project.root)

    const error = await refusal(skills(project.root, ['uninstall', '--agents', 'cursor']))

    expect(error.exitCode).toBe(2)
    expect(plainLines(error)).toEqual([
      'Unknown coding agent "cursor". Use claude-code, codex or all.',
    ])
    expect(snapshot(project.root)).toEqual(before)
  })

  // Permissions do not stop a removal for root or on Windows.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'exits 3 naming the file a removal could not delete, and keeps the manifest',
    async () => {
      const project = newProject('uninstall-read-only')
      await setup(project)
      const folder = join(project.root, '.agents/skills/agent-qa-alpha')
      chmodSync(folder, 0o555)
      try {
        const error = await refusal(skills(project.root, ['uninstall']))

        expect(error.exitCode).toBe(3)
        expect(plainLines(error)).toHaveLength(1)
        expect(plainLines(error)[0]).toMatch(
          /^Could not remove \.agents\/skills\/agent-qa-alpha\/SKILL\.md: [^\n]+$/u,
        )
        expect(existsSync(join(project.root, MANIFEST))).toBe(true)
      } finally {
        chmodSync(folder, 0o755)
      }
    },
  )
})

describe('the agent-qa skills command around uninstall', () => {
  it('refuses skills install with the usage error and exit 2', async () => {
    const project = newProject('skills-install')
    let stderr = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk)
      return true
    })

    const error = await refusal(skills(project.root, ['install']))

    expect(error.exitCode).toBe(2)
    expect((error.cause as CommanderError).code).toBe('commander.excessArguments')
    expect(stderr).toContain("too many arguments for 'skills'")
  })

  it('still lists the packaged skills with --json', async () => {
    const project = newProject('skills-list')

    const output = await skills(project.root, ['--json'])

    const payload = JSON.parse(output) as { skills: { name: string }[] }
    const packaged = listAgentQaSkills(resolveAgentQaSkillsDirectory().path)
    expect(payload.skills.map((skill) => skill.name)).toEqual(packaged.map((skill) => skill.name))
    expect(payload.skills.length).toBeGreaterThan(0)
  })

  it('names uninstall in its help', () => {
    expect(createSkillsCommand().helpInformation()).toMatch(/^\s+uninstall\b/mu)
  })
})

describe('the folder skills uninstall acts on', () => {
  it('is the folder of the global --config, relative to where it runs', async () => {
    const parent = tempProject('uninstall-config')
    const sub = { root: join(parent.root, 'sub'), home: parent.home }
    mkdirSync(sub.root)
    installAgentQa(sub.root)
    writeConfig(sub.root)
    await setup(sub)
    const outside = snapshot(parent.root, ['sub'])

    await skills(parent.root, ['uninstall'], 'sub/agent-qa.config.yaml')

    expect(existsSync(join(sub.root, MANIFEST))).toBe(false)
    expect(existsSync(join(sub.root, '.mcp.json'))).toBe(false)
    expect(snapshot(parent.root, ['sub'])).toEqual(outside)
  })

  it('leaves every byte of a second project in the repository as it was', async () => {
    const repo = tempProject('uninstall-two-projects')
    installAgentQa(repo.root)
    const a = { root: join(repo.root, 'a'), home: repo.home }
    const b = { root: join(repo.root, 'b'), home: repo.home }
    for (const project of [a, b]) {
      mkdirSync(project.root)
      writeConfig(project.root)
      await setup(project)
    }
    const afterB = snapshot(b.root)

    await skills(a.root, ['uninstall'])

    expect(existsSync(join(a.root, MANIFEST))).toBe(false)
    expect(snapshot(b.root)).toEqual(afterB)
  })
})
