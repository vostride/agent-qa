import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKSPACE_ROOTS = ['packages', 'plugins'] as const
type WorkspaceRoot = (typeof WORKSPACE_ROOTS)[number]

function declaredWorkspaceRoots(repoRoot: string): WorkspaceRoot[] {
  const workspaceYaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const declared = new Set(
    workspaceYaml
      .split(/\r?\n/u)
      .map(line => line.trim().match(/^-\s*["']?(packages|plugins)\/\*["']?\s*$/u)?.[1])
      .filter((root): root is WorkspaceRoot => root !== undefined),
  )

  if (!declared.has('packages')) {
    throw new Error('pnpm-workspace.yaml must declare the packages/* workspace member glob')
  }

  return WORKSPACE_ROOTS.filter(root => declared.has(root))
}

function packageDirsUnder(
  repoRoot: string,
  root: WorkspaceRoot,
  qualifies: (packageDir: string) => boolean,
): string[] {
  const rootDir = join(repoRoot, root)
  if (!existsSync(rootDir)) {
    return []
  }

  return readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && qualifies(join(rootDir, entry.name)))
    .map(entry => `${root}/${entry.name}`)
}

export function workspaceMemberDirs(repoRoot: string): string[] {
  return declaredWorkspaceRoots(repoRoot)
    .flatMap(root =>
      packageDirsUnder(repoRoot, root, packageDir => existsSync(join(packageDir, 'package.json'))),
    )
    .sort()
}

export function contractBearingDirs(repoRoot: string): string[] {
  return WORKSPACE_ROOTS.flatMap(root =>
    packageDirsUnder(
      repoRoot,
      root,
      packageDir =>
        existsSync(join(packageDir, 'package.json')) &&
        existsSync(join(packageDir, 'src', 'ownership-contract.ts')),
    ),
  ).sort()
}

export function findContractlessWorkspaceOffenders(
  memberDirs: readonly string[],
  contractDirs: readonly string[],
): string[] {
  const contractDirSet = new Set(contractDirs)
  return memberDirs
    .filter(memberDir => !contractDirSet.has(memberDir))
    .map(memberDir => `${memberDir}: workspace package missing src/ownership-contract.ts`)
    .sort()
}
