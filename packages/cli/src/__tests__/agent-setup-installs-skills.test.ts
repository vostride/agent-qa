// The installer copies agent-qa's skills into Claude Code's and Codex's folders and records them.
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
