import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { REQUIRED_LEGS } from '../gate/evaluate.mjs'
import * as gate from '../gate/run.mjs'

const host = await import('../gate/host.mjs').catch(() => ({}))

const SHA = 'a'.repeat(40)
const FILES = ['a.test.mjs', 'b.test.mjs']
const TOOLS = {
  git: 'git version 2.50.1',
  pnpm: '10.6.1',
  expect: 'expect version 5.45',
  python3: 'Python 3.14.5',
  adb: 'List of devices attached\n',
  xcrun: '== Devices ==\n-- iOS 18.2 --\n',
}
const CHROMIUM = { revision: '1228', browserVersion: '149.0.7827.55' }

function toolExec(overrides = {}) {
  const tools = { ...TOOLS, ...overrides }
  return (command, args = []) => {
    if (command === 'pnpm' && args[0] === 'exec') {
      return { status: 0, stdout: '2.9.7\n', stderr: '' }
    }
    if (command === 'ps') return { status: 0, stdout: '', stderr: '' }
    const stdout = tools[command]
    if (stdout === null || stdout === undefined) {
      return { status: 127, stdout: '', stderr: `${command}: not found` }
    }
    return { status: 0, stdout: `${stdout}\n`, stderr: '' }
  }
}

const fakeHost = {
  chromiumCheck: () => ({
    required: { tool: 'playwright-chromium', version: '1228', ok: true, hint: 'install it' },
    optional: [
      { platform: 'firefox', present: false },
      { platform: 'webkit', present: false },
    ],
    chromium: CHROMIUM,
  }),
}

function populateRoot(root) {
  mkdirSync(join(root, 'scripts/__tests__'), { recursive: true })
  mkdirSync(join(root, 'scripts/gate/inputs'), { recursive: true })
  for (const file of FILES) writeFileSync(join(root, 'scripts/__tests__', file), '')
  writeFileSync(
    join(root, 'scripts/gate/inputs/node-tests.json'),
    JSON.stringify({ schemaVersion: 2, files: FILES }),
  )
  writeFileSync(
    join(root, 'scripts/gate/inputs/register.json'),
    JSON.stringify({ schemaVersion: 2, entries: [] }),
  )
  writeFileSync(
    join(root, 'scripts/gate/inputs/regressions.json'),
    JSON.stringify({ schemaVersion: 2, cells: [] }),
  )
}

function greenReport() {
  const file = '/r/scripts/__tests__/a.test.mjs'
  const tests = [{ file, name: 'one', nesting: 0, status: 'passed' }]
  return JSON.stringify({ schemaVersion: 2, tests, summary: null })
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'agent-qa-gate-run-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const source = join(base, 'source')
  const temp = join(base, 'tmp')
  populateRoot(source)
  mkdirSync(temp)
  return { source, out: join(base, 'out'), temp }
}

function fakeDeps({ temp, porcelain = '', gatePorcelain = '', logBytes = 0, legs, tools } = {}) {
  const lines = []
  const calls = []
  const tool = toolExec(tools)
  const deps = {
    host: fakeHost,
    tmpdir: () => temp,
    now: () => new Date('2026-10-06T07:08:09Z'),
    pid: 42,
    output: { write: chunk => lines.push(...chunk.split('\n').filter(Boolean)) },
    exec(command, args) {
      calls.push([command, ...args])
      if (args.includes('rev-parse')) return { status: 0, stdout: `${SHA}\n`, stderr: '' }
      if (args.includes('status') && args.includes('--')) {
        return { status: 0, stdout: gatePorcelain, stderr: '' }
      }
      if (args.includes('status')) return { status: 0, stdout: porcelain, stderr: '' }
      return tool(command, args)
    },
    async run(command, args, { logPath }) {
      calls.push([command, ...args])
      writeFileSync(logPath, logBytes > 0 && command === 'node' ? 'x'.repeat(logBytes) : 'ok\n')
      if (command === 'git' && args[0] === 'clone') populateRoot(args.at(-1))
      const destination = args.find(
        arg => arg.startsWith('--test-reporter-destination=') && arg.endsWith('.json'),
      )
      if (destination) writeFileSync(destination.slice(destination.indexOf('=') + 1), greenReport())
      return { exitCode: 0, durationMs: 1 }
    },
  }
  if (legs) deps.buildGateLegs = legs
  return { deps, lines, calls }
}

