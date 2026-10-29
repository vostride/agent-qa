/**
 * C-HYG-ARCH-TEST-ORDER (quick 261002-hyg, 432-14 #6): the arch tests read other packages' source,
 * and that source resolves `@vostride/agent-qa-*` through each package's built `dist`; two cells
 * read `core/dist` and `cli/dist` directly. The arch package declares none of those packages, so
 * its own `^build` orders nothing. A forced `--concurrency=2` run once started the arch tests
 * while the schema build had cleared its `dist`. This pins the task graph that prevents it: the
 * arch test waits for every package build under `packages/`, named or reached through `^build`.
 * The arch typecheck compiles the same source, so a fresh clone (no `dist` yet) needs the same
 * order for it.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES_DIR = join(HERE, '..', '..', '..')
const REPO_ROOT = join(PACKAGES_DIR, '..')
const ARCH_TEST = '@vostride/agent-qa-arch#test'
const ARCH_TYPECHECK = '@vostride/agent-qa-arch#typecheck'

interface Manifest {
  name: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function manifests(): Map<string, Manifest> {
  const byName = new Map<string, Manifest>()
  for (const dir of readdirSync(PACKAGES_DIR)) {
    const path = join(PACKAGES_DIR, dir, 'package.json')
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    byName.set(manifest.name, manifest)
  }
  return byName
}

function workspaceDeps(manifest: Manifest, names: ReadonlySet<string>): string[] {
  const all = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }
  return Object.keys(all).filter((name) => names.has(name))
}

const NAMED_BUILDS = [
  '^build',
  '@vostride/agent-qa-schema#build',
  '@vostride/agent-qa-agent#build',
  '@vostride/agent-qa-core#build',
  'agent-qa#build',
]

function expectCoversEveryBuild(task: string): void {
  const turbo = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8')) as {
    tasks: Record<string, { dependsOn?: string[] }>
  }
  const dependsOn = turbo.tasks[task]?.dependsOn ?? []
  for (const named of NAMED_BUILDS) {
    expect(dependsOn, named).toContain(named)
  }

  const byName = manifests()
  const names = new Set(byName.keys())
  const reached = new Set<string>()
  const stack = dependsOn
    .filter((entry) => entry.endsWith('#build'))
    .map((entry) => entry.slice(0, -'#build'.length))
  stack.push(...workspaceDeps(byName.get('@vostride/agent-qa-arch')!, names))
  while (stack.length > 0) {
    const name = stack.pop()!
    if (reached.has(name)) continue
    reached.add(name)
    const manifest = byName.get(name)
    if (manifest !== undefined) stack.push(...workspaceDeps(manifest, names))
  }

  const builds = [...byName.values()]
    .filter((manifest) => manifest.scripts?.build !== undefined)
    .map((manifest) => manifest.name)
  const missing = builds.filter((name) => !reached.has(name)).sort()
  expect(missing, `add each to ${task}.dependsOn in turbo.json`).toEqual([])
}

describe('C-HYG-ARCH-TEST-ORDER — the arch test runs after every build it reads', () => {
  it('C-HYG-ARCH-TEST-ORDER: names the packages it reads and covers every package build', () => {
    expectCoversEveryBuild(ARCH_TEST)
  })

  it('C-HYG-ARCH-TEST-ORDER: the arch typecheck also runs after every build it reads, in a fresh clone', () => {
    expectCoversEveryBuild(ARCH_TYPECHECK)
  })
})
