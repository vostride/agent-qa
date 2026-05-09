import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDashboardDbPath } from '../db/runtime-db-path.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-runtime-db-path-'))
  tempDirs.push(dir)
  return dir
}

describe('resolveDashboardDbPath', () => {
  it('resolves the default dashboard database to .agent-qa/runs.db', async () => {
    const workspaceDir = await createWorkspace()

    expect(resolveDashboardDbPath({ configDir: workspaceDir })).toBe(join(workspaceDir, '.agent-qa', 'runs.db'))
  })

  it('honors an explicit configured relative path without migrating legacy defaults', async () => {
    const workspaceDir = await createWorkspace()
    const legacyPath = join(workspaceDir, '.agent-qa', 'dashboard.db')
    await mkdir(join(workspaceDir, '.agent-qa'), { recursive: true })
    await writeFile(legacyPath, 'legacy')

    expect(resolveDashboardDbPath({ configDir: workspaceDir, configuredDbPath: 'custom/dashboard.db' }))
      .toBe(join(workspaceDir, 'custom', 'dashboard.db'))
    await expect(access(legacyPath)).resolves.toBeUndefined()
  })

  it('moves a legacy default dashboard database to the runs database when no new file exists', async () => {
    const workspaceDir = await createWorkspace()
    const legacyPath = join(workspaceDir, '.agent-qa', 'dashboard.db')
    const defaultPath = join(workspaceDir, '.agent-qa', 'runs.db')
    await mkdir(join(workspaceDir, '.agent-qa'), { recursive: true })
    await writeFile(legacyPath, 'legacy-runs')

    expect(resolveDashboardDbPath({ configDir: workspaceDir })).toBe(defaultPath)

    await expect(access(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(defaultPath, 'utf-8')).resolves.toBe('legacy-runs')
  })

  it('prefers the runs database and leaves legacy untouched when both files exist', async () => {
    const workspaceDir = await createWorkspace()
    const legacyPath = join(workspaceDir, '.agent-qa', 'dashboard.db')
    const defaultPath = join(workspaceDir, '.agent-qa', 'runs.db')
    await mkdir(join(workspaceDir, '.agent-qa'), { recursive: true })
    await writeFile(legacyPath, 'legacy-runs')
    await writeFile(defaultPath, 'current-runs')

    expect(resolveDashboardDbPath({ configDir: workspaceDir })).toBe(defaultPath)

    await expect(readFile(legacyPath, 'utf-8')).resolves.toBe('legacy-runs')
    await expect(readFile(defaultPath, 'utf-8')).resolves.toBe('current-runs')
  })
})