function everyLegAsNodeTest({ root, runDir }) {
  return REQUIRED_LEGS.map(id => {
    const raw = join(runDir, 'raw', `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
    return {
      id,
      kind: 'node-test',
      needsBuild: false,
      cwd: root,
      argv: ['node', '--test', `--test-reporter-destination=${raw}`],
      raw,
    }
  })
}

test('parseGateArgs rejects a missing --out, --in-place with --sha, an unknown leg or flag', () => {
  const { parseGateArgs } = gate
  const messageOf = argv => {
    try {
      parseGateArgs(argv)
    } catch (error) {
      return error.message
    }
    return '<no error>'
  }
  assert.match(messageOf([]), /missing --out/)
  assert.match(
    messageOf(['--out', 'x', '--in-place', '--sha', 'abc']),
    /--in-place cannot be combined with --sha/,
  )
  assert.match(messageOf(['--out', 'x', '--only', 'nope']), /unknown leg/)
  assert.match(messageOf(['--out', 'x', '--bogus']), /unknown argument/)
  const parsed = parseGateArgs(['--', '--out', 'x', '--in-place', '--keep-clone'])
  assert.equal(parsed.inPlace, true)
  assert.equal(parsed.keepClone, true)
})

test('runDirName names the mode, the UTC stamp and the pid', () => {
  assert.equal(typeof gate.runDirName, 'function')
  const { runDirName } = gate
  const now = new Date('2026-10-06T07:08:09Z')
  assert.equal(runDirName({ mode: 'in-place', now, pid: 42 }), 'in-place-20261006T070809Z-42')
})

test('an in-place run is never a record and says so', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps, lines, calls } = fakeDeps({ temp })
  const summary = await gate.runGate({ out, source, inPlace: true, only: ['node-test'] }, deps)
  assert.equal(summary.mode, 'in-place')
  assert.equal(summary.record, false)
  assert.equal(summary.exitCode, 0)
  assert.equal(summary.clonePath, null)
  assert.equal(calls.some(call => call[1] === 'clone'), false)
  assert.deepEqual(summary.steps.find(step => step.id === 'install').skipped, 'in-place')
  assert.ok(lines.some(line => line.includes('in-place run: NOT A RECORD')))
  assert.match(lines.at(-1), /^summary: \//)
  assert.ok(summary.runDir.endsWith(join(SHA, 'in-place-20261006T070809Z-42')))
})

test('a partial clone run is not a record and says so', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps, lines } = fakeDeps({ temp })
  const summary = await gate.runGate({ out, source, only: ['node-test'] }, deps)
  assert.equal(summary.mode, 'clone')
  assert.equal(summary.partial, true)
  assert.equal(summary.record, false)
  assert.ok(lines.some(line => line.includes('partial run (node-test): NOT A RECORD')))
})

test('a full clone run with no leg-missing finding is a record', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps } = fakeDeps({ temp, legs: everyLegAsNodeTest })
  const summary = await gate.runGate({ out, source, only: null }, deps)
  assert.equal(summary.schemaVersion, 2)
  assert.deepEqual(summary.findings, [])
  assert.equal(summary.partial, false)
  assert.equal(summary.record, true)
  assert.equal(summary.cloneRemoved, true)
  assert.equal(existsSync(summary.clonePath), false)
})

test('shouldRemoveClone removes only a green run without --keep-clone', () => {
  assert.equal(typeof gate.shouldRemoveClone, 'function')
  const { shouldRemoveClone } = gate
  assert.equal(shouldRemoveClone({ exitCode: 0, keepClone: false }), true)
  assert.equal(shouldRemoveClone({ exitCode: 0 }), true)
  assert.equal(shouldRemoveClone({ exitCode: 0, keepClone: true }), false)
  assert.equal(shouldRemoveClone({ exitCode: 1, keepClone: false }), false)
})

test('a dirty source in clone mode warns how many paths the clone did not include', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps } = fakeDeps({ temp, porcelain: ' M a.txt\n?? b.txt\n D c.txt\n' })
  const summary = await gate.runGate({ out, source, only: ['node-test'] }, deps)
  assert.equal(summary.sourceDirty, true)
  assert.equal(summary.warnings.length, 1)
  assert.match(summary.warnings[0], /3 uncommitted path\(s\) the clone did not include/)
})

test('C444.1-RECORD-INTEGRITY a clone run whose gate files are dirty is not a record and says so', async t => {
  const { source, out, temp } = await fixture(t)
  const gatePorcelain = ' M scripts/gate/run.mjs\n'
  const { deps, lines } = fakeDeps({ temp, gatePorcelain, legs: everyLegAsNodeTest })
  const summary = await gate.runGate({ out, source, only: null }, deps)
  assert.equal(summary.partial, false)
  assert.equal(summary.sourceDirty, false)
  assert.equal(summary.record, false)
  assert.equal(summary.gate?.dirty, true)
  assert.ok(lines.some(line => line.includes('gate files dirty: NOT A RECORD')))
})

test('C444.1-RECORD-INTEGRITY a clone run whose source checkout is dirty is not a record and says so', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps, lines } = fakeDeps({ temp, porcelain: ' M a.txt\n', legs: everyLegAsNodeTest })
  const summary = await gate.runGate({ out, source, only: null }, deps)
  assert.equal(summary.partial, false)
  assert.equal(summary.sourceDirty, true)
  assert.equal(summary.record, false)
  assert.ok(lines.some(line => line.includes('source checkout dirty: NOT A RECORD')))
})

test('C444.1-RECORD-INTEGRITY a record names the gate commit it was judged by and that its files were clean', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps, calls } = fakeDeps({ temp, legs: everyLegAsNodeTest })
  const summary = await gate.runGate({ out, source, only: null }, deps)
  assert.equal(summary.record, true)
  assert.deepEqual(summary.gate, { name: 'agent-qa-local-gate', sha: SHA, dirty: false })
  const gateRevParse = calls.filter(
    call =>
      call[0] === 'git' &&
      call[1] === '-C' &&
      /scripts[/\\]gate$/.test(call[2]) &&
      call.slice(3).join(' ') === 'rev-parse HEAD',
  )
  assert.equal(gateRevParse.length, 1)
})

test('a leg log over 2 MiB is gzipped and the leg names the .gz path', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps } = fakeDeps({ temp, logBytes: 3 * 1024 * 1024 })
  const summary = await gate.runGate({ out, source, only: ['node-test'] }, deps)
  const leg = summary.legs.find(entry => entry.id === 'node-test')
  assert.match(leg.log, /node-test\.log\.gz$/)
  assert.equal(existsSync(leg.log), true)
  assert.equal(existsSync(leg.log.replace(/\.gz$/, '')), false)
})

test('a missing expect stops preflight with an install hint and the gate runs no leg', async t => {
  assert.equal(typeof host.preflight, 'function')
  const result = host.preflight({ exec: toolExec({ expect: null }), nodeVersion: '24.15.0' })
  assert.equal(result.ok, false)
  assert.match(result.message, /expect/)
  assert.match(result.message, /brew install expect/)

  const { source, out, temp } = await fixture(t)
  const { deps, calls, lines } = fakeDeps({ temp, tools: { expect: null } })
  const summary = await gate.runGate({ out, source, only: ['node-test'] }, deps)
  const missingTool = summary.findings.filter(f => f.rule === 'preflight-missing-tool')
  assert.ok(missingTool.some(f => /expect/.test(f.detail)))
  assert.deepEqual(summary.legs, [])
  assert.equal(summary.exitCode, 1)
  assert.equal(calls.some(call => call[0] === 'node' || call[1] === 'clone'), false)
  assert.ok(lines.some(line => line.includes('brew install expect')))
})

test('pnpm 11 or a Node major of 22 does not pass preflight', () => {
  assert.equal(typeof host.preflight, 'function')
  const pnpm11 = host.preflight({ exec: toolExec({ pnpm: '11.0.0' }), nodeVersion: '24.15.0' })
  assert.equal(pnpm11.ok, false)
  assert.equal(pnpm11.required.find(entry => entry.tool === 'pnpm').ok, false)
  const node22 = host.preflight({ exec: toolExec(), nodeVersion: '22.11.0' })
  assert.equal(node22.ok, false)
  assert.equal(node22.required.find(entry => entry.tool === 'node').ok, false)
  assert.equal(host.preflight({ exec: toolExec(), nodeVersion: '24.15.0' }).ok, true)
})

test('absent Firefox, WebKit, adb device or booted simulator is recorded and never fails', () => {
  assert.equal(typeof host.preflight, 'function')
  assert.equal(typeof host.chromiumCheck, 'function')
  const result = host.preflight({ exec: toolExec(), nodeVersion: '24.15.0', platform: 'darwin' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.optional, [
    { platform: 'android', present: false },
    { platform: 'ios', present: false },
  ])
  const withDevice = host.preflight({
    exec: toolExec({ adb: 'List of devices attached\nemulator-5554\tdevice' }),
    nodeVersion: '24.15.0',
    platform: 'darwin',
  })
  assert.equal(withDevice.optional.find(entry => entry.platform === 'android').present, true)

  const browsers = [
    { name: 'chromium', ...CHROMIUM },
    { name: 'firefox', revision: '1532', browserVersion: '151.0' },
    { name: 'webkit', revision: '2311', browserVersion: '26.5' },
  ]
  const executables = { chromium: '/pw/chromium', firefox: '/pw/firefox', webkit: '/pw/webkit' }
  const check = host.chromiumCheck({
    root: '/clone/agent-qa',
    load: () => ({ browsers, executables }),
    exists: path => path === '/pw/chromium',
  })
  assert.equal(check.required.ok, true)
  assert.deepEqual(check.chromium, CHROMIUM)
  assert.deepEqual(check.optional, [
    { platform: 'firefox', present: false },
    { platform: 'webkit', present: false },
  ])
  const missing = host.chromiumCheck({
    root: '/clone/agent-qa',
    load: () => ({ browsers, executables }),
    exists: () => false,
  })
  assert.equal(missing.required.ok, false)
  assert.match(missing.required.hint, /playwright install chromium/)
})

test('machineSnapshot records pid, executable basename and keyword only, never arguments', () => {
  assert.equal(typeof host.machineSnapshot, 'function')
  const comm = [
    '  1     0 /sbin/launchd',
    '101     1 /Applications/Chromium.app/Contents/MacOS/Chromium',
    '102   199 /usr/local/bin/node',
    '199     1 /usr/local/bin/node',
    '200   199 /usr/local/bin/node',
  ].join('\n')
  const args = [
    '  1 /sbin/launchd',
    '101 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/secret/TOKEN',
    '102 node /x/node_modules/vitest/vitest.mjs run --api-key=SECRET',
    '199 node /x/agent-qa/node_modules/.bin/pnpm run gate:local',
    '200 node /x/agent-qa/scripts/gate/run.mjs --out /tmp/o',
  ].join('\n')
  const exec = (command, argv) => {
    assert.equal(command, 'ps')
    return { status: 0, stdout: argv[1].includes('comm') ? comm : args, stderr: '' }
  }
  const snapshot = host.machineSnapshot({ exec, selfPid: 200 })
  assert.ok(snapshot.cpus > 0)
  assert.equal(snapshot.load.length, 3)
  assert.deepEqual(snapshot.processes, [
    { pid: 101, exe: 'Chromium', keyword: 'chrom' },
    { pid: 102, exe: 'node', keyword: 'vitest' },
  ])
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false)
  assert.equal(JSON.stringify(snapshot).includes('TOKEN'), false)
})

const MEMBERS = JSON.parse(
  readFileSync(new URL('../gate/inputs/packages.json', import.meta.url), 'utf8'),
).members

function turboDeps({ temp, source }) {
  const base = fakeDeps({ temp })
  const turboCalls = []
  const listing = [
    { name: 'agent-qa-monorepo', path: source },
    ...MEMBERS.map((name, index) => ({ name, path: join(source, 'packages', `p${index}`) })),
  ]
  const dryFor = args => {
    const names = args.slice(args.indexOf('run') + 1)
    const tasks = names.slice(0, names.findIndex(arg => arg.startsWith('-')))
    const wanted = tasks.includes('test') ? ['build', ...tasks] : tasks
    return {
      packages: MEMBERS,
      tasks: MEMBERS.flatMap(name =>
        wanted.map(task => ({
          taskId: `${name}#${task}`,
          command: name === '@vostride/agent-qa-arch' && task === 'build' ? '<NONEXISTENT>' : task,
        })),
      ),
    }
  }
  const exec = base.deps.exec
  base.deps.exec = (command, args, opts) => {
    if (command === 'pnpm' && args[0] === 'ls') {
      return { status: 0, stdout: JSON.stringify(listing), stderr: '' }
    }
    if (command === 'pnpm' && args.includes('--dry-run=json')) {
      turboCalls.push(args)
      return { status: 0, stdout: JSON.stringify(dryFor(args)), stderr: '' }
    }
    return exec(command, args, opts)
  }
  const run = base.deps.run
  base.deps.run = async (command, args, opts) => {
    if (command === 'pnpm' && args.includes('turbo')) {
      turboCalls.push(args)
      writeFileSync(opts.logPath, 'ok\n')
      const tasks = dryFor(args)
        .tasks.filter(task => task.command !== '<NONEXISTENT>')
        .map(({ taskId }) => ({ taskId, execution: { exitCode: 0 }, cache: { status: 'MISS' } }))
      const n = tasks.length
      const execution = { attempted: n, success: n, failed: 0, cached: 0, exitCode: 0 }
      mkdirSync(join(source, '.turbo/runs'), { recursive: true })
      writeFileSync(
        join(source, '.turbo/runs/run1.json'),
        JSON.stringify({ envMode: 'strict', execution, tasks }),
      )
      return { exitCode: 0, durationMs: 1 }
    }
    return run(command, args, opts)
  }
  return { ...base, turboCalls }
}

