import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..', '..')
const watched = ['.agent-qa', 'dashboard-artifacts']

function listPaths(): string[] {
  return watched.flatMap((name) => {
    const dir = join(packageRoot, name)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { recursive: true }).map((path) => join(name, String(path)))
  })
}

export default function setup() {
  const before = new Set(listPaths())
  return function teardown() {
    const added = listPaths().filter((path) => !before.has(path))
    if (added.length === 0) return
    console.error(
      [
        `Tests added ${added.length} path(s) (files and directories) to packages/cli:`,
        ...added.slice(0, 20).map((path) => `  ${path}`),
        'Give the test a temporary config root so its run output lands outside the package.',
      ].join('\n'),
    )
    // vitest exits 0 when a globalSetup teardown throws, so the exit code is set instead.
    process.exitCode = 1
  }
}
