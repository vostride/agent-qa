// Every skill asset resolves from the staged CLI tarball.

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { agentQaRoot } from './catalog.js'
import { cleanupTempRoots, trackTempRoot } from './spawned-chat.js'

const STAGE_BUDGET_MS = 600_000
const PACK_BUDGET_MS = 120_000
const MINIMUM_SKILLS = 4

interface PackedFile {
  readonly path: string
  readonly size: number
}

interface StageModule {
  readonly stagePublishPackages: (options: {
    rootDir: string
    targetVersion: string
    outputDir: string
  }) => Promise<unknown>
}

const scene: { files?: ReadonlyMap<string, number>; stagedCli?: string } = {}

function sorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function packEnv(cache: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_offline: 'true',
    npm_config_cache: cache,
    npm_config_logs_dir: join(cache, 'logs'),
  }
  delete env.npm_config_verify_deps_before_run
  return env
}

function packedFiles(packageDir: string): ReadonlyMap<string, number> {
  const cache = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-446-npm-cache-')))
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir,
    encoding: 'utf8',
    env: packEnv(cache),
    stdio: 'pipe',
  })
  const [report] = JSON.parse(output) as { files: PackedFile[] }[]
  if (report === undefined) throw new Error(`npm pack listed nothing in ${packageDir}`)
  return new Map(report.files.map((file) => [file.path, file.size]))
}

function packedSkillNames(files: ReadonlyMap<string, number>): readonly string[] {
  const names: string[] = []
  for (const path of files.keys()) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/u.exec(path)
    if (match?.[1] !== undefined) names.push(match[1])
  }
  return sorted(names)
}

function packedSkillFindings(
  files: ReadonlyMap<string, number>,
  skillsRoot: string,
): readonly string[] {
  const findings: string[] = []
  const names = packedSkillNames(files)
  if (names.length < MINIMUM_SKILLS) {
    findings.push(
      `only ${names.length} skill folders are listed under skills/, expected at least ${MINIMUM_SKILLS}`,
    )
  }
  const sizeFinding = (path: string, missing: string, empty: string): void => {
    const size = files.get(path)
    if (size === undefined) findings.push(missing)
    else if (size <= 0) findings.push(empty)
  }
  for (const name of names) {
    for (const fixed of ['SKILL.md', 'agents/openai.yaml']) {
      const path = `skills/${name}/${fixed}`
      sizeFinding(path, `${path} is missing`, `${path} is empty`)
    }
    const text = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8')
    for (const reference of sorted(text.match(/references\/[A-Za-z0-9._-]+/gu) ?? [])) {
      const subject = `skills/${name}/SKILL.md names ${reference}`
      const path = `skills/${name}/${reference}`
      sizeFinding(path, `${subject}, which is missing`, `${subject}, which is empty`)
    }
  }
  return sorted(findings)
}

function sourceSkillFolders(): readonly string[] {
  const root = join(agentQaRoot(), 'skills')
  return readdirSync(root)
    .filter((entry) => {
      const candidate = join(root, entry)
      return statSync(candidate).isDirectory() && existsSync(join(candidate, 'SKILL.md'))
    })
    .sort()
}

beforeAll(async () => {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  const rootDir = agentQaRoot()
  const stageUrl = pathToFileURL(join(rootDir, 'scripts', 'release', 'stage-packages.mjs')).href
  const { stagePublishPackages } = (await import(stageUrl)) as StageModule
  const outputDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-446-stage-')))
  await stagePublishPackages({ rootDir, targetVersion: '0.2.0', outputDir })
  const stagedCli = join(outputDir, 'cli')
  const files = packedFiles(stagedCli)
  scene.files = files
  scene.stagedCli = stagedCli
}, STAGE_BUDGET_MS)

afterAll(() => {
  cleanupTempRoots()
})

describe('skill assets in the packed CLI', () => {
  it('every SKILL.md, agents/openai.yaml and named reference is in the staged CLI tarball and non-empty', () => {
    const { files, stagedCli } = scene
    if (files === undefined || stagedCli === undefined) {
      throw new Error('the staged CLI package was not listed')
    }
    expect(packedSkillFindings(files, join(stagedCli, 'skills'))).toEqual([])
    const sources = sourceSkillFolders()
    expect(sources.length, 'source skill folders').toBeGreaterThanOrEqual(MINIMUM_SKILLS)
    expect(packedSkillNames(files)).toEqual(sources)
  })

  it('a missing or empty reference in the staged package is named', () => {
    const { stagedCli } = scene
    if (stagedCli === undefined) throw new Error('the staged CLI package was not listed')
    const planted = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-446-planted-')))
    writeFileSync(
      join(planted, 'package.json'),
      `${JSON.stringify({ name: 'planted', version: '0.0.0', files: ['skills'] }, null, 2)}\n`,
    )
    const skillsRoot = join(planted, 'skills')
    cpSync(join(stagedCli, 'skills'), skillsRoot, { recursive: true })
    rmSync(join(skillsRoot, 'agent-qa-result-triage', 'references', 'triage-categories.md'))
    const emptied = join(skillsRoot, 'agent-qa-knowledge', 'references', 'knowledge-reads.md')
    writeFileSync(emptied, '')
    expect(packedSkillFindings(packedFiles(planted), skillsRoot)).toEqual([
      'skills/agent-qa-knowledge/SKILL.md names references/knowledge-reads.md, which is empty',
      'skills/agent-qa-result-triage/SKILL.md names references/triage-categories.md, which is missing',
    ])
  }, PACK_BUDGET_MS)
})
