import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { loadWorkflow, REPO_ROOT } from '../check-ci-matrix.mjs'

const ci = loadWorkflow('ci.yml')
const jobs = Object.entries(ci.jobs)
const stepsOf = (job) => job.steps ?? []
const runOf = (step) => String(step.run ?? '')
const usesOf = (step) => String(step.uses ?? '')
const indexOfUse = (steps, prefix) => steps.findIndex((step) => usesOf(step).startsWith(prefix))
const needsBuild = (job) => [job.needs ?? []].flat().includes('build')

test('only the build job builds and keeps turbo cache, and every later turbo command runs without building', () => {
  for (const [id, job] of jobs) {
    if (id === 'build') continue
    for (const step of stepsOf(job)) {
      const run = runOf(step)
      assert.doesNotMatch(run, /\bpnpm (run )?build\b/, `${id}/${step.name} builds: ${run}`)
      assert.doesNotMatch(run, /\bturbo (run )?build\b/, `${id}/${step.name} builds: ${run}`)
      assert.doesNotMatch(run, /\bpnpm (run )?typecheck\b/, `${id}/${step.name} typechecks through the build: ${run}`)
      if (run.includes('mcp-conformance.sh')) assert.match(run, /(^|\s)--no-build(\s|$)/, `${id}/${step.name}: ${run}`)
      if (/\bturbo (run )?typecheck\b/.test(run)) assert.match(run, /(^|\s)--only(\s|$)/, `${id}/${step.name}: ${run}`)
      if (usesOf(step).startsWith('actions/cache@')) {
        assert.doesNotMatch(String(step.with?.path ?? ''), /\.turbo/, `${id}/${step.name} restores turbo's cache`)
      }
    }
  }
  const pack = stepsOf(ci.jobs.build).find((step) => /\btar -c/.test(runOf(step)))
  assert.ok(pack, 'the build job packs its output with tar')
  assert.match(runOf(pack), /build\.tgz/)
  assert.doesNotMatch(runOf(pack), /\.turbo/, 'the build artifact carries no turbo cache')
})

test('every job that needs the build downloads it after checkout and unpacks it with extraction-time mtimes', () => {
  const upload = stepsOf(ci.jobs.build).find((step) => usesOf(step).startsWith('actions/upload-artifact@'))
  assert.ok(upload, 'the build job uploads its output')
  assert.match(String(upload.with?.path ?? ''), /\/build\.tgz$/)
  assert.equal(upload.with?.archive, false, 'the tarball is uploaded as is, so file modes survive')

  // ci-result needs every job only to read its result.
  const consumers = jobs.filter(([id, job]) => id !== 'ci-result' && needsBuild(job))
  assert.ok(consumers.length > 0, 'some job needs the build')
  for (const [id, job] of consumers) {
    const steps = stepsOf(job)
    const checkout = indexOfUse(steps, 'actions/checkout@')
    const download = indexOfUse(steps, 'actions/download-artifact@')
    const unpack = steps.findIndex((step) => /\btar -xzmf\b/.test(runOf(step)))
    assert.ok(checkout >= 0, `${id} checks out`)
    assert.ok(download > checkout, `${id} downloads the build after checkout`)
    assert.equal(steps[download].with?.name, 'build.tgz', `${id} downloads the build artifact`)
    assert.ok(unpack > download, `${id} unpacks the build with tar -xzmf after downloading it`)
  }
})

