// Each plugins entry's skill installs beside agent-qa's own, at the plugin's version.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { installAgentSetup, type CodingAgent } from '../commands/agent-setup.js'
import {
  cleanupTempProjects,
  fakeRunner,
  skillFolderFiles,
  tempProject,
  writeInstalledPackage,
  writeRemotePluginPackage,
} from './project-fixtures.js'

const VERSION = '1.4.2'
const MANIFEST = '.agents/agent-qa-skills.json'
const BOTH: CodingAgent[] = ['claude-code', 'codex']
const ROOTS = ['.claude/skills', '.agents/skills']
const KERNEL = { name: 'kernel', package: '@vostride/agent-qa-plugin-kernel' }
const ACME = { name: 'acme', package: 'acme-agent-qa-plugin' }

type Project = { root: string; home: string }

afterEach(() => {
  cleanupTempProjects()
})

function installAgentQa(root: string, version = VERSION): void {
  writeInstalledPackage(root, 'agent-qa', version, {
    packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
    files: { 'dist/cli.js': '', ...skillFolderFiles('agent-qa-alpha') },
  })
}

function pluginSkill(name: string, extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    'skill/SKILL.md': [
      '---',
      `name: ${name}`,
      `description: Use when a test runs through the ${name} plugin.`,
      '---',
      '',
      `# ${name}`,
      '',
      'The plugin body stays as it is.',
      '',
    ].join('\n'),
  }
  for (const [path, content] of Object.entries(extra)) files[`skill/${path}`] = content
  return files
}

function installKernel(root: string, version = VERSION): string {
  return writeRemotePluginPackage(root, KERNEL.package, version, {
    files: pluginSkill('agent-qa-plugin-kernel', {
      'references/setup.md': '# Setup\n\nKernel setup steps.\n',
    }),
  })
}

function installAcme(root: string): string {
  return writeRemotePluginPackage(root, ACME.package, '2.1.0', {
    files: pluginSkill('acme-cloud-browsers'),
  })
}

function writeConfig(root: string, plugins: readonly { name: string; package: string }[]): void {
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
      ...(plugins.length === 0 ? [] : ['plugins:']),
      ...plugins.flatMap((plugin) => [
        `  - name: ${plugin.name}`,
        `    package: '${plugin.package}'`,
      ]),
      '',
    ].join('\n'),
  )
}

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text)
  if (match === null) throw new Error('no frontmatter')
  return parse(match[1] ?? '') as Record<string, unknown>
}

function manifestPaths(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf-8')) as {
    files: { path: string }[]
  }
  return manifest.files.map((file) => file.path)
}

async function setup(project: Project, agents: CodingAgent[] = BOTH) {
  return await installAgentSetup({
    projectDir: project.root,
    agents,
    host: { cwd: project.root, homedir: project.home, env: {}, run: fakeRunner() },
  })
}

function outcomeOf(result: { files: { path: string; outcome: string }[] }, path: string) {
  return result.files.find((file) => file.path === path)?.outcome
}

describe('installing the skills of listed plugins', () => {
  it("writes a listed plugin's skill under both agents' skills folders beside agent-qa's own", async () => {
    const project = tempProject('plugin-skill-both')
    installAgentQa(project.root)
    installKernel(project.root)
    writeConfig(project.root, [KERNEL])

    const result = await setup(project)

    expect(result.parts.skills).toEqual({ outcome: 'done' })
    const expected = ROOTS.flatMap((root) => [
      `${root}/agent-qa-alpha/SKILL.md`,
      `${root}/agent-qa-plugin-kernel/SKILL.md`,
      `${root}/agent-qa-plugin-kernel/references/setup.md`,
    ]).sort()
    expect(result.files.map((file) => file.path).sort()).toEqual(expected)
    expect(result.files.every((file) => file.outcome === 'created')).toBe(true)
    expect(manifestPaths(project.root)).toEqual(expected)
  })

  it("stamps the plugin's SKILL.md with its folder name and the plugin's version and copies the rest byte for byte", async () => {
    const project = tempProject('plugin-skill-stamp')
    installAgentQa(project.root)
    const packageDir = installKernel(project.root)
    writeConfig(project.root, [KERNEL])

    await setup(project)

    for (const root of ROOTS) {
      const folder = join(project.root, root, 'agent-qa-plugin-kernel')
      const installed = readFileSync(join(folder, 'SKILL.md'), 'utf-8')
      const data = frontmatter(installed)
      expect(data.name).toBe('agent-qa-plugin-kernel')
      expect((data.metadata as Record<string, unknown>).version).toBe(VERSION)
      expect(installed).toContain(`version: "${VERSION}"`)
      expect(installed.endsWith('The plugin body stays as it is.\n')).toBe(true)
      expect(readFileSync(join(folder, 'references/setup.md'))).toEqual(
        readFileSync(join(packageDir, 'skill/references/setup.md')),
      )
    }
  })

  it("names a third-party plugin's skill after its entry and stamps the third-party package's version", async () => {
    const project = tempProject('plugin-skill-third-party')
    installAgentQa(project.root)
    installAcme(project.root)
    writeConfig(project.root, [ACME])

    await setup(project, ['claude-code'])

    expect(existsSync(join(project.root, '.claude/skills/acme-cloud-browsers'))).toBe(false)
    const installed = readFileSync(
      join(project.root, '.claude/skills/agent-qa-plugin-acme/SKILL.md'),
      'utf-8',
    )
    const data = frontmatter(installed)
    expect(data.name).toBe('agent-qa-plugin-acme')
    expect((data.metadata as Record<string, unknown>).version).toBe('2.1.0')
    expect(installed).toContain('version: "2.1.0"')
  })

  it("removes a plugin's skill folders and records when its entry leaves plugins and keeps the others", async () => {
    const project = tempProject('plugin-skill-removed')
    installAgentQa(project.root)
    installKernel(project.root)
    installAcme(project.root)
    writeConfig(project.root, [KERNEL, ACME])
    await setup(project)

    writeConfig(project.root, [ACME])
    const result = await setup(project)

    for (const root of ROOTS) {
      expect(outcomeOf(result, `${root}/agent-qa-plugin-kernel/SKILL.md`)).toBe('removed')
      expect(outcomeOf(result, `${root}/agent-qa-plugin-kernel/references/setup.md`)).toBe(
        'removed',
      )
      expect(existsSync(join(project.root, root, 'agent-qa-plugin-kernel'))).toBe(false)
      expect(outcomeOf(result, `${root}/agent-qa-plugin-acme/SKILL.md`)).toBe('unchanged')
      expect(existsSync(join(project.root, root, 'agent-qa-plugin-acme/SKILL.md'))).toBe(true)
    }
    const paths = manifestPaths(project.root)
    expect(paths.some((path) => path.includes('/agent-qa-plugin-kernel/'))).toBe(false)
    expect(paths.filter((path) => path.includes('/agent-qa-plugin-acme/'))).toEqual(
      ROOTS.map((root) => `${root}/agent-qa-plugin-acme/SKILL.md`).sort(),
    )
  })

  it("installs agent-qa's skills and no plugin skill when the project has no config", async () => {
    const project = tempProject('plugin-skill-no-config')
    installAgentQa(project.root)
    installKernel(project.root)

    const result = await setup(project)

    expect(result.parts.skills).toEqual({ outcome: 'done' })
    expect(result.notes).toEqual([])
    expect(result.files.map((file) => file.path).sort()).toEqual(
      ROOTS.map((root) => `${root}/agent-qa-alpha/SKILL.md`).sort(),
    )
  })
})
