// The installer copies agent-qa's skills into Claude Code's and Codex's folders and records them.
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  type FakeRunner,
} from './project-fixtures.js'

const VERSION = '1.4.2'
const MANIFEST = '.agents/agent-qa-skills.json'
const ALPHA_EXTRA = {
  'agents/openai.yaml': 'interface:\n  display_name: Alpha\n',
  'references/notes.md': '# Notes\n\nAlpha reference.\n',
}
const BOTH: CodingAgent[] = ['claude-code', 'codex']

afterEach(() => {
  cleanupTempProjects()
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function installAgentQa(
  root: string,
  version: string,
  skills: Record<string, string> = {
    ...skillFolderFiles('agent-qa-alpha', ALPHA_EXTRA),
    ...skillFolderFiles('agent-qa-beta'),
  },
): string {
  return join(
    writeInstalledPackage(root, 'agent-qa', version, {
      packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
      files: { 'dist/cli.js': '', ...skills },
    }),
    '..',
  )
}

function snapshot(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const key = prefix === '' ? name : `${prefix}/${name}`
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) out[key] = 'symlink'
    else if (stat.isDirectory()) {
      out[key] = 'dir'
      Object.assign(out, snapshot(path, key))
    } else out[key] = sha256(readFileSync(path))
  }
  return out
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text)
  if (match === null) throw new Error('no frontmatter')
  return {
    data: parse(match[1] ?? '') as Record<string, unknown>,
    body: text.slice(match[0].length),
  }
}

interface Manifest {
  format: number
  version: string
  agents: string[]
  files: { path: string; sha256: string }[]
  entries: unknown[]
}

function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, MANIFEST), 'utf-8')) as Manifest
}

async function setup(
  project: { root: string; home: string },
  agents: CodingAgent[],
  runner: FakeRunner = fakeRunner(),
  runningPackageDir?: string,
) {
  return await installAgentSetup({
    projectDir: project.root,
    agents,
    parts: ['skills'],
    host: {
      cwd: project.root,
      homedir: project.home,
      env: {},
      run: runner,
      ...(runningPackageDir === undefined ? {} : { runningPackageDir }),
    },
  })
}

const ALPHA_FILES = ['SKILL.md', 'agents/openai.yaml', 'references/notes.md']

