import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { getPublicPackages } from '../release/packages.mjs'
import { absolutizeReadmeLinks, stagePublishPackages } from '../release/stage-packages.mjs'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const shippedSkills = skillFolderNames(join(rootDir, 'skills'))
const knowledgeReference = join('agent-qa-knowledge', 'references', 'knowledge-reads.md')

function skillFolderNames(skillsRoot) {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort()
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function filesUnder(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path))
    else found.push(path)
  }
  return found
}

// A repo-shaped fixture: the real public manifests and source skills, packaged by the real
// copy-skills script, so staging is exercised without the committed packaged mirror.
async function fixtureRepo(tempDir, mutateSkills) {
  const fixture = join(tempDir, 'repo')
  for (const record of getPublicPackages({ rootDir })) {
    const dir = join(fixture, relative(rootDir, record.dir))
    await mkdir(dir, { recursive: true })
    await cp(record.manifestPath, join(dir, 'package.json'))
  }
  await cp(join(rootDir, 'skills'), join(fixture, 'skills'), { recursive: true })
  await cp(join(rootDir, 'README.md'), join(fixture, 'README.md'))
  await mkdir(join(fixture, 'packages', 'cli', 'scripts'), { recursive: true })
  await cp(join(rootDir, 'packages', 'cli', 'scripts', 'copy-skills.mjs'), join(fixture, 'packages', 'cli', 'scripts', 'copy-skills.mjs'))
  if (mutateSkills) await mutateSkills(join(fixture, 'skills'))
  execFileSync(process.execPath, [join(fixture, 'packages', 'cli', 'scripts', 'copy-skills.mjs')], { stdio: 'pipe' })
  return fixture
}

function assertSameFiles(sourceDir, stagedDir, skillName) {
  const sourceFiles = filesUnder(sourceDir).map(file => relative(sourceDir, file)).sort()
  const stagedFiles = filesUnder(stagedDir).map(file => relative(stagedDir, file)).sort()
  assert.deepEqual(stagedFiles, sourceFiles, `${skillName} staged a different file set`)
  for (const file of sourceFiles) {
    assert.ok(readFileSync(join(sourceDir, file)).equals(readFileSync(join(stagedDir, file))), `${skillName}/${file} bytes changed`)
  }
}

async function withTemp(body) {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-stage-packages-'))
  try {
    await body(tempDir)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

test('stages CLI package with packaged skills and without source-only lifecycle hooks', async () => {
  await withTemp(async (tempDir) => {
    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: await fixtureRepo(tempDir), targetVersion: '0.1.1', outputDir: stagedDir })

    const cliDir = join(stagedDir, 'cli')
    const pkg = readJson(join(cliDir, 'package.json'))
    assert.equal(pkg.name, 'agent-qa')
    assert.equal(pkg.version, '0.1.1')
    assert.equal(pkg.scripts.prepack, undefined)
    assert.equal(pkg.scripts['copy:skills'], undefined)

    for (const skillName of shippedSkills) {
      assert.ok(existsSync(join(cliDir, 'skills', skillName, 'SKILL.md')), `missing staged skill ${skillName}`)
      assert.ok(existsSync(join(cliDir, 'skills', skillName, 'agents/openai.yaml')), `missing staged skill agent config ${skillName}`)
    }
  })
})

test('stages every source skill folder, byte for byte, including UTF-8 text', async () => {
  await withTemp(async (tempDir) => {
    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: await fixtureRepo(tempDir), targetVersion: '0.1.1', outputDir: stagedDir })
    const stagedSkills = join(stagedDir, 'cli', 'skills')

    assert.deepEqual(readdirSync(stagedSkills).sort(), shippedSkills)
    for (const skillName of shippedSkills) {
      assertSameFiles(join(rootDir, 'skills', skillName), join(stagedSkills, skillName), skillName)
    }

    const reference = readFileSync(join(stagedSkills, knowledgeReference))
    assert.ok(reference.length > 0)
    assert.ok(reference.some(byte => byte > 0x7f), 'the knowledge reference carries no non-ASCII bytes to preserve')
  })
})

