import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// a project whose socket path is over budget gets a tmpdir fallback
// directory the product never removes. The daemon (`daemon/server.ts`) hashes `resolve(root)`, the
// embedder worker hashes `realpathSync(root)`; both are removed with the root.
function socketFallbackDirs(root: string): string[] {
  const paths = [resolve(root)]
  try {
    paths.push(realpathSync(root))
  } catch {}
  return [...new Set(paths)].map((path) =>
    join(tmpdir(), `agent-qa-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`))
}

export function removeTempRoots(roots: readonly string[]): void {
  const fallbacks = roots.flatMap(socketFallbackDirs)
  for (const path of [...fallbacks, ...roots]) rmSync(path, { recursive: true, force: true })
}

export interface PinnedTmpdir {
  readonly root: string
  restore(): void
}

// a failed browser launch leaves Playwright's dirs in this tmpdir.
export function pinProcessTmpdir(): PinnedTmpdir {
  const previous = process.env.TMPDIR
  const root = mkdtempSync('/tmp/aq24-')
  process.env.TMPDIR = root
  return {
    root,
    restore: () => {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    },
  }
}