function populatePin(root) {
  writeFileSync(
    join(root, 'scripts/gate/inputs/packages.json'),
    JSON.stringify({ schemaVersion: 2, members: MEMBERS }),
  )
}

test('the build/typecheck leg is forced, continued, summarized and set-checked', async t => {
  const { source, out, temp } = await fixture(t)
  populatePin(source)
  const { deps, turboCalls } = turboDeps({ temp, source })
  const summary = await gate.runGate(
    { out, source, inPlace: true, only: ['turbo-build-typecheck'], turboConcurrency: 4 },
    deps,
  )
  assert.deepEqual(summary.findings, [])
  assert.equal(summary.exitCode, 0)
  assert.equal(summary.members.length, 23)
  assert.equal(summary.members.find(member => member.name === 'agent-qa').dir, 'packages/p22')
  const leg = summary.legs.find(entry => entry.id === 'turbo-build-typecheck')
  assert.equal(leg.executed, 45)
  assert.equal(leg.expectedTasks, 45)
  assert.deepEqual(turboCalls[0], ['exec', 'turbo', 'run', 'build', 'typecheck', '--dry-run=json'])
  for (const flag of ['--force', '--continue', '--summarize', '--concurrency=4']) {
    assert.ok(turboCalls[1].includes(flag), flag)
  }
  assert.equal(turboCalls.flat().some(arg => arg.includes('--filter')), false)
  assert.equal(summary.turbo.envMode, 'strict')
  assert.equal(summary.turbo.concurrency, 4)
  const raw = join(summary.runDir, 'raw', 'turbo-build-typecheck-summary.json.gz')
  assert.equal(JSON.parse(gunzipSync(readFileSync(raw))).execution.attempted, 45)
  assert.ok(existsSync(join(summary.runDir, 'raw', 'turbo-build-typecheck-dry-run.json.gz')))
  assert.equal(gate.parseGateArgs(['--out', 'x', '--turbo-concurrency', '4']).turboConcurrency, 4)
  assert.throws(() => gate.parseGateArgs(['--out', 'x', '--turbo-concurrency', '0']), /invalid/)
})