test('every job that installs packages takes pnpm from packageManager, then sets up Node from .nvmrc or from the floor engines.node names, caching the pnpm store', () => {
  const installers = jobs.filter(([, job]) => stepsOf(job).some((step) => /\bpnpm install\b/.test(runOf(step))))
  assert.ok(installers.length > 0, 'some job installs packages')
  for (const [id, job] of installers) {
    const steps = stepsOf(job)
    const pnpm = indexOfUse(steps, 'pnpm/action-setup@')
    const install = steps.findIndex((step) => /\bpnpm install\b/.test(runOf(step)))
    const nodes = steps.flatMap((step, index) => (usesOf(step).startsWith('actions/setup-node@') ? [index] : []))
    assert.ok(pnpm >= 0, `${id} installs pnpm with pnpm/action-setup`)
    assert.equal(steps[pnpm].with?.version, undefined, `${id}: pnpm's version comes from packageManager`)
    assert.ok(nodes.length > 0, `${id} sets up Node`)
    for (const at of nodes) {
      const node = steps[at]
      assert.ok(at > pnpm, `${id} sets up Node after pnpm, so the pnpm cache can resolve the store`)
      assert.ok(install > at, `${id} installs after Node is set up`)
      assert.equal(node.with?.cache, 'pnpm', `${id} caches the pnpm store`)
      if (node.if === "matrix.node == 'floor'") {
        assert.equal(node.with?.['node-version-file'], undefined, `${id}: the floor does not read .nvmrc`)
        assert.equal(node.with?.['node-version'], '${{ steps.floor.outputs.major }}', `${id}: the floor version comes from the floor step`)
        assert.equal(node.with?.['check-latest'], true, `${id}: the floor takes the newest release of its major`)
        const floor = steps.findIndex((step) => step.id === 'floor')
        assert.ok(floor >= 0 && floor < at, `${id} reads the floor before setting it up`)
        assert.equal(steps[floor].if, "matrix.node == 'floor'", `${id}: the floor step runs only on the floor line`)
        const read = runOf(steps[floor])
        assert.match(read, /\.engines\.node'? package\.json/, `${id}: the floor is read from engines.node in package.json`)
        assert.match(read, /\| sed -nE 's\/\^>=\(\[0-9\]\+\)\$\/\\1\/p'/, `${id}: the floor keeps only the major of >=<major>`)
        assert.match(read, /major=.*\$GITHUB_OUTPUT/, `${id}: the floor step outputs major`)
        assert.match(read, /::error::[\s\S]*exit 1/, `${id}: the floor step fails when engines.node has another shape`)
      } else {
        assert.equal(node.with?.['node-version-file'], '.nvmrc', `${id} reads Node from .nvmrc`)
        assert.equal(node.with?.['node-version'], undefined, `${id} names no Node version by hand`)
      }
    }
    const guards = nodes.map((at) => steps[at].if)
    if (job.strategy?.matrix?.node === undefined) {
      assert.deepEqual(guards, [undefined], `${id} has no node axis, so it sets up Node once from .nvmrc`)
    } else {
      assert.deepEqual(
        [...guards].sort(),
        ["matrix.node == 'floor'", "matrix.node == 'toolchain'"],
        `${id} sets up Node once per line`,
      )
    }
  }
})

test('the workspace legs and MCP conformance run on the toolchain and the floor, and the other jobs run on .nvmrc only', () => {
  for (const id of ['workspace', 'mcp-conformance']) {
    assert.deepEqual(ci.jobs[id].strategy?.matrix?.node, ['toolchain', 'floor'], `${id} runs on both Node lines`)
  }
  for (const id of ['ps-hosts', 'checks', 'knip', 'audit', 'build', 'images']) {
    assert.equal(ci.jobs[id].strategy?.matrix?.node, undefined, `${id} has a node axis`)
  }
})

test('the images job builds the web and android images for linux/amd64 on .nvmrc without pushing, logging in or caching layers, and CI result needs it', () => {
  const job = ci.jobs.images
  assert.ok(job, 'ci.yml has an images job')
  assert.deepEqual(job.strategy?.matrix?.image, ['web', 'android'])
  for (const image of job.strategy.matrix.image) {
    assert.ok(existsSync(join(REPO_ROOT, 'docker', `Dockerfile.${image}`)), `docker/Dockerfile.${image} exists`)
  }
  const steps = stepsOf(job)
  assert.ok(!steps.some((step) => usesOf(step).startsWith('docker/login-action@')), 'the images job logs in to no registry')
  const builds = steps.filter((step) => usesOf(step).startsWith('docker/build-push-action@'))
  assert.equal(builds.length, 1, 'the images job has one build step')
  const build = builds[0].with ?? {}
  assert.equal(build.file, 'docker/Dockerfile.${{ matrix.image }}')
  assert.equal(build.platforms, 'linux/amd64')
  assert.equal(build.push, false)
  assert.equal(build['cache-from'], undefined, 'the images job restores no layer cache')
  assert.equal(build['cache-to'], undefined, 'the images job saves no layer cache')
  const version = build['build-args']?.match(/^NODE_VERSION=\$\{\{ steps\.([\w-]+)\.outputs\.version \}\}$/)
  assert.ok(version, `NODE_VERSION comes from a step output: ${build['build-args']}`)
  const read = steps.find((step) => step.id === version[1])
  assert.match(runOf(read), /\$\(cat \.nvmrc\)/, 'NODE_VERSION is read from .nvmrc')
  assert.ok([ci.jobs['ci-result'].needs].flat().includes('images'), 'CI result needs the images job')
  assert.equal(ci.jobs['ci-result'].name, 'CI result')
  assert.equal(ci.jobs['ci-result'].if, 'always()')
})

test('the workspace and ps-hosts legs cache Playwright browsers under the installed playwright-core version', () => {
  for (const id of ['workspace', 'ps-hosts']) {
    const steps = stepsOf(ci.jobs[id])
    const install = steps.findIndex((step) => /\bpnpm install\b/.test(runOf(step)))
    const read = steps.findIndex((step) => runOf(step).includes('playwright-core/package.json') && runOf(step).includes('GITHUB_OUTPUT'))
    assert.ok(read > install, `${id} reads the playwright-core version after installing`)
    const stepId = steps[read].id
    assert.ok(stepId, `${id}: the version step has an id`)
    const cache = steps.findIndex(
      (step) => usesOf(step).startsWith('actions/cache@') && String(step.with?.key ?? '').includes(`steps.${stepId}.outputs.version`),
    )
    assert.ok(cache > read, `${id} keys a cache on the playwright-core version`)
    assert.match(String(steps[cache].with.path), /ms-playwright/, `${id} caches Playwright's browser folder`)
    const chromium = steps.findIndex((step) => /playwright-core install/.test(runOf(step)))
    assert.ok(chromium > cache, `${id} installs Chromium after restoring the cache`)
  }
})

test("CI runs on pushes to main, pull requests into main and release's call", () => {
  assert.deepEqual(Object.keys(ci.on).sort(), ['pull_request', 'push', 'workflow_call'])
  assert.deepEqual(ci.on.push.branches, ['main'])
  assert.deepEqual(ci.on.pull_request.branches, ['main'])
})

test('only pull request runs cancel an in-flight run, and push and release runs are grouped by their own run id', () => {
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}")
  assert.match(ci.concurrency.group, /github\.event_name/)
  assert.match(ci.concurrency.group, /github\.run_id/)
})

test('the audit job reports production advisories without failing, and CI result needs it', () => {
  const steps = stepsOf(ci.jobs.audit)
  const report = steps.findIndex((step) => /\bpnpm audit --prod --audit-level high\b/.test(runOf(step)))
  assert.ok(report >= 0, 'a step audits production dependencies at high')
  assert.equal(steps[report]['continue-on-error'], true, 'the audit step never fails the job')
  const summary = steps.findIndex((step) => runOf(step).includes('$GITHUB_STEP_SUMMARY'))
  assert.ok(summary > report, 'a later step writes the report to the step summary')
  assert.equal(steps[summary].if, 'always()', 'the summary is written whatever the audit found')
  assert.ok([ci.jobs['ci-result'].needs].flat().includes('audit'), 'CI result needs the audit job')
})

test('CI never grants an OIDC token: it reads contents only and no job widens that', () => {
  assert.deepEqual(ci.permissions, { contents: 'read' })
  for (const [id, job] of jobs) assert.equal(job.permissions, undefined, `${id} sets its own permissions`)
})
