// A dry run of the installer reports what a real run would change and changes nothing.
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { installAgentSetup, type AgentSetupResult } from '../commands/agent-setup.js'
import {
  cleanupTempProjects,
  fakeRunner,
  skillFolderFiles,
  tempProject,
  writeInstalledPackage,
} from './project-fixtures.js'

const MANIFEST = '.agents/agent-qa-skills.json'
const LONG_AGO = new Date('2001-01-01T00:00:00Z')

type Project = { root: string; home: string }

afterEach(() => {
  cleanupTempProjects()
})

function installAgentQa(root: string, version: string, skills: readonly string[]): void {
  rmSync(join(root, 'node_modules', 'agent-qa'), { recursive: true, force: true })
  const files: Record<string, string> = { 'dist/cli.js': '' }
  for (const skill of skills) Object.assign(files, skillFolderFiles(skill))
  writeInstalledPackage(root, 'agent-qa', version, {
    packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
    files,
  })
}

async function install(project: Project, dryRun: boolean): Promise<AgentSetupResult> {
  return await installAgentSetup({
    projectDir: project.root,
    agents: ['claude-code'],
    host: { cwd: project.root, homedir: project.home, env: {}, run: fakeRunner() },
    ...(dryRun ? { dryRun: true } : {}),
  })
}

interface Entry {
  kind: 'dir' | 'file'
  sha256?: string
  mtimeMs: number
}

function snapshot(
  dir: string,
  prefix = '',
  out: Record<string, Entry> = {},
): Record<string, Entry> {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const key = prefix === '' ? name : `${prefix}/${name}`
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      out[key] = { kind: 'dir', mtimeMs: stat.mtimeMs }
      snapshot(path, key, out)
    } else {
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
      out[key] = { kind: 'file', sha256, mtimeMs: stat.mtimeMs }
    }
  }
  return out
}

function ageEverything(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) ageEverything(path)
    utimesSync(path, LONG_AGO, LONG_AGO)
  }
}

function changedFiles(before: Record<string, Entry>, after: Record<string, Entry>): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...paths]
    .filter((path) => (before[path] ?? after[path])?.kind === 'file')
    .filter((path) => JSON.stringify(before[path]) !== JSON.stringify(after[path]))
    .sort()
}

// Installed at 1.4.2, then agent-qa moved to 1.4.3 and dropped a skill while a person edited,
// deleted and removed parts of what the installer wrote.
async function driftedProject(): Promise<Project> {
  const project = tempProject('agent-setup-dry-run')
  installAgentQa(project.root, '1.4.2', ['agent-qa-alpha', 'agent-qa-beta', 'agent-qa-gamma'])
  await install(project, false)
  installAgentQa(project.root, '1.4.3', ['agent-qa-alpha', 'agent-qa-beta', 'agent-qa-delta'])

  const alpha = join(project.root, '.claude/skills/agent-qa-alpha/SKILL.md')
  writeFileSync(alpha, `${readFileSync(alpha, 'utf-8')}\nMy own note.\n`)
  rmSync(join(project.root, '.claude/skills/agent-qa-beta'), { recursive: true })
  writeFileSync(
    join(project.root, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2)}\n`,
  )
  const agentsMd = join(project.root, 'AGENTS.md')
  writeFileSync(agentsMd, readFileSync(agentsMd, 'utf-8').replace('- Runs:', '- Runs (mine):'))
  ageEverything(project.root)
  return project
}

describe('a dry run of the installer', () => {
  it('reports the outcomes and notes a real run has, and leaves every byte and mtime as it was', async () => {
    const project = await driftedProject()
    const before = snapshot(project.root)

    const planned = await install(project, true)

    expect(snapshot(project.root)).toEqual(before)
    expect(planned.files).toEqual([
      { path: '.claude/skills/agent-qa-alpha/SKILL.md', outcome: 'replaced' },
      { path: '.claude/skills/agent-qa-beta/SKILL.md', outcome: 'created' },
      { path: '.claude/skills/agent-qa-delta/SKILL.md', outcome: 'created' },
      { path: '.claude/skills/agent-qa-gamma/SKILL.md', outcome: 'removed' },
      { path: '.mcp.json', outcome: 'created' },
      { path: 'AGENTS.md', outcome: 'replaced' },
    ])
    expect(planned.notes).toEqual([
      'Replaced your edit: .claude/skills/agent-qa-alpha/SKILL.md',
      'Replaced your edit: the agent-qa block in AGENTS.md',
    ])

    const real = await install(project, false)

    expect(real.files).toEqual(planned.files)
    expect(real.notes).toEqual(planned.notes)
    expect(real.parts).toEqual(planned.parts)
    expect(real.version).toBe(planned.version)
  })

  it('is followed by a real run that writes exactly the files it reported, and the manifest', async () => {
    const project = await driftedProject()
    const planned = await install(project, true)
    const before = snapshot(project.root)

    await install(project, false)

    const reported = planned.files
      .filter((file) => !['unchanged', 'kept'].includes(file.outcome))
      .map((file) => file.path)
    expect(changedFiles(before, snapshot(project.root))).toEqual([...reported, MANIFEST].sort())
  })

  it('with nothing drifted reports every file unchanged and writes nothing', async () => {
    const project = tempProject('agent-setup-dry-run-current')
    installAgentQa(project.root, '1.4.2', ['agent-qa-alpha'])
    await install(project, false)
    ageEverything(project.root)
    const before = snapshot(project.root)

    const planned = await install(project, true)

    expect(snapshot(project.root)).toEqual(before)
    expect(planned.files.map((file) => file.outcome)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ])
    expect(planned.notes).toEqual([])
  })
})
