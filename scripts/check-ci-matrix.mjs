// The CI test matrix covers every workspace package exactly once on ubuntu, every sharded package
// with a complete 1..N shard set, and on macOS the daemon and lease packages (knowledge-local and
// the whole of agent-qa). packages/arch's C-CI-MATRIX cells run this in CI; run it directly with
// `node scripts/check-ci-matrix.mjs`.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PS_HOST_PACKAGES = ['@vostride/agent-qa-knowledge-local', 'agent-qa']
const MATRIX_JOBS = [
  { id: 'workspace', test: 'Test', expected: 'workspace' },
  { id: 'ps-hosts', test: 'Test daemon and lease packages', expected: PS_HOST_PACKAGES },
]

export function loadCiWorkflow(repo = REPO_ROOT) {
  // The workspace root declares no YAML parser; the CLI package's own dependency is used.
  const { parse } = createRequire(join(repo, 'packages', 'cli', 'package.json'))('yaml')
  return parse(readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8'))
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
  [...new Set(MATRIX_JOBS.flatMap(({ id }) => (ci.jobs?.[id]?.strategy?.matrix?.include ?? []).map((entry) => filterTokens(entry.filter).join(' '))))]

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
  for (const { id, test, expected } of MATRIX_JOBS) {
    const job = ci.jobs?.[id]
    if (job === undefined) {
      failures.push(`ci.yml has no job ${id}`)
      continue
    }
    if (job.strategy?.['fail-fast'] !== false) failures.push(`${id}: strategy.fail-fast must be false, so one red leg cannot cancel the others`)
    const include = job.strategy?.matrix?.include
    if (!Array.isArray(include) || include.length === 0) {
      failures.push(`${id}: matrix.include must be a non-empty list`)
      continue
    }
    const groups = include.map((entry) => entry.group)
    if (groups.some((group) => typeof group !== 'string' || group === '') || new Set(groups).size !== groups.length) {
      failures.push(`${id}: every leg needs a unique group name`)
    }

    const byFilter = new Map()
    for (const entry of include) {
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
    if (!run.includes('${{ matrix.filter }}') || !run.includes('${{ matrix.vitest }}')) {
      failures.push(`${id}/${test}: run must pass \${{ matrix.filter }} and \${{ matrix.vitest }}`)
    }
    if (!words(run).includes('--continue')) failures.push(`${id}/${test}: run lacks --continue`)
    if (steps[at].env?.TURBO_CONCURRENCY !== '1') failures.push(`${id}/${test}: env.TURBO_CONCURRENCY must be '1'`)
    if (words(run).includes('--only')) {
      const build = steps.findIndex((step) => String(step.run ?? '').trim() === 'pnpm build')
      if (build < 0 || build > at) failures.push(`${id}: --only skips the build tasks, so a pnpm build step must come before ${test}`)
    }
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
