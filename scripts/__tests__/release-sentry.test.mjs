import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  debugIdTargets,
  injectDebugIds,
  parseSentryArgs,
  redactDsn,
  renderSentryProjectFile,
  runCli as runSentryCli,
  sentryCliDeadlineMs,
  uploadSourceMaps,
  validateSentryReleaseArtifacts,
} from '../release/sentry.mjs'

const dsn = 'https://key@o0.ingest.example/1'
const dsnFile = 'packages/analytics/src/sentry-project.ts'
const debugIdComment = '//# debugId=0b6e8a52-2f4c-4d1e-9b3a-6c7d8e9f0a1b'
const token = 'tok_test'
const release = 'agent-qa@0.0.1'
const shellPath = '/usr/bin:/bin'
// The shell a release step runs in, with the variables sentry-cli would also read.
const releaseEnv = {
  PATH: shellPath,
  HOME: '/home/release',
  SENTRY_AUTH_TOKEN: token,
  SENTRY_ORG: 'example-org',
  SENTRY_PROJECT: 'example-project',
  SENTRY_DSN: dsn,
  SENTRY_URL: 'https://sentry.example',
  SENTRY_PROPERTIES: 'sentry.properties',
  SENTRY_RELEASE: 'agent-qa@9.9.9',
  SENTRY_LOAD_DOTENV: '1',
  SENTRY_DOTENV_PATH: '.env.release',
}

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

