import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { createSkillsCommand, listAgentQaSkills, resolveAgentQaSkillsDirectory } from '../commands/skills.js'

async function seedPackageRoot(withPackagedSkills = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-qa-skills-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'agent-qa' }))

  if (withPackagedSkills) {
    await mkdir(path.join(root, 'skills', 'agent-qa-authoring'), { recursive: true })
    await mkdir(path.join(root, 'skills', 'agent-qa-debug-fix'), { recursive: true })
    await writeFile(path.join(root, 'skills', 'agent-qa-authoring', 'SKILL.md'), [
      '---',
      'name: agent-qa-authoring',
      'description: Author tests safely',
      '---',
      '',
    ].join('\n'))
    await writeFile(path.join(root, 'skills', 'agent-qa-debug-fix', 'SKILL.md'), [
      '---',
      'name: agent-qa-debug-fix',
      'description: Debug failed runs',
      '---',
      '',
    ].join('\n'))
  }

  return root
}

async function runSkillsCommand(root: string, ...args: string[]) {
  let stdout = ''
  let stderr = ''
  const program = new Command()
  program.exitOverride()
  program.addCommand(createSkillsCommand({
    startDir: path.join(root, 'dist'),
    stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk); return true } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk); return true } },
  }))

  process.exitCode = 0
  await program.parseAsync(['node', 'agent-qa', 'skills', ...args])
  return { stdout, stderr, exitCode: process.exitCode }
}

describe('skills command', () => {
  const roots: string[] = []

  afterEach(async () => {
    process.exitCode = 0
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
    roots.length = 0
  })

  it('resolves packaged skills from the agent-qa package root', async () => {
    const root = await seedPackageRoot()
    roots.push(root)

    const resolved = resolveAgentQaSkillsDirectory(path.join(root, 'dist'))
    expect(resolved).toEqual({ path: path.join(root, 'skills'), source: 'package' })
    expect(listAgentQaSkills(resolved.path).map(skill => skill.name)).toEqual([
      'agent-qa-authoring',
      'agent-qa-debug-fix',
    ])
  })

  it('prints text output with the skills path and skill names', async () => {
    const root = await seedPackageRoot()
    roots.push(root)

    const result = await runSkillsCommand(root)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('agent-qa skills')
    expect(result.stdout).toContain(`Path: ${path.join(root, 'skills')}`)
    expect(result.stdout).toContain('agent-qa-authoring')
    expect(result.stdout).toContain('agent-qa-debug-fix')
    expect(result.stderr).toBe('')
  })

  it('prints JSON output for automation', async () => {
    const root = await seedPackageRoot()
    roots.push(root)

    const result = await runSkillsCommand(root, '--json')
    const payload = JSON.parse(result.stdout) as { path: string; source: string; skills: Array<{ name: string }> }

    expect(result.exitCode).toBe(0)
    expect(payload.path).toBe(path.join(root, 'skills'))
    expect(payload.source).toBe('package')
    expect(payload.skills.map(skill => skill.name)).toEqual(['agent-qa-authoring', 'agent-qa-debug-fix'])
  })

  it('reports missing skills without writing user files', async () => {
    const root = await seedPackageRoot(false)
    roots.push(root)

    const before = listAgentQaSkills(path.join(root, 'skills'))
    const result = await runSkillsCommand(root)
    const after = listAgentQaSkills(path.join(root, 'skills'))

    expect(before).toEqual([])
    expect(after).toEqual([])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('agent-qa skills not found')
  })
})
