import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateAgentInstructions } from '../validate-agent-instructions.mjs'

function writeFixture(rootDir, packageName = '@vostride/agent-qa-core') {
  writeFileSync(
    join(rootDir, 'AGENTS.md'),
    [
      '# agent-qa Agent Instructions',
      '',
      '`agent-qa` `AGENT_QA_*` `agent_qa_*` `@vostride/agent-qa-*`',
      '',
      '<!-- branding-forbidden:start -->',
      '`AgentQA` `AGENTQA` `agentqa` `agentqa_`',
      '<!-- branding-forbidden:end -->',
      '',
    ].join('\n'),
  )

  const packageDir = join(rootDir, 'packages/core')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: packageName }, null, 2))
  writeFileSync(
    join(packageDir, 'AGENTS.md'),
    [
      `# agent-qa package instructions: ${packageName}`,
      '',
      `pnpm --filter ${packageName} test`,
      '',
    ].join('\n'),
  )
}

function withFixture(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'agent-qa-agents-'))
  try {
    mkdirSync(rootDir, { recursive: true })
    writeFixture(rootDir)
    return fn(rootDir)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

function validateOnePackage(rootDir) {
  return validateAgentInstructions(rootDir, { expectedPackageCount: 1 })
}

test('complete fixture passes and allows forbidden examples in root marker block', () => {
  withFixture(rootDir => {
    assert.deepEqual(validateOnePackage(rootDir), [])
  })
})

test('missing root AGENTS.md is reported', () => {
  withFixture(rootDir => {
    unlinkSync(join(rootDir, 'AGENTS.md'))

    const errors = validateOnePackage(rootDir)

    assert.ok(errors.some(error => error.includes('root AGENTS.md is missing')))
  })
})

test('missing package AGENTS.md is reported with the package name', () => {
  withFixture(rootDir => {
    unlinkSync(join(rootDir, 'packages/core/AGENTS.md'))

    const errors = validateOnePackage(rootDir)

    assert.ok(errors.some(error => error.includes('@vostride/agent-qa-core')))
    assert.ok(errors.some(error => error.includes('AGENTS.md is missing')))
  })
})

test('lowercase agents.md files are reported', () => {
  withFixture(rootDir => {
    const docsDir = join(rootDir, 'docs')
    mkdirSync(docsDir, { recursive: true })
    writeFileSync(join(docsDir, 'agents.md'), '# wrong name\n')

    const errors = validateOnePackage(rootDir)

    assert.ok(errors.some(error => error.includes('lowercase agents.md')))
  })
})

test('forbidden branding outside root marker block is reported', () => {
  withFixture(rootDir => {
    writeFileSync(
      join(rootDir, 'packages/core/AGENTS.md'),
      [
        '# agent-qa package instructions: @vostride/agent-qa-core',
        '',
        'pnpm --filter @vostride/agent-qa-core test',
        'Do not write AgentQA here.',
        '',
      ].join('\n'),
    )

    const errors = validateOnePackage(rootDir)

    assert.ok(errors.some(error => error.includes('forbidden branding')))
  })
})