test('a leg with no new turbo run summary, or a pnpm listing off the pin, is red', async t => {
  const { source, out, temp } = await fixture(t)
  populatePin(source)
  const { deps } = turboDeps({ temp, source })
  const run = deps.run
  deps.run = async (command, args, opts) => {
    const result = await run(command, args, opts)
    writeFileSync(join(source, '.turbo/runs/run2.json'), '{}')
    return result
  }
  const exec = deps.exec
  deps.exec = (command, args, opts) => {
    if (command === 'pnpm' && args[0] === 'ls') {
      return { status: 0, stdout: JSON.stringify([{ name: 'agent-qa', path: '/x' }]), stderr: '' }
    }
    return exec(command, args, opts)
  }
  const summary = await gate.runGate(
    { out, source, inPlace: true, only: ['turbo-build-typecheck'] },
    deps,
  )
  const byRule = rule => summary.findings.filter(f => f.rule === rule)
  assert.match(byRule('results-missing')[0].detail, /one new run summary.*found 2/)
  assert.match(byRule('package-set-mismatch')[0].detail, /^pnpm workspace listing: missing/)
  assert.equal(summary.exitCode, 1)
})

function memberJson(root, dir, assertions) {
  return JSON.stringify({
    success: true,
    numPassedTests: 999,
    testResults: [
      {
        name: join(root, dir, 'src/a.test.ts'),
        status: 'passed',
        message: '',
        assertionResults: assertions.map(([title, status]) => ({
          ancestorTitles: [],
          title,
          fullName: title,
          status,
        })),
      },
    ],
  })
}

