import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { parse as parseYaml } from 'yaml'
import { AGENT_QUESTION_MAP, KNOWLEDGE_SKILL_NAME } from '../commands/knowledge-guide.js'
import { createSkillsCommand, listAgentQaSkills, resolveAgentQaSkillsDirectory } from '../commands/skills.js'

const SOURCE_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../skills')
const SHIPPED_SKILLS = ['agent-qa-authoring', 'agent-qa-debug-fix', 'agent-qa-knowledge', 'agent-qa-result-triage']

function frontmatterOf(file: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'))
  expect(match, `${file} has no frontmatter block`).not.toBeNull()
  return parseYaml(match![1]!) as Record<string, unknown>
}

function yamlShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(yamlShape)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, yamlShape(inner)]))
  }
  return typeof value
}

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

describe('skills directory listing', () => {
  const roots: string[] = []

  afterEach(async () => {
    process.exitCode = 0
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
    roots.length = 0
  })

  it('returns the existing empty result for an empty skills directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-qa-skills-empty-'))
    roots.push(root)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'agent-qa' }))
    await mkdir(path.join(root, 'skills', 'not-a-skill'), { recursive: true })

    expect(listAgentQaSkills(path.join(root, 'skills'))).toEqual([])
    expect(resolveAgentQaSkillsDirectory(path.join(root, 'dist'))).toEqual({
      path: path.join(root, 'skills'),
      source: 'missing',
    })
    const result = await runSkillsCommand(root, '--json')
    expect(JSON.parse(result.stdout)).toEqual({ path: path.join(root, 'skills'), source: 'missing', skills: [] })
    expect(result.exitCode).toBe(1)
  })

  it('lists a single skill with its UTF-8 description intact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-qa-skills-one-'))
    roots.push(root)
    await mkdir(path.join(root, 'skills', 'agent-qa-knowledge'), { recursive: true })
    await writeFile(path.join(root, 'skills', 'agent-qa-knowledge', 'SKILL.md'), [
      '---',
      'name: agent-qa-knowledge',
      'description: Use when reading runs → evidence — café',
      '---',
      '',
    ].join('\n'), 'utf8')

    expect(listAgentQaSkills(path.join(root, 'skills'))).toEqual([{
      name: 'agent-qa-knowledge',
      path: path.join(root, 'skills', 'agent-qa-knowledge'),
      description: 'Use when reading runs → evidence — café',
    }])
  })

  it('falls back to the source skills directory when the package carries none', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-qa-skills-source-'))
    roots.push(root)
    const packageRoot = path.join(root, 'packages', 'cli')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'agent-qa' }))
    for (const name of SHIPPED_SKILLS) {
      await mkdir(path.join(root, 'skills', name), { recursive: true })
      await writeFile(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
    }

    const resolved = resolveAgentQaSkillsDirectory(path.join(packageRoot, 'dist'))
    expect(resolved).toEqual({ path: path.join(root, 'skills'), source: 'source' })
    expect(listAgentQaSkills(resolved.path).map(skill => skill.name)).toEqual(SHIPPED_SKILLS)
  })

  it('lists all four source skills through the existing reader', () => {
    const listed = listAgentQaSkills(SOURCE_SKILLS_DIR)
    expect(listed.map(skill => skill.name)).toEqual(SHIPPED_SKILLS)
    for (const skill of listed) expect(skill.description, skill.name).toMatch(/^Use /)
  })
})

