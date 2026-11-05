import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function findPackageRoot(fromDir: string): string | undefined {
  let dir = fromDir
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function readPackageJson(packageRoot: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}
