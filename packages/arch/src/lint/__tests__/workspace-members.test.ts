import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contractBearingDirs, workspaceMemberDirs } from '../workspace-members.js'

const roots: string[] = []

function repoWith(workspaceGlobs: readonly string[], packageDirs: readonly string[]): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'arch-workspace-members-'))
  roots.push(repoRoot)
  writeFileSync(
    join(repoRoot, 'pnpm-workspace.yaml'),
    `packages:\n${workspaceGlobs.map(glob => `  - "${glob}"`).join('\n')}\n`,
  )
  for (const packageDir of packageDirs) {
    mkdirSync(join(repoRoot, packageDir, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, packageDir, 'package.json'), '{}\n')
    writeFileSync(join(repoRoot, packageDir, 'src', 'ownership-contract.ts'), '')
  }
  return repoRoot
}

afterEach(() => {
  for (const repoRoot of roots.splice(0)) {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

describe('workspaceMemberDirs', () => {
  it('reads only packages/ when only packages/* is declared', () => {
    const repoRoot = repoWith(['packages/*'], ['packages/core', 'plugins/acme'])

    expect(workspaceMemberDirs(repoRoot)).toEqual(['packages/core'])
  })

  it('reads packages/ without throwing when plugins/* is declared and plugins/ is absent', () => {
    const repoRoot = repoWith(['packages/*', 'plugins/*'], ['packages/core'])

    expect(workspaceMemberDirs(repoRoot)).toEqual(['packages/core'])
    expect(contractBearingDirs(repoRoot)).toEqual(['packages/core'])
  })

  it('lists plugin members when both roots are declared', () => {
    const repoRoot = repoWith(['packages/*', 'plugins/*'], ['packages/core', 'plugins/acme'])

    expect(workspaceMemberDirs(repoRoot)).toEqual(['packages/core', 'plugins/acme'])
    expect(contractBearingDirs(repoRoot)).toEqual(['packages/core', 'plugins/acme'])
  })

  it('throws when packages/* is not declared', () => {
    const repoRoot = repoWith(['plugins/*'], ['plugins/acme'])

    expect(() => workspaceMemberDirs(repoRoot)).toThrow(
      'pnpm-workspace.yaml must declare the packages/* workspace member glob',
    )
  })
})
