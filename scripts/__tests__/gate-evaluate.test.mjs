import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  REQUIRED_LEGS,
  classifyNodeTest,
  evaluateGate,
  expectedTurboTasks,
  nodeTestFindings,
  orderRootCause,
  packageSetFindings,
  registerFindings,
  turboFindings,
  validateRegister,
} from '../gate/evaluate.mjs'
import * as gateRules from '../gate/evaluate.mjs'

const PACKAGE_PIN = JSON.parse(
  readFileSync(new URL('../gate/inputs/packages.json', import.meta.url), 'utf8'),
).members

const PINNED = ['a.test.mjs', 'b.test.mjs']

function report(tests) {
  return { schemaVersion: 2, tests, summary: null }
}

function cell(file, name, status) {
  return { file: `/clone/agent-qa/scripts/__tests__/${file}`, name, nesting: 0, status }
}

function greenReport() {
  return report([
    cell('a.test.mjs', 'one', 'passed'),
    cell('a.test.mjs', 'two', 'passed'),
    cell('b.test.mjs', 'three', 'passed'),
  ])
}

function rules(findings) {
  return findings.map(f => f.rule)
}

test('a green node:test report with the pinned files on disk has no findings', () => {
  const { counts, findings } = nodeTestFindings(greenReport(), {
    pinnedFiles: PINNED,
    onDiskFiles: PINNED,
    exitCode: 0,
  })
  assert.deepEqual(findings, [])
  assert.equal(counts.executed, 3)
  assert.equal(counts.passed, 3)
})

test('a report with no passed and no failed tests is zero-executed', () => {
  const { findings } = nodeTestFindings(report([]), {
    pinnedFiles: PINNED,
    onDiskFiles: PINNED,
    exitCode: 0,
  })
  assert.deepEqual(rules(findings), ['zero-executed'])
})

test('a pinned file absent on disk is a node-test-files-mismatch naming it', () => {
  const { findings } = nodeTestFindings(greenReport(), {
    pinnedFiles: [...PINNED, 'gone.test.mjs'],
    onDiskFiles: PINNED,
    exitCode: 0,
  })
  assert.deepEqual(rules(findings), ['node-test-files-mismatch'])
  assert.match(findings[0].detail, /gone\.test\.mjs/)
})

test('an on-disk file absent from the pin is a node-test-files-mismatch naming it', () => {
  const { findings } = nodeTestFindings(greenReport(), {
    pinnedFiles: PINNED,
    onDiskFiles: [...PINNED, 'new.test.mjs'],
    exitCode: 0,
  })
  assert.deepEqual(rules(findings), ['node-test-files-mismatch'])
  assert.match(findings[0].detail, /new\.test\.mjs/)
})

test('skipped, todo and cancelled tests keep their own columns and never count as passed', () => {
  const input = report([
    cell('a.test.mjs', 'ran', 'passed'),
    cell('a.test.mjs', 'skipped one', 'skipped'),
    cell('b.test.mjs', 'todo one', 'todo'),
    cell('b.test.mjs', 'cancelled one', 'cancelled'),
  ])
  const counts = classifyNodeTest(input)
  assert.equal(counts.passed, 1)
  assert.equal(counts.executed, 1)
  assert.equal(counts.skipped, 1)
  assert.equal(counts.todo, 1)
  assert.equal(counts.notRun, 1)

  const { findings, cells } = nodeTestFindings(input, {
    pinnedFiles: PINNED,
    onDiskFiles: PINNED,
    exitCode: 0,
    rootDir: '/clone/agent-qa',
  })
  assert.deepEqual(findings, [])
  assert.deepEqual(cells[1], {
    file: 'scripts/__tests__/a.test.mjs',
    name: 'skipped one',
    fullName: 'skipped one',
    nesting: 0,
    status: 'skipped',
  })
})

test('a missing report is results-missing', () => {
  const { findings } = nodeTestFindings(null, {
    pinnedFiles: PINNED,
    onDiskFiles: PINNED,
    exitCode: 0,
  })
  assert.deepEqual(rules(findings), ['results-missing'])
})

test('a non-zero leg exit is leg-exit-nonzero', () => {
  const { findings } = nodeTestFindings(greenReport(), {
    pinnedFiles: PINNED,
    onDiskFiles: PINNED,
    exitCode: 1,
  })
  assert.deepEqual(rules(findings), ['leg-exit-nonzero'])
})

test('a failed test is a finding even when the exit code says 0', () => {
  const { counts, findings } = nodeTestFindings(
    report([cell('a.test.mjs', 'one', 'passed'), cell('b.test.mjs', 'broken', 'failed')]),
    { pinnedFiles: PINNED, onDiskFiles: PINNED, exitCode: 0 },
  )
  assert.equal(counts.failed, 1)
  assert.deepEqual(rules(findings), ['test-failed'])
})

test('REQUIRED_LEGS names the 14 legs in run order', () => {
  assert.equal(REQUIRED_LEGS.length, 14)
  assert.equal(REQUIRED_LEGS[0], 'turbo-build-typecheck')
  assert.equal(REQUIRED_LEGS.at(-1), 'audit')
  assert.ok(REQUIRED_LEGS.includes('node-test'))
})

test('a non-partial run lacking required legs is leg-missing for each one', () => {
  const { findings, exitCode } = evaluateGate({
    legs: [{ id: 'node-test', findings: [] }],
    partial: false,
  })
  const missing = findings.filter(f => f.rule === 'leg-missing').map(f => f.leg)
  assert.deepEqual(
    missing,
    REQUIRED_LEGS.filter(id => id !== 'node-test'),
  )
  assert.equal(exitCode, 1)
})