test('the test leg clears old results, reads every member JSON, records counts', async t => {
  const { source, out, temp } = await fixture(t)
  populatePin(source)
  writeFileSync(join(source, 'turbo.json'), JSON.stringify({ tasks: { test: {} } }))
  for (const index of MEMBERS.keys()) {
    mkdirSync(join(source, 'packages', `p${index}`), { recursive: true })
  }
  writeFileSync(join(source, 'packages/p5/vitest.config.ts'), 'test: { maxWorkers: 1, }\n')
  writeFileSync(join(source, 'packages/p12/vitest.config.ts'), 'test: {\n    maxWorkers: 4,\n}\n')
  const stalePath = join(source, 'packages/p0/test-results/gate-vitest.json')
  mkdirSync(dirname(stalePath), { recursive: true })
  writeFileSync(stalePath, '{"stale":true}')
  const { deps, turboCalls } = turboDeps({ temp, source })
  const run = deps.run
  let staleSeen = null
  deps.run = async (command, args, opts) => {
    if (args.includes('test') && args.includes('turbo')) {
      staleSeen = existsSync(stalePath)
      MEMBERS.forEach((name, index) => {
        if (name === '@vostride/agent-qa-arch') return
        const dir = `packages/p${index}`
        const file = join(source, dir, 'test-results/gate-vitest.json')
        mkdirSync(dirname(file), { recursive: true })
        const assertions = [['ok', 'passed']]
        if (name === 'agent-qa') assertions.push(['later', 'skipped'])
        writeFileSync(file, memberJson(source, dir, assertions))
      })
    }
    return run(command, args, opts)
  }
  const summary = await gate.runGate({ out, source, inPlace: true, only: ['turbo-test'] }, deps)
  assert.equal(staleSeen, false)
  const testCall = turboCalls.find(call => call.includes('test') && call.includes('--force'))
  const sep = testCall.indexOf('--')
  assert.ok(sep > 0)
  assert.deepEqual(testCall.slice(sep + 1), [
    '--reporter=default',
    '--reporter=json',
    '--outputFile.json=test-results/gate-vitest.json',
  ])
  assert.equal(summary.packages.length, 23)
  const cli = summary.packages.find(entry => entry.name === 'agent-qa')
  assert.equal(cli.executed, 1)
  assert.equal(cli.passed, 1)
  assert.equal(cli.skipped, 1)
  assert.match(cli.resultsSha256, /^[0-9a-f]{64}$/)
  const silent = summary.packages.find(entry => entry.name === '@vostride/agent-qa-arch')
  assert.equal(silent.executed, 0)
  assert.equal(silent.resultsFile, null)
  const missing = summary.findings.filter(f => f.rule === 'results-missing')
  assert.deepEqual(
    missing.map(f => f.detail.split(':')[0]),
    ['@vostride/agent-qa-arch'],
  )
  assert.ok(summary.findings.some(f => f.rule === 'unlisted-skip' && /^agent-qa:/.test(f.detail)))
  const leg = summary.legs.find(entry => entry.id === 'turbo-test')
  assert.equal(leg.executed, 22)
  assert.equal(leg.skipped, 1)
  assert.deepEqual(summary.concurrency, {
    turbo: 'default',
    workerLimits: { '@vostride/agent-qa-core': 1, '@vostride/agent-qa-knowledge-local': 4 },
  })
  assert.equal(
    summary.turbo.envDisposition.DO_NOT_TRACK,
    'stripped (strict env mode; not declared in turbo.json)',
  )
  const cliRaw = join(summary.runDir, 'raw', 'vitest-agent-qa.json.gz')
  assert.equal(JSON.parse(gunzipSync(readFileSync(cliRaw))).numPassedTests, 999)
})

