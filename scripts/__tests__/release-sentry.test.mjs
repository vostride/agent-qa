import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  parseSentryArgs,
  redactDsn,
  renderSentryProjectFile,
  runCli as runSentryCli,
  validateSentryReleaseArtifacts,
} from '../release/sentry.mjs'

const dsn = 'https://key@o0.ingest.example/1'
const dsnFile = 'packages/analytics/src/sentry-project.ts'
const debugIdComment = '//# debugId=0b6e8a52-2f4c-4d1e-9b3a-6c7d8e9f0a1b'

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// The analytics dist in the shape the build emits once it inlines the DSN constant.
function writeAnalyticsDist(packageRoot, bakedDsn = dsn) {
  const text = `const AGENT_QA_SENTRY_DSN = ${JSON.stringify(bakedDsn)};\n`
  writeFile(join(packageRoot, 'dist/index.js'), text)
  writeFile(join(packageRoot, 'dist/index.cjs'), text)
}

// A cli entry as inject leaves it: the banner on line 1 and the debug-ID comment last.
function cliEntryText({ shebang = true, debugId = true } = {}) {
  return [
    ...(shebang ? ['#!/usr/bin/env node'] : []),
    "import './cli-main.js'",
    '//# sourceMappingURL=cli.js.map',
    ...(debugId ? [debugIdComment] : []),
  ].join('\n') + '\n'
}

function createReleaseFixture(rootDir, stagedDir) {
  writeFile(
    join(rootDir, 'packages/analytics/src/index.ts'),
    "export * from './sentry-project.js'\n",
  )
  writeFile(join(rootDir, dsnFile), `export const AGENT_QA_SENTRY_DSN = "${dsn}"\n`)
  writeFile(
    join(rootDir, 'packages/cli/src/composition/error-reporting.ts'),
    "import { AGENT_QA_SENTRY_DSN } from '@vostride/agent-qa-analytics'\n",
  )
  writeAnalyticsDist(join(rootDir, 'packages/analytics'))
  writeAnalyticsDist(join(stagedDir, 'analytics'))
  writeFile(join(stagedDir, 'cli/dist/cli.js'), cliEntryText())
  writeFile(join(stagedDir, 'cli/dist/cli.cjs'), cliEntryText())
}

async function withReleaseFixture(run) {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-sentry-root-'))
  const stagedDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-sentry-staged-'))
  try {
    createReleaseFixture(rootDir, stagedDir)
    await run({ rootDir, stagedDir })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
    await rm(stagedDir, { recursive: true, force: true })
  }
}

// The message of the error the check throws, which must never carry the DSN.
function refusal(check) {
  try {
    check()
  } catch (error) {
    assert.ok(!error.message.includes(dsn), 'a refusal never prints the DSN')
    return error.message
  }
  assert.fail('the release check passed')
}

// The script falls back to the shell's SENTRY_DSN, so a cell that needs it absent removes it.
async function withoutShellDsn(run) {
  const shellDsn = process.env.SENTRY_DSN
  delete process.env.SENTRY_DSN
  try {
    await run()
  } finally {
    if (shellDsn !== undefined) process.env.SENTRY_DSN = shellDsn
  }
}

test('renders the DSN file as one exported JSON string literal and refuses a blank DSN', () => {
  assert.equal(renderSentryProjectFile(dsn), `export const AGENT_QA_SENTRY_DSN = "${dsn}"\n`)
  const awkward = 'https://key@o0.ingest.example/1"quoted"\\path\nnext'
  assert.equal(
    renderSentryProjectFile(awkward),
    `export const AGENT_QA_SENTRY_DSN = ${JSON.stringify(awkward)}\n`,
  )
  for (const blank of ['', '  ', undefined]) {
    assert.throws(() => renderSentryProjectFile(blank), /SENTRY_DSN is required/)
  }
  assert.equal(redactDsn(dsn), '[redacted SENTRY_DSN]')
})