test('a partial run reports no leg-missing for unselected legs', () => {
  const { findings, exitCode } = evaluateGate({
    legs: [{ id: 'node-test', findings: [] }],
    partial: true,
    selected: ['node-test'],
  })
  assert.deepEqual(findings, [])
  assert.equal(exitCode, 0)
})

test('a partial run whose selected leg never ran is leg-missing', () => {
  const { findings } = evaluateGate({ legs: [], partial: true, selected: ['node-test'] })
  assert.deepEqual(rules(findings), ['leg-missing'])
})

test('evaluateGate exits 1 whenever any finding exists, and 0 only when none do', () => {
  const allGreen = REQUIRED_LEGS.map(id => ({ id, findings: [] }))
  assert.deepEqual(evaluateGate({ legs: allGreen, partial: false }), { findings: [], exitCode: 0 })

  const oneRed = allGreen.map(leg =>
    leg.id === 'audit' ? { ...leg, findings: [{ rule: 'leg-exit-nonzero', leg: 'audit' }] } : leg,
  )
  assert.equal(evaluateGate({ legs: oneRed, partial: false }).exitCode, 1)

  const stepRed = evaluateGate({
    legs: allGreen,
    steps: [{ id: 'install', findings: [{ rule: 'install-failed', leg: 'install' }] }],
    partial: false,
  })
  assert.deepEqual(rules(stepRed.findings), ['install-failed'])
  assert.equal(stepRed.exitCode, 1)
})

test('evaluateGate reports every finding rather than stopping at the first', () => {
  const legs = [
    { id: 'node-test', findings: [{ rule: 'zero-executed', leg: 'node-test' }] },
    { id: 'audit', findings: [{ rule: 'leg-exit-nonzero', leg: 'audit' }] },
  ]
  const { findings } = evaluateGate({ legs, partial: true, selected: ['node-test', 'audit'] })
  assert.deepEqual(rules(findings), ['zero-executed', 'leg-exit-nonzero'])
})

function dryRun(tasks, packages = ['a', 'b']) {
  return { packages, tasks: tasks.map(([taskId, command]) => ({ taskId, command })) }
}

function runSummary(tasks, execution = {}) {
  const ran = tasks.map(([taskId, exitCode, status = 'MISS']) => ({
    taskId,
    execution: { exitCode },
    cache: { status },
  }))
  const success = ran.filter(task => task.execution.exitCode === 0).length
  return {
    execution: {
      attempted: ran.length,
      success,
      failed: ran.length - success,
      cached: 0,
      exitCode: success === ran.length ? 0 : 1,
      ...execution,
    },
    tasks: ran,
  }
}

const TWO_TASKS = dryRun([
  ['a#build', 'tsup'],
  ['a#typecheck', 'tsc --noEmit'],
  ['b#build', '<NONEXISTENT>'],
])

test('the package pin names 23 sorted members including agent-qa and arch', () => {
  assert.equal(PACKAGE_PIN.length, 23)
  assert.deepEqual([...PACKAGE_PIN].sort(), PACKAGE_PIN)
  for (const name of ['agent-qa', '@vostride/agent-qa-arch']) {
    assert.ok(PACKAGE_PIN.includes(name), name)
  }
})

test('expectedTurboTasks drops <NONEXISTENT> tasks and keeps the rest', () => {
  assert.deepEqual(expectedTurboTasks(TWO_TASKS), ['a#build', 'a#typecheck'])
})

