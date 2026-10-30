// A dropped leg or shard leaves tests unrun while CI stays green; this package runs in `rest`.
import { describe, expect, it } from 'vitest'

type Leg = { group: string; filter: string; vitest?: string }
type Job = {
  if?: string
  needs?: string | string[]
  strategy: { matrix: { include: Leg[] } }
  steps: Array<{ name?: string; run?: string; uses?: string; env?: Record<string, string> }>
}
type Workflow = { jobs: Record<string, Job> }
type Check = {
  loadCiWorkflow: () => Workflow
  workspaceTestPackages: () => Promise<string[]>
  turboSelects: (filter: string) => Promise<string[]>
  matrixFilters: (ci: Workflow) => string[]
  resolveFilter: (filter: string, packages: string[]) => string[]
  ciMatrixFailures: (ci: Workflow, packages: string[]) => string[]
}

const check = (await import(new URL('../../../../scripts/check-ci-matrix.mjs', import.meta.url).href)) as Check
const packages = check.workspaceTestPackages()

function mutated(edit: (ci: Workflow) => void): Workflow {
  const ci = structuredClone(check.loadCiWorkflow())
  edit(ci)
  return ci
}
const legs = (ci: Workflow, job: string) => ci.jobs[job]!.strategy.matrix.include
const drop = (ci: Workflow, job: string, group: string) => {
  const include = legs(ci, job)
  const at = include.findIndex((leg) => leg.group === group)
  if (at < 0) throw new Error(`${job} has no leg ${group}`)
  include.splice(at, 1)
}

describe('C-CI-MATRIX', () => {
  it('every workspace package is tested by exactly one ubuntu leg, each sharded package by a whole shard set, and macOS covers knowledge-local and all of agent-qa', async () => {
    const all = await packages
    expect(all, 'turbo lists this package among the tested ones').toContain('@vostride/agent-qa-arch')
    const ci = check.loadCiWorkflow()
    expect(check.ciMatrixFailures(ci, all)).toEqual([])
    // The check reads filters by exact package name; turbo must select the same packages for each.
    const filters = check.matrixFilters(ci)
    const selected = await Promise.all(filters.map((filter) => check.turboSelects(filter)))
    expect(
      Object.fromEntries(filters.map((filter) => [filter, check.resolveFilter(filter, all)])),
      'each matrix filter selects what turbo selects',
    ).toEqual(Object.fromEntries(filters.map((filter, index) => [filter, selected[index]])))
  })

  it('a dropped leg, shard or exclusion, an unknown package name, an unwired shard or an aggregate that can be skipped or misses a job fails the check', async () => {
    const all = await packages
    const failures = (edit: (ci: Workflow) => void) => check.ciMatrixFailures(mutated(edit), all)
    const cases: Array<[string, (ci: Workflow) => void, string]> = [
      ['the web leg is dropped', (ci) => drop(ci, 'workspace', 'web'), 'workspace: no leg tests @vostride/agent-qa-web'],
      [
        'the rest leg is dropped',
        (ci) => drop(ci, 'workspace', 'rest'),
        'workspace: no leg tests @vostride/agent-qa-analytics, @vostride/agent-qa-android, @vostride/agent-qa-arch',
      ],
      [
        'the third agent-qa shard is dropped',
        (ci) => drop(ci, 'workspace', 'cli-3'),
        'workspace: shards of "--filter=agent-qa" are ["-- --shard=1/3","-- --shard=2/3"], expected ["-- --shard=1/2","-- --shard=2/2"]',
      ],
      [
        "rest loses web's exclusion",
        (ci) => {
          const rest = legs(ci, 'workspace').find((leg) => leg.group === 'rest')!
          rest.filter = rest.filter.replace('--filter=!@vostride/agent-qa-web ', '')
        },
        'workspace: @vostride/agent-qa-web is tested by both',
      ],
      [
        'a leg names a package that does not exist',
        (ci) => {
          legs(ci, 'workspace').find((leg) => leg.group === 'dashboard-ui')!.filter = '--filter=@vostride/agent-qa-dashbord-ui'
        },
        'workspace: no workspace package named "@vostride/agent-qa-dashbord-ui"',
      ],
      [
        'the Test step stops passing the shard',
        (ci) => {
          const test = ci.jobs.workspace!.steps.find((step) => step.name === 'Test')!
          test.run = test.run!.replace(' ${{ matrix.vitest }}', '')
        },
        'workspace/Test: run must pass ${{ matrix.filter }} and ${{ matrix.vitest }}',
      ],
      [
        'macOS drops its second agent-qa shard',
        (ci) => drop(ci, 'ps-hosts', 'cli-2'),
        'ps-hosts: shards of "--filter=agent-qa" are ["-- --shard=1/3","-- --shard=3/3"], expected ["-- --shard=1/2","-- --shard=2/2"]',
      ],
      [
        'macOS drops knowledge-local',
        (ci) => drop(ci, 'ps-hosts', 'knowledge-local'),
        'ps-hosts: no leg tests @vostride/agent-qa-knowledge-local',
      ],
      [
        'the workspace legs stop downloading the build',
        (ci) => {
          const steps = ci.jobs.workspace!.steps
          const at = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'))
          if (at < 0) throw new Error('workspace has no download step')
          steps.splice(at, 1)
        },
        'workspace: --only skips the build tasks',
      ],
      [
        'the aggregate stops needing knip',
        (ci) => {
          const aggregate = ci.jobs['ci-result']!
          aggregate.needs = [aggregate.needs ?? []].flat().filter((id) => id !== 'knip')
        },
        'ci-result: does not need knip',
      ],
      [
        'the aggregate loses always()',
        (ci) => {
          delete ci.jobs['ci-result']!.if
        },
        'ci-result: must run with if: always()',
      ],
    ]
    for (const [what, edit, expected] of cases) {
      const found = failures(edit)
      expect(found.some((failure) => failure.startsWith(expected)), `${what}: ${JSON.stringify(found)}`).toBe(true)
    }
  })
})
