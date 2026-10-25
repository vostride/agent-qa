// The `agent-qa run` PARITY GOLDEN generator (Phase 401 plan 11).
//
// WHY THIS EXISTS AT ALL. Plan 11 extracts the in-process run execution out of `run.ts` into one
// composable implementation. A refactor that is *supposed* to change nothing observable has nothing
// to go red first — so the acceptance bar is a two-sided parity differential, and the only honest
// way to hold one across a change is to capture the PRE side before a single line moves and commit
// it. A parity claim that lives only in a plan's `<action>` and a SUMMARY table passes identically
// whether the measurement happened, was skipped, or was invented.
//
// THE TWO SIDES ARE ASYMMETRIC ON PURPOSE. The "pre" side needs a tree that stops existing the
// moment the plan lands, and re-materialising it inside a committed script would mean the
// destructive working-tree manipulation this repo forbids (`git stash` / `git checkout -- .`). So
// the POST side is a committed cell (`run-parity.e2e.test.ts`) and the PRE side is the committed
// golden this script writes.
//
// ONE SCRUBBER, NOT TWO. `scrubTranscript` below is exported and the cell IMPORTS it. A golden and
// a later reading scrubbed by two matching-but-separate implementations could drift into agreeing
// about nothing.
//
// USAGE
//   node scripts/401-11-capture-parity.mjs --write   # (re)write the golden — pre-extraction only
//   node scripts/401-11-capture-parity.mjs --print    # take the readings and dump them
//
// REGENERATING THE GOLDEN IS A PLAN-LEVEL FAILURE, NOT A FIX. If the cell reds, the extraction
// changed observable behaviour. The only sanctioned reasons to touch this file's output are the
// artifacts plan 11's own truths name, and each such edit is recorded in the SUMMARY.

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'


const HERE = dirname(fileURLToPath(import.meta.url))
/** The repo root (`agent-qa/`) — this file lives in `agent-qa/scripts`. */
export const REPO_ROOT = join(HERE, '..')
/** The SHIPPED binary. Every reading runs on a `pnpm build --force` dist, both sides. */
export const CLI_DIST = join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js')
/** The committed pre-extraction reading. */
export const PARITY_GOLDEN_PATH = join(
  REPO_ROOT,
  'packages',
  'cli',
  'src',
  'commands',
  '__tests__',
  '__fixtures__',
  'run-parity-golden.json',
)

/**
 * The three invocations. `--all` is here because it folds the suite path's exit code into the
 * single-test path's — the one discriminator neither of the other two can range.
 */
// The id package's built entry, by relative path. `scripts/` is not a workspace package, so it has
// no `@vostride/agent-qa-ids` dependency edge to resolve through — and minting ids by hand would
// re-spell the canonical `<prefix>_ + 10 id-agent words` shape the parser enforces.
const { generateSuiteId, generateTestId } = await import(
  join(REPO_ROOT, 'packages', 'ids', 'dist', 'index.js')
)

export const PARITY_INVOCATIONS = [
  { id: 'single-test', args: ['tests/direct.yaml'] },
  { id: 'suite', args: ['suites/gate.suite.yaml'] },
  { id: 'all', args: ['--all'] },
]

/**
 * THE ONE SCRUBBER.
 *
 * What it removes is exactly what varies between two runs of the same build: minted ids, wall-clock
 * timings, the temp project directory, the loopback target's ephemeral port, token/cost accounting
 * and ISO timestamps. What it must NOT remove is anything a botched extraction could change —
 * reporter prose, ordering, exit codes, error text.
 */
