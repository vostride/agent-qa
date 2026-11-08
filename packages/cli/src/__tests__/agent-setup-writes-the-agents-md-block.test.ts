// The installer writes agent-qa's block in the project folder's AGENTS.md and leaves the rest alone.
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { installAgentSetup, type CodingAgent } from '../commands/agent-setup.js'
import {
  cleanupTempProjects,
  fakeRunner,
  skillFolderFiles,
  tempProject,
  writeInstalledPackage,
  writeRemotePluginPackage,
  type FakeRunner,
} from './project-fixtures.js'

const VERSION = '1.4.2'
const MANIFEST = '.agents/agent-qa-skills.json'
const BOTH: CodingAgent[] = ['claude-code', 'codex']
const START = '<!-- agent-qa init:start -->'
const END = '<!-- agent-qa init:end -->'
const KERNEL_PACKAGE = '@vostride/agent-qa-plugin-kernel'

type Project = { root: string; home: string }

afterEach(() => {
  cleanupTempProjects()
})

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function installAgentQa(root: string, version = VERSION): void {
  writeInstalledPackage(root, 'agent-qa', version, {
    packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
    files: {
      'dist/cli.js': '',
      ...skillFolderFiles('agent-qa-beta'),
      ...skillFolderFiles('agent-qa-alpha'),
    },
  })
}

function installKernel(root: string): void {
  writeRemotePluginPackage(root, KERNEL_PACKAGE, VERSION, {
    files: {
      'skill/SKILL.md': [
        '---',
        'name: agent-qa-plugin-kernel',
        'description: Use when a test runs through the kernel plugin. More detail follows.',
        '---',
        '',
        '# Kernel',
        '',
      ].join('\n'),
    },
  })
  writeFileSync(
    join(root, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      '    - tests/**/*.yaml',
      '  suiteMatch:',
      '    - suites/**/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'plugins:',
      '  - name: kernel',
      `    package: '${KERNEL_PACKAGE}'`,
      '',
    ].join('\n'),
  )
}

function agentsMd(project: Project): string {
  return readFileSync(join(project.root, 'AGENTS.md'), 'utf-8')
}

function blockOf(text: string): string {
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start === -1 || end === -1) throw new Error('no agent-qa block')
  return text.slice(start, end + END.length)
}

function manifestEntries(project: Project): unknown[] {
  return (JSON.parse(readFileSync(join(project.root, MANIFEST), 'utf-8')) as { entries: unknown[] })
    .entries
}

async function setup(project: Project, runner: FakeRunner = fakeRunner()) {
  return await installAgentSetup({
    projectDir: project.root,
    agents: BOTH,
    parts: ['skills', 'agents-md'],
    host: { cwd: project.root, homedir: project.home, env: {}, run: runner },
  })
}

function outcomeOf(result: { files: { path: string; outcome: string }[] }, path: string) {
  return result.files.find((file) => file.path === path)?.outcome
}