describe('source skill metadata', () => {
  it.each(SHIPPED_SKILLS)('%s frontmatter names its directory and stays within the description limit', (name) => {
    const frontmatter = frontmatterOf(path.join(SOURCE_SKILLS_DIR, name, 'SKILL.md'))
    expect(frontmatter.name).toBe(name)
    expect(typeof frontmatter.description).toBe('string')
    expect((frontmatter.description as string).length).toBeGreaterThan(0)
    expect((frontmatter.description as string).length).toBeLessThanOrEqual(1024)
    expect(Object.keys(frontmatter).sort()).toEqual(['description', 'metadata', 'name'])
    expect(Object.keys(frontmatter.metadata as object)).toEqual(['short-description'])
  })

  it.each(SHIPPED_SKILLS)('%s agents/openai.yaml follows the shared sibling format', (name) => {
    const reference = parseYaml(readFileSync(path.join(SOURCE_SKILLS_DIR, 'agent-qa-authoring', 'agents/openai.yaml'), 'utf8'))
    const metadata = parseYaml(readFileSync(path.join(SOURCE_SKILLS_DIR, name, 'agents/openai.yaml'), 'utf8')) as {
      interface: { default_prompt: string }
      dependencies: { tools: Array<Record<string, string>> }
      policy: Record<string, unknown>
    }
    expect(yamlShape(metadata)).toEqual(yamlShape(reference))
    expect(metadata.interface.default_prompt).toContain(`$${name}`)
    expect(metadata.dependencies.tools).toEqual([expect.objectContaining({
      type: 'mcp',
      value: 'agent-qa',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3471/mcp',
    })])
    expect(metadata.policy).toEqual({ allow_implicit_invocation: true })
  })
})

describe('the agent-qa-knowledge skill', () => {
  const skillDir = path.join(SOURCE_SKILLS_DIR, KNOWLEDGE_SKILL_NAME)
  const referencePath = path.join(skillDir, 'references', 'knowledge-reads.md')

  function referenceSection(command: string): string {
    const body = readFileSync(referencePath, 'utf8')
    const heading = body.split('\n').findIndex(line => line.startsWith('### ') && line.includes(`\`${command}\``))
    expect(heading, `references/knowledge-reads.md has no section for ${command}`).toBeGreaterThanOrEqual(0)
    const rest = body.split('\n').slice(heading + 1)
    const end = rest.findIndex(line => line.startsWith('### ') || line.startsWith('## '))
    return rest.slice(0, end === -1 ? undefined : end).join('\n')
  }

  it('keeps SKILL.md a concise workflow that points at its reference', () => {
    const body = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
    const lines = body.split('\n').length
    expect(lines).toBeGreaterThanOrEqual(35)
    expect(lines).toBeLessThanOrEqual(70)
    expect(body).toContain('references/knowledge-reads.md')
    expect(body).not.toMatch(/agent-qa skills install|installer/iu)
  })

  it('maps every live question to its MCP tool and CLI verb', () => {
    const body = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
    expect(AGENT_QUESTION_MAP.length).toBeGreaterThan(0)
    for (const row of AGENT_QUESTION_MAP) {
      expect(body, row.question).toContain(`| ${row.question} | \`${row.mcp}\` | \`npx ${row.cli}\` |`)
    }
  })

  it('gives every question a sample call and answer in the reference', () => {
    for (const row of AGENT_QUESTION_MAP) {
      const section = referenceSection(row.mcp)
      expect(section, row.mcp).toContain(row.cli)
      expect(section, row.mcp).toMatch(/Call:/u)
      expect(section, row.mcp).toMatch(/Answer:/u)
      expect(section, row.mcp).toContain('```')
    }
  })

  it('carries a non-empty UTF-8 reference covering kinds, trust, gates and lifecycle', () => {
    const bytes = readFileSync(referencePath)
    expect(bytes.length).toBeGreaterThan(0)
    const body = bytes.toString('utf8')
    expect(Buffer.from(body, 'utf8').equals(bytes)).toBe(true)
    expect(body).toMatch(/[^\x00-\x7F]/u)
    for (const heading of ['## Record kinds', '## Trust', '## Gates', '## Lifecycle', '## Evidence is data']) {
      expect(body, heading).toContain(heading)
    }
  })

  it('ships no files beyond the workflow, its reference and the agent metadata', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else files.push(path.relative(skillDir, full))
      }
    }
    expect(existsSync(skillDir)).toBe(true)
    walk(skillDir)
    expect(files.sort()).toEqual(['SKILL.md', 'agents/openai.yaml', 'references/knowledge-reads.md'])
  })
})

