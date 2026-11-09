// A re-run checks a coding agent's setup with a dry run of the installer and repairs it.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it } from 'vitest'

import type { InitDocument } from '../commands/init-document.js'
import { SETUP_MENU_QUESTION } from '../commands/init-rerun.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import { cleanupTempProjects } from './project-fixtures.js'
import {
  editSkillFile,
  initializedProject,
  initializedProjectWithAgent,
  rerun,
} from './rerun-fixtures.js'

const VERSION = getAgentQaVersion().trim()
const ALPHA = '.claude/skills/agent-qa-alpha/SKILL.md'
const asked = { hooks: { isTTY: true } }

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

describe("a re-run's skills row", () => {
  it("labels one edited skill file as differing from agent-qa's copy and pre-checks it", async () => {
    const project = await initializedProjectWithAgent('rerun-skills-edited', 'claude-code', VERSION)
    editSkillFile(project, ALPHA)

    const menu = await rerun(project, [], { ...asked, answers: { [SETUP_MENU_QUESTION]: [] } })

    expect(menu.exit, menu.stderr).toBe(0)
    expect(menuOf(menu.entries)?.labels ?? 'no menu').toEqual([
      `skills     1 file differs from agent-qa ${VERSION}'s copy`,
      'gitignore  current',
    ])
    expect(menuOf(menu.entries)?.initialValues ?? 'no menu').toEqual(['skills'])
  })

  it("with --yes puts agent-qa's copy back and names the replaced file in the step line", async () => {
    const project = await initializedProjectWithAgent('rerun-skills-restore', 'claude-code', VERSION)
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
    const project = await initializedProjectWithAgent('rerun-skills-deleted', 'claude-code', VERSION)
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
      `skills     current (${VERSION})`,
      'gitignore  current',
    ])
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').toEqual([])
    expect(result.entries).toContainEqual({ kind: 'skipped', text: 'skills: current' })
  })

  it('with no coding agent shows no skills row and records it hidden in the document', async () => {
    const project = await initializedProject('rerun-skills-no-agent')

    const menu = await rerun(project, [], asked)
    const result = await rerun(project, ['--json'], { plain: true })

    expect(menuOf(menu.entries)?.labels ?? 'no menu').toEqual(['gitignore  current'])
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
