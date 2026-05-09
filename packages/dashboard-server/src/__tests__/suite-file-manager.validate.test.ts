import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveWorkspacePaths, type ResolvedWorkspacePaths } from '@vostride/agent-qa-core'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { TestFileManager } from '../tests/test-file-manager.js'

const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const VALID_TEST_ID_TWO = 't_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'

let workspaceDir: string
let workspacePaths: ResolvedWorkspacePaths

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'suite-fm-'))
  workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['specs/web/**/*.yaml'],
        suiteMatch: ['cases/**/*.suite.yaml'],
        hooksFile: 'runtime/hooks/custom-hooks.yaml',
        agentRules: 'agent-rules.md',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
    },
    configPath: join(workspaceDir, 'agent-qa.config.yaml'),
  })
  await mkdir(join(workspaceDir, 'specs/web'), { recursive: true })
  // Create one real test file
  await writeFile(
    join(workspaceDir, 'specs/web', 'login.yaml'),
    [
      'name: Login',
      `test-id: ${VALID_TEST_ID}`,
      'target: web',
      'steps:',
      '  - Log in',
    ].join('\n'),
  )
})

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('SuiteFileManager.validate with test existence check', () => {
  it('returns valid:true when all referenced tests exist', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const sfm = new SuiteFileManager(workspacePaths, tfm)
    const content = [
      'name: Smoke',
      'target: web',
      'tests:',
      '  - test: specs/web/login.yaml',
      `    id: ${VALID_TEST_ID}`,
    ].join('\n')
    const result = await sfm.validate(content)
    expect(result.valid).toBe(true)
    expect(result.missingTests).toBeUndefined()
  })

  it('returns missingTests when a referenced test is absent', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const sfm = new SuiteFileManager(workspacePaths, tfm)
    const content = [
      'name: Smoke',
      'target: web',
      'tests:',
      '  - test: specs/web/missing.yaml',
      `    id: ${VALID_TEST_ID_TWO}`,
      '  - test: specs/web/login.yaml',
      `    id: ${VALID_TEST_ID}`,
    ].join('\n')
    const result = await sfm.validate(content)
    expect(result.valid).toBe(false)
    expect(result.missingTests).toEqual([
      { index: 0, test: 'specs/web/missing.yaml', id: VALID_TEST_ID_TWO },
    ])
    expect(result.errors[0].message).toMatch(/Cannot save — referenced tests not found/)
  })

  it('rejects schema violations (variables: block) before the test-exists check', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const sfm = new SuiteFileManager(workspacePaths, tfm)
    const content = [
      'name: Smoke',
      'target: web',
      'variables:',
      '  FOO: bar',
      'tests:',
      '  - test: specs/web/login.yaml',
      `    id: ${VALID_TEST_ID}`,
    ].join('\n')
    const result = await sfm.validate(content)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('skips test-exists check when no testFileManager injected (back-compat)', async () => {
    const sfm = new SuiteFileManager(workspacePaths)
    const content = [
      'name: Smoke',
      'target: web',
      'tests:',
      '  - test: specs/web/does-not-exist.yaml',
      `    id: ${VALID_TEST_ID_TWO}`,
    ].join('\n')
    const result = await sfm.validate(content)
    expect(result.valid).toBe(true) // schema ok; no test resolver available
  })

  it('accepts workspace-relative paths matched by workspace.testMatch', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const sfm = new SuiteFileManager(workspacePaths, tfm)
    const content = [
      'name: Smoke',
      'target: web',
      'tests:',
      '  - test: specs/web/login.yaml',
      `    id: ${VALID_TEST_ID}`,
    ].join('\n')
    const result = await sfm.validate(content)
    expect(result.valid).toBe(true)
    expect(result.missingTests).toBeUndefined()
  })

  it('rejects legacy test-root-relative paths that are not workspace-relative', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const sfm = new SuiteFileManager(workspacePaths, tfm)
    const content = [
      'name: Smoke',
      'target: web',
      'tests:',
      '  - test: web/login.yaml',
      `    id: ${VALID_TEST_ID}`,
    ].join('\n')
    const result = await sfm.validate(content)
    expect(result.valid).toBe(false)
    expect(result.missingTests).toEqual([
      { index: 0, test: 'web/login.yaml', id: VALID_TEST_ID },
    ])
  })

  it('reports missingTests with the ORIGINAL path the user wrote (not the normalized form)', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const sfm = new SuiteFileManager(workspacePaths, tfm)
    const content = [
      'name: Smoke',
      'target: web',
      'tests:',
      '  - test: specs/web/does-not-exist.yaml',
      `    id: ${VALID_TEST_ID_TWO}`,
    ].join('\n')
    const result = await sfm.validate(content)
    expect(result.valid).toBe(false)
    expect(result.missingTests).toEqual([
      { index: 0, test: 'specs/web/does-not-exist.yaml', id: VALID_TEST_ID_TWO },
    ])
  })

  it('validatePath traversal guard is unaffected by path normalization (defense-in-depth)', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const sfm = new SuiteFileManager(workspacePaths, tfm)
    const content = [
      'name: Smoke',
      'target: web',
      'tests:',
      '  - test: ../../../etc/passwd',
      `    id: ${VALID_TEST_ID_TWO}`,
    ].join('\n')
    const result = await sfm.validate(content)
    // validate() is in-memory only; the crafted entry.test normalizes to something
    // that won't match any known test file, so it's reported as missing.
    expect(result.valid).toBe(false)
    expect(result.missingTests?.[0]?.test).toBe('../../../etc/passwd')
    // The validatePath guard protects read/write/delete — those methods would throw
    // on this path, but validate() never invokes them. This test locks in the
    // separation of concerns: normalization is for comparison only, not filesystem access.
  })

  it('blocks TestFileManager writes that escape into sibling directories sharing the workspace prefix', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const siblingDir = `${basename(workspaceDir)}-escape`

    await expect(tfm.write(`../${siblingDir}/escape.yaml`, 'name: Escape\nsteps: []\n')).rejects.toThrow(
      'Workspace file path escapes config directory',
    )
    await expect(stat(join(workspaceDir, '..', siblingDir, 'escape.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks SuiteFileManager writes that escape into sibling directories sharing the workspace prefix', async () => {
    const tfm = new TestFileManager(workspacePaths)
    const sfm = new SuiteFileManager(workspacePaths, tfm)
    const siblingDir = `${basename(workspaceDir)}-escape`

    await expect(sfm.write(`../${siblingDir}/escape.suite.yaml`, 'name: Escape\nsteps: []\n')).rejects.toThrow(
      'Workspace file path escapes config directory',
    )
    await expect(stat(join(workspaceDir, '..', siblingDir, 'escape.suite.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
