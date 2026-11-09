// doctor reports a coding agent's setup with the re-run menu's own dry-run checks.
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: vi.fn(() => Buffer.from('ok')),
  execFileSync: vi.fn(() => Buffer.from('')),
}))

vi.mock('@vostride/agent-qa-runner-local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner-local')>()),
  checkDockerAvailable: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../commands/doctor-knowledge-checks.js', () => ({
  createKnowledgeChecks: () => [],
}))

// The agent-qa running doctor; unset, it is this build.
const running = vi.hoisted(() => ({ version: undefined as string | undefined }))

vi.mock('@vostride/agent-qa-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-core')>()
  return {
    ...actual,
    getAgentQaVersion: () => running.version ?? actual.getAgentQaVersion(),
    resolveLLMAuth: vi.fn(() =>
      Promise.resolve({
        kind: 'unauthenticated',
        credentialKey: 'default',
        provider: 'openai-compatible',
        optional: true,
        message: 'Testing without a saved credential.',
      }),
    ),
    validateProject: vi.fn(() =>
      Promise.resolve({ errorCount: 0, warningCount: 0, fileCount: 1, results: [] }),
    ),
  }
})

vi.mock('@vostride/agent-qa-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-model')>()),
  createModel: vi.fn(() => ({})),
}))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
}))

import { getAgentQaVersion } from '@vostride/agent-qa-core'

import { createDoctorCommand } from '../commands/doctor.js'
import { cleanupTempProjects, tempProject } from './project-fixtures.js'
import {
  editSkillFile,
  foundChromium,
  initializedProject,
  installAgentQaFixture,
  rerun,
  type InitializedProject,
} from './rerun-fixtures.js'

interface Row {
  name: string
  status: 'pass' | 'warn' | 'fail' | 'skip'
  message: string
  fix?: string
}

const VERSION = getAgentQaVersion().trim()
const CODEX_ALPHA = '.agents/skills/agent-qa-alpha/SKILL.md'
const MANIFEST = '.agents/agent-qa-skills.json'
const BLOCK_END = '<!-- agent-qa init:end -->'
const SUBSCRIPTION = '@vostride/agent-qa-subscription-auth'

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempProjects()
  running.version = undefined
  process.exitCode = 0
})

async function projectWithBothAgents(label: string): Promise<InitializedProject> {
  const project = tempProject(label)
  installAgentQaFixture(project.root, VERSION)
  const fresh = await rerun(project, [
    '--yes',
    '--pm',
    'none',
    '--no-browsers',
    '--agents',
    'claude-code,codex',
    '--llm',
    'gemini',
  ])
  if (fresh.exit !== 0) throw new Error(`the fresh init exited ${fresh.exit}:\n${fresh.stderr}`)
  return project
}

async function doctorRows(project: InitializedProject): Promise<Row[]> {
  const printed: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    printed.push(parts.map(String).join(' '))
  })
  try {
    const program = new Command()
    program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
    program.addCommand(
      createDoctorCommand({
        chromium: foundChromium,
        daemon: async () => ({ kind: 'absent' }),
        listDevicesHere: async (platform) =>
          platform === 'android' ? { attached: [], avds: [] } : { simulators: [] },
        host: { homedir: project.home, env: {} },
      }),
    )
    const configPath = join(project.root, 'agent-qa.config.yaml')
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'doctor', '--json'])
  } finally {
    log.mockRestore()
  }
  return (JSON.parse(printed.join('\n')) as { rows: Row[] }).rows
}

function row(rows: readonly Row[], name: string): Row | string {
  return rows.find((entry) => entry.name === name) ?? `no ${name} row`
}

function json(project: InitializedProject, path: string): Record<string, unknown> {
  return JSON.parse(read(project, path)) as Record<string, unknown>
}

function writeJson(project: InitializedProject, path: string, value: unknown): void {
  write(project, path, `${JSON.stringify(value, null, 2)}\n`)
}

function setInstalledVersion(project: InitializedProject, name: string, version: string): void {
  const path = join('node_modules', ...name.split('/'), 'package.json')
  writeJson(project, path, { ...json(project, path), version })
}

function setDeclaredVersion(project: InitializedProject, name: string, version: string): void {
  const pkg = json(project, 'package.json') as { devDependencies: Record<string, string> }
  pkg.devDependencies[name] = version
  writeJson(project, 'package.json', pkg)
}

function read(project: InitializedProject, path: string): string {
  return readFileSync(join(project.root, path), 'utf-8')
}

function write(project: InitializedProject, path: string, text: string): void {
  writeFileSync(join(project.root, path), text)
}

// Every file's bytes and modification time, by path.
function snapshot(dir: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const shown = `${prefix}${entry.name}`
    if (entry.isDirectory()) {
      for (const [inner, value] of snapshot(path, `${shown}/`)) files.set(inner, value)
    } else if (entry.isFile()) {
      files.set(shown, `${statSync(path).mtimeMs} ${readFileSync(path, 'base64')}`)
    }
  }
  return files
}

