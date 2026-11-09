// A re-run checks a coding agent's setup with a dry run of the installer and repairs it.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSetupOptions } from '../commands/agent-setup.js'
import type { InitDocument } from '../commands/init-document.js'
import { SETUP_MENU_QUESTION } from '../commands/init-rerun.js'
import { buildKnowledgeAgentGuide } from '../commands/knowledge-guide.js'
import { upsertCodexMcpEntry } from '../commands/mcp-entries.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import { cleanupTempProjects } from './project-fixtures.js'
import {
  editSkillFile,
  initializedProject,
  initializedProjectWithAgent,
  rerun,
} from './rerun-fixtures.js'

const installs = vi.hoisted(() => ({ real: 0 }))

vi.mock('../commands/agent-setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/agent-setup.js')>()
  return {
    ...actual,
    installAgentSetup: async (options: AgentSetupOptions) => {
      if (options.dryRun !== true) installs.real += 1
      return await actual.installAgentSetup(options)
    },
  }
})

const VERSION = getAgentQaVersion().trim()
const ALPHA = '.claude/skills/agent-qa-alpha/SKILL.md'
const GUIDE = 'agent-qa-knowledge/AGENTS.md'
const CODEX_CONFIG = '.codex/config.toml'
const CODEX_ALPHA = '.agents/skills/agent-qa-alpha/SKILL.md'
const MANIFEST = '.agents/agent-qa-skills.json'
const AGENTS_QUESTION = 'Which coding agents should agent-qa set up?'
const asked = { hooks: { isTTY: true } }

beforeEach(() => {
  installs.real = 0
})

afterEach(() => {
  cleanupTempProjects()
})

function menuOf(
  entries: readonly FakeInitUiEntry[],
): Extract<FakeInitUiEntry, { kind: 'multiselect' }> | undefined {
  const entry = entries.find(
    (item) => item.kind === 'multiselect' && item.text === SETUP_MENU_QUESTION,
  )
  return entry?.kind === 'multiselect' ? entry : undefined
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf-8')
}

function skillsRow(doc: InitDocument): unknown {
  return doc.setup?.find((row) => row.name === 'skills') ?? 'no skills row'
}

function agentsQuestionOf(
  entries: readonly FakeInitUiEntry[],
): Extract<FakeInitUiEntry, { kind: 'multiselect' }> | undefined {
  const entry = entries.find((item) => item.kind === 'multiselect' && item.text === AGENTS_QUESTION)
  return entry?.kind === 'multiselect' ? entry : undefined
}

function setupRow(doc: InitDocument, name: string): unknown {
  return doc.setup?.find((row) => row.name === name) ?? `no ${name} row`
}

function refusalLines(stderr: string): string[] {
  return stripVTControlCharacters(stderr)
    .split('\n')
    .filter((line) => line !== '')
}

