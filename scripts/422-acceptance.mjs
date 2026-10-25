#!/usr/bin/env node
/**
 * 422-24-T2 — the Phase 422 acceptance instrument.
 *
 * FIVE MODES, ONE RULE: this instrument may observe an admission and may never cause one. It
 * never names the committer, and the argv it builds for a demo mode is asserted flag by flag by
 * `packages/cli/src/__tests__/adversarial-acceptance.test.ts` (A11) rather than trusted.
 *
 *   --fixtures        temporary roots and fake models only. Exits zero ONLY after every
 *                     required leg RAN and PASSED — see `validateFixtureEvidence`.
 *   --inspect-demo    read-only observation of the configured host's roots.
 *   --stage-demo      production staging through the built CLI. Stages; never commits.
 *   --check-staged    the masked review manifest, read from the configured local audit dir only.
 *   --verify-admitted verifies an admission an operator already performed by hand.
 *
 * WHAT IT DOES NOT DO. It does not claim demo admission, it does not claim empirical model
 * quality, and it does not re-spell a leg some other plan's suite already pins — the
 * `production-path` leg REQUIRES those suites by name and reads their TAP, because a second
 * spelling of a pinned leg is a second opinion about what it means.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

// ---------------------------------------------------------------------------
// The contract the acceptance cells read.
// ---------------------------------------------------------------------------

/** The legs `--fixtures` must see execute and pass before it may exit zero. */
export const REQUIRED_FIXTURE_LEGS = ['release-exit-2', 'production-path']

/** Every mode that takes `--config <path>` and operates on the configured demo host. */
export const DEMO_MODES = ['--inspect-demo', '--stage-demo', '--check-staged', '--verify-admitted']

/** The subset that may not verify an admission, because none of them may cause one. */
export const READ_ONLY_MODES = ['--inspect-demo', '--stage-demo', '--check-staged']

/**
 * The suites whose passing TAP IS the `production-path` leg.
 *
 * Named by file, in their owning package: the eligible-singleton and missing-sibling probe arms
 * (`adversarial-probe-preflight`), the stage/admit tracer and the admission cells, the integrated
 * acceptance cells, and the zero-model BYOM promotion floor.
 */
export const PRODUCTION_PATH_SUITES = [
  { package: 'cli', file: 'src/__tests__/adversarial-acceptance.test.ts' },
  { package: 'cli', file: 'src/__tests__/adversarial-tracer.test.ts' },
  { package: 'cli', file: 'src/__tests__/adversarial-admit.test.ts' },
  { package: 'cli', file: 'src/__tests__/adversarial-probe-preflight.test.ts' },
  { package: 'knowledge-local', file: 'src/curator/__tests__/promotion-floor.acceptance.test.ts' },
]

/** Cells the acceptance file must have executed and passed; an absent name is a failure. */
export const REQUIRED_ACCEPTANCE_CELLS = [
  '(A1) every documented eval command resolves against the registered command tree',
  '(A2) staging leaves the committed root byte-identical and admission moves the corpus digest',
  '(A3) an interrupted admission reports a partial batch and never folds remaining into admitted',
  '(A4) a batch altered after review refuses staging-integrity without starting a write',
  '(A6) identical refusal populations do not report refusal-population-differs',
  '(A9) a probe capability gap is typed, costs nothing, and leaves the deterministic families alone',
  '(A10) the acceptance instrument refuses incomplete fixture evidence',
  '(A11) the read-only and staging demo modes cannot admit',
]

/** A batch is named by its digest, never by a path a generated manifest could supply. */
export function isBatchDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * The gate this instrument exists to be.
 *
 * A leg that is ABSENT, that did not RUN, and that ran and did not PASS are three different
 * facts and each refuses. Absence is called out separately because "we never got there" is
 * exactly the shape a partially-executed acceptance takes, and a validator that read it as
 * a pass would let the instrument exit zero having proven nothing.
 */
export function validateFixtureEvidence(evidence) {
  const errors = []
  for (const leg of REQUIRED_FIXTURE_LEGS) {
    const row = evidence == null ? undefined : evidence[leg]
    if (row === undefined || row === null) {
      errors.push(`${leg}: no evidence recorded`)
      continue
    }
    if (row.ran !== true) {
      errors.push(`${leg}: did not run${row.detail ? ` (${row.detail})` : ''}`)
      continue
    }
    if (row.ok !== true) errors.push(`${leg}: ran and did not pass${row.detail ? ` (${row.detail})` : ''}`)
  }
  return errors
}

