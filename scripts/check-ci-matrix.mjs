// CI's legs test every package once on ubuntu and the daemon and lease packages on macOS, with
// whole shard sets, each leg downloads the build job's output before its --only Test step, and the
// ci-result job always runs and needs every other job.
// Every ubuntu leg also runs on the Node floor; the macOS legs run on .nvmrc only.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PS_HOST_PACKAGES = ['@vostride/agent-qa-knowledge-local', 'agent-qa']
const MATRIX_JOBS = [
  { id: 'workspace', test: 'Test', expected: 'workspace', nodeLines: ['toolchain', 'floor'] },
  { id: 'ps-hosts', test: 'Test daemon and lease packages', expected: PS_HOST_PACKAGES },
]
const AGGREGATE_JOB = 'ci-result'

export function loadWorkflow(name, repo = REPO_ROOT) {
  // The workspace root declares no YAML parser; the CLI package's own dependency is used.
  const { parse } = createRequire(join(repo, 'packages', 'cli', 'package.json'))('yaml')
  return parse(readFileSync(join(repo, '.github', 'workflows', name), 'utf8'))
}

export function loadCiWorkflow(repo = REPO_ROOT) {
  return loadWorkflow('ci.yml', repo)
}

const turbo = (repo, args) =>
  promisify(execFile)('pnpm', ['exec', 'turbo', 'run', 'test', ...args, '--only', '--dry=json'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).then(({ stdout }) => [
    ...new Set(JSON.parse(stdout).tasks.filter((task) => task.task === 'test').map((task) => task.package)),
  ].sort())

/** Every workspace package with a test task, as turbo sees the workspace. */
export function workspaceTestPackages(repo = REPO_ROOT) {
  return turbo(repo, [])
}

/** What turbo itself selects for one matrix filter. */
export function turboSelects(filter, repo = REPO_ROOT) {
  return turbo(repo, filterTokens(filter))
}

export const filterTokens = (filter) => String(filter ?? '').trim().split(/\s+/).filter(Boolean)
export const matrixFilters = (ci) =>
  [...new Set(MATRIX_JOBS.flatMap(({ id }) => (ci.jobs?.[id]?.strategy?.matrix?.leg ?? []).map((entry) => filterTokens(entry.filter).join(' '))))]

/**
 * pnpm/turbo selection for exact package names: the union of the included names (every package
 * when none is included) minus the excluded ones. Any other filter syntax is refused, so a filter
 * this cannot read never passes as covered.
 */
export function resolveFilter(filter, packages) {
  const include = []
  const exclude = []
  for (const token of filterTokens(filter)) {
    const match = /^--filter=(!?)([@a-z0-9][\w./@-]*)$/u.exec(token)
    if (match === null || /[*{}[\]]|\.\.\./u.test(match[2])) {
      throw new Error(`unsupported filter token "${token}"; name packages exactly, or extend check-ci-matrix`)
    }
    if (!packages.includes(match[2])) throw new Error(`no workspace package named "${match[2]}" (in "${filter}")`)
    ;(match[1] === '!' ? exclude : include).push(match[2])
  }
  return (include.length > 0 ? include : packages).filter((name) => !exclude.includes(name)).sort()
}

const words = (run) => String(run ?? '').trim().split(/\s+/)

/** Every way the matrix fails its coverage contract; an empty list means it holds. */
export function ciMatrixFailures(ci, packages) {
  const failures = []
  for (const { id, test, expected, nodeLines } of MATRIX_JOBS) {
    const job = ci.jobs?.[id]
    if (job === undefined) {
      failures.push(`ci.yml has no job ${id}`)
      continue
    }
    if (job.strategy?.['fail-fast'] !== false) failures.push(`${id}: strategy.fail-fast must be false, so one red leg cannot cancel the others`)
    const node = job.strategy?.matrix?.node
    if (nodeLines === undefined) {
      if (node !== undefined) failures.push(`${id}: runs on .nvmrc only and must not have a node axis`)
    } else if (JSON.stringify(node) !== JSON.stringify(nodeLines)) {
      failures.push(`${id}: matrix.node must be [${nodeLines.join(', ')}], so every leg also runs on the Node floor`)
    }
    const legs = job.strategy?.matrix?.leg
    if (!Array.isArray(legs) || legs.length === 0) {
      failures.push(`${id}: matrix.leg must be a non-empty list`)
      continue
    }
    const groups = legs.map((entry) => entry.group)
    if (groups.some((group) => typeof group !== 'string' || group === '') || new Set(groups).size !== groups.length) {
      failures.push(`${id}: every leg needs a unique group name`)
    }

    const byFilter = new Map()
    for (const entry of legs) {
      const key = filterTokens(entry.filter).join(' ')
      if (key === '') failures.push(`${id}/${entry.group}: missing filter`)
      else byFilter.set(key, [...(byFilter.get(key) ?? []), entry])
    }
    const owner = new Map()
    for (const [filter, entries] of byFilter) {
      let selected
      try {
        selected = resolveFilter(filter, packages)
      } catch (error) {
        failures.push(`${id}: ${error.message}`)
        continue
      }
      if (selected.length === 0) failures.push(`${id}: "${filter}" selects no package`)
      const shards = entries.map((entry) => String(entry.vitest ?? '').trim())
      if (entries.length === 1) {
        if (shards[0] !== '') failures.push(`${id}/${entries[0].group}: a filter on one leg must not shard ("${shards[0]}")`)
      } else {
        if (selected.length !== 1) failures.push(`${id}: sharded "${filter}" must select one package, got ${selected.join(', ')}`)
        const want = entries.map((_, index) => `-- --shard=${String(index + 1)}/${String(entries.length)}`).sort()
        if (JSON.stringify([...shards].sort()) !== JSON.stringify(want)) {
          failures.push(`${id}: shards of "${filter}" are ${JSON.stringify([...shards].sort())}, expected ${JSON.stringify(want)}`)
        }
      }
      for (const name of selected) {
        if (owner.has(name)) failures.push(`${id}: ${name} is tested by both "${owner.get(name)}" and "${filter}"`)
        else owner.set(name, filter)
      }
    }
    const want = expected === 'workspace' ? packages : expected
    const missing = want.filter((name) => !owner.has(name))
    const extra = [...owner.keys()].filter((name) => !want.includes(name))
    if (missing.length > 0) failures.push(`${id}: no leg tests ${missing.join(', ')}`)
    if (extra.length > 0) failures.push(`${id}: legs test ${extra.join(', ')}, which this job does not cover`)

    const steps = job.steps ?? []
    const at = steps.findIndex((step) => step.name === test)
    if (at < 0) {
      failures.push(`${id}: missing step ${test}`)
      continue
    }
    const run = String(steps[at].run ?? '')
    if (!run.includes('${{ matrix.leg.filter }}') || !run.includes('${{ matrix.leg.vitest }}')) {
      failures.push(`${id}/${test}: run must pass \${{ matrix.leg.filter }} and \${{ matrix.leg.vitest }}`)
    }
    if (!words(run).includes('--continue')) failures.push(`${id}/${test}: run lacks --continue`)
    if (steps[at].env?.TURBO_CONCURRENCY !== '1') failures.push(`${id}/${test}: env.TURBO_CONCURRENCY must be '1'`)
    if (words(run).includes('--only')) {
      const needs = [job.needs ?? []].flat()
      if (!needs.includes('build')) failures.push(`${id}: must need the build job`)
      const download = steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/download-artifact@'))
      if (download < 0 || download > at) {
        failures.push(`${id}: --only skips the build tasks, so a download of the build artifact must come before ${test}`)
      }
    }
  }
  failures.push(...aggregateFailures(ci))
  return failures
}

// A skipped required check counts as passing.
function aggregateFailures(ci) {
  const aggregate = ci.jobs?.[AGGREGATE_JOB]
  if (aggregate === undefined) return [`ci.yml has no job ${AGGREGATE_JOB}`]
  const failures = []
  if (!/\balways\(\)/u.test(String(aggregate.if ?? ''))) {
    failures.push(`${AGGREGATE_JOB}: must run with if: always(), so a failed or skipped job cannot leave it skipped`)
  }
  const needs = [aggregate.needs ?? []].flat()
  for (const id of Object.keys(ci.jobs)) {
    if (id !== AGGREGATE_JOB && !needs.includes(id)) failures.push(`${AGGREGATE_JOB}: does not need ${id}`)
  }
  return failures
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ci = loadCiWorkflow()
  const packages = await workspaceTestPackages()
  const failures = ciMatrixFailures(ci, packages)
  for (const filter of matrixFilters(ci)) {
    let mine
    try {
      mine = resolveFilter(filter, packages)
    } catch {
      continue
    }
    const theirs = await turboSelects(filter)
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) failures.push(`"${filter}" reads as ${mine.join(', ')} here but turbo selects ${theirs.join(', ')}`)
  }
  for (const failure of failures) console.error(`FAIL: ${failure}`)
  if (failures.length > 0) process.exit(1)
  console.log('ci-matrix: ok')
}
