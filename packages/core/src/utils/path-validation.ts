import path from 'node:path'

export function isPathInsideDir(childPath: string, parentDir: string): boolean {
  if (!childPath) return false
  const resolved = path.resolve(parentDir, childPath)
  const relative = path.relative(parentDir, resolved)
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}