const newSkillBody = [
  '---',
  'name: agent-qa-zzz',
  'description: A skill folder added after the release scripts were written.',
  '---',
  '',
  '# agent-qa-zzz',
  '',
  'List recent runs with `agent_qa_list_runs`.',
  '',
].join('\n')
const newSkillOpenAi = [
  'interface:',
  '  display_name: "agent-qa zzz"',
  '  short_description: "A skill folder added after the release scripts were written."',
  'policy:',
  '  allow_implicit_invocation: true',
  '',
].join('\n')

async function addSkillFolder(skills, name, body = newSkillBody) {
  await mkdir(join(skills, name, 'agents'), { recursive: true })
  await writeFile(join(skills, name, 'SKILL.md'), body)
  await writeFile(join(skills, name, 'agents', 'openai.yaml'), newSkillOpenAi)
}

test('a new skill folder ships with no script change', async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(tempDir, skills => addSkillFolder(skills, 'agent-qa-zzz'))
    const fixtureSkills = join(fixture, 'skills')
    execFileSync(process.execPath, [join(fixtureSkills, 'scripts', 'validate-skills.mjs')], { stdio: 'pipe' })

    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: stagedDir })
    const stagedSkills = join(stagedDir, 'cli', 'skills')

    const sourceSet = skillFolderNames(fixtureSkills)
    assert.ok(sourceSet.includes('agent-qa-zzz'))
    assert.deepEqual(readdirSync(stagedSkills).sort(), sourceSet)
    assertSameFiles(join(fixtureSkills, 'agent-qa-zzz'), join(stagedSkills, 'agent-qa-zzz'), 'agent-qa-zzz')
  })
})

test("a skill's own scripts folder is packaged and staged, and the validator folder is not", async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(tempDir, async (skills) => {
      await addSkillFolder(skills, 'agent-qa-zzz')
      await mkdir(join(skills, 'agent-qa-zzz', 'scripts'), { recursive: true })
      await writeFile(join(skills, 'agent-qa-zzz', 'scripts', 'check.sh'), '#!/bin/sh\necho checked\n')
    })
    const packaged = join(fixture, 'packages', 'cli', 'skills')
    assert.ok(existsSync(join(packaged, 'agent-qa-zzz', 'scripts', 'check.sh')))
    assert.equal(existsSync(join(packaged, 'scripts')), false)

    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: stagedDir })
    const stagedSkills = join(stagedDir, 'cli', 'skills')
    assertSameFiles(join(fixture, 'skills', 'agent-qa-zzz'), join(stagedSkills, 'agent-qa-zzz'), 'agent-qa-zzz')
    assert.equal(existsSync(join(stagedSkills, 'scripts')), false)
  })
})

test('a checkout inside a folder named dist or scripts still packages and stages every skill file', async () => {
  await withTemp(async (tempDir) => {
    const parent = join(tempDir, 'dist', 'scripts')
    await mkdir(parent, { recursive: true })
    const fixture = await fixtureRepo(parent)

    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: stagedDir })
    const stagedSkills = join(stagedDir, 'cli', 'skills')
    for (const skillName of shippedSkills) {
      assertSameFiles(join(fixture, 'skills', skillName), join(stagedSkills, skillName), skillName)
    }
  })
})

test('source skill validation requires every reference a SKILL.md body names', async () => {
  await withTemp(async (tempDir) => {
    const skills = join(tempDir, 'skills')
    await cp(join(rootDir, 'skills'), skills, { recursive: true })
    await addSkillFolder(skills, 'agent-qa-zzz', `${newSkillBody}Read references/missing.md first.\n`)
    assert.throws(
      () => execFileSync(process.execPath, [join(skills, 'scripts', 'validate-skills.mjs')], { stdio: 'pipe', encoding: 'utf8' }),
      error => /agent-qa-zzz: missing references\/missing\.md/.test(String(error.stderr)),
    )
    await mkdir(join(skills, 'agent-qa-zzz', 'references'))
    await writeFile(join(skills, 'agent-qa-zzz', 'references', 'missing.md'), 'Present now.\n')
    execFileSync(process.execPath, [join(skills, 'scripts', 'validate-skills.mjs')], { stdio: 'pipe' })
  })
})