describe("a re-run's skills row", () => {
  it("labels one edited skill file as differing from agent-qa's copy and pre-checks it", async () => {
    const project = await initializedProjectWithAgent('rerun-skills-edited', 'claude-code', VERSION)
    editSkillFile(project, ALPHA)

    const menu = await rerun(project, [], { ...asked, answers: { [SETUP_MENU_QUESTION]: [] } })

    expect(menu.exit, menu.stderr).toBe(0)
    expect(menuOf(menu.entries)?.labels ?? 'no menu').toEqual([
      'deps       nothing missing',
      `skills     1 file differs from agent-qa ${VERSION}'s copy`,
      'mcp        current',
      'agents-md  current',
      'browsers   Chromium found',
      'gitignore  current',
      'scaffold   nothing missing',
    ])
    expect(menuOf(menu.entries)?.initialValues ?? 'no menu').toEqual(['skills'])
  })

  it("with --yes puts agent-qa's copy back and names the replaced file in the step line", async () => {
    const project = await initializedProjectWithAgent(
      'rerun-skills-restore',
      'claude-code',
      VERSION,
    )
    const original = read(project.root, ALPHA)
    editSkillFile(project, ALPHA)

    const result = await rerun(project, ['--yes'])

    expect(result.exit, result.stderr).toBe(0)
    expect(read(project.root, ALPHA)).toBe(original)
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: `skills: put back agent-qa ${VERSION}'s copy for Claude Code; replaced ${ALPHA}`,
    })
  })

  it('lists the replaced file under the skills step in the --json document', async () => {
    const project = await initializedProjectWithAgent('rerun-skills-json', 'claude-code', VERSION)
    editSkillFile(project, ALPHA)

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.files).toContainEqual({ path: ALPHA, outcome: 'replaced', step: 'skills' })
    expect(doc.steps).toContainEqual({ name: 'skills', outcome: 'done' })
    expect(skillsRow(doc)).toEqual({
      name: 'skills',
      state: `1 file differs from agent-qa ${VERSION}'s copy`,
      prechecked: true,
      selected: true,
    })
  })

  it('pre-checks skills when a skill folder was deleted and brings the folder back', async () => {
    const project = await initializedProjectWithAgent(
      'rerun-skills-deleted',
      'claude-code',
      VERSION,
    )
    const beta = '.claude/skills/agent-qa-beta/SKILL.md'
    const original = read(project.root, beta)
    rmSync(join(project.root, '.claude/skills/agent-qa-beta'), { recursive: true })

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(skillsRow(doc)).toEqual({
      name: 'skills',
      state: '1 file missing',
      prechecked: true,
      selected: true,
    })
    expect(read(project.root, beta)).toBe(original)
    expect(doc.files).toContainEqual({ path: beta, outcome: 'created', step: 'skills' })
  })

  it('names the coding agent as not set up when none of its skill files is left', async () => {
    const project = await initializedProjectWithAgent('rerun-skills-gone', 'claude-code', VERSION)
    rmSync(join(project.root, '.claude/skills'), { recursive: true })

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(skillsRow(doc)).toMatchObject({ state: 'Claude Code not set up', prechecked: true })
    expect(existsSync(join(project.root, ALPHA))).toBe(true)
  })

  it('reads current with the version and is not pre-checked when nothing differs', async () => {
    const project = await initializedProjectWithAgent('rerun-skills-current', 'codex', VERSION)

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(menuOf(result.entries)?.labels ?? 'no menu').toEqual([
      'deps       nothing missing',
      `skills     current (${VERSION})`,
      'mcp        current',
      'agents-md  current',
      'browsers   Chromium found',
      'gitignore  current',
      'scaffold   nothing missing',
    ])
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').toEqual([])
    expect(result.entries).toContainEqual({ kind: 'skipped', text: 'skills: current' })
  })

  it('with no coding agent shows no skills row and records it hidden in the document', async () => {
    const project = await initializedProject('rerun-skills-no-agent')

    const menu = await rerun(project, [], asked)
    const result = await rerun(project, ['--json'], { plain: true })

    expect(menuOf(menu.entries)?.labels ?? 'no menu').toEqual([
      'deps       nothing missing',
      'agents-md  current',
      'browsers   Chromium found',
      'gitignore  current',
      'scaffold   nothing missing',
    ])
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(skillsRow(doc)).toEqual({
      name: 'skills',
      state: 'no coding agent chosen',
      prechecked: false,
      selected: false,
      hidden: 'no coding agent chosen',
    })
    expect(doc.steps.map((step) => step.name)).not.toContain('skills')
  })
})

describe("a re-run's mcp row", () => {
  it('labels a Codex entry that is missing and pre-checks it', async () => {
    const project = await initializedProjectWithAgent('rerun-mcp-missing', 'codex', VERSION)
    writeFileSync(join(project.root, CODEX_CONFIG), 'model = "o3"\n')

    const menu = await rerun(project, [], { ...asked, answers: { [SETUP_MENU_QUESTION]: [] } })

    expect(menu.exit, menu.stderr).toBe(0)
    expect(menuOf(menu.entries)?.labels ?? 'no menu').toEqual([
      'deps       nothing missing',
      `skills     current (${VERSION})`,
      'mcp        Codex entry missing',
      'agents-md  current',
      'browsers   Chromium found',
      'gitignore  current',
      'scaffold   nothing missing',
    ])
    expect(menuOf(menu.entries)?.initialValues ?? 'no menu').toEqual(['mcp'])
  })

  it('with --yes writes the Codex entry back and keeps every other byte of the file', async () => {
    const project = await initializedProjectWithAgent('rerun-mcp-restore', 'codex', VERSION)
    const mine = '# my settings\nmodel = "o3"\n'
    writeFileSync(join(project.root, CODEX_CONFIG), mine)
    const edit = upsertCodexMcpEntry(mine)
    if ('refused' in edit) throw new Error(edit.refused)

    const result = await rerun(project, ['--yes'])

    expect(result.exit, result.stderr).toBe(0)
    expect(read(project.root, CODEX_CONFIG)).toBe(edit.text)
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: 'mcp: put back the agent-qa entry for Codex',
    })
  })

  it("labels an edited Claude Code entry as differing and puts agent-qa's entry back", async () => {
    const project = await initializedProjectWithAgent('rerun-mcp-differs', 'claude-code', VERSION)
    const original = read(project.root, '.mcp.json')
    writeFileSync(join(project.root, '.mcp.json'), original.replace('6000000', '1000'))

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(setupRow(doc, 'mcp')).toEqual({
      name: 'mcp',
      state: 'Claude Code entry differs',
      prechecked: true,
      selected: true,
    })
    expect(read(project.root, '.mcp.json')).toBe(original)
    expect(doc.files).toContainEqual({ path: '.mcp.json', outcome: 'replaced', step: 'mcp' })
    expect(doc.steps).toContainEqual({ name: 'mcp', outcome: 'done' })
  })

  it('is hidden with no coding agent chosen', async () => {
    const project = await initializedProject('rerun-mcp-no-agent')

    const result = await rerun(project, ['--json'], { plain: true })

    const doc = JSON.parse(result.stdout) as InitDocument
    expect(setupRow(doc, 'mcp')).toEqual({
      name: 'mcp',
      state: 'no coding agent chosen',
      prechecked: false,
      selected: false,
      hidden: 'no coding agent chosen',
    })
  })
})