describe("doctor's coding agent rows", () => {
  it('passes the agent whose skills are current and warns the one whose skill file was edited', async () => {
    const project = await projectWithBothAgents('doctor-skills')
    editSkillFile(project, CODEX_ALPHA)

    const rows = await doctorRows(project)

    expect(row(rows, 'Skills (Claude Code)')).toEqual({
      name: 'Skills (Claude Code)',
      status: 'pass',
      message: `current (${VERSION})`,
    })
    expect(row(rows, 'Skills (Codex)')).toEqual({
      name: 'Skills (Codex)',
      status: 'warn',
      message: `1 file differs from agent-qa ${VERSION}'s copy`,
      fix: 'Run `npx agent-qa init --setup skills`.',
    })
  })

  it('warns the MCP entry of an agent whose host file has no agent-qa entry', async () => {
    const project = await projectWithBothAgents('doctor-mcp')
    write(project, '.codex/config.toml', '# my own settings\n')

    const rows = await doctorRows(project)

    expect(row(rows, 'MCP entry (Claude Code)')).toEqual({
      name: 'MCP entry (Claude Code)',
      status: 'pass',
      message: 'current',
    })
    expect(row(rows, 'MCP entry (Codex)')).toEqual({
      name: 'MCP entry (Codex)',
      status: 'warn',
      message: 'no agent-qa entry in .codex/config.toml',
      fix: 'Run `npx agent-qa init --setup mcp`.',
    })
  })

  it('passes the AGENTS.md block when the block and the knowledge guide are current', async () => {
    const project = await projectWithBothAgents('doctor-block-current')

    const rows = await doctorRows(project)

    expect(row(rows, 'AGENTS.md block')).toEqual({
      name: 'AGENTS.md block',
      status: 'pass',
      message: 'current',
    })
  })

  it('warns the AGENTS.md block when the block was edited', async () => {
    const project = await projectWithBothAgents('doctor-block-edited')
    write(project, 'AGENTS.md', read(project, 'AGENTS.md').replace(BLOCK_END, `My note.\n${BLOCK_END}`))

    const rows = await doctorRows(project)

    expect(row(rows, 'AGENTS.md block')).toEqual({
      name: 'AGENTS.md block',
      status: 'warn',
      message: 'the block was edited',
      fix: 'Run `npx agent-qa init --setup agents-md`.',
    })
  })

  it('warns the AGENTS.md block when the knowledge guide was changed', async () => {
    const project = await projectWithBothAgents('doctor-guide')
    const guide = 'agent-qa-knowledge/AGENTS.md'
    write(project, guide, `${read(project, guide)}\nMy own rule.\n`)

    const rows = await doctorRows(project)

    expect(row(rows, 'AGENTS.md block')).toEqual({
      name: 'AGENTS.md block',
      status: 'warn',
      message: 'knowledge guide differs',
      fix: 'Run `npx agent-qa init --setup agents-md`.',
    })
  })

  it('shows one SKIP row and no agent rows when no coding agent is set up', async () => {
    const project = await initializedProject('doctor-no-agent')

    const rows = await doctorRows(project)

    expect(row(rows, 'Coding agents')).toEqual({
      name: 'Coding agents',
      status: 'skip',
      message: 'no coding agent set up',
    })
    expect(
      rows.filter(
        (entry) =>
          entry.name.startsWith('Skills (') ||
          entry.name.startsWith('MCP entry (') ||
          entry.name === 'AGENTS.md block',
      ),
    ).toEqual([])
  })

  it('shows the versions row and the agent rows right after Config validation', async () => {
    const project = await projectWithBothAgents('doctor-order')

    const names = (await doctorRows(project)).map((entry) => entry.name)
    const after = names.indexOf('Config validation') + 1

    expect(names.slice(after, after + 6)).toEqual([
      'agent-qa versions',
      'Skills (Claude Code)',
      'Skills (Codex)',
      'MCP entry (Claude Code)',
      'MCP entry (Codex)',
      'AGENTS.md block',
    ])
  })

  it('leaves every byte and modification time in the project unchanged', async () => {
    const project = await projectWithBothAgents('doctor-writes-nothing')
    editSkillFile(project, CODEX_ALPHA)
    write(project, '.codex/config.toml', '# my own settings\n')
    write(project, 'AGENTS.md', read(project, 'AGENTS.md').replace(BLOCK_END, `My note.\n${BLOCK_END}`))
    const before = snapshot(project.root)

    const rows = await doctorRows(project)

    expect(rows.filter((entry) => entry.status === 'warn').map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['Skills (Codex)', 'MCP entry (Codex)', 'AGENTS.md block']),
    )
    expect(snapshot(project.root)).toEqual(before)
  })

  it('warns with the refusal on one line when the manifest is malformed', async () => {
    const project = await projectWithBothAgents('doctor-bad-manifest')
    write(project, MANIFEST, '{ "format": 1,\n  "version": ')

    const rows = await doctorRows(project)
    const agents = row(rows, 'Coding agents') as Row

    expect(agents.status).toBe('warn')
    expect(agents.message).toMatch(
      /^Refusing malformed \.agents\/agent-qa-skills\.json: it is not valid JSON/u,
    )
    expect(agents.message).not.toContain('\n')
    expect(agents.fix).toContain('`npx agent-qa init --setup skills`')
  })

  it('warns with the refusal on one line when the AGENTS.md block is malformed', async () => {
    const project = await projectWithBothAgents('doctor-bad-block')
    write(project, 'AGENTS.md', read(project, 'AGENTS.md').replace(BLOCK_END, ''))

    const rows = await doctorRows(project)
    const block = row(rows, 'AGENTS.md block') as Row

    expect(block.status).toBe('warn')
    expect(block.message).toMatch(/^Refusing malformed AGENTS\.md: /u)
    expect(block.message).not.toContain('\n')
    expect(block.fix).toContain('`npx agent-qa init --setup agents-md`')
    expect(rows.some((entry) => entry.status === 'fail' && entry.name.includes('('))).toBe(false)
  })
})