test('the --write entry writes the DSN file under the given root and logs only the redacted form', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-sentry-write-'))
  try {
    const lines = []
    await runSentryCli(['--write'], {
      rootDir,
      env: { SENTRY_DSN: dsn },
      log: (line) => lines.push(line),
    })
    assert.equal(existsSync(join(rootDir, dsnFile)), true)
    assert.equal(
      readFileSync(join(rootDir, dsnFile), 'utf8'),
      `export const AGENT_QA_SENTRY_DSN = "${dsn}"\n`,
    )
    assert.equal(lines.length, 1)
    assert.match(lines[0], /packages\/analytics\/src\/sentry-project\.ts/)
    assert.match(lines[0], /\[redacted SENTRY_DSN\]/)
    assert.ok(!lines[0].includes(dsn))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('the --write entry refuses to write when SENTRY_DSN is absent', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-sentry-absent-'))
  try {
    await withoutShellDsn(() =>
      assert.rejects(
        runSentryCli(['--write'], { rootDir, env: {}, log: () => {} }),
        /SENTRY_DSN is required/,
      ),
    )
    assert.equal(existsSync(join(rootDir, dsnFile)), false)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('the argument parser accepts --write alone', () => {
  assert.deepEqual(parseSentryArgs(['--write']), { mode: 'write' })
  assert.throws(() => parseSentryArgs([]), /missing --write/)
  for (const argv of [['--write', '--write'], ['--write', '--bad'], ['write'], ['--dsn']]) {
    assert.throws(() => parseSentryArgs(argv), /invalid args:/)
  }
})

test('the release check passes a baked analytics dist and staged cli entries with shebang and debug ID', async () => {
  await withReleaseFixture(({ rootDir, stagedDir }) => {
    assert.doesNotThrow(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
    assert.doesNotThrow(() => validateSentryReleaseArtifacts({ rootDir, env: { SENTRY_DSN: dsn } }))
  })
})

test('the release check names an analytics dist file that is missing or does not hold the DSN', async () => {
  await withReleaseFixture(({ rootDir, stagedDir }) => {
    const workspaceCjs = join(rootDir, 'packages/analytics/dist/index.cjs')
    writeFileSync(workspaceCjs, 'const AGENT_QA_SENTRY_DSN = "";\n')
    const unbaked = refusal(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
    assert.ok(unbaked.endsWith(workspaceCjs), unbaked)
  })

  await withReleaseFixture(({ rootDir, stagedDir }) => {
    const stagedJs = join(stagedDir, 'analytics/dist/index.js')
    rmSync(stagedJs)
    const missing = refusal(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
    assert.ok(missing.endsWith(stagedJs), missing)
    assert.match(missing, /missing/)

    for (const bakedDsn of ['', 'https://other@o0.ingest.example/2']) {
      writeAnalyticsDist(join(stagedDir, 'analytics'), bakedDsn)
      const wrong = refusal(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
      assert.ok(wrong.endsWith(stagedJs), wrong)
      assert.doesNotMatch(wrong, /missing/)
    }
  })
})

test('the release check names a staged cli entry that lost its shebang or has no debug ID', async () => {
  await withReleaseFixture(({ rootDir, stagedDir }) => {
    const cjs = join(stagedDir, 'cli/dist/cli.cjs')
    for (const text of [cliEntryText({ shebang: false }), `\n${cliEntryText()}`]) {
      writeFileSync(cjs, text)
      const lostShebang = refusal(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
      assert.ok(lostShebang.endsWith(cjs), lostShebang)
      assert.match(lostShebang, /#!\/usr\/bin\/env node/)
    }
  })

  await withReleaseFixture(({ rootDir, stagedDir }) => {
    const js = join(stagedDir, 'cli/dist/cli.js')
    writeFileSync(js, cliEntryText({ debugId: false }))
    const noDebugId = refusal(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
    assert.ok(noDebugId.endsWith(js), noDebugId)
    assert.match(noDebugId, /debug ID/)
  })
})

test('the release check names a runtime source that reads SENTRY_DSN from the environment', async () => {
  await withReleaseFixture(({ rootDir, stagedDir }) => {
    const compose = join(rootDir, 'packages/analytics/src/compose.ts')
    writeFile(compose, 'export const dsn = process.env.SENTRY_DSN ?? ""\n')
    const analyticsRead = refusal(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
    assert.ok(analyticsRead.endsWith(compose), analyticsRead)
    assert.match(analyticsRead, /process\.env\.SENTRY_DSN/)
  })

  await withReleaseFixture(({ rootDir, stagedDir }) => {
    const reporter = join(rootDir, 'packages/cli/src/composition/error-reporting.ts')
    writeFile(reporter, "export const dsn = process.env['SENTRY_DSN']\n")
    const reporterRead = refusal(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
    assert.ok(reporterRead.endsWith(reporter), reporterRead)
  })

  await withReleaseFixture(({ rootDir, stagedDir }) => {
    writeFile(
      join(rootDir, 'packages/analytics/src/__tests__/dsn.test.ts'),
      "expect(source).not.toContain('process.env.SENTRY_DSN')\n",
    )
    assert.doesNotThrow(() => validateSentryReleaseArtifacts({ rootDir, stagedDir, dsn }))
  })
})