describe("a re-run's agents-md row", () => {
  it("labels an edited block, pre-checks it, and puts agent-qa's block back keeping the rest", async () => {
    const project = await initializedProjectWithAgent(
      'rerun-agents-md-edited',
      'claude-code',
      VERSION,
    )
    const block = read(project.root, 'AGENTS.md')
    const edited = block.replace('agent-qa-knowledge/AGENTS.md', 'my-notes.md')
    writeFileSync(join(project.root, 'AGENTS.md'), `# My project\n\n${edited}`)

    const menu = await rerun(project, [], { ...asked, answers: { [SETUP_MENU_QUESTION]: [] } })
    const result = await rerun(project, ['--yes'])

    expect(menuOf(menu.entries)?.labels ?? 'no menu').toContain('agents-md  the block was edited')
    expect(menuOf(menu.entries)?.initialValues ?? 'no menu').toEqual(['agents-md'])
    expect(result.exit, result.stderr).toBe(0)
    expect(read(project.root, 'AGENTS.md')).toBe(`# My project\n\n${block}`)
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: "agents-md: put back agent-qa's block in AGENTS.md; replaced AGENTS.md",
    })
  })

  it('labels a missing block and writes it back', async () => {
    const project = await initializedProjectWithAgent('rerun-agents-md-missing', 'codex', VERSION)
    const block = read(project.root, 'AGENTS.md')
    writeFileSync(join(project.root, 'AGENTS.md'), '# My project\n')

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(setupRow(doc, 'agents-md')).toMatchObject({ state: 'block missing', prechecked: true })
    expect(read(project.root, 'AGENTS.md')).toContain(block)
    expect(doc.files).toContainEqual({ path: 'AGENTS.md', outcome: 'created', step: 'agents-md' })
  })

  it('refuses a malformed block with one line, exit 2, leaving it as it was', async () => {
    const project = await initializedProjectWithAgent('rerun-agents-md-malformed', 'codex', VERSION)
    const block = read(project.root, 'AGENTS.md')
    writeFileSync(join(project.root, 'AGENTS.md'), `${block}\n${block}`)

    const result = await rerun(project, [], asked)

    expect(result.exit).toBe(2)
    const lines = refusalLines(result.stderr)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Refusing malformed AGENTS\.md: /u)
    expect(result.entries).toEqual([])
    expect(read(project.root, 'AGENTS.md')).toBe(`${block}\n${block}`)
  })

  it("pre-checks a changed knowledge guide and writes agent-qa's guide back", async () => {
    const project = await initializedProjectWithAgent('rerun-guide-differs', 'codex', VERSION)
    writeFileSync(join(project.root, GUIDE), 'hand edited\n')

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(setupRow(doc, 'agents-md')).toEqual({
      name: 'agents-md',
      state: 'knowledge guide differs',
      prechecked: true,
      selected: true,
    })
    expect(read(project.root, GUIDE)).toBe(buildKnowledgeAgentGuide())
    expect(doc.files).toContainEqual({ path: GUIDE, outcome: 'updated', step: 'agents-md' })
  })

  it('pre-checks a deleted knowledge guide and leaves it absent when agents-md is not selected', async () => {
    const project = await initializedProjectWithAgent('rerun-guide-unselected', 'codex', VERSION)
    unlinkSync(join(project.root, GUIDE))

    const result = await rerun(project, [], { ...asked, answers: { [SETUP_MENU_QUESTION]: [] } })

    expect(result.exit, result.stderr).toBe(0)
    expect(menuOf(result.entries)?.labels ?? 'no menu').toContain(
      'agents-md  knowledge guide missing',
    )
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').toEqual(['agents-md'])
    expect(existsSync(join(project.root, GUIDE))).toBe(false)
    expect(result.entries).toContainEqual({ kind: 'skipped', text: 'agents-md: not selected' })
  })

  it('with no coding agent covers the knowledge guide only and puts it back without AGENTS.md', async () => {
    const project = await initializedProject('rerun-guide-no-agent')
    unlinkSync(join(project.root, GUIDE))

    const menu = await rerun(project, [], { ...asked, answers: { [SETUP_MENU_QUESTION]: [] } })
    const result = await rerun(project, ['--yes'])

    expect(menuOf(menu.entries)?.labels ?? 'no menu').toEqual([
      'deps       nothing missing',
      'agents-md  knowledge guide missing',
      'browsers   Chromium found',
      'gitignore  current',
      'scaffold   nothing needed is missing',
    ])
    expect(result.exit, result.stderr).toBe(0)
    expect(read(project.root, GUIDE)).toBe(buildKnowledgeAgentGuide())
    expect(existsSync(join(project.root, 'AGENTS.md'))).toBe(false)
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: 'agents-md: put back the knowledge guide',
    })
  })
})