// The message of the error a check throws, which must never carry the DSN.
function refusal(check) {
  try {
    check()
  } catch (error) {
    assert.ok(!error.message.includes(dsn), 'a refusal never prints the DSN')
    return error.message
  }
  assert.fail('nothing was refused')
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

async function withPackagesFixture(dists, run) {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-sentry-packages-'))
  try {
    for (const dist of dists) writeFile(join(rootDir, dist, 'index.js'), 'export {}\n')
    writeFile(join(rootDir, 'packages/arch/package.json'), '{}\n')
    await run(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

const releaseDists = [
  'packages/core/dist',
  'packages/cli/dist',
  'packages/dashboard-ui/dist',
  'plugins/kernel/dist',
]

function recordingRunner() {
  const calls = []
  return {
    calls,
    run: (command, args, options) => {
      calls.push({ command, args, options })
      return ''
    },
  }
}

// Fails the way execFileSync does, with sentry-cli's own output, token included, on the error.
function failingRunner(status) {
  const calls = []
  return {
    calls,
    run: (command, args, options) => {
      calls.push({ command, args, options })
      const output = `error: API request failed for token ${token}`
      const error = new Error(`Command failed: ${command} ${args.join(' ')}\n${output}`)
      if (status === undefined) error.code = 'ENOENT'
      else error.status = status
      error.stderr = output
      throw error
    },
  }
}

// Stands in for the sentry-cli that pnpm exec finds, @sentry/cli's node wrapper: it starts the
// binary, passes SIGTERM on to it and exits when it does. This binary never finishes.
const hungSentryCli = [
  "const { spawn } = require('node:child_process')",
  "const { writeFileSync } = require('node:fs')",
  "const binary = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {",
  "  stdio: 'inherit',",
  '})',
  "binary.on('exit', (code) => process.exit(code))",
  "process.on('SIGTERM', () => binary.kill('SIGTERM'))",
  "writeFileSync('sentry-cli.pids', JSON.stringify([process.pid, binary.pid]))",
].join('\n')
const hungDeadlineMs = 1_500

// Runs the hung stand-in with the options the script gave sentry-cli, for five seconds at most, so
// a script that sets a longer deadline or none fails the cell instead of holding it.
function hungRunner() {
  const calls = []
  return {
    calls,
    run: (command, args, options) => {
      calls.push({ command, args, options })
      return execFileSync(process.execPath, ['-e', hungSentryCli], {
        ...options,
        timeout: Math.min(options.timeout || 5_000, 5_000),
      })
    },
  }
}

// The stand-in's processes that still run once the script has moved on. The cell ends them, so
// none outlives it.
function processesLeft(rootDir) {
  const pids = JSON.parse(readFileSync(join(rootDir, 'sentry-cli.pids'), 'utf8'))
  const running = pids.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  for (const pid of running) process.kill(pid, 'SIGKILL')
  return running
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

test('the argument parser accepts --write, --inject and --upload --release <name> only', () => {
  assert.deepEqual(parseSentryArgs(['--write']), { mode: 'write' })
  assert.deepEqual(parseSentryArgs(['--inject']), { mode: 'inject' })
  assert.deepEqual(parseSentryArgs(['--upload', '--release', release]), {
    mode: 'upload',
    release,
  })
  for (const argv of [
    [],
    ['--upload'],
    ['--upload', '--release'],
    ['--upload', '--release', ''],
    ['--upload', '--release', '--inject'],
    ['--release', release, '--upload'],
    ['--inject', '--write'],
    ['--write', '--bad'],
    ['write'],
  ]) {
    const message = refusal(() => parseSentryArgs(argv))
    assert.match(message, /^invalid args:/)
    for (const form of ['--write', '--inject', '--upload --release <name>']) {
      assert.ok(message.includes(form), `${message} names ${form}`)
    }
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

test('debug IDs go into every package dist but the dashboard UI, and into no plugin', async () => {
  await withPackagesFixture(releaseDists, (rootDir) => {
    assert.deepEqual(debugIdTargets(rootDir), ['packages/cli/dist', 'packages/core/dist'])
  })
})

test('the --inject entry runs sentry-cli over the targets from the root with no token in its environment', async () => {
  await withPackagesFixture(releaseDists, async (rootDir) => {
    const runner = recordingRunner()
    await runSentryCli(['--inject'], {
      rootDir,
      env: releaseEnv,
      execFileSync: runner.run,
      log: () => {},
    })
    assert.equal(runner.calls.length, 1)
    const [{ command, args, options }] = runner.calls
    assert.equal(command, 'sentry-cli')
    assert.deepEqual(args, ['sourcemaps', 'inject', 'packages/cli/dist', 'packages/core/dist'])
    assert.equal(options.cwd, rootDir)
    assert.equal(options.stdio, 'pipe')
    assert.deepEqual(options.env, { PATH: shellPath, SENTRY_LOAD_DOTENV: '0' })
  })
})

test('inject fails when sentry-cli fails or there is no package dist to inject', async () => {
  await withPackagesFixture(releaseDists, (rootDir) => {
    const runner = failingRunner(1)
    assert.throws(
      () => injectDebugIds({ rootDir, env: releaseEnv, execFileSync: runner.run, log: () => {} }),
      /Command failed: sentry-cli sourcemaps inject/,
    )
  })

  await withPackagesFixture(['packages/dashboard-ui/dist', 'plugins/kernel/dist'], (rootDir) => {
    const runner = recordingRunner()
    assert.throws(
      () => injectDebugIds({ rootDir, env: releaseEnv, execFileSync: runner.run, log: () => {} }),
      /no package dist/,
    )
    assert.equal(runner.calls.length, 0)
  })
})

test('upload runs sentry-cli with the release, the targets and exactly five environment keys, and no --url', async () => {
  await withPackagesFixture(releaseDists, (rootDir) => {
    const runner = recordingRunner()
    const lines = []
    const result = uploadSourceMaps({
      rootDir,
      release,
      env: releaseEnv,
      execFileSync: runner.run,
      log: (line) => lines.push(line),
    })
    assert.deepEqual(result, { uploaded: true })
    assert.equal(runner.calls.length, 1)
    const [{ command, args, options }] = runner.calls
    assert.equal(command, 'sentry-cli')
    assert.deepEqual(args, [
      'sourcemaps',
      'upload',
      '--release',
      release,
      'packages/cli/dist',
      'packages/core/dist',
    ])
    assert.ok(!args.some((arg) => arg.startsWith('--url')))
    assert.equal(options.cwd, rootDir)
    assert.equal(options.stdio, 'pipe')
    assert.deepEqual(options.env, {
      PATH: shellPath,
      SENTRY_AUTH_TOKEN: token,
      SENTRY_ORG: 'example-org',
      SENTRY_PROJECT: 'example-project',
      SENTRY_LOAD_DOTENV: '0',
    })
    assert.ok(lines.every((line) => !line.startsWith('::warning::')), lines.join('\n'))
  })
})

test('upload warns and runs nothing when SENTRY_AUTH_TOKEN, SENTRY_ORG or SENTRY_PROJECT is blank', async () => {
  const names = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']
  await withPackagesFixture(releaseDists, (rootDir) => {
    for (const name of names) {
      const { [name]: _removed, ...absent } = releaseEnv
      for (const env of [absent, { ...releaseEnv, [name]: '' }, { ...releaseEnv, [name]: '  ' }]) {
        const runner = recordingRunner()
        const lines = []
        const result = uploadSourceMaps({
          rootDir,
          release,
          env,
          execFileSync: runner.run,
          log: (line) => lines.push(line),
        })
        assert.deepEqual(result, { uploaded: false })
        assert.equal(runner.calls.length, 0)
        assert.equal(lines.length, 1)
        assert.ok(lines[0].startsWith('::warning::'), lines[0])
        assert.ok(lines[0].includes(name), lines[0])
        for (const other of names.filter((candidate) => candidate !== name)) {
          assert.ok(!lines[0].includes(other), lines[0])
        }
      }
    }
  })
})

test('upload warns with a fixed sentence and the exit status, never sentry-cli output, when it fails', async () => {
  await withPackagesFixture(releaseDists, (rootDir) => {
    for (const status of [3, undefined]) {
      const runner = failingRunner(status)
      const lines = []
      const result = uploadSourceMaps({
        rootDir,
        release,
        env: releaseEnv,
        execFileSync: runner.run,
        log: (line) => lines.push(line),
      })
      assert.deepEqual(result, { uploaded: false })
      assert.equal(runner.calls.length, 1)
      assert.equal(lines.length, 1)
      assert.ok(lines[0].startsWith('::warning::'), lines[0])
      assert.doesNotMatch(lines[0], /API request failed|Command failed/)
      if (status === undefined) assert.doesNotMatch(lines[0], /exit status/)
      else assert.match(lines[0], /exit status 3/)
    }
  })
})

test('the --upload entry resolves with no failing exit code when a value is missing or the upload fails', async () => {
  await withPackagesFixture(releaseDists, async (rootDir) => {
    const { SENTRY_AUTH_TOKEN: _token, ...noToken } = releaseEnv
    for (const [env, runner] of [
      [noToken, recordingRunner()],
      [releaseEnv, failingRunner(1)],
    ]) {
      const result = await runSentryCli(['--upload', '--release', release], {
        rootDir,
        env,
        execFileSync: runner.run,
        log: () => {},
      })
      assert.deepEqual(result, { uploaded: false })
      assert.equal(process.exitCode ?? 0, 0)
    }
  })
})

test('inject and upload give sentry-cli minutes, not seconds, before they stop it', async () => {
  await withPackagesFixture(releaseDists, (rootDir) => {
    const runner = recordingRunner()
    injectDebugIds({ rootDir, env: releaseEnv, execFileSync: runner.run, log: () => {} })
    uploadSourceMaps({ rootDir, release, env: releaseEnv, execFileSync: runner.run, log: () => {} })
    assert.equal(runner.calls.length, 2)
    for (const { args, options } of runner.calls) {
      assert.equal(options.timeout, sentryCliDeadlineMs, args[1])
    }
    assert.ok(sentryCliDeadlineMs >= 60_000, `${sentryCliDeadlineMs} ms`)
  })
})

test('a hung upload is stopped at its deadline, sentry-cli and all, and the release goes on with a warning', async () => {
  await withPackagesFixture(releaseDists, async (rootDir) => {
    const runner = hungRunner()
    const lines = []
    const result = await runSentryCli(['--upload', '--release', release], {
      rootDir,
      env: releaseEnv,
      execFileSync: runner.run,
      log: (line) => lines.push(line),
      deadlineMs: hungDeadlineMs,
    })
    assert.deepEqual(processesLeft(rootDir), [])
    assert.equal(runner.calls[0].options.timeout, hungDeadlineMs)
    assert.deepEqual(result, { uploaded: false })
    assert.equal(process.exitCode ?? 0, 0)
    assert.deepEqual(lines, [
      '::warning::Source maps were not uploaded to Sentry: the upload timed out',
    ])
  })
})

test('a hung inject is stopped at its deadline, sentry-cli and all, and fails the release', async () => {
  await withPackagesFixture(releaseDists, async (rootDir) => {
    const runner = hungRunner()
    await assert.rejects(
      runSentryCli(['--inject'], {
        rootDir,
        env: releaseEnv,
        execFileSync: runner.run,
        log: () => {},
        deadlineMs: hungDeadlineMs,
      }),
      { code: 'ETIMEDOUT' },
    )
    assert.deepEqual(processesLeft(rootDir), [])
    assert.equal(runner.calls[0].options.timeout, hungDeadlineMs)
  })
})

test('no log line of inject or upload holds the token', async () => {
  await withPackagesFixture(releaseDists, (rootDir) => {
    const lines = []
    const log = (line) => lines.push(line)
    const env = releaseEnv
    injectDebugIds({ rootDir, env, execFileSync: recordingRunner().run, log })
    uploadSourceMaps({ rootDir, release, env, execFileSync: recordingRunner().run, log })
    uploadSourceMaps({ rootDir, release, env, execFileSync: failingRunner(1).run, log })
    uploadSourceMaps({
      rootDir,
      release,
      env: { ...env, SENTRY_ORG: '' },
      execFileSync: recordingRunner().run,
      log,
    })
    assert.equal(lines.length, 4)
    assert.ok(lines.every((line) => !line.includes(token)), lines.join('\n'))
  })
})