test('refuses to stage a missing or empty knowledge reference', async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(join(tempDir, 'missing'), async (skills) => {
      await rm(join(skills, knowledgeReference))
    })
    await assert.rejects(
      stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: join(tempDir, 'staged-missing') }),
      /missing CLI skill file for staged package: agent-qa-knowledge\/references\/knowledge-reads\.md/,
    )
  })
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(join(tempDir, 'empty'), async (skills) => {
      await writeFile(join(skills, knowledgeReference), '')
    })
    await assert.rejects(
      stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: join(tempDir, 'staged-empty') }),
      /empty CLI skill file for staged package: agent-qa-knowledge\/references\/knowledge-reads\.md/,
    )
  })
})

test('source skill validation fails on a missing or empty knowledge reference', async () => {
  for (const [label, mutate, expected] of [
    ['missing', skills => rm(join(skills, knowledgeReference)), /agent-qa-knowledge: missing references\/knowledge-reads\.md/],
    ['empty', skills => writeFile(join(skills, knowledgeReference), ''), /agent-qa-knowledge: empty references\/knowledge-reads\.md/],
  ]) {
    await withTemp(async (tempDir) => {
      const skills = join(tempDir, 'skills')
      await cp(join(rootDir, 'skills'), skills, { recursive: true })
      execFileSync(process.execPath, [join(skills, 'scripts', 'validate-skills.mjs')], { stdio: 'pipe' })
      await mutate(skills)
      assert.throws(
        () => execFileSync(process.execPath, [join(skills, 'scripts', 'validate-skills.mjs')], { stdio: 'pipe', encoding: 'utf8' }),
        error => expected.test(String(error.stderr)),
        `validate-skills accepted a ${label} reference`,
      )
    })
  }
})

test('source skill validation refuses an agents/openai.yaml that declares dependencies', async () => {
  await withTemp(async (tempDir) => {
    const skills = join(tempDir, 'skills')
    await cp(join(rootDir, 'skills'), skills, { recursive: true })
    execFileSync(process.execPath, [join(skills, 'scripts', 'validate-skills.mjs')], { stdio: 'pipe' })
    const openAi = join(skills, 'agent-qa-knowledge', 'agents', 'openai.yaml')
    await writeFile(openAi, [
      readFileSync(openAi, 'utf8').trimEnd(),
      'dependencies:',
      '  tools:',
      '    - type: "mcp"',
      '      value: "agent-qa"',
      '      transport: "stdio"',
      '      command: "npx"',
      '',
    ].join('\n'))
    assert.throws(
      () => execFileSync(process.execPath, [join(skills, 'scripts', 'validate-skills.mjs')], { stdio: 'pipe', encoding: 'utf8' }),
      error => /agent-qa-knowledge: agents\/openai\.yaml declares dependencies/.test(String(error.stderr)),
      'validate-skills accepted an openai.yaml that declares dependencies',
    )
  })
})

test('stages the root README into every public package but a plugin with its own, without writing it to the source packages', async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(tempDir)
    const stagedDir = join(tempDir, 'staged')
    const stagedRecords = await stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: stagedDir })
    const expected = absolutizeReadmeLinks(readFileSync(join(rootDir, 'README.md'), 'utf8'))

    assert.equal(stagedRecords.length, getPublicPackages({ rootDir }).length)
    for (const record of stagedRecords) {
      assert.equal(readFileSync(join(record.dir, 'README.md'), 'utf8'), expected, `${record.pkg.name} staged a different README`)
      assert.ok(!existsSync(join(record.sourceDir, 'README.md')), `${record.pkg.name} source package gained a README`)
    }
    assert.ok(expected.includes('https://raw.githubusercontent.com/vostride/agent-qa/main/docs/assets/readme/'))
    assert.doesNotMatch(expected, /\b(?:src|srcset|href)="(?!https?:\/\/|#)/)
    assert.doesNotMatch(expected, /\]\((?!https?:\/\/|#)/)
  })
})