/**
 * The exact argv a demo mode hands the built CLI.
 *
 * EXPORTED so (A11) can assert on the argv this instrument actually builds rather than on the
 * absence of a word in its source. A taboo on a spelling is evaded by respelling it; an
 * assertion over the constructed argv is not.
 */
export function demoArgv(mode, configPath, opts = {}) {
  if (!DEMO_MODES.includes(mode)) throw new Error(`unknown demo mode: ${mode}`)
  if (mode !== '--stage-demo') return undefined
  return [
    CLI_ENTRY,
    '--config', configPath,
    'eval', 'adversarial',
    ...(opts.product === undefined ? [] : ['--product', opts.product]),
    ...(opts.maxSeeds === undefined ? [] : ['--max-seeds', String(opts.maxSeeds)]),
    '--json',
  ]
}

const CLI_ENTRY = join(REPO, 'packages/cli/dist/cli.js')

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

const sha = value => createHash('sha256').update(value).digest('hex')
const fileSha = path => sha(readFileSync(path))

function git(args) {
  const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unavailable'
}

function nodeBin() {
  return process.execPath
}

/** Resolve the configured host's roots from a config path, and nothing else from it. */
function hostRoots(configPath) {
  const absolute = resolve(process.cwd(), configPath)
  if (!existsSync(absolute)) throw new Error(`no config at ${absolute}`)
  const configDir = dirname(absolute)
  return {
    configPath: absolute,
    configDir,
    committedRoot: join(configDir, 'agent-qa-eval'),
    agentQaRoot: join(configDir, '.agent-qa'),
    stagingRoot: join(configDir, '.agent-qa', 'eval', 'adversarial'),
  }
}

async function evalCore() {
  return import(pathToFileURL(join(REPO, 'packages/eval/dist/index.js')).href)
}

async function corpusReader() {
  return import(pathToFileURL(join(REPO, 'packages/eval-local/dist/reader.js')).href)
}

/**
 * Every PROPOSER-VISIBLE committed entry, grouped by split.
 *
 * Read through `eval-local/reader` — the proposer's own door — and therefore NOT the whole
 * corpus: the private held-out split is structurally unreadable through it (ROOT-10), so a
 * count from here is always short by exactly that population. Every consumer below stamps
 * `readerVisibility` beside the number, because a total that silently omitted the private split
 * would read as corpus shrinkage the next time someone compared two of these records.
 */
/**
 * The AUTHORITATIVE corpus digest — the one the production CLI prints, the baseline pointer
 * pins, and the stale-receipt filter compares against.
 *
 * It is computed over EVERY committed entry, including the private held-out split. The
 * proposer's `/reader` cannot see that split (ROOT-10), so a digest folded from
 * `committedCensus`'s entries is a digest of a DIFFERENT population and is not comparable with
 * anything the system reports. On the demo root the two differ outright — reader-visible gives
 * `40c1031b…` over 129 entries, the whole corpus gives `cbf1e383…` over 155 — so reporting the
 * reader's value under the name `corpusDigest` invited exactly the false comparison an operator
 * makes when checking whether an admission moved the digest. Both are reported, named apart.
 *
 * This reads the entry files directly rather than through `/reader` BECAUSE the reader is the
 * thing that cannot see the whole corpus. It is a read-only audit path in an acceptance
 * instrument, never a production one.
 */
