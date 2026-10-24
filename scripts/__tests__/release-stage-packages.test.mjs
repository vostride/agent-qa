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
const shippedSkills = ['agent-qa-authoring', 'agent-qa-result-triage', 'agent-qa-debug-fix', 'agent-qa-knowledge']
const knowledgeReference = join('agent-qa-knowledge', 'references', 'knowledge-reads.md')

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
    const dir = join(fixture, 'packages', record.packageDirName)
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

test('stages exactly the four source skills, byte for byte, including UTF-8 text', async () => {
  await withTemp(async (tempDir) => {
    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir: await fixtureRepo(tempDir), targetVersion: '0.1.1', outputDir: stagedDir })
    const stagedSkills = join(stagedDir, 'cli', 'skills')

    assert.deepEqual(readdirSync(stagedSkills).sort(), [...shippedSkills].sort())
    let compared = 0
    for (const skillName of shippedSkills) {
      const sourceDir = join(rootDir, 'skills', skillName)
      const sourceFiles = filesUnder(sourceDir).map(file => relative(sourceDir, file)).sort()
      const stagedFiles = filesUnder(join(stagedSkills, skillName)).map(file => relative(join(stagedSkills, skillName), file)).sort()
      assert.deepEqual(stagedFiles, sourceFiles, `${skillName} staged a different file set`)
      for (const file of sourceFiles) {
        const source = readFileSync(join(sourceDir, file))
        assert.ok(source.equals(readFileSync(join(stagedSkills, skillName, file))), `${skillName}/${file} bytes changed`)
        compared += 1
      }
    }
    assert.ok(compared >= 9, `only ${String(compared)} skill files were compared`)

    const reference = readFileSync(join(stagedSkills, knowledgeReference))
    assert.ok(reference.length > 0)
    assert.ok(reference.some(byte => byte > 0x7f), 'the knowledge reference carries no non-ASCII bytes to preserve')
    assert.ok(readFileSync(join(stagedSkills, 'agent-qa-knowledge', 'agents', 'openai.yaml'))
      .equals(readFileSync(join(rootDir, 'skills', 'agent-qa-knowledge', 'agents', 'openai.yaml'))))
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

test('stages the root README into every public package without writing it to the source packages', async () => {
  await withTemp(async (tempDir) => {
    const fixture = await fixtureRepo(tempDir)
    const stagedDir = join(tempDir, 'staged')
    const stagedRecords = await stagePublishPackages({ rootDir: fixture, targetVersion: '0.1.1', outputDir: stagedDir })
    const expected = absolutizeReadmeLinks(readFileSync(join(rootDir, 'README.md'), 'utf8'), 'v0.1.1')

    assert.equal(stagedRecords.length, getPublicPackages({ rootDir }).length)
    for (const record of stagedRecords) {
      assert.equal(readFileSync(join(record.dir, 'README.md'), 'utf8'), expected, `${record.pkg.name} staged a different README`)
      assert.ok(!existsSync(join(record.sourceDir, 'README.md')), `${record.pkg.name} source package gained a README`)
    }
    assert.ok(expected.includes('https://raw.githubusercontent.com/vostride/agent-qa/v0.1.1/docs/assets/readme/'))
    assert.doesNotMatch(expected, /\b(?:src|srcset|href)="(?!https?:\/\/|#)/)
    assert.doesNotMatch(expected, /\]\((?!https?:\/\/|#)/)
  })
})

test('pins relative README images to raw files and links to blobs, leaving absolute links alone', () => {
  const body = [
    '<img src="docs/a.png"> <source srcset="./docs/b.jpg"> <a href="LICENSE.md">l</a> <a href="https://x.dev">x</a>',
    '![shot](docs/c.png) [License](LICENSE.md) [Docs](https://vostride.com/docs) [Top](#get-started)',
  ].join('\n')
  assert.equal(absolutizeReadmeLinks(body, 'v1.2.3'), [
    '<img src="https://raw.githubusercontent.com/vostride/agent-qa/v1.2.3/docs/a.png"> <source srcset="https://raw.githubusercontent.com/vostride/agent-qa/v1.2.3/docs/b.jpg"> <a href="https://github.com/vostride/agent-qa/blob/v1.2.3/LICENSE.md">l</a> <a href="https://x.dev">x</a>',
    '![shot](https://raw.githubusercontent.com/vostride/agent-qa/v1.2.3/docs/c.png) [License](https://github.com/vostride/agent-qa/blob/v1.2.3/LICENSE.md) [Docs](https://vostride.com/docs) [Top](#get-started)',
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
