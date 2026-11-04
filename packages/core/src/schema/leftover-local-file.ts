import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { LOCAL_FILE_NAME, RETIRED_LOCAL_FILE_MESSAGE } from './retired-keys.js'

// Checks only that the file exists: its content may hold old serials or credentials.
export function leftoverLocalFileRefusal(dirs: readonly string[]): string | undefined {
  for (const dir of new Set(dirs.map((dir) => resolve(dir)))) {
    const path = join(dir, LOCAL_FILE_NAME)
    if (existsSync(path)) return `${path}: ${RETIRED_LOCAL_FILE_MESSAGE}`
  }
  return undefined
}