test('an expected task absent from the run summary is cancelled-or-missing', () => {
  const findings = turboFindings({
    legId: 'turbo-test',
    dryRun: TWO_TASKS,
    runSummary: runSummary([['a#build', 0]], { attempted: 2, failed: 1, success: 1 }),
  })
  assert.deepEqual(rules(findings), ['cancelled-or-missing'])
  assert.match(findings[0].detail, /a#typecheck/)
})

test('a task with a non-zero exit code is task-failed', () => {
  const findings = turboFindings({
    legId: 'turbo-build-typecheck',
    dryRun: TWO_TASKS,
    runSummary: runSummary([
      ['a#build', 0],
      ['a#typecheck', 1],
    ]),
    exitCode: 1,
  })
  assert.deepEqual(rules(findings), ['task-failed'])
  assert.equal(findings[0].taskId, 'a#typecheck')
})

test('attempted not equal to success + failed + cached is unaccounted-tasks', () => {
  const findings = turboFindings({
    legId: 'turbo-build-typecheck',
    dryRun: TWO_TASKS,
    runSummary: runSummary(
      [
        ['a#build', 0],
        ['a#typecheck', 0],
      ],
      { attempted: 3, success: 1, failed: 1, cached: 0 },
    ),
  })
  assert.deepEqual(rules(findings), ['unaccounted-tasks'])
})

test('a cached task is red under a forced run', () => {
  const findings = turboFindings({
    legId: 'turbo-build-typecheck',
    dryRun: TWO_TASKS,
    runSummary: runSummary(
      [
        ['a#build', 0, 'HIT'],
        ['a#typecheck', 0],
      ],
      { attempted: 2, success: 1, failed: 0, cached: 1 },
    ),
  })
  assert.deepEqual(rules(findings), ['cached'])
  assert.match(findings[0].detail, /a#build/)
})

test('a clean forced run summary has no turbo findings', () => {
  const findings = turboFindings({
    legId: 'turbo-build-typecheck',
    dryRun: TWO_TASKS,
    runSummary: runSummary([
      ['a#build', 0],
      ['a#typecheck', 0],
    ]),
    exitCode: 0,
  })
  assert.deepEqual(findings, [])
})

test('a dry run with zero tasks (a filter matching nothing) is a package-set-mismatch', () => {
  const empty = { packages: [], tasks: [] }
  const findings = packageSetFindings({
    leg: 'turbo-build-typecheck',
    pinned: PACKAGE_PIN,
    dryRunPackages: empty.packages,
  })
  assert.deepEqual(rules(findings), ['package-set-mismatch'])
  assert.match(findings[0].detail, /turbo dry-run packages: missing .*@vostride\/agent-qa-arch/)
  const turbo = turboFindings({
    legId: 'turbo-build-typecheck',
    dryRun: empty,
    runSummary: runSummary([]),
    exitCode: 0,
  })
  assert.deepEqual(rules(turbo), ['zero-executed'])
})

test('a pnpm listing off the pin, or a differing dry run, names the source and names', () => {
  const missing = packageSetFindings({
    pinned: PACKAGE_PIN,
    pnpmMembers: PACKAGE_PIN.filter(name => name !== '@vostride/agent-qa-arch'),
  })
  assert.deepEqual(rules(missing), ['package-set-mismatch'])
  assert.match(missing[0].detail, /^pnpm workspace listing: missing @vostride\/agent-qa-arch$/)

  const extra = packageSetFindings({ pinned: PACKAGE_PIN, pnpmMembers: [...PACKAGE_PIN, 'x'] })
  assert.deepEqual(rules(extra), ['package-set-mismatch'])
  assert.match(extra[0].detail, /^pnpm workspace listing: extra x$/)

  const dry = packageSetFindings({
    pinned: PACKAGE_PIN,
    pnpmMembers: PACKAGE_PIN,
    dryRunPackages: PACKAGE_PIN.filter(name => name !== 'agent-qa'),
  })
  assert.deepEqual(rules(dry), ['package-set-mismatch'])
  assert.match(dry[0].detail, /^turbo dry-run packages: missing agent-qa$/)

  const all = { pinned: PACKAGE_PIN, pnpmMembers: PACKAGE_PIN, dryRunPackages: PACKAGE_PIN }
  assert.deepEqual(packageSetFindings(all), [])
})

test('orderRootCause lists failed #build tasks first and as the root cause', () => {
  const input = [
    { rule: 'unlisted-skip', leg: 'turbo-test', detail: 'x' },
    { rule: 'task-failed', leg: 'turbo-test', detail: 'a#test exited 1', taskId: 'a#test' },
    { rule: 'task-failed', leg: 'turbo-test', detail: 'b#build exited 1', taskId: 'b#build' },
  ]
  const { findings, rootCause } = orderRootCause(input)
  assert.deepEqual(
    findings.map(f => f.taskId ?? f.rule),
    ['b#build', 'unlisted-skip', 'a#test'],
  )
  assert.deepEqual(rootCause.map(f => f.taskId), ['b#build'])
  assert.deepEqual(orderRootCause([input[0]]).rootCause, [])
})

const ROOT = '/private/var/clone/agent-qa'

function vitestJson(files, success = true) {
  return {
    numTotalTests: 0,
    numPassedTests: 0,
    numPendingTests: 0,
    success,
    testResults: files.map(([name, status, assertions, message = '']) => ({
      name: `${ROOT}/${name}`,
      status,
      message,
      assertionResults: assertions.map(([title, state]) => ({
        ancestorTitles: ['suite'],
        title,
        fullName: `suite ${title}`,
        status: state,
      })),
    })),
  }
}

test('classifyVitest counts by status and keeps relative file, fullName and status', () => {
  assert.equal(typeof gateRules.classifyVitest, 'function')
  const json = vitestJson([
    [
      'packages/x/src/a.test.ts',
      'failed',
      [
        ['p1', 'passed'],
        ['p2', 'passed'],
        ['f1', 'failed'],
      ],
    ],
    [
      'packages/x/src/b.test.ts',
      'passed',
      [
        ['s1', 'skipped'],
        ['t1', 'todo'],
        ['q1', 'pending'],
      ],
    ],
  ])
  json.numPassedTests = 99
  json.numPendingTests = 99
  const counts = gateRules.classifyVitest(json, ROOT)
  assert.equal(counts.executed, 3)
  assert.equal(counts.passed, 2)
  assert.equal(counts.failed, 1)
  assert.equal(counts.skipped, 1)
  assert.equal(counts.todo, 1)
  assert.equal(counts.notRun, 1)
  assert.deepEqual(counts.cells[0], {
    file: 'packages/x/src/a.test.ts',
    fullName: 'suite p1',
    status: 'passed',
  })
})

test('a vitest JSON with clean counts but success false is success-false', () => {
  assert.equal(typeof gateRules.vitestFindings, 'function')
  const json = vitestJson([['packages/x/src/a.test.ts', 'passed', [['p1', 'passed']]]], false)
  const findings = gateRules.vitestFindings('x', gateRules.classifyVitest(json, ROOT))
  assert.deepEqual(rules(findings), ['success-false'])
  assert.match(findings[0].detail, /^x:/)
})

test('a failed file with no assertions is file-failed naming the file and its message', () => {
  assert.equal(typeof gateRules.vitestFindings, 'function')
  const json = vitestJson(
    [
      ['packages/x/src/a.test.ts', 'passed', [['p1', 'passed']]],
      ['packages/x/src/posture.test.ts', 'failed', [], 'ENOENT: no such file, open demo/init'],
    ],
    false,
  )
  const findings = gateRules.vitestFindings('x', gateRules.classifyVitest(json, ROOT))
  assert.deepEqual(rules(findings), ['file-failed'])
  assert.match(findings[0].detail, /packages\/x\/src\/posture\.test\.ts/)
  assert.match(findings[0].detail, /ENOENT/)
})

test('an all-skipped member is zero-executed and skips never count as passed', () => {
  assert.equal(typeof gateRules.vitestFindings, 'function')
  const json = vitestJson([
    [
      'packages/x/src/a.test.ts',
      'passed',
      [
        ['s1', 'skipped'],
        ['s2', 'skipped'],
      ],
    ],
  ])
  const counts = gateRules.classifyVitest(json, ROOT)
  assert.equal(counts.passed, 0)
  assert.equal(counts.executed, 0)
  const findings = gateRules.vitestFindings('x', counts)
  assert.deepEqual(rules(findings), ['zero-executed'])
  const cells = counts.cells.map(c => ({ runner: 'vitest', member: 'x', ...c }))
  const judged = registerFindings({ cells, register: emptyRegister(), legsRan: ['turbo-test'] })
  assert.deepEqual(rules(judged.findings), ['unlisted-skip', 'unlisted-skip'])
})

test('no JSON is results-missing and a JSON older than the leg is stale-results', () => {
  assert.equal(typeof gateRules.vitestFindings, 'function')
  assert.equal(typeof gateRules.staleResultFindings, 'function')
  assert.deepEqual(rules(gateRules.vitestFindings('x', null)), ['results-missing'])
  const stale = gateRules.staleResultFindings(
    [
      { member: 'x', file: 'packages/x/test-results/gate-vitest.json', mtimeMs: 900 },
      { member: 'y', file: 'packages/y/test-results/gate-vitest.json', mtimeMs: 1100 },
      { member: 'z', file: null, mtimeMs: null },
    ],
    1000,
  )
  assert.deepEqual(rules(stale), ['stale-results'])
  assert.match(stale[0].detail, /^x:/)
})

test('under strict env mode CI passes as a turbo built-in and DO_NOT_TRACK is stripped', () => {
  assert.equal(typeof gateRules.turboEnvDisposition, 'function')
  const disposition = gateRules.turboEnvDisposition({
    turboJson: { tasks: { build: { dependsOn: ['^build'] }, test: {} } },
    envMode: 'strict',
    gateEnv: { CI: 'true', DO_NOT_TRACK: '1' },
  })
  assert.deepEqual(disposition, {
    CI: 'passed (turbo built-in)',
    DO_NOT_TRACK: 'stripped (strict env mode; not declared in turbo.json)',
  })
  const declared = gateRules.turboEnvDisposition({
    turboJson: { globalPassThroughEnv: ['DO_NOT_TRACK'], tasks: {} },
    envMode: 'strict',
    gateEnv: { DO_NOT_TRACK: '1' },
  })
  assert.match(declared.DO_NOT_TRACK, /^passed/)
})

function emptyRegister(entries = []) {
  return { schemaVersion: 2, entries }
}

function vcell(fullName, status, file = 'packages/cli/src/a.test.ts') {
  return { runner: 'vitest', member: 'agent-qa', file, fullName, status }
}

function ncell(fullName, status, file = 'scripts/__tests__/a.test.mjs') {
  return { runner: 'node-test', file, fullName, status }
}

function entry(cellLike, overrides = {}) {
  return {
    runner: cellLike.runner,
    file: cellLike.file,
    fullName: cellLike.fullName,
    kind: 'skipped',
    reason: 'needs a live model',
    condition: 'AGENT_QA_LIVE unset',
    conditional: false,
    ...overrides,
  }
}

const BOTH_LEGS = ['turbo-test', 'node-test']

test('an unregistered skipped, todo, pending or cancelled cell is unlisted-skip by kind', () => {
  const cells = [
    vcell('suite ran', 'passed'),
    vcell('suite skipped', 'skipped'),
    vcell('suite todo', 'todo'),
    vcell('suite pending', 'notRun'),
    ncell('outer > cancelled', 'cancelled'),
  ]
  const { findings, register } = registerFindings({
    cells,
    register: emptyRegister(),
    legsRan: BOTH_LEGS,
  })
  assert.deepEqual(rules(findings), Array(4).fill('unlisted-skip'))
  assert.deepEqual(
    findings.map(f => [f.leg, f.detail]),
    [
      ['turbo-test', 'agent-qa: packages/cli/src/a.test.ts > suite skipped (skipped)'],
      ['turbo-test', 'agent-qa: packages/cli/src/a.test.ts > suite todo (todo)'],
      ['turbo-test', 'agent-qa: packages/cli/src/a.test.ts > suite pending (notRun)'],
      ['node-test', 'scripts/__tests__/a.test.mjs > outer > cancelled (notRun)'],
    ],
  )
  assert.deepEqual(
    register.unlisted.map(u => u.kind),
    ['skipped', 'todo', 'notRun', 'notRun'],
  )
})

test('a skipped cell listed with matching runner, file and fullName is matched, not red', () => {
  const skipped = vcell('suite live call', 'skipped')
  const { findings, register } = registerFindings({
    cells: [vcell('suite ran', 'passed'), skipped],
    register: emptyRegister([entry(skipped)]),
    legsRan: BOTH_LEGS,
  })
  assert.deepEqual(findings, [])
  assert.equal(register.entries, 1)
  assert.equal(register.matched, 1)
  assert.deepEqual(register.stale, [])
  assert.deepEqual(register.unlisted, [])
  const otherFile = registerFindings({
    cells: [skipped],
    register: emptyRegister([entry({ ...skipped, file: 'packages/cli/src/b.test.ts' })]),
    legsRan: BOTH_LEGS,
  })
  assert.deepEqual(rules(otherFile.findings), ['unlisted-skip', 'stale-register-entry'])
})

test('a listed non-conditional cell that ran, or that is gone, is stale-register-entry', () => {
  const passed = vcell('suite now runs', 'passed')
  const failed = ncell('now fails', 'failed')
  const gone = vcell('suite renamed away', 'skipped')
  const { findings, register } = registerFindings({
    cells: [passed, failed],
    register: emptyRegister([entry(passed), entry(failed), entry(gone)]),
    legsRan: BOTH_LEGS,
  })
  assert.deepEqual(rules(findings), [
    'stale-register-entry',
    'stale-register-entry',
    'stale-register-entry',
  ])
  assert.match(findings[0].detail, /suite now runs is listed as skipped but ran \(passed\)$/)
  assert.match(findings[1].detail, /now fails is listed as skipped but ran \(failed\)$/)
  assert.match(findings[2].detail, /suite renamed away .* is no longer in the turbo-test results$/)
  assert.deepEqual(
    register.stale.map(s => s.fullName),
    ['suite now runs', 'now fails', 'suite renamed away'],
  )
})

test('a conditional entry may run and pass; when it fails only the leg failure stands', () => {
  const firefox = vcell('suite firefox smoke', 'passed')
  const webkit = vcell('suite webkit smoke', 'failed')
  const { findings, register } = registerFindings({
    cells: [firefox, webkit],
    register: emptyRegister([
      entry(firefox, { conditional: true, reason: 'optional browser', condition: 'no Firefox' }),
      entry(webkit, { conditional: true, reason: 'optional browser', condition: 'no WebKit' }),
    ]),
    legsRan: BOTH_LEGS,
  })
  assert.deepEqual(findings, [])
  assert.equal(register.conditionalRan, 1)
  assert.deepEqual(register.stale, [])
  const leg = gateRules.vitestFindings('agent-qa', {
    success: false,
    executed: 2,
    fileFailures: [],
    cells: [firefox, webkit],
  })
  assert.deepEqual(rules(leg), ['test-failed'])
})

test('an entry with no reason or condition, or an unknown kind or runner, is invalid', () => {
  const base = vcell('suite x', 'skipped')
  const findings = validateRegister(
    emptyRegister([
      entry(base, { reason: '' }),
      entry(base, { fullName: 'suite y', condition: '  ' }),
      entry(base, { fullName: 'suite z', kind: 'flaky' }),
      entry(base, { fullName: 'suite w', runner: 'jest' }),
      entry(base, { fullName: 'suite ok' }),
      entry(base, { fullName: 'suite ok' }),
    ]),
  )
  assert.deepEqual(rules(findings), Array(5).fill('register-entry-invalid'))
  assert.deepEqual(
    findings.map(f => f.detail.replace(/^entries\[(\d)\].*: /, '$1 ')),
    [
      '0 missing reason',
      '1 missing condition',
      '2 unknown kind flaky',
      '3 unknown runner jest',
      '5 duplicate entry',
    ],
  )
  assert.deepEqual(validateRegister(emptyRegister([entry(base)])), [])
  assert.deepEqual(rules(validateRegister(null)), ['register-entry-invalid'])
  for (const schemaVersion of [1, 3]) {
    assert.deepEqual(rules(validateRegister({ schemaVersion, entries: [] })), [
      'register-entry-invalid',
    ])
  }
})

test('a vitest entry is not judged when the turbo-test leg did not run', () => {
  const skipped = vcell('suite live call', 'skipped')
  const listedGone = vcell('suite listed only', 'skipped')
  const { findings, register } = registerFindings({
    cells: [skipped, ncell('one', 'passed')],
    register: emptyRegister([entry(listedGone)]),
    legsRan: ['node-test'],
  })
  assert.deepEqual(findings, [])
  assert.deepEqual(register.stale, [])
  assert.deepEqual(register.unlisted, [])
})

function regressionList(cells) {
  return { schemaVersion: 2, cells }
}

function named(cellLike, origin = '434 D-14 census') {
  return { runner: cellLike.runner, file: cellLike.file, fullName: cellLike.fullName, origin }
}

test('a listed regression cell that passed has no finding and is counted', () => {
  assert.equal(typeof gateRules.regressionFindings, 'function')
  const cell = vcell('suite aria labels', 'passed')
  const { findings, regressions } = gateRules.regressionFindings({
    cells: [cell, ncell('other', 'passed')],
    list: regressionList([named(cell)]),
    legsRan: BOTH_LEGS,
  })
  assert.deepEqual(findings, [])
  assert.equal(regressions.cells, 1)
  assert.equal(regressions.passed, 1)
  assert.deepEqual(regressions.missing, [])
  assert.deepEqual(regressions.notPassed, [])
})

test('a listed regression cell absent from its leg results is named-cell-missing', () => {
  assert.equal(typeof gateRules.regressionFindings, 'function')
  const renamed = vcell('suite aria labels', 'passed')
  const { findings, regressions } = gateRules.regressionFindings({
    cells: [{ ...renamed, fullName: 'suite aria labels (renamed)' }],
    list: regressionList([named(renamed), named(ncell('deleted', 'passed'))]),
    legsRan: BOTH_LEGS,
  })
  assert.deepEqual(rules(findings), ['named-cell-missing', 'named-cell-missing'])
  assert.deepEqual(
    findings.map(f => f.leg),
    ['turbo-test', 'node-test'],
  )
  assert.match(findings[0].detail, /packages\/cli\/src\/a\.test\.ts > suite aria labels/)
  assert.equal(regressions.missing.length, 2)
})

test('a listed regression cell skipped, todo, pending or failed is named-cell-not-passed', () => {
  assert.equal(typeof gateRules.regressionFindings, 'function')
  const cells = [
    vcell('suite skipped one', 'skipped'),
    vcell('suite todo one', 'todo'),
    vcell('suite pending one', 'notRun'),
    ncell('failed one', 'failed'),
  ]
  const { findings, regressions } = gateRules.regressionFindings({
    cells,
    list: regressionList(cells.map(cell => named(cell))),
    legsRan: BOTH_LEGS,
  })
  assert.deepEqual(rules(findings), Array(4).fill('named-cell-not-passed'))
  assert.deepEqual(
    regressions.notPassed.map(entry => entry.status),
    ['skipped', 'todo', 'notRun', 'failed'],
  )
  assert.match(findings[0].detail, /suite skipped one .*\(skipped\)$/)
  assert.equal(regressions.passed, 0)
})

test('a duplicate regression entry, or one missing file, fullName or origin, is invalid', () => {
  assert.equal(typeof gateRules.validateRegressions, 'function')
  const cell = vcell('suite x', 'passed')
  const findings = gateRules.validateRegressions(
    regressionList([
      named(cell),
      named(cell),
      { ...named(cell), fullName: 'suite y', file: '' },
      { ...named(cell), fullName: '' },
      { ...named(cell), fullName: 'suite z', origin: ' ' },
    ]),
  )
  assert.deepEqual(rules(findings), Array(4).fill('regression-entry-invalid'))
  assert.deepEqual(
    findings.map(f => f.detail.replace(/^cells\[(\d)\].*: /, '$1 ')),
    ['1 duplicate entry', '2 missing file', '3 missing fullName', '4 missing origin'],
  )
  assert.deepEqual(gateRules.validateRegressions(regressionList([named(cell)])), [])
  assert.deepEqual(rules(gateRules.validateRegressions(null)), ['regression-entry-invalid'])
  for (const schemaVersion of [1, 3]) {
    assert.deepEqual(rules(gateRules.validateRegressions({ schemaVersion, cells: [] })), [
      'regression-entry-invalid',
    ])
  }
})

test('a listed vitest regression cell is not judged when the turbo-test leg did not run', () => {
  assert.equal(typeof gateRules.regressionFindings, 'function')
  const { findings, regressions } = gateRules.regressionFindings({
    cells: [ncell('one', 'passed')],
    list: regressionList([named(vcell('suite not measured', 'passed'))]),
    legsRan: ['node-test'],
  })
  assert.deepEqual(findings, [])
  assert.deepEqual(regressions.missing, [])
  assert.equal(regressions.passed, 0)
})

function runSummaryOf({ sha = 'a'.repeat(40), exitCode = 0, cli = 4699, nodeTest = 137 } = {}) {
  return {
    sha,
    exitCode,
    record: true,
    packages: [
      { name: '@vostride/agent-qa-core', executed: 746 },
      { name: 'agent-qa', executed: cli },
    ],
    legs: [
      { id: 'turbo-build-typecheck', executed: 46 },
      { id: 'turbo-test', executed: 746 + cli },
      { id: 'node-test', executed: nodeTest },
    ],
  }
}

test('three green runs with identical executed counts compare identical with no finding', () => {
  assert.equal(typeof gateRules.compareRuns, 'function')
  const result = gateRules.compareRuns([runSummaryOf(), runSummaryOf(), runSummaryOf()])
  assert.deepEqual(result.findings, [])
  assert.equal(result.identical, true)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.perPackageExecuted, {
    '@vostride/agent-qa-core': [746, 746, 746],
    'agent-qa': [4699, 4699, 4699],
  })
  assert.deepEqual(result.perLegExecuted['node-test'], [137, 137, 137])
})

test('a member whose executed count differs in run 2 is repeat-count-mismatch with all values', () => {
  assert.equal(typeof gateRules.compareRuns, 'function')
  const result = gateRules.compareRuns([
    runSummaryOf(),
    runSummaryOf({ cli: 4698 }),
    runSummaryOf(),
  ])
  const mismatches = result.findings.filter(f => f.rule === 'repeat-count-mismatch')
  assert.match(mismatches[0].detail, /^member agent-qa executed 4699, 4698, 4699$/)
  assert.match(mismatches[1].detail, /^leg turbo-test executed 5445, 5444, 5445$/)
  assert.equal(mismatches.length, 2)
  assert.equal(result.identical, false)
  assert.equal(result.exitCode, 1)
})

test('a red run is repeat-run-red and runs on different SHAs are repeat-sha-mismatch', () => {
  assert.equal(typeof gateRules.compareRuns, 'function')
  const red = gateRules.compareRuns([runSummaryOf(), runSummaryOf({ exitCode: 1 })])
  assert.deepEqual(rules(red.findings), ['repeat-run-red'])
  assert.match(red.findings[0].detail, /^run 2 exited 1$/)
  assert.equal(red.identical, true)
  assert.equal(red.exitCode, 1)
  const shas = gateRules.compareRuns([runSummaryOf(), runSummaryOf({ sha: 'b'.repeat(40) })])
  assert.deepEqual(rules(shas.findings), ['repeat-sha-mismatch'])
  assert.match(shas.findings[0].detail, /a{40}, b{40}/)
})

const ARCH_FILES = ['src/__tests__/validate-arch.test.ts', 'src/__tests__/412-x.test.ts']

function validatorJson(files, success = true) {
  return vitestJson(
    files.map(([file, assertions]) => [`packages/arch/${file}`, 'passed', assertions]),
    success,
  )
}

function validatorInput(json, overrides = {}) {
  return {
    legId: 'validate:arch',
    json,
    expectedFiles: ARCH_FILES.map(file => `${ROOT}/packages/arch/${file}`),
    rootDir: ROOT,
    exitCode: 0,
    register: emptyRegister(),
    ...overrides,
  }
}

test('a validator that wrote no vitest JSON is empty-filter', () => {
  assert.equal(typeof gateRules.vitestValidatorFindings, 'function')
  const { findings, counts } = gateRules.vitestValidatorFindings(validatorInput(null))
  assert.deepEqual(rules(findings), ['empty-filter'])
  assert.equal(findings[0].leg, 'validate:arch')
  assert.equal(counts.executed, 0)
})

test('a validator JSON naming exactly the script files, executed and successful, is green', () => {
  assert.equal(typeof gateRules.vitestValidatorFindings, 'function')
  const json = validatorJson(ARCH_FILES.map(file => [file, [['p1', 'passed']]]))
  const { findings, counts } = gateRules.vitestValidatorFindings(validatorInput(json))
  assert.deepEqual(findings, [])
  assert.equal(counts.executed, 2)
  assert.equal(counts.testFiles, 2)
  assert.equal(counts.expected, 2)
})

test('a script file missing from the validator JSON, or an extra file, is files-mismatch', () => {
  assert.equal(typeof gateRules.vitestValidatorFindings, 'function')
  const dropped = validatorJson([[ARCH_FILES[0], [['p1', 'passed']]]])
  const missing = gateRules.vitestValidatorFindings(validatorInput(dropped)).findings
  assert.deepEqual(rules(missing), ['validator-files-mismatch'])
  assert.match(missing[0].detail, /packages\/arch\/src\/__tests__\/412-x\.test\.ts is named/)
  const extraFile = 'src/__tests__/stray.test.ts'
  const grown = validatorJson([...ARCH_FILES, extraFile].map(file => [file, [['p', 'passed']]]))
  const extra = gateRules.vitestValidatorFindings(validatorInput(grown)).findings
  assert.deepEqual(rules(extra), ['validator-files-mismatch'])
  assert.match(extra[0].detail, /stray\.test\.ts ran but is not named by the script/)
})

test('a validator JSON that executed 0 tests, or reports success false, is red', () => {
  assert.equal(typeof gateRules.vitestValidatorFindings, 'function')
  const empty = validatorJson(ARCH_FILES.map(file => [file, []]))
  const zero = gateRules.vitestValidatorFindings(validatorInput(empty)).findings
  assert.deepEqual(rules(zero), ['zero-executed'])
  const unsuccessful = validatorJson(ARCH_FILES.map(file => [file, [['p1', 'passed']]]), false)
  const red = gateRules.vitestValidatorFindings(validatorInput(unsuccessful)).findings
  assert.deepEqual(rules(red), ['success-false'])
})

test('a skipped validator cell goes through the register with the stale check off', () => {
  assert.equal(typeof gateRules.vitestValidatorFindings, 'function')
  const json = validatorJson([
    [ARCH_FILES[0], [['p1', 'passed'], ['s1', 'skipped']]],
    [ARCH_FILES[1], [['p2', 'passed']]],
  ])
  const elsewhere = entry(vcell('suite elsewhere', 'skipped', 'packages/cli/src/a.test.ts'))
  const result = gateRules.vitestValidatorFindings(
    validatorInput(json, { register: emptyRegister([elsewhere]) }),
  )
  assert.deepEqual(rules(result.findings), ['unlisted-skip'])
  assert.equal(result.findings[0].leg, 'validate:arch')
  assert.match(result.findings[0].detail, /validate-arch\.test\.ts > suite s1 \(skipped\)$/)
  assert.deepEqual(result.register.stale, [])

  const skipped = { runner: 'vitest', file: `packages/arch/${ARCH_FILES[0]}`, fullName: 'suite s1' }
  const listed = gateRules.vitestValidatorFindings(
    validatorInput(json, { register: emptyRegister([entry(skipped), elsewhere]) }),
  )
  assert.deepEqual(listed.findings, [])
  assert.equal(listed.register.matched, 1)
})

function countLine(record) {
  return `AGENT_QA_GATE_COUNT ${JSON.stringify(record)}`
}

test('parseGateCountLine reads the count line for its id; none, two or another id is red', () => {
  assert.equal(typeof gateRules.parseGateCountLine, 'function')
  const skills = countLine({ validator: 'skills', executed: 4, unit: 'skills' })
  const ok = gateRules.parseGateCountLine(`> pnpm header\nvalidation passed\n${skills}\n`, 'skills')
  assert.deepEqual(ok.findings, [])
  assert.equal(ok.executed, 4)
  assert.equal(ok.unit, 'skills')
  const other = countLine({ validator: 'agents', executed: 24, unit: 'AGENTS.md files' })
  for (const stdout of ['validation passed\n', `${skills}\n${skills}\n`, `${other}\n`]) {
    const { findings } = gateRules.parseGateCountLine(stdout, 'skills')
    assert.deepEqual(rules(findings), ['validator-count-missing'], stdout)
    assert.equal(findings[0].leg, 'validate:skills')
  }
  const garbled = gateRules.parseGateCountLine('AGENT_QA_GATE_COUNT {not json\n', 'skills')
  assert.deepEqual(rules(garbled.findings), ['validator-count-missing'])
  const zero = countLine({ validator: 'publish', executed: 0, unit: 'packages packed' })
  assert.deepEqual(rules(gateRules.parseGateCountLine(zero, 'publish').findings), [
    'zero-executed',
  ])
})

const CONFORMANCE_RUN = [
  '[396-conformance] running 50 scenarios at requirements 2026-07-28',
  '',
  'MCP conformance: 9/37 required server scenarios passed (24.3%)',
  '  suite pin            @modelcontextprotocol/conformance@0.2.0-alpha.11',
  '  requirement set      2026-07-28 (frozen)',
  '  scenarios executed   50 (37 required + 13 not scored)',
  '  baseline entries     41 (declared in packages/mcp/conformance-baseline.yaml, all matched)',
  '  ratchet exit code    0 (0 = no NEW failure and no stale entry; the score never gates)',
].join('\n')

test('the conformance run leg needs exit 0, its published headline and scenarios executed', () => {
  assert.equal(typeof gateRules.conformanceFindings, 'function')
  const legId = 'conformance'
  const green = gateRules.conformanceFindings({ legId, exitCode: 0, output: CONFORMANCE_RUN })
  assert.deepEqual(green.findings, [])
  assert.equal(green.counts.executed, 50)
  assert.equal(green.counts.passed, 9)
  assert.equal(green.counts.total, 37)
  assert.equal(green.counts.baselineEntries, 41)
  const headless = CONFORMANCE_RUN.replace(/^MCP conformance: .*$/m, '')
  const missing = gateRules.conformanceFindings({ legId, exitCode: 0, output: headless })
  assert.deepEqual(rules(missing.findings), ['conformance-count-missing'])
  const red = gateRules.conformanceFindings({ legId, exitCode: 1, output: CONFORMANCE_RUN })
  assert.deepEqual(rules(red.findings), ['leg-exit-nonzero'])
})

const SELFTEST = [
  '[396-conformance] S1 dead port: exit 1 (required nonzero) ✓',
  '[396-conformance] S2 truncated set (1 scenario, not 50): exit 1, G2 fired ✓',
  '    G2: the run executed 1 scenarios, the frozen set is 50.',
  '[396-conformance] S3 ratchet boundary: with the stale entry exit 1, without it exit 0 ✓',
  '[396-conformance] S4 dead baseline entry: the suite exited 0 (silent), G5 fired ✓',
  '[396-conformance] selftest: all four proofs failed as required',
].join('\n')

test('the conformance selftest leg counts its proof lines and needs its final line', () => {
  assert.equal(typeof gateRules.conformanceFindings, 'function')
  const legId = 'conformance-selftest'
  const green = gateRules.conformanceFindings({ legId, exitCode: 0, output: SELFTEST })
  assert.deepEqual(green.findings, [])
  assert.equal(green.counts.executed, 4)
  const unfinished = SELFTEST.split('\n').slice(0, -1).join('\n')
  const missing = gateRules.conformanceFindings({ legId, exitCode: 0, output: unfinished })
  assert.deepEqual(rules(missing.findings), ['conformance-count-missing'])
})

function auditReport(vulnerabilities = {}, dependencies = 493) {
  const metadata = {
    vulnerabilities: { info: 0, low: 1, moderate: 5, high: 0, critical: 0, ...vulnerabilities },
    dependencies,
  }
  return JSON.stringify({ advisories: {}, metadata })
}

test('the audit leg is judged by its JSON metadata: high or critical red, no report red', () => {
  assert.equal(typeof gateRules.auditFindings, 'function')
  const clean = gateRules.auditFindings({ exitCode: 0, stdout: auditReport() })
  assert.deepEqual(clean.findings, [])
  assert.equal(clean.counts.executed, 493)
  assert.equal(clean.counts.high, 0)
  assert.equal(clean.counts.critical, 0)
  const moderatesOnly = gateRules.auditFindings({ exitCode: 1, stdout: auditReport() })
  assert.deepEqual(moderatesOnly.findings, [])
  const high = gateRules.auditFindings({ exitCode: 1, stdout: auditReport({ high: 1 }) })
  assert.deepEqual(rules(high.findings), ['audit-findings'])
  assert.equal(high.findings[0].leg, 'audit')
  const critical = gateRules.auditFindings({ exitCode: 1, stdout: auditReport({ critical: 2 }) })
  assert.deepEqual(rules(critical.findings), ['audit-findings'])
  for (const stdout of ['ERR_PNPM_AUDIT_BAD_RESPONSE', '{"error":{"code":"E500"}}', '']) {
    const { findings } = gateRules.auditFindings({ exitCode: 1, stdout })
    assert.deepEqual(rules(findings), ['audit-no-observation'], stdout)
  }
  const empty = gateRules.auditFindings({ exitCode: 0, stdout: auditReport({}, 0) })
  assert.deepEqual(rules(empty.findings), ['audit-no-observation'])
})
