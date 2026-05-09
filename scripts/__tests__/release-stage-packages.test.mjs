import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { stagePublishPackages } from '../release/stage-packages.mjs'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('stages CLI package with packaged skills and without source-only lifecycle hooks', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-stage-packages-'))
  try {
    const stagedDir = join(tempDir, 'staged')
    await stagePublishPackages({ rootDir, targetVersion: '0.1.1', outputDir: stagedDir })

    const cliDir = join(stagedDir, 'cli')
    const pkg = readJson(join(cliDir, 'package.json'))
    assert.equal(pkg.name, 'agent-qa')
    assert.equal(pkg.version, '0.1.1')
    assert.equal(pkg.scripts.prepack, undefined)
    assert.equal(pkg.scripts['copy:skills'], undefined)

    for (const skillName of ['agent-qa-authoring', 'agent-qa-result-triage', 'agent-qa-debug-fix']) {
      assert.ok(existsSync(join(cliDir, 'skills', skillName, 'SKILL.md')), `missing staged skill ${skillName}`)
      assert.ok(existsSync(join(cliDir, 'skills', skillName, 'agents/openai.yaml')), `missing staged skill agent config ${skillName}`)
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