async function fullCorpusDigest(committedRoot) {
  const corpusDir = join(committedRoot, 'corpus')
  if (!existsSync(corpusDir)) return { digest: 'unavailable', entries: 0 }
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.json')) files.push(path)
    }
  }
  try {
    walk(corpusDir)
    const entries = files.sort().map(path => JSON.parse(readFileSync(path, 'utf8')))
    const core = await evalCore()
    return { digest: core.computeCorpusDigest(entries), entries: entries.length }
  } catch (error) {
    // An unreadable corpus is reported as unreadable. Falling back to the reader's digest here
    // would reintroduce the exact substitution this function exists to remove.
    return { digest: 'unreadable', entries: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

async function committedCensus(committedRoot) {
  if (!existsSync(committedRoot)) return { present: false, products: {}, total: 0, bySplit: {} }
  const { openCorpusReader } = await corpusReader()
  const reader = openCorpusReader(committedRoot)
  const corpusDir = join(committedRoot, 'corpus')
  const products = existsSync(corpusDir)
    ? readdirSync(corpusDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
    : []
  const bySplit = {}
  const perProduct = {}
  let total = 0
  for (const product of products) {
    const entries = reader.listEntries(product)
    const counts = {}
    for (const entry of entries) {
      counts[entry.split] = (counts[entry.split] ?? 0) + 1
      bySplit[entry.split] = (bySplit[entry.split] ?? 0) + 1
      total += 1
    }
    perProduct[product] = counts
  }
  return { present: true, products: perProduct, total, bySplit }
}

// ---------------------------------------------------------------------------
// LEG 1 — the release exit-2 case, in process, over the built gate.
// ---------------------------------------------------------------------------

function vector(core, i) {
  return {
    key: `acceptance-cassette-${i}#-#0`,
    cassetteId: `acceptance-cassette-${i}`,
    decisionOrdinal: 0,
    product: 'example-web',
    briefSource: 'proof',
    axes: {
      headline: i < 41 ? 'correct' : 'incorrect',
      elementIdentity: 'correct',
      value: 'correct',
      opClass: 'correct',
      sideEffect: 'correct',
      loop: 'not-applicable',
    },
  }
}

function gateFixture(core) {
  const baselineReport = core.buildEvalReport([], undefined, undefined, { declaredSeed: 11 })
  const currentReport = core.buildEvalReport([], undefined, undefined, { declaredSeed: 29 })
  baselineReport.batchKey = 'acceptance-baseline'
  currentReport.batchKey = 'acceptance-current'
  baselineReport.briefSourceCounts = { proof: 24, empty: 24, rendered: 0 }
  currentReport.briefSourceCounts = { proof: 24, empty: 24, rendered: 0 }
  const pointer = core.projectBaselinePointer({
    plannerModelId: 'acceptance-planner',
    fingerprint: 'acceptance-fingerprint',
    corpusDigest: 'acceptance-corpus',
    matcherVersion: baselineReport.matcherVersion,
    batchKey: baselineReport.batchKey,
  })
  const vectors = Array.from({ length: 48 }, (_, i) => vector(core, i))
  const floor = core.foldNoiseFloorArtefact({
    profile: {
      profileKey: pointer.profileKey,
      fingerprint: pointer.fingerprint,
      plannerModelId: pointer.plannerModelId,
      matcherVersion: pointer.matcherVersion,
    },
    corpusDigest: pointer.corpusDigest,
    partitionVersion: 1,
    seeds: [11, 29],
    repeats: 3,
    bootstrapSeed: 17,
    runs: [11, 11, 11, 29].map((seed, index) => ({ index, seed, report: baselineReport, vectors, wallClockMs: 0 })),
    splitByCassetteId: new Map(),
    censusByProduct: { 'example-web': { natural: 48, heldOutShared: 0, heldOutPrivate: 0 } },
  })
  return {
    expectedProfileKey: pointer.profileKey,
    pointer: { kind: 'current', pointer },
    floor,
    baseline: {
      report: baselineReport,
      vectors: core.projectDecisionVectorsDocument({
        batchKey: baselineReport.batchKey,
        matcherVersion: baselineReport.matcherVersion,
        vectors,
      }),
    },
    current: {
      report: currentReport,
      vectors: structuredClone(vectors),
      fingerprint: pointer.fingerprint,
      corpusDigest: pointer.corpusDigest,
    },
  }
}

/**
 * SC4, as an exit code rather than as a sentence.
 *
 * A guardrail block reaches the release gate as a moved guard-failed refusal population.
 * A moved harness-error population is the infrastructure control; both are inconclusive.
 * The control — identical
 * populations on both sides — is asserted in the same leg, because a cell that only ever checks
 * the differing case cannot tell a real signal from a reason the gate raises unconditionally.
 */
async function releaseExitTwoLeg() {
  const core = await evalCore()
  const findings = []
  const fail = message => findings.push(message)

  if (!core.REPLAY_REFUSAL_REASONS.includes('guard-failed')) fail('guard-failed is not a replay refusal reason')

  const refusal = gateFixture(core)
  refusal.baseline.report.honesty.refusalCounts['guard-failed'] = 0
  refusal.current.report.honesty.refusalCounts['guard-failed'] = 3
  const refused = core.computeGateVerdict(refusal)
  if (refused.exit !== 2) fail(`a moved guard-failed population exited ${refused.exit}, expected 2`)
  if (!refused.inconclusive.some(row => row.reason === 'refusal-population-differs')) {
    fail('a moved guard-failed population did not report refusal-population-differs')
  }
  if (refused.regressions.length !== 0) fail('a refused population was reported as a regression')

  const harness = gateFixture(core)
  harness.baseline.report.honesty.harnessErrorCount = 0
  harness.current.report.honesty.harnessErrorCount = 3
  const blocked = core.computeGateVerdict(harness)
  if (blocked.exit !== 2) fail(`a moved harness-error population exited ${blocked.exit}, expected 2`)
  if (!blocked.inconclusive.some(row => row.reason === 'harness-errors')) {
    fail('a moved harness-error population did not report harness-errors')
  }
  if (blocked.regressions.length !== 0) fail('a blocked replay was reported as a regression')

  const control = gateFixture(core)
  for (const reason of core.REPLAY_REFUSAL_REASONS) {
    control.baseline.report.honesty.refusalCounts[reason] = 2
    control.current.report.honesty.refusalCounts[reason] = 2
  }
  const clean = core.computeGateVerdict(control)
  if (clean.inconclusive.some(row => row.reason === 'refusal-population-differs')) {
    fail('identical refusal populations were reported as differing')
  }
  if (clean.exit !== 0) fail(`identical populations exited ${clean.exit}, expected 0`)

  return {
    ran: true,
    ok: findings.length === 0,
    detail: findings.join('; '),
    checks: {
      refusalPopulationMovedExit: refused.exit,
      harnessErrorMovedExit: blocked.exit,
      identicalPopulationExit: clean.exit,
      regressionsReported: refused.regressions.length + blocked.regressions.length,
    },
  }
}

// ---------------------------------------------------------------------------
// LEG 2 — the production-path suites, required by name.
// ---------------------------------------------------------------------------

/** Flatten vitest's nested TAP into (name, ok) leaves, verbatim. */
function tapLeaves(output) {
  const leaves = []
  for (const line of String(output).split('\n')) {
    const match = line.match(/^(\s*)(ok|not ok) \d+ - (.+?)(?: # time=.*)?$/)
    if (!match || match[1].length === 0) continue
    const name = match[3]
    if (/\.test\.tsx?$/.test(name)) continue
    leaves.push({ ok: match[2] === 'ok', name })
  }
  return leaves
}

function runSuites(packageName, files) {
  const cwd = join(REPO, 'packages', packageName)
  const result = spawnSync(
    nodeBin(),
    [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', ...files, '--typecheck.enabled=false', '--reporter=tap'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return { cwd, exit: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

async function productionPathLeg() {
  const findings = []
  const byPackage = new Map()
  for (const suite of PRODUCTION_PATH_SUITES) {
    byPackage.set(suite.package, [...(byPackage.get(suite.package) ?? []), suite.file])
  }
  const runs = []
  const seen = new Map()
  for (const [packageName, files] of byPackage) {
    for (const file of files) {
      const path = join(REPO, 'packages', packageName, file)
      if (!existsSync(path)) findings.push(`required suite missing: packages/${packageName}/${file}`)
    }
    const run = runSuites(packageName, files)
    runs.push({ package: packageName, files, exit: run.exit })
    if (run.exit !== 0) findings.push(`packages/${packageName}: vitest exited ${run.exit}`)
    const leaves = tapLeaves(run.output)
    if (leaves.length === 0) findings.push(`packages/${packageName}: no tests executed`)
    for (const leaf of leaves) {
      seen.set(leaf.name, (seen.get(leaf.name) ?? true) && leaf.ok)
      if (!leaf.ok) findings.push(`packages/${packageName}: failed cell ${leaf.name}`)
    }
    runs[runs.length - 1].cells = leaves.length
  }
  // A named cell that never appeared is not a pass. This is what stops a renamed or deleted
  // acceptance cell from quietly removing itself from the required evidence.
  for (const cell of REQUIRED_ACCEPTANCE_CELLS) {
    if (seen.get(cell) !== true) findings.push(`required acceptance cell absent or failed: ${cell}`)
  }
  return {
    ran: true,
    ok: findings.length === 0,
    detail: findings.join('; '),
    checks: { runs, cellsObserved: seen.size, requiredCells: REQUIRED_ACCEPTANCE_CELLS.length },
  }
}

// ---------------------------------------------------------------------------
// --fixtures
// ---------------------------------------------------------------------------

async function fixturesMode() {
  const evidence = {}
  const started = Date.now()
  // A leg that throws is a leg that DID NOT RUN, recorded as such. Swallowing it into `ok: false`
  // would erase the difference between "the check failed" and "the check never happened".
  for (const [leg, run] of [['release-exit-2', releaseExitTwoLeg], ['production-path', productionPathLeg]]) {
    try {
      evidence[leg] = await run()
    } catch (error) {
      evidence[leg] = { ran: false, ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
    console.log(`${leg}: ran=${evidence[leg].ran} ok=${evidence[leg].ok}${evidence[leg].detail ? ` — ${evidence[leg].detail}` : ''}`)
  }
  const errors = validateFixtureEvidence(evidence)
  const record = {
    mode: '--fixtures',
    sourceSha: git(['rev-parse', 'HEAD']),
    sourceClean: git(['status', '--porcelain']) === '',
    startedAt: new Date(started).toISOString(),
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    requiredLegs: REQUIRED_FIXTURE_LEGS,
    evidence,
    errors,
  }
  const out = join(tmpdir(), `422-acceptance-fixtures-${started}.json`)
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`evidence: ${out}`)
  if (errors.length > 0) {
    for (const error of errors) console.error(`FAIL ${error}`)
    return 1
  }
  console.log('422_ACCEPTANCE_FIXTURES_OK')
  return 0
}

// ---------------------------------------------------------------------------
// The demo modes. Each takes `--config <path>`; none of them commits.
// ---------------------------------------------------------------------------

async function inspectDemo(configPath) {
  const roots = hostRoots(configPath)
  const census = await committedCensus(roots.committedRoot)
  const { openCorpusReader } = await corpusReader()
  const core = await evalCore()
  let readerVisibleDigest = 'unavailable'
  let seedsWithProofBrief = 0
  if (census.present) {
    const reader = openCorpusReader(roots.committedRoot)
    const entries = []
    for (const product of Object.keys(census.products)) {
      for (const entry of reader.listEntries(product)) {
        entries.push(entry)
        if (entry.split !== 'natural') continue
        const loaded = reader.loadCassette(entry.cassetteId)
        if (loaded.kind === 'loaded' && loaded.cassette.granularity === 'leaf'
          && loaded.cassette.input?.servedBrief?.proof !== undefined) seedsWithProofBrief += 1
      }
    }
    readerVisibleDigest = core.computeCorpusDigest(entries)
  }
  const full = census.present ? await fullCorpusDigest(roots.committedRoot) : { digest: 'unavailable', entries: 0 }
  const reportsDir = join(roots.committedRoot, 'reports')
  const record = {
    mode: '--inspect-demo',
    sourceSha: git(['rev-parse', 'HEAD']),
    configPath: roots.configPath,
    committedRoot: roots.committedRoot,
    committedRootPresent: census.present,
    // The digest every production surface means when it says "corpus digest".
    corpusDigest: full.digest,
    corpusEntries: full.entries,
    // The same fold over the proposer-visible subset only. A DIFFERENT population, so a
    // DIFFERENT value — never compare it against a digest the CLI printed.
    readerVisibleCorpusDigest: readerVisibleDigest,
    digestNote: 'corpusDigest folds every committed entry and is the value the CLI, the baseline pointer and the stale-receipt filter use. readerVisibleCorpusDigest folds only the proposer-visible subset (ROOT-10) and is comparable with nothing the system reports.',
    entries: census.total,
    readerVisibility: 'proposer /reader: the private held-out split is structurally unreadable here (ROOT-10), so these counts exclude it',
    bySplit: census.bySplit,
    byProduct: census.products,
    // UPPER BOUND, not the eligible-seed count. Production additionally requires a non-empty
    // memory channel (`isProofBacked`, packages/eval/src/adversarial/generate.ts), which this
    // instrument deliberately does not re-spell. The authoritative figures are the refresh
    // verb's own `eligibleSeeds` and its `brief-not-proof-backed` skips.
    naturalSeedsWithProofBrief: seedsWithProofBrief,
    seedEligibilityNote: 'naturalSeedsWithProofBrief is an UPPER BOUND on eligible seeds: it tests only that the served brief carries a proof. Production also requires at least one non-empty memory channel. Read eligibleSeeds / brief-not-proof-backed off `eval adversarial` for the real figure.',
    adversarialEntries: census.bySplit.adversarial ?? 0,
    reports: existsSync(reportsDir)
      ? readdirSync(reportsDir, { withFileTypes: true }).map(e => `${e.name}${e.isDirectory() ? '/' : ''}`).sort()
      : [],
    stagingRootPresent: existsSync(roots.stagingRoot),
    note: 'read-only observation; this mode performs no staging and no admission',
  }
  console.log(JSON.stringify(record, null, 2))
  return 0
}

async function stageDemo(configPath, opts) {
  const roots = hostRoots(configPath)
  if (!existsSync(CLI_ENTRY)) throw new Error(`built CLI missing at ${CLI_ENTRY}; run pnpm build first`)
  const argv = demoArgv('--stage-demo', roots.configPath, opts)
  const started = Date.now()
  const result = spawnSync(nodeBin(), argv, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = join(tmpdir(), `422-acceptance-stage-${started}.json`)
  const record = {
    mode: '--stage-demo',
    sourceSha: git(['rev-parse', 'HEAD']),
    argv: argv.map(part => (part === CLI_ENTRY ? 'packages/cli/dist/cli.js' : part)),
    exit: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    note: 'production staging through the built CLI; this mode commits nothing',
  }
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`)
  console.log(result.stdout ?? '')
  if (result.stderr) console.error(result.stderr)
  console.log(`result file: ${out}`)
  console.log(`staging root: ${roots.stagingRoot}`)
  return result.status === 0 ? 0 : (result.status ?? 1)
}

/**
 * The masked review manifest, resolved ONLY from the configured local audit dir.
 *
 * A batch is located by walking `<configDir>/.agent-qa/eval/adversarial/<product>/<digest>/` and
 * checking each directory name with `isBatchDigest`. No path from a manifest, a CLI line or any
 * other generated text is ever opened: a batch this instrument cannot name by digest under the
 * configured root is a batch it does not read.
 *
 * MASKED means the three per-case documents are reported by SHA, never by content. The text an
 * operator must review is injection-shaped by construction, and a review manifest that inlined
 * it would be a second copy of it in a log.
 */
async function checkStaged(configPath, opts) {
  const roots = hostRoots(configPath)
  const batches = []
  const skipped = []
  if (existsSync(roots.stagingRoot)) {
    for (const productEntry of readdirSync(roots.stagingRoot, { withFileTypes: true })) {
      if (!productEntry.isDirectory()) continue
      const productDir = join(roots.stagingRoot, productEntry.name)
      for (const batchEntry of readdirSync(productDir, { withFileTypes: true })) {
        if (!batchEntry.isDirectory()) continue
        if (!isBatchDigest(batchEntry.name)) { skipped.push(`${productEntry.name}/${batchEntry.name}`); continue }
        if (opts.batch !== undefined && batchEntry.name !== opts.batch) continue
        const dir = join(productDir, batchEntry.name)
        const manifestPath = join(dir, 'manifest.json')
        if (!existsSync(manifestPath)) { skipped.push(`${productEntry.name}/${batchEntry.name}: no manifest`); continue }
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const cases = readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && /^case-\d{4}$/.test(entry.name))
          .map(entry => entry.name)
          .sort()
          .map(name => {
            const caseDir = join(dir, name)
            const documents = {}
            for (const document of ['cassette.json', 'label.json', 'entry.json']) {
              const path = join(caseDir, document)
              documents[document] = existsSync(path)
                ? { sha256: fileSha(path), bytes: statSync(path).size }
                : { absent: true }
            }
            return { case: name, documents }
          })
        batches.push({
          product: manifest.product,
          batchDigest: manifest.batchDigest,
          tableVersion: manifest.tableVersion,
          tableHash: manifest.tableHash,
          stagedAt: manifest.stagedAt,
          manifestSha256: fileSha(manifestPath),
          declaredCases: Array.isArray(manifest.cases) ? manifest.cases.length : 0,
          reviewedCases: cases.length,
          // Identity and provenance only. No authored text, no accessible name, no gold.
          rows: (manifest.cases ?? []).map(row => ({
            cassetteId: row.cassetteId,
            seedCassetteId: row.seedCassetteId,
            mutator: row.mutator,
            kind: row.kind,
            promptVersion: row.promptVersion,
            cassetteTextHash: row.cassetteTextHash,
            labelTextHash: row.labelTextHash,
            entryTextHash: row.entryTextHash,
          })),
          documents: cases,
        })
      }
    }
  }
  const census = await committedCensus(roots.committedRoot)
  const core = await evalCore()
  let readerVisibleDigest = 'unavailable'
  if (census.present) {
    const { openCorpusReader } = await corpusReader()
    const reader = openCorpusReader(roots.committedRoot)
    const entries = Object.keys(census.products).flatMap(product => reader.listEntries(product))
    readerVisibleDigest = core.computeCorpusDigest(entries)
  }
  // The pre-digest an operator compares against after admitting has to be the digest the ADMIT
  // verb prints. That verb folds the whole corpus, so this one must too.
  const full = census.present ? await fullCorpusDigest(roots.committedRoot) : { digest: 'unavailable', entries: 0 }
  const started = Date.now()
  const record = {
    mode: '--check-staged',
    sourceSha: git(['rev-parse', 'HEAD']),
    configPath: roots.configPath,
    stagingRoot: roots.stagingRoot,
    batches,
    skippedPaths: skipped,
    // Comparable with the digest the admit verb prints. See fullCorpusDigest.
    committedRootPreDigest: full.digest,
    committedRootEntries: full.entries,
    readerVisiblePreDigest: readerVisibleDigest,
    digestNote: 'committedRootPreDigest folds every committed entry and is what the admit verb reports moving. readerVisiblePreDigest folds the proposer-visible subset only (ROOT-10) and is comparable with nothing the system reports.',
    committedEntries: census.total,
    readerVisibility: 'proposer /reader: the private held-out split is structurally unreadable here (ROOT-10), so these counts exclude it',
    committedBySplit: census.bySplit,
    note: 'review manifest only; nothing here admits, and no document content is reproduced',
  }
  const out = join(tmpdir(), `422-acceptance-check-staged-${started}.json`)
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`)
  console.log(JSON.stringify(record, null, 2))
  console.log(`result file: ${out}`)
  return batches.length === 0 && opts.batch !== undefined ? 1 : 0
}

/**
 * Verify an admission an operator already performed. This mode CANNOT perform one.
 *
 * With `--batch <digest>` it asks the one question that matters after a hand-run admission: is
 * every case the reviewed manifest declared now committed, under the adversarial split, with the
 * generator provenance the manifest named. Without it, it reports what the committed root holds.
 */
async function verifyAdmitted(configPath, opts) {
  const roots = hostRoots(configPath)
  const census = await committedCensus(roots.committedRoot)
  if (!census.present) {
    console.error(`FAIL no committed root at ${roots.committedRoot}`)
    return 1
  }
  const { openCorpusReader } = await corpusReader()
  const reader = openCorpusReader(roots.committedRoot)
  const findings = []
  const committed = new Map()
  for (const product of Object.keys(census.products)) {
    for (const entry of reader.listEntries(product)) committed.set(entry.cassetteId, entry)
  }
  let declared = 0
  if (opts.batch !== undefined) {
    if (!isBatchDigest(opts.batch)) throw new Error('--batch must be a 64-character lower-hex digest')
    // The manifest is located under the configured audit root by digest, never by a supplied path.
    const candidates = existsSync(roots.stagingRoot)
      ? readdirSync(roots.stagingRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(roots.stagingRoot, entry.name, opts.batch, 'manifest.json'))
        .filter(path => existsSync(path))
      : []
    if (candidates.length === 0) {
      // A retired batch is the NORMAL outcome of a complete admission: the reviewed directory is
      // removed only when every member landed. Absence is therefore evidence, not an error.
      findings.push(`reviewed batch ${opts.batch} is no longer staged (retired, or never present here)`)
    } else {
      const manifest = JSON.parse(readFileSync(candidates[0], 'utf8'))
      declared = manifest.cases.length
      for (const row of manifest.cases) {
        const entry = committed.get(row.cassetteId)
        if (entry === undefined) { findings.push(`declared case not committed: ${row.cassetteId}`); continue }
        if (entry.split !== 'adversarial') findings.push(`${row.cassetteId} committed under split ${entry.split}`)
        if (entry.split === 'adversarial' && entry.generator?.seedCassetteId !== row.seedCassetteId) {
          findings.push(`${row.cassetteId} committed with a different seed than the manifest declared`)
        }
      }
    }
  }
  const full = await fullCorpusDigest(roots.committedRoot)
  const record = {
    mode: '--verify-admitted',
    sourceSha: git(['rev-parse', 'HEAD']),
    configPath: roots.configPath,
    committedRoot: roots.committedRoot,
    // The post-admission digest, folded the same way the admit verb folds it, so the two can
    // actually be compared.
    corpusDigest: full.digest,
    corpusEntries: full.entries,
    committedEntries: census.total,
    readerVisibility: 'proposer /reader: the private held-out split is structurally unreadable here (ROOT-10), so these counts exclude it',
    committedBySplit: census.bySplit,
    adversarialEntries: census.bySplit.adversarial ?? 0,
    batch: opts.batch ?? null,
    declaredCases: declared,
    findings,
    note: 'verification only; an admission is an operator act this instrument cannot perform',
  }
  console.log(JSON.stringify(record, null, 2))
  const hard = findings.filter(line => line.startsWith('declared case not committed')
    || line.includes('committed under split') || line.includes('different seed'))
  if (hard.length > 0) { for (const line of hard) console.error(`FAIL ${line}`) ; return 1 }
  console.log('422_ACCEPTANCE_VERIFY_ADMITTED_OK')
  return 0
}

// ---------------------------------------------------------------------------

const HELP = `422-acceptance — Phase 422 acceptance instrument

  node scripts/422-acceptance.mjs --fixtures
      Temporary roots and fake models only. Runs the release exit-2 case in process and the
      named production-path suites, and exits zero ONLY when every required leg ran and passed.
      Required legs: ${REQUIRED_FIXTURE_LEGS.join(', ')}.

  node scripts/422-acceptance.mjs --inspect-demo --config <path>
      Read-only observation of the configured host: corpus digest, entries by split, an upper
      bound on eligible seeds, published reports and whether a staging root exists. Writes
      nothing. corpusDigest folds the WHOLE corpus and is the value the CLI reports;
      readerVisibleCorpusDigest folds the proposer-visible subset only and compares with
      nothing the system prints.

  node scripts/422-acceptance.mjs --stage-demo --config <path> [--product <slug>] [--max-seeds <n>]
      Production staging through the built CLI (packages/cli/dist/cli.js). Stages a reviewable
      batch and commits nothing. Build first: pnpm build.

  node scripts/422-acceptance.mjs --check-staged --config <path> [--batch <digest>]
      The masked review manifest for every batch under the CONFIGURED local audit dir
      (<configDir>/.agent-qa/eval/adversarial/). Reports each case by document SHA and by the
      manifest's own text hashes; no document content is reproduced. Reads only directories whose
      name is a 64-character lower-hex digest.

  node scripts/422-acceptance.mjs --verify-admitted --config <path> [--batch <digest>]
      Verifies an admission an operator already performed. It cannot perform one.

PLAN 25 USES THESE EXACTLY:
  1. --inspect-demo   record the pre-admission roots, digest and standing measurements.
  2. --stage-demo     stage a real batch; review the bytes it names.
  3. --check-staged   produce the masked review manifest and approve ONE batch digest.
  4. The operator then runs the real CLI verb by hand — the admit branch of
     "agent-qa --config <path> eval adversarial", naming the approved batch digest. That command
     is the only committer, and it is deliberately not reachable from this instrument; see
     'agent-qa eval adversarial --help' for its exact form.
  5. --verify-admitted --batch <digest>   confirm what actually landed.

This instrument observes an admission and never causes one. It does not establish empirical
model quality and it does not claim demo admission.
`

function parseArgs(argv) {
  const opts = {}
  let mode
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--fixtures' || DEMO_MODES.includes(token)) {
      if (mode !== undefined) throw new Error('exactly one mode may be supplied')
      mode = token
    } else if (token === '--config') { opts.config = argv[i += 1] }
    else if (token === '--batch') { opts.batch = argv[i += 1] }
    else if (token === '--product') { opts.product = argv[i += 1] }
    else if (token === '--max-seeds') { opts.maxSeeds = Number(argv[i += 1]) }
    else if (token === '--help' || token === '-h') { mode = '--help' }
    else throw new Error(`unknown argument: ${token}`)
  }
  return { mode, opts }
}

async function main(argv) {
  const { mode, opts } = parseArgs(argv)
  if (mode === undefined || mode === '--help') { console.log(HELP); return mode === undefined ? 1 : 0 }
  if (mode === '--fixtures') return fixturesMode()
  if (opts.config === undefined) throw new Error(`${mode} requires --config <path>`)
  if (opts.batch !== undefined && !isBatchDigest(opts.batch)) {
    throw new Error('--batch must be a 64-character lower-hex digest, never a path')
  }
  if (mode === '--inspect-demo') return inspectDemo(opts.config)
  if (mode === '--stage-demo') return stageDemo(opts.config, opts)
  if (mode === '--check-staged') return checkStaged(opts.config, opts)
  return verifyAdmitted(opts.config, opts)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code })
    .catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}

// Keep references so an unused-import lint never drops the temp-root helpers the demo modes use.
void mkdirSync
void mkdtempSync
void rmSync