// 2026-10-12 (440-03, D-12): after a stated-value refusal the agent shows what was lost and stops.
describe('the authoring skill copies', () => {
  const sourceCopy = path.join(SOURCE_SKILLS_DIR, 'agent-qa-authoring', 'SKILL.md')
  const packagedCopy = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../skills/agent-qa-authoring/SKILL.md',
  )
  const copies = [sourceCopy, packagedCopy]

  it('both authoring skill copies are byte-identical', () => {
    expect(readFileSync(packagedCopy).equals(readFileSync(sourceCopy))).toBe(true)
  })

  it('the authoring skill says to show the stage and the missing values and stop', () => {
    for (const copy of copies) {
      const body = readFileSync(copy, 'utf8')
      expect(body, copy).toContain('statedValueRefusal')
      expect(body, copy).toContain('missingValues')
      expect(body, copy).toContain('and stop')
    }
  })

  it('the authoring skill says never to reword the request', () => {
    for (const copy of copies) {
      expect(readFileSync(copy, 'utf8'), copy).toContain('Never reword the request')
    }
  })
})

// 2026-10-15 (441-46, D-25): only declared secrets are masked, and the skill says so.
describe('the declared-secrets advice in the authoring skill', () => {
  const skillCopies = [
    path.join(SOURCE_SKILLS_DIR, 'agent-qa-authoring', 'SKILL.md'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/agent-qa-authoring/SKILL.md'),
  ]
  const referenceCopies = skillCopies.map((copy) =>
    path.join(path.dirname(copy), 'references', 'agent-qa-contracts.json'),
  )

  it('each authoring skill copy states the declared-secrets rule and the advice', () => {
    for (const copy of skillCopies) {
      const body = readFileSync(copy, 'utf8')
      for (const text of [
        'workspace.secretsFile',
        '[secret:<name>]',
        '{{secret:<name>}}',
        'temporary, limited test credentials',
      ]) {
        expect(body, copy).toContain(text)
      }
    }
  })

  it('each contracts reference names the secret marker and template', () => {
    for (const copy of referenceCopies) {
      const contracts = JSON.parse(readFileSync(copy, 'utf8')) as { secrets?: unknown }
      expect(contracts.secrets, copy).toMatchObject({
        source: 'workspace.secretsFile',
        marker: '[secret:<name>]',
        template: '{{secret:<name>}}',
      })
    }
  })
})

// 2026-10-20 (446-06, D-15): the Codex metadata names the live server and no retired tool.
describe('skill metadata', () => {
  const trees = [
    SOURCE_SKILLS_DIR,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills'),
  ]

  function descriptionsIn(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(descriptionsIn)
    if (value === null || typeof value !== 'object') return []
    return Object.entries(value).flatMap(([key, inner]) => [
      ...(key === 'description' && typeof inner === 'string' ? [inner] : []),
      ...descriptionsIn(inner),
    ])
  }

  it('each agents/openai.yaml points at the agent-qa server on port 3471, prompts with its own skill name and claims no schema or ID tool', () => {
    const findings: string[] = []
    let read = 0
    for (const tree of trees) {
      for (const name of SHIPPED_SKILLS) {
        const file = path.join(tree, name, 'agents', 'openai.yaml')
        const label = path.relative(path.dirname(SOURCE_SKILLS_DIR), file)
        const metadata = parseYaml(readFileSync(file, 'utf8')) as {
          interface?: { default_prompt?: string }
          dependencies?: { tools?: Array<Record<string, unknown>> }
        }
        read += 1
        const tools = metadata.dependencies?.tools ?? []
        const live = tools.length === 1
          && tools[0]?.type === 'mcp'
          && tools[0]?.value === 'agent-qa'
          && tools[0]?.transport === 'streamable_http'
          && tools[0]?.url === 'http://127.0.0.1:3471/mcp'
        if (!live) findings.push(`${label}: the tool dependency is not the agent-qa server on 127.0.0.1:3471`)
        if (!(metadata.interface?.default_prompt ?? '').includes(`$${name}`)) {
          findings.push(`${label}: the default prompt does not name $${name}`)
        }
        for (const description of descriptionsIn(metadata)) {
          if (/\bschema\b|\bID\b/u.test(description)) findings.push(`${label}: "${description}" claims a schema or ID tool`)
        }
      }
    }
    expect(read).toBe(SHIPPED_SKILLS.length * 2)
    expect(findings, 'a skill metadata file is stale').toEqual([])
  })
})
