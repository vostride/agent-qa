// Concrete filesystem run-artifact store.
//
// Implements the storage-neutral `RunArtifactStorePort` from @vostride/agent-qa-runner. This is a
// storageImplementation home for node:fs + node:path (the FsEventLog / FsHandoffStore boundary) —
// the durable artifact fs write lives here, never in the runner (validate:arch storageNeutral).
// On-disk layout — one JSON document beside the run's events.jsonl / handoff.json (D-08, one
// self-contained run directory):
//
//   <root>/runs/<slug(runId)>/artifact.json
//
// The runId directory component is slugged traversal-safe (the T-360-03 `slugBranch` idiom, shared
// with FsEventLog via `RUNS_SUBDIR`) so a planner-supplied `../..`-shaped runId can never escape
// the runs root — the path is NEVER re-minted here.
//
// Per the RESEARCH Q5 keep/drop table the FILE artifact keeps ONLY the config snapshot, the
// test/suite source snapshot, terminal errors, and metadata. The top-level `runtime` section is
// DROPPED from new documents (it is derivable from events.jsonl / handoff.json), so `stage`/
// `finalize` strip any incoming top-level `runtime` before writing. `stage` persists config+source
// once after runStarted; `finalize` merges terminal errors + `finalizedAt` before runFinished
// (the dashboard staged/finalize idiom — a crashed run still leaves a staged artifact.json).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { RUN_ARTIFACT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  RunArtifactFinalizeInput,
  RunArtifactPayload,
  RunArtifactStageInput,
} from '@vostride/agent-qa-schema'
import type { RunArtifactStorePort } from '@vostride/agent-qa-runner'

import { slugBranch } from './branch-resolver.js'
import { RUNS_SUBDIR } from './event-log.js'

/** The single JSON document each run writes its run artifact to. */
export const ARTIFACT_FILE = 'artifact.json'

export interface FsRunArtifactStoreConfig {
  /** Runtime root (e.g. DEFAULT_AGENT_QA_DIR = '.agent-qa'). */
  root: string
  /** The run this artifact belongs to; slugged before it becomes a path segment. */
  runId: string
}

/** The persisted artifact document shape (schema-stamped, runtime-free). */
type PersistedArtifact = Omit<RunArtifactPayload, 'runtime'> & { finalizedAt?: string }

export class FsRunArtifactStore implements RunArtifactStorePort {
  private readonly dir: string
  private readonly file: string

  constructor(config: FsRunArtifactStoreConfig) {
    // Same slugged run dir as FsEventLog so artifact.json lands beside events.jsonl.
    this.dir = join(config.root, RUNS_SUBDIR, slugBranch(config.runId))
    this.file = join(this.dir, ARTIFACT_FILE)
  }

  stage(document: RunArtifactStageInput): void {
    const persisted = this.merge({ schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION }, document)
    this.write(persisted)
  }

  finalize(patch: RunArtifactFinalizeInput): void {
    const base = this.readExisting() ?? { schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION }
    const persisted = this.merge(base, patch)
    this.write(persisted)
  }

  /** Shallow-merge a stage/finalize input onto the base, always dropping the top-level runtime. */
  private merge(base: PersistedArtifact, input: RunArtifactStageInput | RunArtifactFinalizeInput): PersistedArtifact {
    const { runtime: _dropRuntime, ...rest } = input as RunArtifactStageInput & { runtime?: unknown }
    const merged: PersistedArtifact = {
      ...base,
      ...rest,
      schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    }
    delete (merged as { runtime?: unknown }).runtime
    return merged
  }

  private readExisting(): PersistedArtifact | undefined {
    try {
      return JSON.parse(readFileSync(this.file, 'utf-8')) as PersistedArtifact
    } catch (err) {
      // No staged artifact yet (crash before stage) ⇒ start fresh, never throw on the read leg.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  private write(document: PersistedArtifact): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(document)}\n`, 'utf-8')
  }
}
