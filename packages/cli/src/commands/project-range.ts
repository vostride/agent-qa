import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ProjectHost, ProjectIo } from './project-host.js'

export interface ProjectRange {
  start: string
  folders: readonly string[]
}

function isFilesystemRoot(folder: string): boolean {
  return dirname(folder) === folder
}

// Bounded by the nearest folder holding a .git entry; never the home folder, the filesystem root
// or anything above them.
export async function projectRange(
  start: string,
  host: Pick<ProjectHost, 'homedir' | 'io'>,
): Promise<ProjectRange> {
  const realStart = await host.io.realpath(start)
  const home = await host.io.realpath(host.homedir)
  const folders: string[] = []
  let folder = realStart
  while (folder !== home && !isFilesystemRoot(folder)) {
    folders.push(folder)
    if (host.io.exists(join(folder, '.git'))) break
    const parent = dirname(folder)
    if (parent === home || isFilesystemRoot(parent)) break
    folder = parent
  }
  return { start: realStart, folders }
}

export function nearestFile(range: ProjectRange, name: string, io: ProjectIo): string | undefined {
  for (const folder of range.folders) {
    const candidate = join(folder, name)
    if (io.exists(candidate)) return candidate
  }
  return undefined
}

function joinsAsPackagePath(name: string): boolean {
  if (name.includes('\\')) return false
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function isAtOrBelow(folder: string, path: string): boolean {
  const fromFolder = relative(folder, path)
  return (
    fromFolder === '' ||
    (fromFolder !== '..' && !fromFolder.startsWith(`..${sep}`) && !isAbsolute(fromFolder))
  )
}

export function nearestInstalledPackage(
  range: ProjectRange,
  fromDir: string,
  name: string,
  io: ProjectIo,
): string | undefined {
  if (!joinsAsPackagePath(name)) return undefined
  for (const folder of range.folders) {
    if (!isAtOrBelow(folder, fromDir)) continue
    const candidate = join(folder, 'node_modules', ...name.split('/'), 'package.json')
    if (io.exists(candidate)) return candidate
  }
  return undefined
}