test('keeps a plugin\'s own README and gives a packages/ member with one the root README', async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(tempDir)
    const pluginReadme = '# Kernel plugin\n\nOptions and settings.\n'
    await writeFile(join(fixture, 'plugins', 'kernel', 'README.md'), pluginReadme)
    await writeFile(join(fixture, 'packages', 'cli', 'README.md'), '# CLI notes\n')
    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: stagedDir })
    const rootReadme = absolutizeReadmeLinks(readFileSync(join(rootDir, 'README.md'), 'utf8'))

    assert.equal(readFileSync(join(stagedDir, 'plugins-kernel', 'README.md'), 'utf8'), pluginReadme)
    assert.equal(readFileSync(join(stagedDir, 'cli', 'README.md'), 'utf8'), rootReadme)
    assert.equal(readFileSync(join(fixture, 'plugins', 'kernel', 'README.md'), 'utf8'), pluginReadme)
  })
})

test('points relative README images at raw files and links at blobs on main, leaving absolute links alone', () => {
  const body = [
    '<img src="docs/a.png"> <source srcset="./docs/b.jpg"> <a href="LICENSE.md">l</a> <a href="https://x.dev">x</a>',
    '![shot](docs/c.png) [License](LICENSE.md) [Docs](https://vostride.com/docs) [Top](#get-started)',
  ].join('\n')
  assert.equal(absolutizeReadmeLinks(body), [
    '<img src="https://raw.githubusercontent.com/vostride/agent-qa/main/docs/a.png"> <source srcset="https://raw.githubusercontent.com/vostride/agent-qa/main/docs/b.jpg"> <a href="https://github.com/vostride/agent-qa/blob/main/LICENSE.md">l</a> <a href="https://x.dev">x</a>',
    '![shot](https://raw.githubusercontent.com/vostride/agent-qa/main/docs/c.png) [License](https://github.com/vostride/agent-qa/blob/main/LICENSE.md) [Docs](https://vostride.com/docs) [Top](#get-started)',
  ].join('\n'))
})

test('refuses to stage without a root README', async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(tempDir)
    await rm(join(fixture, 'README.md'))
    await assert.rejects(
      stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: join(tempDir, 'staged') }),
      /missing root README for staged packages/,
    )
  })
})

test('staging copies no package-local .agent-qa runtime folder', async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(tempDir)
    const runtimeFile = join(fixture, 'packages', 'cli', '.agent-qa', 'artifacts', 'working-memory-flush-fixture.json')
    await mkdir(dirname(runtimeFile), { recursive: true })
    await writeFile(runtimeFile, '{}\n')
    assert.ok(existsSync(runtimeFile))

    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: stagedDir })
    const cliDir = join(stagedDir, 'cli')
    assert.ok(existsSync(join(cliDir, 'package.json')), 'the CLI package was not staged')
    const runtimeCopies = filesUnder(cliDir)
      .map(file => relative(cliDir, file).split('\\').join('/'))
      .filter(file => file.split('/').includes('.agent-qa'))
    assert.deepEqual(runtimeCopies, [])
  })
})

test('stages a plugin as plugins-<folder> and every packages/ member under its own folder name', async () => {
  await withTemp(async (tempDir) => {
    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: await fixtureRepo(tempDir), targetVersion: '0.1.1', outputDir: stagedDir })

    assert.equal(readJson(join(stagedDir, 'plugins-kernel', 'package.json')).name, '@vostride/agent-qa-plugin-kernel')
    assert.equal(readJson(join(stagedDir, 'plugin-kit', 'package.json')).name, '@vostride/agent-qa-plugin-kit')
    assert.equal(readJson(join(stagedDir, 'cli', 'package.json')).name, 'agent-qa')
    assert.equal(existsSync(join(stagedDir, 'kernel')), false)
  })
})

test('refuses to stage when a packages/ folder and a plugin claim the same staged folder', async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(tempDir)
    const clash = join(fixture, 'packages', 'plugins-kernel')
    await mkdir(clash, { recursive: true })
    await writeFile(join(clash, 'package.json'), `${JSON.stringify({ name: '@vostride/agent-qa-clash', private: false })}\n`)

    await assert.rejects(
      stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: join(tempDir, 'staged') }),
      /staged folder plugins-kernel is claimed by both @vostride\/agent-qa-clash and @vostride\/agent-qa-plugin-kernel/,
    )
  })
})