describe('installing agent-qa skills into a project', () => {
  it('copies every skill file of the installed agent-qa to both agents and reports them created', async () => {
    const project = tempProject('setup-both')
    installAgentQa(project.root, VERSION)
    const runner = fakeRunner()

    const result = await setup(project, BOTH, runner)

    expect(result.source).toBe('project')
    expect(result.version).toBe(VERSION)
    expect(result.parts.skills).toEqual({ outcome: 'done' })
    const expected = ['.agents/skills', '.claude/skills'].flatMap((root) => [
      ...ALPHA_FILES.map((file) => `${root}/agent-qa-alpha/${file}`),
      `${root}/agent-qa-beta/SKILL.md`,
    ])
    expect(result.files.map((file) => file.path).sort()).toEqual(expected.sort())
    expect(result.files.every((file) => file.outcome === 'created')).toBe(true)
    for (const path of expected) expect(existsSync(join(project.root, path))).toBe(true)
    expect(runner.calls).toEqual([])
  })

  it('stamps each SKILL.md with the installed version and copies every other file byte for byte', async () => {
    const project = tempProject('setup-stamp')
    const packageDir = installAgentQa(project.root, VERSION)

    await setup(project, BOTH)

    for (const root of ['.claude/skills', '.agents/skills']) {
      for (const skill of ['agent-qa-alpha', 'agent-qa-beta']) {
        const source = frontmatter(
          readFileSync(join(packageDir, 'skills', skill, 'SKILL.md'), 'utf-8'),
        )
        const installedText = readFileSync(join(project.root, root, skill, 'SKILL.md'), 'utf-8')
        const installed = frontmatter(installedText)
        const metadata = installed.data.metadata as Record<string, unknown>
        expect(metadata.version).toBe(VERSION)
        expect(installedText).toContain(`version: "${VERSION}"`)
        expect(metadata['short-description']).toBe(
          (source.data.metadata as Record<string, unknown>)['short-description'],
        )
        expect(installed.data.name).toBe(source.data.name)
        expect(installed.data.description).toBe(source.data.description)
        expect(Object.keys(installed.data).sort()).toEqual(Object.keys(source.data).sort())
        expect(installed.body).toBe(source.body)
      }
      for (const file of ['agents/openai.yaml', 'references/notes.md']) {
        expect(readFileSync(join(project.root, root, 'agent-qa-alpha', file))).toEqual(
          readFileSync(join(packageDir, 'skills', 'agent-qa-alpha', file)),
        )
      }
    }
  })

  it('records every written file with the hash of its bytes on disk in the manifest', async () => {
    const project = tempProject('setup-manifest')
    installAgentQa(project.root, VERSION)

    const result = await setup(project, BOTH)

    const manifest = readManifest(project.root)
    expect(manifest.format).toBe(1)
    expect(manifest.version).toBe(VERSION)
    expect(manifest.agents).toEqual(['claude-code', 'codex'])
    expect(manifest.entries).toEqual([])
    const paths = manifest.files.map((file) => file.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toEqual(result.files.map((file) => file.path).sort())
    for (const file of manifest.files) {
      expect(file.sha256).toBe(sha256(readFileSync(join(project.root, file.path))))
    }
    expect(readFileSync(join(project.root, MANIFEST), 'utf-8')).toMatch(
      /^\{\n {2}"format": 1,[\s\S]*\}\n$/u,
    )
  })

  it('creates no .claude folder when installing for Codex alone', async () => {
    const project = tempProject('setup-codex')
    installAgentQa(project.root, VERSION)

    const result = await setup(project, ['codex'])

    expect(existsSync(join(project.root, '.claude'))).toBe(false)
    expect(result.agents).toEqual(['codex'])
    expect(result.files.every((file) => file.path.startsWith('.agents/skills/'))).toBe(true)
    expect(readManifest(project.root).agents).toEqual(['codex'])
  })

  it("takes the running agent-qa's skills and says so when the project has no agent-qa installed", async () => {
    const project = tempProject('setup-running')
    const running = tempProject('setup-running-package').root
    writeFileSync(
      join(running, 'package.json'),
      `${JSON.stringify({ name: 'agent-qa', version: '2.0.1' })}\n`,
    )
    for (const [path, content] of Object.entries(skillFolderFiles('agent-qa-gamma'))) {
      mkdirSync(join(running, path, '..'), { recursive: true })
      writeFileSync(join(running, path), content)
    }

    const result = await setup(project, ['claude-code'], fakeRunner(), running)

    expect(result.source).toBe('running')
    expect(result.version).toBe('2.0.1')
    expect(result.notes).toEqual([
      'agent-qa is not installed in the project, so the skills come from the running agent-qa 2.0.1.',
    ])
    const installed = readFileSync(
      join(project.root, '.claude/skills/agent-qa-gamma/SKILL.md'),
      'utf-8',
    )
    expect((frontmatter(installed).data.metadata as Record<string, unknown>).version).toBe('2.0.1')
  })

  it('writes nothing outside the project folder and nothing in it but the skills and the manifest', async () => {
    const project = tempProject('setup-confined')
    installAgentQa(project.root, VERSION)
    const before = snapshot(project.root)

    await setup(project, BOTH)

    const after = snapshot(project.root)
    const added = Object.keys(after).filter((path) => !(path in before))
    const insideAgentFolders = (path: string) =>
      ['.claude', '.agents'].some((folder) => path === folder || path.startsWith(`${folder}/`))
    expect(added.every(insideAgentFolders)).toBe(true)
    for (const [path, value] of Object.entries(before)) expect(after[path]).toBe(value)
    expect(readdirSync(project.home)).toEqual([])
  })
})

function shipOnly(root: string, version: string, skills: Record<string, string>): void {
  rmSync(join(root, 'node_modules', 'agent-qa'), { recursive: true, force: true })
  installAgentQa(root, version, skills)
}

function outcomeOf(result: { files: { path: string; outcome: string }[] }, path: string) {
  return result.files.find((file) => file.path === path)?.outcome
}

describe('reinstalling agent-qa skills', () => {
  it("writes agent-qa's copy over an edited file and names it as replaced", async () => {
    const project = tempProject('reinstall-edit')
    installAgentQa(project.root, VERSION)
    await setup(project, BOTH)
    const edited = '.claude/skills/agent-qa-alpha/SKILL.md'
    const original = readFileSync(join(project.root, edited))
    writeFileSync(join(project.root, edited), 'my own version\n')

    const result = await setup(project, BOTH)

    expect(outcomeOf(result, edited)).toBe('replaced')
    expect(result.notes).toContain(`Replaced your edit: ${edited}`)
    expect(readFileSync(join(project.root, edited))).toEqual(original)
    const record = readManifest(project.root).files.find((file) => file.path === edited)
    expect(record?.sha256).toBe(sha256(original))
  })

  it('restores a deleted skill folder and leaves the untouched files unchanged', async () => {
    const project = tempProject('reinstall-restore')
    installAgentQa(project.root, VERSION)
    await setup(project, BOTH)
    rmSync(join(project.root, '.agents/skills/agent-qa-beta'), { recursive: true })

    const result = await setup(project, BOTH)

    expect(outcomeOf(result, '.agents/skills/agent-qa-beta/SKILL.md')).toBe('created')
    expect(existsSync(join(project.root, '.agents/skills/agent-qa-beta/SKILL.md'))).toBe(true)
    const others = result.files.filter(
      (file) => !file.path.startsWith('.agents/skills/agent-qa-beta/'),
    )
    expect(others.every((file) => file.outcome === 'unchanged')).toBe(true)
    expect(result.notes).toEqual([])
  })

  it("updates an unedited file when the package's copy changed", async () => {
    const project = tempProject('reinstall-update')
    installAgentQa(project.root, VERSION)
    await setup(project, BOTH)
    shipOnly(project.root, '1.5.0', {
      ...skillFolderFiles('agent-qa-alpha', {
        ...ALPHA_EXTRA,
        'references/notes.md': '# Notes\n\nA newer reference.\n',
      }),
      ...skillFolderFiles('agent-qa-beta'),
    })

    const result = await setup(project, BOTH)

    expect(outcomeOf(result, '.claude/skills/agent-qa-alpha/SKILL.md')).toBe('updated')
    expect(outcomeOf(result, '.claude/skills/agent-qa-alpha/references/notes.md')).toBe('updated')
    expect(outcomeOf(result, '.claude/skills/agent-qa-alpha/agents/openai.yaml')).toBe('unchanged')
    expect(result.files.some((file) => file.outcome === 'replaced')).toBe(false)
    expect(readManifest(project.root).version).toBe('1.5.0')
    const installed = readFileSync(
      join(project.root, '.agents/skills/agent-qa-beta/SKILL.md'),
      'utf-8',
    )
    expect((frontmatter(installed).data.metadata as Record<string, unknown>).version).toBe('1.5.0')
  })

  it('removes the files and emptied folders of a skill the package no longer ships', async () => {
    const project = tempProject('reinstall-drop')
    installAgentQa(project.root, VERSION)
    await setup(project, BOTH)
    shipOnly(project.root, VERSION, skillFolderFiles('agent-qa-alpha', ALPHA_EXTRA))

    const result = await setup(project, BOTH)

    for (const root of ['.claude/skills', '.agents/skills']) {
      expect(outcomeOf(result, `${root}/agent-qa-beta/SKILL.md`)).toBe('removed')
      expect(existsSync(join(project.root, root, 'agent-qa-beta'))).toBe(false)
      expect(existsSync(join(project.root, root))).toBe(true)
    }
    const paths = readManifest(project.root).files.map((file) => file.path)
    expect(paths.some((path) => path.includes('/agent-qa-beta/'))).toBe(false)
    expect(paths).toHaveLength(6)
  })

  it("never writes or removes a person's own skill or a file they added inside an agent-qa skill", async () => {
    const project = tempProject('reinstall-unlisted')
    installAgentQa(project.root, VERSION)
    await setup(project, BOTH)
    const ownSkill = join(project.root, '.claude/skills/my-skill/SKILL.md')
    const ownNotes = join(project.root, '.claude/skills/agent-qa-alpha/my-notes.md')
    mkdirSync(join(ownSkill, '..'), { recursive: true })
    writeFileSync(ownSkill, '---\nname: my-skill\n---\nMine.\n')
    writeFileSync(ownNotes, 'my notes\n')

    await setup(project, BOTH)
    expect(readFileSync(ownSkill, 'utf-8')).toBe('---\nname: my-skill\n---\nMine.\n')
    expect(readFileSync(ownNotes, 'utf-8')).toBe('my notes\n')

    shipOnly(project.root, VERSION, skillFolderFiles('agent-qa-beta'))
    const result = await setup(project, BOTH)

    expect(outcomeOf(result, '.claude/skills/agent-qa-alpha/SKILL.md')).toBe('removed')
    expect(readFileSync(ownSkill, 'utf-8')).toBe('---\nname: my-skill\n---\nMine.\n')
    expect(readFileSync(ownNotes, 'utf-8')).toBe('my notes\n')
    expect(readdirSync(join(project.root, '.claude/skills/agent-qa-alpha'))).toEqual([
      'my-notes.md',
    ])
    expect(existsSync(join(project.root, '.agents/skills/agent-qa-alpha'))).toBe(false)
    const paths = readManifest(project.root).files.map((file) => file.path)
    expect(paths.some((path) => path.includes('my-'))).toBe(false)
  })

  it("adopts an unlisted file equal to agent-qa's copy and keeps and names one that differs", async () => {
    const reference = tempProject('adopt-reference')
    installAgentQa(reference.root, VERSION)
    await setup(reference, ['claude-code'])
    const project = tempProject('adopt')
    installAgentQa(project.root, VERSION)
    const same = '.claude/skills/agent-qa-alpha/SKILL.md'
    const different = '.claude/skills/agent-qa-beta/SKILL.md'
    mkdirSync(join(project.root, same, '..'), { recursive: true })
    mkdirSync(join(project.root, different, '..'), { recursive: true })
    writeFileSync(join(project.root, same), readFileSync(join(reference.root, same)))
    writeFileSync(join(project.root, different), 'not agent-qa\n')

    const result = await setup(project, ['claude-code'])

    expect(outcomeOf(result, same)).toBe('unchanged')
    expect(outcomeOf(result, different)).toBe('kept')
    expect(readFileSync(join(project.root, different), 'utf-8')).toBe('not agent-qa\n')
    expect(result.notes).toContain(
      `${different} exists and is not agent-qa's; remove it and run npx agent-qa init`,
    )
    const paths = readManifest(project.root).files.map((file) => file.path)
    expect(paths).toContain(same)
    expect(paths).not.toContain(different)
  })

  it("leaves the other agent's files and records alone when installing for one agent", async () => {
    const project = tempProject('reinstall-one-agent')
    installAgentQa(project.root, VERSION)
    await setup(project, BOTH)
    const codexRecords = readManifest(project.root).files.filter((file) =>
      file.path.startsWith('.agents/skills/'),
    )
    writeFileSync(join(project.root, '.agents/skills/agent-qa-beta/SKILL.md'), 'edited\n')
    const codexBefore = snapshot(join(project.root, '.agents/skills'))
    shipOnly(project.root, '1.5.0', skillFolderFiles('agent-qa-alpha', ALPHA_EXTRA))

    const result = await setup(project, ['claude-code'])

    expect(snapshot(join(project.root, '.agents/skills'))).toEqual(codexBefore)
    expect(result.files.every((file) => file.path.startsWith('.claude/skills/'))).toBe(true)
    const manifest = readManifest(project.root)
    expect(manifest.agents).toEqual(['claude-code', 'codex'])
    expect(manifest.files.filter((file) => file.path.startsWith('.agents/skills/'))).toEqual(
      codexRecords,
    )
  })

  const malformed: [string, string][] = [
    ['text that is not JSON', '{ "format": 1,'],
    [
      'another format',
      JSON.stringify({ format: 2, version: VERSION, agents: [], files: [], entries: [] }),
    ],
    ['an absolute path', manifestListing('/etc/passwd')],
    ['a path with a dot-dot segment', manifestListing('.claude/skills/agent-qa-alpha/../../../x')],
    ['a path with a backslash', manifestListing('.claude\\skills\\agent-qa-alpha\\SKILL.md')],
    [
      'a path outside the two skill folders',
      manifestListing('.codex/skills/agent-qa-alpha/SKILL.md'),
    ],
  ]

  it.each(malformed)('refuses a manifest holding %s and writes nothing', async (_label, text) => {
    const project = tempProject('malformed')
    installAgentQa(project.root, VERSION)
    mkdirSync(join(project.root, '.agents'))
    writeFileSync(join(project.root, MANIFEST), text)
    const before = snapshot(project.root)
    const runner = fakeRunner()

    await expect(setup(project, BOTH, runner)).rejects.toThrow(
      'Refusing malformed .agents/agent-qa-skills.json:',
    )

    expect(snapshot(project.root)).toEqual(before)
    expect(runner.calls).toEqual([])
  })

  it('refuses a symlinked .agents folder before writing anything', async () => {
    const project = tempProject('symlink-agents')
    const outside = tempProject('symlink-agents-outside').root
    installAgentQa(project.root, VERSION)
    symlinkSync(outside, join(project.root, '.agents'))
    const runner = fakeRunner()

    await expect(setup(project, BOTH, runner)).rejects.toThrow(/symbolic link/u)

    expect(readdirSync(outside)).toEqual(['.git'])
    expect(existsSync(join(project.root, '.claude'))).toBe(false)
    expect(runner.calls).toEqual([])
  })

  it('fails the skills part and writes nothing through a symlinked .claude folder', async () => {
    const project = tempProject('symlink-claude')
    const outside = tempProject('symlink-claude-outside').root
    installAgentQa(project.root, VERSION)
    symlinkSync(outside, join(project.root, '.claude'))
    const runner = fakeRunner()

    const result = await setup(project, BOTH, runner)

    expect(result.parts.skills?.outcome).toBe('failed')
    expect(result.parts.skills?.reason).toMatch(/symbolic link/u)
    expect(readdirSync(outside)).toEqual(['.git'])
    const paths = readManifest(project.root).files.map((file) => file.path)
    expect(paths.every((path) => path.startsWith('.agents/skills/'))).toBe(true)
    expect(runner.calls).toEqual([])
  })

  it('fails the skills part for a folder where a skill file goes and still writes the rest', async () => {
    const project = tempProject('folder-in-the-way')
    installAgentQa(project.root, VERSION)
    const blocked = '.claude/skills/agent-qa-alpha/SKILL.md'
    mkdirSync(join(project.root, blocked), { recursive: true })

    const result = await setup(project, BOTH)

    expect(result.parts.skills?.outcome).toBe('failed')
    expect(result.parts.skills?.reason).toContain('directory')
    expect(lstatSync(join(project.root, blocked)).isDirectory()).toBe(true)
    expect(existsSync(join(project.root, '.claude/skills/agent-qa-beta/SKILL.md'))).toBe(true)
    expect(existsSync(join(project.root, '.agents/skills/agent-qa-alpha/SKILL.md'))).toBe(true)
    const paths = readManifest(project.root).files.map((file) => file.path)
    expect(paths).not.toContain(blocked)
    expect(paths).toHaveLength(7)
  })
})

function manifestListing(path: string): string {
  return JSON.stringify({
    format: 1,
    version: VERSION,
    agents: ['claude-code'],
    files: [{ path, sha256: 'a'.repeat(64) }],
    entries: [],
  })
}
