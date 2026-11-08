import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION_REFRESH_ENTRY = 'version-refresh.js'

export type VersionRefreshSpawn = (homeDir: string) => void

// The refresh entry ships beside the bundle that holds this code.
export function versionRefreshEntryPath(): string {
  const here = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
  return join(dirname(here), VERSION_REFRESH_ENTRY)
}

// Detached and unref'd, so the command exits without waiting and the request still finishes.
export const spawnVersionRefresh: VersionRefreshSpawn = (homeDir) => {
  const child = spawn(process.execPath, [versionRefreshEntryPath(), homeDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
}