describe('the AGENTS.md block the installer writes', () => {
  it("creates AGENTS.md holding the block that lists agent-qa's skills, then each plugin skill", async () => {
    const project = tempProject('agents-md-created')
    installAgentQa(project.root)
    installKernel(project.root)
    const runner = fakeRunner()

    const result = await setup(project, runner)

    expect(result.parts['agents-md']).toEqual({ outcome: 'done' })
    expect(result.parts.skills).toEqual({ outcome: 'done' })
    expect(outcomeOf(result, 'AGENTS.md')).toBe('created')
    const text = agentsMd(project)
    const block = blockOf(text)
    expect(text).toBe(`${block}\n`)
    const lines = block.split('\n')
    expect(lines[0]).toBe(START)
    expect(lines.at(-1)).toBe(END)
    const skillsAt = lines.indexOf(`- Skills (agent-qa ${VERSION}):`)
    expect(skillsAt).toBeGreaterThan(0)
    expect(lines.slice(skillsAt + 1, skillsAt + 5)).toEqual([
      '  - agent-qa-alpha: agent-qa-alpha in short',
      '  - agent-qa-beta: agent-qa-beta in short',
      '  - agent-qa-plugin-kernel: Use when a test runs through the kernel plugin.',
      '- Skills or MCP server missing or stale: run `npx agent-qa init`',
    ])
    expect(manifestEntries(project)).toEqual([
      { file: 'AGENTS.md', key: 'agent-qa init block', sha256: sha256(block) },
    ])
    expect(runner.calls).toEqual([])
  })

  it("replaces an old block in a person's CRLF AGENTS.md and keeps every byte around it", async () => {
    const project = tempProject('agents-md-crlf')
    installAgentQa(project.root)
    const before = '# Our project\r\n\r\nRead the style guide first.\r\n\r\n'
    const after = '\r\n\r\nMore notes ✓\r\n'
    writeFileSync(
      join(project.root, 'AGENTS.md'),
      `${before}${START}\r\n## agent-qa\r\nan old line\r\n${END}${after}`,
    )

    const result = await setup(project)

    expect(result.parts['agents-md']).toEqual({ outcome: 'done' })
    expect(outcomeOf(result, 'AGENTS.md')).toBe('replaced')
    const bytes = readFileSync(join(project.root, 'AGENTS.md'))
    const block = blockOf(bytes.toString('utf-8'))
    expect(block).not.toContain('an old line')
    expect(block).toContain('  - agent-qa-alpha: agent-qa-alpha in short')
    expect(bytes.equals(Buffer.from(`${before}${block}${after}`, 'utf-8'))).toBe(true)
  })

  it('rewrites an edited block and names it, then leaves it unchanged on the next run', async () => {
    const project = tempProject('agents-md-edited')
    installAgentQa(project.root)
    await setup(project)
    const original = agentsMd(project)
    writeFileSync(
      join(project.root, 'AGENTS.md'),
      original.replace('- Runs:', '- Runs (my own words):'),
    )

    const rewritten = await setup(project)

    expect(outcomeOf(rewritten, 'AGENTS.md')).toBe('replaced')
    expect(rewritten.notes).toEqual(['Replaced your edit: the agent-qa block in AGENTS.md'])
    expect(agentsMd(project)).toBe(original)

    const again = await setup(project)

    expect(outcomeOf(again, 'AGENTS.md')).toBe('unchanged')
    expect(again.notes).toEqual([])
    expect(agentsMd(project)).toBe(original)
  })

  it('updates an unedited block when the installed agent-qa changes', async () => {
    const project = tempProject('agents-md-updated')
    installAgentQa(project.root)
    await setup(project)
    rmSync(join(project.root, 'node_modules', 'agent-qa'), { recursive: true })
    installAgentQa(project.root, '1.5.0')

    const result = await setup(project)

    expect(outcomeOf(result, 'AGENTS.md')).toBe('updated')
    expect(result.notes).toEqual([])
    const block = blockOf(agentsMd(project))
    expect(block).toContain('- Skills (agent-qa 1.5.0):')
    expect(manifestEntries(project)).toEqual([
      { file: 'AGENTS.md', key: 'agent-qa init block', sha256: sha256(block) },
    ])
  })

  it('appends the block again after a person deleted it', async () => {
    const project = tempProject('agents-md-restored')
    installAgentQa(project.root)
    await setup(project)
    const block = blockOf(agentsMd(project))
    writeFileSync(join(project.root, 'AGENTS.md'), '# Our notes\n')

    const result = await setup(project)

    expect(outcomeOf(result, 'AGENTS.md')).toBe('created')
    expect(agentsMd(project)).toBe(`# Our notes\n\n${block}\n`)
  })

  it('fails the AGENTS.md part on a lone start marker and still installs the skills', async () => {
    const project = tempProject('agents-md-malformed')
    installAgentQa(project.root)
    const text = `# Our notes\n${START}\nhalf a block\n`
    writeFileSync(join(project.root, 'AGENTS.md'), text)

    const result = await setup(project)

    expect(result.parts['agents-md']).toEqual({
      outcome: 'failed',
      reason:
        'Refusing malformed AGENTS.md: expected at most one complete agent-qa init managed block',
    })
    expect(result.parts.skills).toEqual({ outcome: 'done' })
    expect(outcomeOf(result, '.claude/skills/agent-qa-alpha/SKILL.md')).toBe('created')
    expect(outcomeOf(result, 'AGENTS.md')).toBeUndefined()
    expect(readFileSync(join(project.root, 'AGENTS.md'), 'utf-8')).toBe(text)
    expect(manifestEntries(project)).toEqual([])
  })
})