test('a member JSON older than the test leg start is stale-results', async t => {
  const { source, out, temp } = await fixture(t)
  populatePin(source)
  for (const index of MEMBERS.keys()) {
    mkdirSync(join(source, 'packages', `p${index}`), { recursive: true })
  }
  const { deps } = turboDeps({ temp, source })
  const run = deps.run
  deps.run = async (command, args, opts) => {
    if (args.includes('test') && args.includes('turbo')) {
      MEMBERS.forEach((name, index) => {
        const dir = `packages/p${index}`
        const file = join(source, dir, 'test-results/gate-vitest.json')
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, memberJson(source, dir, [['ok', 'passed']]))
        if (name === 'agent-qa') utimesSync(file, new Date(0), new Date(0))
      })
    }
    return run(command, args, opts)
  }
  const summary = await gate.runGate({ out, source, inPlace: true, only: ['turbo-test'] }, deps)
  const stale = summary.findings.filter(f => f.rule === 'stale-results')
  assert.deepEqual(
    stale.map(f => f.detail.split(':')[0]),
    ['agent-qa'],
  )
})

test('the register is read from the measured clone and a stale entry there is red', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps } = fakeDeps({ temp })
  const run = deps.run
  deps.run = async (command, args, opts) => {
    const result = await run(command, args, opts)
    if (command === 'git' && args[0] === 'clone') {
      const entry = {
        runner: 'node-test',
        file: 'scripts/__tests__/b.test.mjs',
        fullName: 'gone',
        kind: 'skipped',
        reason: 'r',
        condition: 'c',
        conditional: false,
      }
      writeFileSync(
        join(args.at(-1), 'scripts/gate/inputs/register.json'),
        JSON.stringify({ schemaVersion: 2, entries: [entry] }),
      )
    }
    return result
  }
  const summary = await gate.runGate({ out, source, only: ['node-test'] }, deps)
  assert.deepEqual(summary.regressions, { cells: 0, passed: 0, missing: [], notPassed: [] })
  assert.equal(summary.register.entries, 1)
  assert.deepEqual(
    summary.register.stale.map(s => s.fullName),
    ['gone'],
  )
  assert.deepEqual(
    summary.findings.map(f => f.rule),
    ['stale-register-entry'],
  )
  assert.equal(summary.exitCode, 1)
})