describe("a re-run's agent rows together", () => {
  it('serve skills, mcp and agents-md with one installer run, each row with its own step', async () => {
    const project = await initializedProjectWithAgent('rerun-agent-rows', 'claude-code', VERSION)
    editSkillFile(project, ALPHA)
    const mcp = read(project.root, '.mcp.json')
    writeFileSync(join(project.root, '.mcp.json'), mcp.replace('6000000', '1000'))
    writeFileSync(join(project.root, 'AGENTS.md'), '# My project\n')
    installs.real = 0

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect(installs.real).toBe(1)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps.map((step) => `${step.name} ${step.outcome}`)).toEqual([
      'deps skipped',
      'skills done',
      'mcp done',
      'agents-md done',
      'browsers skipped',
      'gitignore skipped',
      'scaffold skipped',
      'validate done',
      'dashboard skipped',
    ])
    expect(doc.files).toContainEqual({ path: ALPHA, outcome: 'replaced', step: 'skills' })
    expect(doc.files).toContainEqual({ path: '.mcp.json', outcome: 'replaced', step: 'mcp' })
    expect(doc.files).toContainEqual({ path: 'AGENTS.md', outcome: 'created', step: 'agents-md' })
  })
})

describe("a re-run's coding agents question", () => {
  it('comes after the summary and before the menu, pre-checked with the manifest agents', async () => {
    const project = await initializedProjectWithAgent('rerun-agents-order', 'claude-code', VERSION)

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    const kinds = result.entries
      .filter((entry) => entry.kind === 'summary' || entry.kind === 'multiselect')
      .map((entry) => entry.text)
    expect(kinds).toEqual(['This project', AGENTS_QUESTION, SETUP_MENU_QUESTION])
    expect(agentsQuestionOf(result.entries)?.labels ?? 'no question').toEqual([
      'Claude Code',
      'Codex',
    ])
    expect(agentsQuestionOf(result.entries)?.initialValues ?? 'no question').toEqual([
      'claude-code',
    ])
  })

  it('starts with nothing checked without a manifest, whatever markers the folder has', async () => {
    const project = await initializedProject('rerun-agents-no-manifest')
    mkdirSync(join(project.root, '.claude'))
    mkdirSync(join(project.root, '.codex'))

    const result = await rerun(project, [], {
      hooks: { isTTY: true, host: { env: { CLAUDECODE: '1' } } },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(agentsQuestionOf(result.entries)?.initialValues ?? 'no question').toEqual([])
  })

  it('checking Codex in a Claude Code project pre-checks its three rows and sets Codex up', async () => {
    const project = await initializedProjectWithAgent('rerun-agents-add', 'claude-code', VERSION)

    const result = await rerun(project, [], {
      ...asked,
      answers: { [AGENTS_QUESTION]: ['claude-code', 'codex'] },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(menuOf(result.entries)?.labels ?? 'no menu').toEqual([
      'deps       nothing missing',
      'skills     Codex not set up',
      'mcp        Codex entry missing',
      'agents-md  Codex not set up',
      'browsers   Chromium found',
      'gitignore  current',
      'scaffold   nothing missing',
    ])
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').toEqual([
      'skills',
      'mcp',
      'agents-md',
    ])
    expect(existsSync(join(project.root, CODEX_ALPHA))).toBe(true)
    expect(read(project.root, CODEX_CONFIG)).toContain('[mcp_servers.agent-qa]')
    expect(JSON.parse(read(project.root, MANIFEST))).toMatchObject({
      agents: ['claude-code', 'codex'],
    })
  })

  it("unchecking Claude Code leaves its files and its manifest records as they were", async () => {
    const project = await initializedProjectWithAgent('rerun-agents-drop', 'claude-code', VERSION)
    editSkillFile(project, ALPHA)
    const skill = read(project.root, ALPHA)
    const manifest = read(project.root, MANIFEST)
    const mcp = read(project.root, '.mcp.json')
    const block = read(project.root, 'AGENTS.md')

    const result = await rerun(project, [], { ...asked, answers: { [AGENTS_QUESTION]: [] } })

    expect(result.exit, result.stderr).toBe(0)
    expect(menuOf(result.entries)?.labels ?? 'no menu').toEqual([
      'deps       nothing missing',
      'agents-md  current',
      'browsers   Chromium found',
      'gitignore  current',
      'scaffold   nothing missing',
    ])
    expect(read(project.root, ALPHA)).toBe(skill)
    expect(read(project.root, MANIFEST)).toBe(manifest)
    expect(read(project.root, '.mcp.json')).toBe(mcp)
    expect(read(project.root, 'AGENTS.md')).toBe(block)
  })

  it('--agents answers the question without drawing it, and the document records the chosen agents', async () => {
    const project = await initializedProjectWithAgent('rerun-agents-flag', 'claude-code', VERSION)
    const mcp = read(project.root, '.mcp.json')

    const drawn = await rerun(project, ['--agents', 'codex'], {
      ...asked,
      answers: { [SETUP_MENU_QUESTION]: [] },
    })
    const result = await rerun(project, ['--agents', 'codex', '--yes', '--json'], { plain: true })

    expect(drawn.exit, drawn.stderr).toBe(0)
    expect(agentsQuestionOf(drawn.entries)?.text ?? 'no question').toBe('no question')
    expect(menuOf(drawn.entries)?.labels[1] ?? 'no menu').toBe('skills     Codex not set up')
    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.agents).toEqual(['codex'])
    expect(existsSync(join(project.root, CODEX_ALPHA))).toBe(true)
    expect(read(project.root, '.mcp.json')).toBe(mcp)
  })

  it('refuses an unknown --agents value with one line, exit 2, drawing nothing', async () => {
    const project = await initializedProjectWithAgent('rerun-agents-bogus', 'claude-code', VERSION)

    const result = await rerun(project, ['--agents', 'bogus'], asked)

    expect(result.exit).toBe(2)
    expect(refusalLines(result.stderr)).toEqual([
      'Unknown coding agent "bogus". Use claude-code, codex, all or none.',
    ])
    expect(result.entries).toEqual([])
  })

  it('--yes keeps the manifest agents and asks nothing', async () => {
    const project = await initializedProjectWithAgent('rerun-agents-yes', 'codex', VERSION)

    const result = await rerun(project, ['--yes'], asked)
    const json = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect(agentsQuestionOf(result.entries)?.text ?? 'no question').toBe('no question')
    expect((JSON.parse(json.stdout) as InitDocument).agents).toEqual(['codex'])
  })

  it('--setup runs its rows over the agents the question chose', async () => {
    const project = await initializedProjectWithAgent('rerun-agents-setup', 'claude-code', VERSION)

    const result = await rerun(project, ['--setup', 'mcp'], {
      ...asked,
      answers: { [AGENTS_QUESTION]: ['claude-code', 'codex'] },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(agentsQuestionOf(result.entries)?.initialValues ?? 'no question').toEqual([
      'claude-code',
    ])
    expect(menuOf(result.entries)?.text ?? 'no menu').toBe('no menu')
    expect(read(project.root, CODEX_CONFIG)).toContain('[mcp_servers.agent-qa]')
    expect(existsSync(join(project.root, CODEX_ALPHA))).toBe(false)
  })
})
