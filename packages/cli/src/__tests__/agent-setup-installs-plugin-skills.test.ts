// Each plugins entry's skill installs beside agent-qa's own, at the plugin's version.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
  writeConfigText(root, [
    ...(plugins.length === 0 ? [] : ['plugins:']),
    ...plugins.flatMap((plugin) => [
      `  - name: ${plugin.name}`,
      `    package: '${plugin.package}'`,
    ]),
  ])
}

function writeConfigText(root: string, lines: readonly string[]): void {
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
      ...lines,
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
    parts: ['skills'],
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

function pluginFolders(root: string): string[] {
  return ROOTS.filter((skills) => existsSync(join(root, skills))).flatMap((skills) =>
    readdirSync(join(root, skills))
      .filter((name) => name.startsWith('agent-qa-plugin-'))
      .map((name) => `${skills}/${name}`),
  )
}

describe('the plugin skills the installer refuses', () => {
  it('installs nothing of a skill path that leaves its package and says so in one note', async () => {
    const project = tempProject('plugin-skill-dot-dot')
    installAgentQa(project.root)
    writeRemotePluginPackage(project.root, ACME.package, '2.1.0', {
      manifest: { skill: '../outside' },
    })
    const outside = join(project.root, 'node_modules/outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: Outside.\n---\n')
    writeConfig(project.root, [ACME])

    const result = await setup(project)

    expect(pluginFolders(project.root)).toEqual([])
    expect(result.notes).toEqual([
      expect.stringMatching(
        /^Plugin entry acme names acme-agent-qa-plugin, .*skill resolves outside the package.* Its skill is not installed\.$/u,
      ),
    ])
  })

  it('installs nothing of a skill folder that is a symlink out of its package', async () => {
    const project = tempProject('plugin-skill-symlinked-folder')
    const outside = tempProject('plugin-skill-symlinked-folder-outside').root
    installAgentQa(project.root)
    const packageDir = writeRemotePluginPackage(project.root, ACME.package, '2.1.0')
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: Outside.\n---\n')
    symlinkSync(outside, join(packageDir, 'skill'))
    writeConfig(project.root, [ACME])

    const result = await setup(project)

    expect(pluginFolders(project.root)).toEqual([])
    expect(result.notes).toEqual([
      expect.stringMatching(
        /^Plugin entry acme .*skill resolves outside the package.* Its skill is not installed\.$/u,
      ),
    ])
  })

  it('copies the regular files of a skill folder and not a file symlinked out of the package', async () => {
    const project = tempProject('plugin-skill-symlinked-file')
    const outside = tempProject('plugin-skill-symlinked-file-outside').root
    installAgentQa(project.root)
    const packageDir = installKernel(project.root)
    writeFileSync(join(outside, 'secret.txt'), 'host file\n')
    symlinkSync(join(outside, 'secret.txt'), join(packageDir, 'skill/references/secret.txt'))
    writeConfig(project.root, [KERNEL])

    const result = await setup(project, ['claude-code'])

    const folder = join(project.root, '.claude/skills/agent-qa-plugin-kernel')
    expect(existsSync(join(folder, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(folder, 'references/setup.md'))).toBe(true)
    expect(existsSync(join(folder, 'references/secret.txt'))).toBe(false)
    expect(result.files.some((file) => file.path.endsWith('secret.txt'))).toBe(false)
  })

  const invalidNames: [string, string][] = [
    ['a dot', 'kernel.eu'],
    ['a double hyphen', 'a--b'],
    ['a prefixed folder past 64 characters', 'x'.repeat(49)],
  ]

  it.each(invalidNames)(
    'skips an entry whose name has %s with one note naming the skill name rule',
    async (_label, name) => {
      const project = tempProject('plugin-skill-bad-name')
      installAgentQa(project.root)
      installKernel(project.root)
      writeConfig(project.root, [{ name, package: KERNEL.package }])

      const result = await setup(project)

      expect(pluginFolders(project.root)).toEqual([])
      expect(result.notes).toEqual([
        `Plugin ${name}: agent-qa-plugin-${name} is not a valid skill name (lowercase letters, ` +
          'digits and single hyphens, at most 64 characters), so its skill is not installed.',
      ])
    },
  )

  it("skips an uninstalled, a mismatched and a malformed plugin each with the resolver's reason", async () => {
    const project = tempProject('plugin-skill-unresolved')
    installAgentQa(project.root)
    installKernel(project.root, '1.0.0')
    writeRemotePluginPackage(project.root, ACME.package, '2.1.0', {
      manifest: { serves: [] },
      files: pluginSkill('acme'),
    })
    writeConfig(project.root, [
      { name: 'steel', package: '@vostride/agent-qa-plugin-steel' },
      KERNEL,
      ACME,
    ])

    const result = await setup(project)

    expect(pluginFolders(project.root)).toEqual([])
    expect(result.notes).toEqual([
      expect.stringMatching(
        /^Plugin entry steel names @vostride\/agent-qa-plugin-steel, which is not installed\. Run .+\. Its skill is not installed\.$/u,
      ),
      expect.stringMatching(
        /^Plugin entry kernel names @vostride\/agent-qa-plugin-kernel at 1\.0\.0, and agent-qa is at 1\.4\.2\. Run .+\. Its skill is not installed\.$/u,
      ),
      expect.stringMatching(
        /^Plugin entry acme names acme-agent-qa-plugin, whose package\.json has no valid agent-qa plugin manifest .+ Its skill is not installed\.$/u,
      ),
    ])
  })

  it("leaves a listed plugin's installed skill as it is while its package is not installed", async () => {
    const project = tempProject('plugin-skill-held')
    installAgentQa(project.root)
    installKernel(project.root)
    writeConfig(project.root, [KERNEL])
    await setup(project)
    const before = manifestPaths(project.root)
    rmSync(join(project.root, 'node_modules/@vostride'), { recursive: true })

    const result = await setup(project)

    expect(result.files.filter((file) => file.path.includes('agent-qa-plugin-'))).toEqual([])
    expect(pluginFolders(project.root).sort()).toEqual(
      ROOTS.map((root) => `${root}/agent-qa-plugin-kernel`).sort(),
    )
    expect(manifestPaths(project.root)).toEqual(before)
    expect(result.notes).toEqual([expect.stringMatching(/^Plugin entry kernel .* not installed/u)])
  })

  it("keeps and names an unlisted plugin skill file that differs from agent-qa's copy", async () => {
    const project = tempProject('plugin-skill-unlisted')
    installAgentQa(project.root)
    installKernel(project.root)
    writeConfig(project.root, [KERNEL])
    const mine = '.claude/skills/agent-qa-plugin-kernel/SKILL.md'
    mkdirSync(join(project.root, mine, '..'), { recursive: true })
    writeFileSync(join(project.root, mine), 'my own kernel notes\n')

    const result = await setup(project, ['claude-code'])

    expect(outcomeOf(result, mine)).toBe('kept')
    expect(readFileSync(join(project.root, mine), 'utf-8')).toBe('my own kernel notes\n')
    expect(manifestPaths(project.root)).not.toContain(mine)
    expect(result.notes).toEqual([
      `${mine} exists and is not agent-qa's; remove it and run npx agent-qa init`,
    ])
  })

  it("installs agent-qa's skills and leaves the listed plugin skill files alone when the config does not load", async () => {
    const project = tempProject('plugin-skill-bad-config')
    installAgentQa(project.root)
    installKernel(project.root)
    writeConfig(project.root, [KERNEL])
    await setup(project)
    const before = JSON.parse(readFileSync(join(project.root, MANIFEST), 'utf-8')) as {
      files: { path: string; sha256: string }[]
    }
    const edited = join(project.root, '.agents/skills/agent-qa-plugin-kernel/references/setup.md')
    writeFileSync(edited, 'my edit\n')
    rmSync(join(project.root, '.claude/skills/agent-qa-alpha'), { recursive: true })
    writeConfigText(project.root, ['plugins:', '  - name: kernel'])

    const result = await setup(project)

    expect(outcomeOf(result, '.claude/skills/agent-qa-alpha/SKILL.md')).toBe('created')
    expect(result.files.filter((file) => file.path.includes('agent-qa-plugin-'))).toEqual([])
    expect(readFileSync(edited, 'utf-8')).toBe('my edit\n')
    expect(pluginFolders(project.root).sort()).toEqual(
      ROOTS.map((root) => `${root}/agent-qa-plugin-kernel`).sort(),
    )
    const after = JSON.parse(readFileSync(join(project.root, MANIFEST), 'utf-8')) as {
      files: { path: string; sha256: string }[]
    }
    expect(after.files).toEqual(before.files)
    expect(result.notes).toEqual([
      expect.stringMatching(
        /^Plugin skills were not updated: Config validation failed: plugins\.0[^\n]*\. Run npx agent-qa validate\.$/u,
      ),
    ])
  })
})
