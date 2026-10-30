import assert from 'node:assert/strict'
import test from 'node:test'

import { loadWorkflow } from '../check-ci-matrix.mjs'

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

  const consumers = jobs.filter(([, job]) => needsBuild(job))
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

test('every job that installs packages takes pnpm from packageManager before setup-node reads .nvmrc and caches the pnpm store', () => {
  const installers = jobs.filter(([, job]) => stepsOf(job).some((step) => /\bpnpm install\b/.test(runOf(step))))
  assert.ok(installers.length > 0, 'some job installs packages')
  for (const [id, job] of installers) {
    const steps = stepsOf(job)
    const pnpm = indexOfUse(steps, 'pnpm/action-setup@')
    const node = indexOfUse(steps, 'actions/setup-node@')
    const install = steps.findIndex((step) => /\bpnpm install\b/.test(runOf(step)))
    assert.ok(pnpm >= 0, `${id} installs pnpm with pnpm/action-setup`)
    assert.equal(steps[pnpm].with?.version, undefined, `${id}: pnpm's version comes from packageManager`)
    assert.ok(node > pnpm, `${id} sets up Node after pnpm, so the pnpm cache can resolve the store`)
    assert.equal(steps[node].with?.['node-version-file'], '.nvmrc', `${id} reads Node from .nvmrc`)
    assert.equal(steps[node].with?.['node-version'], undefined, `${id} names no Node version by hand`)
    assert.equal(steps[node].with?.cache, 'pnpm', `${id} caches the pnpm store`)
    assert.ok(install > node, `${id} installs after Node is set up`)
  }
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