describe("doctor's agent-qa versions row", () => {
  it('warns with the skills fix when the skills are older than the installed agent-qa', async () => {
    const project = await projectWithBothAgents('doctor-versions-skills')
    setInstalledVersion(project, 'agent-qa', '0.3.2')
    setDeclaredVersion(project, 'agent-qa', '0.3.2')
    writeJson(project, MANIFEST, { ...json(project, MANIFEST), version: '0.3.0' })
    running.version = '0.3.2'

    const rows = await doctorRows(project)

    expect(row(rows, 'agent-qa versions')).toEqual({
      name: 'agent-qa versions',
      status: 'warn',
      message: 'agent-qa 0.3.2, skills 0.3.0',
      fix: 'Run `npx agent-qa init --setup skills`.',
    })
  })

  it('warns with the deps fix when the subscription plugin is at another version than agent-qa', async () => {
    const project = await initializedProject('doctor-versions-plugin', { llm: 'codex' })
    setInstalledVersion(project, SUBSCRIPTION, '0.3.1')

    const rows = await doctorRows(project)

    expect(row(rows, 'agent-qa versions')).toEqual({
      name: 'agent-qa versions',
      status: 'warn',
      message: `agent-qa ${VERSION}, subscription plugin 0.3.1`,
      fix: 'Run `npx agent-qa init --setup deps`.',
    })
  })

  it('passes when agent-qa, its plugins and the skills are on one version', async () => {
    const project = await projectWithBothAgents('doctor-versions-match')

    const rows = await doctorRows(project)

    expect(row(rows, 'agent-qa versions')).toEqual({
      name: 'agent-qa versions',
      status: 'pass',
      message: `agent-qa ${VERSION}, skills ${VERSION}`,
    })
  })

  it("names this agent-qa's version when another copy runs doctor", async () => {
    const project = await projectWithBothAgents('doctor-versions-running')
    running.version = '9.9.9'

    const rows = await doctorRows(project)

    expect(row(rows, 'agent-qa versions')).toEqual({
      name: 'agent-qa versions',
      status: 'pass',
      message: `agent-qa ${VERSION}, skills ${VERSION}, this agent-qa 9.9.9`,
    })
  })

  it('fails with the deps fix when agent-qa is declared and not installed, and doctor exits 3', async () => {
    const project = await initializedProject('doctor-versions-missing')
    rmSync(join(project.root, 'node_modules', 'agent-qa'), { recursive: true, force: true })

    const rows = await doctorRows(project)

    expect(row(rows, 'agent-qa versions')).toEqual({
      name: 'agent-qa versions',
      status: 'fail',
      message: 'agent-qa declared, not installed',
      fix: 'Run `npx agent-qa init --setup deps`.',
    })
    expect(rows.filter((entry) => entry.status === 'fail').map((entry) => entry.name)).toEqual([
      'agent-qa versions',
    ])
    expect(process.exitCode).toBe(3)
  })
})

describe("doctor's scaffold file rows", () => {
  it('name init --setup scaffold as the fix for a missing secrets file or hooks file', async () => {
    const project = await initializedProject('doctor-scaffold-fix')
    rmSync(join(project.root, '.env.secrets.local'))
    rmSync(join(project.root, 'hooks.yaml'))

    const rows = await doctorRows(project)

    for (const name of ['Secrets file', 'Workspace files']) {
      const found = row(rows, name) as Row
      expect(found.status, name).toBe('fail')
      expect(found.fix, name).toContain('Run `npx agent-qa init --setup scaffold` to write the missing file')
    }
  })
})