export function scrubTranscript(text, context) {
  let out = text
  // Longest paths first: the project dir is inside the tmp dir, so the tmp rule would otherwise
  // eat the prefix and leave a half-scrubbed tail.
  for (const path of [context.project, context.home, context.tmp].filter(Boolean)) {
    out = out.split(path).join(path === context.project ? '<PROJECT>' : path === context.home ? '<HOME>' : '<TMP>')
  }
  out = out.split(context.repoRoot).join('<REPO>')
  if (context.targetOrigin) out = out.split(context.targetOrigin).join('http://127.0.0.1:<TARGET>')
  return out
    // Canonical entity ids (`t_`, `s_`, `r_`, `h_`, `obs_` + 10 dashed words).
    .replace(/\b(?:obs|[tshr])_[a-z0-9]+(?:-[a-z0-9]+){2,}/gi, '<ID>')
    // ISO timestamps.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
    // Durations: `1.23s`, `450ms`, `1m 2s`.
    .replace(/\b\d+m \d+(?:\.\d+)?s\b/g, '<DUR>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, '<DUR>')
    // Money and token accounting.
    .replace(/\$\d+(?:\.\d+)?/g, '<COST>')
    // Any surviving ephemeral loopback port (a second server, a retry line).
    .replace(/127\.0\.0\.1:\d{2,5}/g, '127.0.0.1:<PORT>')
    // Normalise trailing whitespace so a reporter's padding cannot flap the comparison.
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
}

/** A loopback target that counts who knocked — the requests discriminator. */
class CountingTarget {
  constructor() {
    this.hits = []
    this.server = undefined
    this.originValue = ''
  }

  async listen() {
    this.server = createServer((request, response) => {
      this.hits.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Example</title><p>Example</p>')
    })
    await new Promise((ready) => this.server.listen(0, '127.0.0.1', ready))
    this.originValue = `http://127.0.0.1:${this.server.address().port}`
  }

  async close() {
    if (this.server === undefined) return
    await new Promise((closed) => this.server.close(() => closed()))
  }

  get origin() {
    return this.originValue
  }
}

/**
 * The fixture: one target, one standalone test, one suite over its own member.
 *
 * `--all` therefore discovers TWO tests (`direct.yaml`, `member.yaml`) and ONE suite, runs the
 * suite first and then the tests, which is the fold the third invocation exists to range.
 *
 * THE MODEL POINTS AT AN UNBINDABLE PORT (1) on purpose, inherited from `suite-run-fixture.ts`: the
 * run STARTS, plans, fails to reach the model and finishes. If the model shared the counting
 * server, a planner retry would land in `hits` and the requests discriminator would be measuring
 * the planner rather than the run-start probe.
 *
 * `home/` is the child's `HOME`. Redirecting it makes the reading independent of the developer's
 * machine — and the seeded `version-check.json` (a fresh `lastAttemptedAt`, no cached version) is
 * what keeps `printAgentQaUpdateNoticeIfNeeded` from making a network call whose answer would
 * differ between the golden and every later reading.
 */
export function createParityFixture(origin) {
  const directTestId = generateTestId()
  const memberTestId = generateTestId()
  const suiteId = generateSuiteId()
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'run-parity-')))
  mkdirSync(join(project, 'tests'), { recursive: true })
  mkdirSync(join(project, 'suites'), { recursive: true })
  const home = join(project, 'home')
  mkdirSync(join(home, '.agent-qa'), { recursive: true })
  mkdirSync(join(project, 'no-browsers'), { recursive: true })
  writeFileSync(
    join(home, '.agent-qa', 'version-check.json'),
    JSON.stringify({ lastAttemptedAt: new Date().toISOString() }),
  )

  writeFileSync(
    join(project, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      "    - 'tests/**/*.yaml'",
      '  suiteMatch:',
      "    - 'suites/**/*.suite.yaml'",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'registry:',
      '  targets:',
      '    parity-thing:',
      '      platform: web',
      `      url: ${origin}/parity-thing`,
      '      environment: local',
      '  llms:',
      '    - name: unreachable',
      '      provider: openai-compatible',
      '      model: gpt-4o-mini',
      '      baseURL: http://127.0.0.1:1/v1',
      'use:',
      '  llm: unreachable',
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
  )
  writeFileSync(join(project, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(project, '.env'), '')
  writeFileSync(join(project, '.env.secrets.local'), '')

  writeFileSync(
    join(project, 'tests', 'direct.yaml'),
    [
      `test-id: ${directTestId}`,
      'name: the standalone test',
      'target: parity-thing',
      'steps:',
      '  - Verify the page says "Example"',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'tests', 'member.yaml'),
    [
      `test-id: ${memberTestId}`,
      'name: the suite member',
      'target: parity-thing',
      'steps:',
      '  - Verify the page says "Example"',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'suites', 'gate.suite.yaml'),
    [
      `suite-id: ${suiteId}`,
      'name: the parity suite',
      'target: parity-thing',
      'tests:',
      '  - test: tests/member.yaml',
      `    id: ${memberTestId}`,
      '',
    ].join('\n'),
  )

  return { project, home }
}

async function runCli(fixture, args) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    DO_NOT_TRACK: '1',
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    // PIN THE BROWSER POSTURE, so the reading is a property of the build rather than of the
    // machine. Playwright resolves its binaries under this root; an empty one guarantees the
    // "browser support is not installed" branch on every host, exactly as the unbindable model
    // port guarantees the planner's. Without it the single-test path would launch a real Chromium
    // wherever one happens to be installed and the golden would stop being comparable.
    PLAYWRIGHT_BROWSERS_PATH: join(fixture.project, 'no-browsers'),
  }
  // An inherited run id would attach this run to another run's directory, and an EMPTY string is
  // not absence: `?? generateRunId()` keeps `''`, which slugs to a run dir called `default`.
  delete env.AGENT_QA_RUN_ID
  delete env.AGENT_QA_BUILD_TAG
  delete env.AGENT_QA_LIVE_EVENTS

  const child = spawn(process.execPath, [CLI_DIST, 'run', ...args], { cwd: fixture.project, env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const status = await new Promise((settle, fail) => {
    child.on('error', fail)
    child.on('close', (code) => settle(code))
  })
  return { status, stdout, stderr }
}

/**
 * The invocation's run directories, IN THE ORDER THE RUNS HAPPENED.
 *
 * NOT ALPHABETICAL, and that is a measured correction rather than a preference. A run directory is
 * named after its run id, and a run id is random — so an `--all` invocation (which starts two runs:
 * the suite fold, then the tests) produced its two event logs in a coin-flip order under a
 * name sort, and the event-SEQUENCE discriminator flapped between two orderings of the same run.
 * A parity instrument that flaps is worse than none: the first red teaches a reader to re-run it.
 * Creation time is what "the order the runs happened" actually means.
 */
function runDirs(project) {
  const runs = join(project, '.agent-qa', 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs)
    .map((entry) => join(runs, entry))
    .map((dir) => ({ dir, at: statSync(dir).birthtimeMs }))
    .sort((left, right) => (left.at - right.at) || left.dir.localeCompare(right.dir))
    .map((entry) => entry.dir)
}

function eventTypes(project) {
  return runDirs(project).flatMap((dir) => {
    const path = join(dir, 'events.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line).type)
  })
}

function runDirFiles(project) {
  return runDirs(project)
    .flatMap((dir) => readdirSync(dir))
    .sort()
}

/**
 * RUN-DIRECTORY MEMBERS ADDED ON PURPOSE AFTER THE GOLDEN WAS CAPTURED.
 *
 * WHY THIS EXISTS AT ALL. The golden is a PRE-EXTRACTION capture from 401-11 and regenerating it
 * is a plan-level failure, because a wholesale re-capture blinds the instrument to exactly the
 * drift it was built to catch. But `runDirFiles` is an inventory, and a later phase that ships a
 * new run-directory member on purpose is not drift — it is a ratified change to what a run leaves
 * behind. Without a way to say that, the only two moves available are "regenerate the golden"
 * (blind the instrument) or "never add a run-dir member again" (freeze the product). This list is
 * the third move: each addition is named, dated to its plan, and justified, and the comparison
 * subtracts these names FROM BOTH SIDES before asserting.
 *
 * WHAT IT DOES NOT WEAKEN. Only the `runDirFiles` axis is filtered, and only by exact file name:
 *
 *   - a REMOVAL from the golden inventory still reds (it is gone from the actual side too, and
 *     nothing here puts it back);
 *   - an addition NOT on this list still reds (it survives the subtraction on the actual side and
 *     has no counterpart in the golden);
 *   - `stdout`, `stderr`, `eventTypes`, `targetHits` and `exitCode` are untouched and stay exact.
 *
 * SUBTRACTED FROM BOTH SIDES, deliberately: a future legitimate re-capture would bake these names
 * into the golden, and a one-sided filter would then red on its own allowance.
 *
 * IT SHRINKS THE SAME WAY THE SURFACE-FIREWALL LEDGER DOES. `assertDeclaredAdditionsObserved`
 * below fails on an entry that no reading actually produces, so a name that stops being written
 * has to be deleted here in the same commit rather than lingering as a permanent blind spot.
 */
// 441-58 (D-14) retired 405-02's `masking-digests.json`: no run writes it now.
export const POST_GOLDEN_RUN_DIR_ADDITIONS = [
  {
    file: 'run-config.json',
    addedBy: '442-10',
    reason:
      'Phase 442 D-17: every run records its absolute config path beside its handoff so another '
      + "run's tail curates it only under that config's mask and knowledge root. It names a path "
      + 'and holds no secret.',
  },
]

/** The declared names, as a Set — one derivation, used by both helpers below. */
const declaredAdditionNames = new Set(POST_GOLDEN_RUN_DIR_ADDITIONS.map((entry) => entry.file))

/**
 * Drop the declared post-golden additions from a run-dir inventory.
 *
 * Applied to the golden reading AND the fresh reading, so the comparison ranges exactly the
 * inventory both trees were supposed to share.
 */
export function withoutDeclaredRunDirAdditions(files) {
  return [...files].filter((name) => !declaredAdditionNames.has(name))
}

/**
 * The staleness direction: every declared addition must actually be observed.
 *
 * An entry nothing writes any more is a permanent hole in the instrument, so it fails here and has
 * to be deleted. Returns the stale entries rather than throwing, so the caller decides how to
 * report — the cell wants a named diff, not an exception.
 */
export function staleDeclaredAdditions(observedFiles) {
  const observed = new Set(observedFiles)
  return POST_GOLDEN_RUN_DIR_ADDITIONS.filter((entry) => !observed.has(entry.file))
}

/**
 * Take all six discriminators for one invocation, on a FRESH fixture (its own project dir, its own
 * counting target), so no reading can inherit another's run directory.
 */
export async function captureInvocation(invocation) {
  const target = new CountingTarget()
  await target.listen()
  let fixture
  try {
    fixture = createParityFixture(target.origin)
    const result = await runCli(fixture, invocation.args)
    const context = {
      project: fixture.project,
      home: fixture.home,
      tmp: realpathSync(tmpdir()),
      repoRoot: realpathSync(REPO_ROOT),
      targetOrigin: target.origin,
    }
    return {
      id: invocation.id,
      args: invocation.args,
      exitCode: result.status,
      stdout: scrubTranscript(result.stdout, context),
      stderr: scrubTranscript(result.stderr, context),
      eventTypes: eventTypes(fixture.project),
      targetHits: [...target.hits],
      runDirFiles: runDirFiles(fixture.project),
    }
  } finally {
    await target.close()
    if (fixture !== undefined) rmSync(fixture.project, { recursive: true, force: true })
  }
}

/** All three invocations, in order. */
export async function captureParityReadings() {
  const readings = []
  for (const invocation of PARITY_INVOCATIONS) {
    readings.push(await captureInvocation(invocation))
  }
  return readings
}

/**
 * A golden captured from a broken build would make every later comparison trivially true, so the
 * golden is checked for non-vacuity on load rather than trusted for being a file.
 */
export function assertGoldenNonVacuous(golden) {
  const ids = PARITY_INVOCATIONS.map((invocation) => invocation.id)
  if (!Array.isArray(golden?.readings) || golden.readings.length !== ids.length) {
    throw new Error(`run-parity golden: expected ${ids.length} readings, got ${golden?.readings?.length}`)
  }
  for (const id of ids) {
    const reading = golden.readings.find((entry) => entry.id === id)
    if (reading === undefined) throw new Error(`run-parity golden: missing reading "${id}"`)
    if (typeof reading.stdout !== 'string' || reading.stdout.trim() === '') {
      throw new Error(`run-parity golden: reading "${id}" has an empty stdout — captured from a broken build?`)
    }
    if (!Array.isArray(reading.eventTypes) || !reading.eventTypes.includes('runStarted')) {
      throw new Error(`run-parity golden: reading "${id}" never started a run — captured from a broken build?`)
    }
  }
  return golden
}

export function loadGolden() {
  return assertGoldenNonVacuous(JSON.parse(readFileSync(PARITY_GOLDEN_PATH, 'utf8')))
}

async function main() {
  const write = process.argv.includes('--write')
  const readings = await captureParityReadings()
  const golden = { capturedAt: new Date().toISOString(), readings }
  if (write) {
    mkdirSync(dirname(PARITY_GOLDEN_PATH), { recursive: true })
    assertGoldenNonVacuous(golden)
    writeFileSync(PARITY_GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`)
    console.log(`wrote ${PARITY_GOLDEN_PATH}`)
  }
  for (const reading of readings) {
    console.log(`\n=== ${reading.id} (${reading.args.join(' ')}) exit=${reading.exitCode}`)
    console.log(`events: ${reading.eventTypes.join(', ')}`)
    console.log(`hits: ${JSON.stringify(reading.targetHits)}`)
    console.log(`runDirFiles: ${JSON.stringify(reading.runDirFiles)}`)
    console.log(`--- stdout ---\n${reading.stdout}`)
    console.log(`--- stderr ---\n${reading.stderr}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