test('the node:test JSON reporter gives every test its ancestors as fullName', async t => {
  const base = await mkdtemp(join(tmpdir(), 'agent-qa-gate-reporter-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const file = join(base, 'x.test.mjs')
  writeFileSync(
    file,
    [
      "import test, { describe, it } from 'node:test'",
      "describe('outer', () => { it('a', () => {}); describe('inner', () => { it.skip('b') }) })",
      "test('top', async t => { await t.test('child', () => {}) })",
    ].join('\n'),
  )
  const reporter = new URL('../gate/node-test-json.mjs', import.meta.url).pathname
  const destination = join(base, 'out.json')
  const { spawnSync } = await import('node:child_process')
  const { NODE_TEST_CONTEXT, NODE_TEST_WORKER_ID, ...env } = process.env
  const result = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${reporter}`, `--test-reporter-destination=${destination}`, file],
    { cwd: base, encoding: 'utf8', env },
  )
  assert.equal(result.status, 0, result.stderr)
  const written = JSON.parse(readFileSync(destination, 'utf8'))
  assert.equal(written.schemaVersion, 2)
  const tests = written.tests
  assert.deepEqual(
    tests.map(entry => [entry.fullName, entry.status]),
    [
      ['outer > a', 'passed'],
      ['outer > inner > b', 'skipped'],
      ['top > child', 'passed'],
      ['top', 'passed'],
    ],
  )
})

test('parseGateArgs rejects --repeat 1, --repeat x and --repeat with --in-place', () => {
  const messageOf = argv => {
    try {
      gate.parseGateArgs(argv)
    } catch (error) {
      return error.message
    }
    return '<no error>'
  }
  assert.match(messageOf(['--out', 'x', '--repeat', '1']), /invalid --repeat: 1/)
  assert.match(messageOf(['--out', 'x', '--repeat', 'x']), /invalid --repeat: x/)
  assert.match(
    messageOf(['--out', 'x', '--repeat', '3', '--in-place']),
    /--repeat cannot be combined with --in-place/,
  )
  assert.equal(gate.parseGateArgs(['--out', 'x', '--repeat', '3']).repeat, 3)
})

test('--repeat runs back to back on one SHA into one repeat directory with a summary', async t => {
  const { source, out, temp } = await fixture(t)
  const { deps, calls } = fakeDeps({ temp })
  const summary = await gate.runGate({ out, source, only: ['node-test'], repeat: 2 }, deps)
  const repeatDir = join(out, SHA, 'repeat-20261006T070809Z-42')
  for (const file of ['run-1/summary.json', 'run-2/summary.json', 'repeat-summary.json']) {
    assert.ok(existsSync(join(repeatDir, file)), file)
  }
  const written = JSON.parse(readFileSync(join(repeatDir, 'repeat-summary.json'), 'utf8'))
  assert.deepEqual(written, summary)
  assert.equal(summary.schemaVersion, 2)
  assert.equal(summary.sha, SHA)
  assert.equal(summary.n, 2)
  assert.equal(summary.record, false)
  assert.equal(summary.identical, true)
  assert.equal(summary.exitCode, 0)
  assert.deepEqual(
    summary.runs.map(entry => [entry.runDir, entry.exitCode]),
    [
      [join(repeatDir, 'run-1'), 0],
      [join(repeatDir, 'run-2'), 0],
    ],
  )
  assert.deepEqual(summary.perLegExecuted, { 'node-test': [1, 1] })
  const revParses = calls.filter(call => call.includes('rev-parse') && call.includes('--verify'))
  assert.deepEqual(
    revParses.map(call => call.at(-1)),
    ['HEAD^{commit}', `${SHA}^{commit}`, `${SHA}^{commit}`],
  )
  assert.equal(calls.filter(call => call[1] === 'clone').length, 2)
})

test('buildGateLegs lists every required leg in order and never a removed or mutation one', () => {
  const legs = gate.buildGateLegs({ root: '/clone/agent-qa', runDir: '/out/run' })
  assert.deepEqual(
    legs.map(leg => leg.id),
    REQUIRED_LEGS,
  )
  for (const leg of legs) {
    const words = [leg.id, ...leg.argv, ...(leg.dryRunArgv ?? [])].join(' ')
    assert.doesNotMatch(words, /mutation|eval-root-hygiene|release-gate/, leg.id)
  }
  const byId = Object.fromEntries(legs.map(leg => [leg.id, leg]))
  for (const id of ['validate:skills', 'validate:agents', 'validate:431-discovery-imports']) {
    assert.deepEqual(byId[id].argv, ['pnpm', 'run', id])
    assert.equal(byId[id].needsBuild, true)
  }
  assert.deepEqual(byId.conformance.argv, ['bash', 'scripts/396-conformance.sh'])
  assert.deepEqual(byId['conformance-selftest'].argv.slice(-1), ['--selftest'])
  assert.deepEqual(byId.audit.argv, ['pnpm', 'audit', '--prod', '--audit-level', 'high', '--json'])
  for (const id of ['conformance-selftest', 'conformance', 'audit']) {
    assert.equal(byId[id].needsBuild, false, id)
  }
  assert.deepEqual(
    gate.buildGateLegs({}).map(leg => leg.id),
    REQUIRED_LEGS,
  )
})

test('validator, conformance and audit legs read structured counts from their output', async t => {
  const { source, out, temp } = await fixture(t)
  populatePin(source)
  const runner = MEMBERS.indexOf('@vostride/agent-qa-runner')
  const toolsTest = 'src/tools/__tests__/validate-tools.test.ts'
  const scripts = {
    'validate:tools': `pnpm --filter @vostride/agent-qa-runner exec vitest run ${toolsTest}`,
  }
  writeFileSync(join(source, 'package.json'), JSON.stringify({ scripts }))
  const { deps } = turboDeps({ temp, source })
  const exec = deps.exec
  deps.exec = (command, args, opts) => {
    if (command === 'git' && args.includes('ls-files')) {
      const files = ['packages/a/src/x.ts', 'packages/a/dist/x.js', 'packages/a/package.json']
      return { status: 0, stdout: `${files.join('\0')}\0`, stderr: '' }
    }
    return exec(command, args, opts)
  }
  const skillsCount = { validator: 'skills', executed: 4, unit: 'skills' }
  const outputs = {
    'validate:skills': `AGENT_QA_GATE_COUNT ${JSON.stringify(skillsCount)}`,
    '--selftest': [
      '[396-conformance] S1 dead port: exit 1 (required nonzero) ✓',
      '[396-conformance] S2 truncated set: exit 1, G2 fired ✓',
      '[396-conformance] selftest: all four proofs failed as required',
    ].join('\n'),
    'scripts/396-conformance.sh': [
      'MCP conformance: 9/37 required server scenarios passed (24.3%)',
      '  scenarios executed   50 (37 required + 13 not scored)',
      '  baseline entries     41 (declared in packages/mcp/conformance-baseline.yaml)',
    ].join('\n'),
  }
  const audit = {
    advisories: {},
    metadata: {
      vulnerabilities: { info: 0, low: 1, moderate: 5, high: 0, critical: 0 },
      dependencies: 493,
    },
  }
  deps.run = async (command, args, { logPath, stdoutPath }) => {
    const key = args.findLast(arg => Object.hasOwn(outputs, arg))
    writeFileSync(logPath, `${key ? outputs[key] : 'ok'}\n`)
    const json = args.find(arg => arg.startsWith('--outputFile.json='))
    if (json) {
      const name = join(source, `packages/p${runner}`, toolsTest)
      const results = [
        { name, status: 'passed', assertionResults: [{ title: 't', status: 'passed' }] },
      ]
      const report = JSON.stringify({ success: true, testResults: results })
      writeFileSync(json.slice(json.indexOf('=') + 1), report)
    }
    if (command === 'pnpm' && args[0] === 'audit') writeFileSync(stdoutPath, JSON.stringify(audit))
    return { exitCode: command === 'pnpm' && args[0] === 'audit' ? 1 : 0, durationMs: 1 }
  }
  const only = [
    'validate:skills',
    'validate:tools',
    'lint:namespace',
    'conformance-selftest',
    'conformance',
    'audit',
  ]
  const summary = await gate.runGate({ out, source, inPlace: true, only }, deps)
  assert.deepEqual(summary.findings, [])
  const executed = Object.fromEntries(summary.legs.map(leg => [leg.id, leg.executed]))
  assert.deepEqual(executed, {
    'validate:skills': 4,
    'validate:tools': 1,
    'lint:namespace': 2,
    'conformance-selftest': 2,
    conformance: 50,
    audit: 493,
  })
  const auditLeg = summary.legs.find(leg => leg.id === 'audit')
  assert.equal(auditLeg.high, 0)
  assert.equal(auditLeg.critical, 0)
  const raw = join(summary.runDir, 'raw', 'audit.json.gz')
  assert.equal(JSON.parse(gunzipSync(readFileSync(raw))).metadata.dependencies, 493)
  assert.equal(summary.legs.find(leg => leg.id === 'conformance').baselineEntries, 41)
})
