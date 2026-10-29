// Run-end working-memory flush. Every value is masked with the run's
// declared mask and written as is to `.agent-qa/artifacts`, then the store
// is disposed. The flush never throws, so the run exit code is untouched (Pitfall 5).
//
// Boundary contract (Pitfall 7 boundary 3): mask() applies ONLY here at flush; the store and
// turn content stay verbatim.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const WORKING_MEMORY_FLUSH_KIND = 'working-memory-flush'

/**
 * Structural view of one working-memory entry the flush needs. Kept local (not imported from
 * schema) so the surface package's dependency set stays unchanged — the store's `WorkingMemoryEntry`
 * satisfies it by construction.
 */
interface FlushEntry {
  key: string
  value: string
  kind: string
  provenance: string
  testIndex?: number
  stepIndex?: number
}

/**
 * Structural view of the run-scoped store at flush time (WM store's `entries`/`dispose` satisfy it).
 */
export interface WorkingMemoryFlushSource {
  entries(): readonly FlushEntry[]
  dispose(): void
}

export interface FlushWorkingMemoryOptions {
  /** Directory the CLI already owns (`.agent-qa/artifacts`); created if missing. */
  artifactsDir: string
  /** The run redactor's mask, applied to every value. */
  mask?: (value: string) => string
}

export interface FlushWorkingMemoryResult {
  /** Path of the written artifact (empty string only if the write itself failed — never throws). */
  path: string
  /** Number of entries the store held at flush time. */
  entriesWritten: number
}

/**
 * Flush the run-scoped working memory with every value masked, then dispose the store.
 * Resolves best-effort: a failed write leaves `path` empty, and the store is always disposed.
 */
export async function flushWorkingMemory(
  store: WorkingMemoryFlushSource,
  options: FlushWorkingMemoryOptions,
): Promise<FlushWorkingMemoryResult> {
  const { artifactsDir, mask = (value: string) => value } = options

  try {
    const entries = [...store.entries()]
    const flushedAt = new Date().toISOString()
    const artifactEntries = entries.map((entry) => {
      let value: string
      try {
        value = mask(entry.value)
      } catch {
        // A misbehaving mask must never leak a raw value — fall back to a coded blank.
        value = '[mask-error]'
      }
      const out: FlushEntry = {
        key: entry.key,
        value,
        kind: entry.kind,
        provenance: entry.provenance,
      }
      if (entry.testIndex !== undefined) out.testIndex = entry.testIndex
      if (entry.stepIndex !== undefined) out.stepIndex = entry.stepIndex
      return out
    })

    const artifact = {
      kind: WORKING_MEMORY_FLUSH_KIND,
      flushedAt,
      entryCount: entries.length,
      entries: artifactEntries,
    }

    let path = ''
    try {
      await mkdir(artifactsDir, { recursive: true })
      path = join(
        artifactsDir,
        `working-memory-flush-${flushedAt.replace(/[:.]/g, '-')}.json`,
      )
      await writeFile(path, JSON.stringify(artifact, null, 2), 'utf8')
    } catch {
      // Best-effort: a failed write must not crash run teardown.
      path = ''
    }

    return { path, entriesWritten: entries.length }
  } finally {
    // WM-02 disposal always runs — on the clean path and any error path.
    try {
      store.dispose()
    } catch {
      /* disposal must never throw out of teardown */
    }
  }
}
