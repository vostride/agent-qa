// A later step runs through the project's installed agent-qa, and says which copy and version ran it.
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgentQaStep } from '../commands/project-agent-qa.js'
import { projectHost } from '../commands/project-host.js'
import { projectRange } from '../commands/project-range.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
} from './project-fixtures.js'

const NODE = '/fake/node'
const RUNNING = '0.3.3'
const OLDER = '0.3.1'
const STEP = ['skills', 'install', '--yes']
const folders: string[] = []

function tempFolder(label: string): string {
  const folder = mkdtempSync(join(tmpdir(), `agent-qa-step-${label}-`))
  folders.push(folder)
  return folder
}

function writeCopy(dir: string, version: string): string {
  writeInstalledPackage(dir, 'agent-qa', version, {
    packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
    files: { 'dist/cli.js': '' },
  })
  return join(dir, 'node_modules', 'agent-qa')
}

async function step(
  root: string,
  home: string,
  runningPackageDir: string,
  run: FakeRunner = fakeRunner(() => ({ code: 0, signal: null, output: 'from the project\n' })),
) {
  const host = projectHost({
    cwd: root,
    homedir: home,
    env: {},
    run,
    execPath: NODE,
    runningPackageDir,
  })
  const range = await projectRange(root, host)
  const inProcess = vi.fn(async () => ({ code: 0, output: 'in this process\n' }))
  const result = await runAgentQaStep(STEP, {
    host,
    range,
    fromDir: range.start,
    runningVersion: RUNNING,
    inProcess,
  })
  return { result, run, inProcess }
}

describe('later steps run through the project agent-qa', () => {
  afterEach(() => {
    cleanupTempProjects()
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  it('the running copy itself runs the step in this process', async () => {
    const { root, home } = tempProject('step-same-copy')
    const copy = writeCopy(root, RUNNING)
    const link = join(tempFolder('link'), 'agent-qa')
    symlinkSync(copy, link)

    const { result, run, inProcess } = await step(root, home, link)

    expect(inProcess).toHaveBeenCalledWith(STEP)
    expect(run.calls).toEqual([])
    expect(result).toEqual({
      via: 'in-process',
      version: RUNNING,
      code: 0,
      output: 'in this process\n',
    })
  })

  it('another installed copy runs the step as a child on the same Node', async () => {
    const { root, home } = tempProject('step-other-copy')
    writeCopy(root, OLDER)
    const elsewhere = tempFolder('running')

    const { result, run, inProcess } = await step(root, home, elsewhere)

    expect(inProcess).not.toHaveBeenCalled()
    const bin = join(realpathSync(root), 'node_modules', 'agent-qa', 'dist', 'cli.js')
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]).toMatchObject({
      command: NODE,
      args: [bin, ...STEP],
      cwd: root,
      stdio: 'capture',
    })
    expect(run.calls[0]?.env.AGENT_QA_HANDED_OFF).toBe('1')
    expect(result).toEqual({
      via: 'project',
      version: OLDER,
      code: 0,
      output: 'from the project\n',
    })
  })

  it('with no installed copy this agent-qa runs the step and says the project has none', async () => {
    const { root, home } = tempProject('step-no-copy')
    const elsewhere = tempFolder('running')

    const { result, run, inProcess } = await step(root, home, elsewhere)

    expect(inProcess).toHaveBeenCalledWith(STEP)
    expect(run.calls).toEqual([])
    expect(result).toEqual({
      via: 'running',
      version: RUNNING,
      code: 0,
      output: 'in this process\n',
    })
  })
})
