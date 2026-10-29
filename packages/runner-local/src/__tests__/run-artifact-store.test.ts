// FsRunArtifactStore. Pins the file-side run-artifact contract: stage writes
// config+source into artifact.json in the run dir, finalize merges terminal errors + finalizedAt,
// the top-level runtime section is never written (RESEARCH Q5 keep/drop table), and a
// traversal-shaped runId is neutralized by slugBranch so it lands under runs/.
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FsRunArtifactStore, ARTIFACT_FILE } from '../run-artifact-store.js'
import { slugBranch } from '../branch-resolver.js'
import { RUNS_SUBDIR } from '../event-log.js'
import { RUN_ARTIFACT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { RunArtifactStageInput, RunArtifactTerminalError } from '@vostride/agent-qa-schema'

function stageDoc(): RunArtifactStageInput {
  return {
    config: { rawConfigContent: 'baseUrl: http://localhost', cliVars: { FOO: 'bar' } },
    source: { kind: 'test', testId: 't-1', name: 'login', rawYaml: 'steps: []' },
    // A top-level runtime section that MUST be dropped by the store (derived from events/handoff).
    runtime: { status: 'running', duration: 0 },
  }
}

async function readArtifact(root: string, runId: string): Promise<Record<string, unknown>> {
  const file = join(root, RUNS_SUBDIR, slugBranch(runId), ARTIFACT_FILE)
  return JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>
}

describe('FsRunArtifactStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-run-artifact-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('stage writes artifact.json beside events.jsonl with config + source and schemaVersion', async () => {
    const store = new FsRunArtifactStore({ root, runId: 'run-1' })
    store.stage(stageDoc())

    const artifact = await readArtifact(root, 'run-1')
    expect(artifact.schemaVersion).toBe(RUN_ARTIFACT_SCHEMA_VERSION)
    expect((artifact.config as Record<string, unknown>).rawConfigContent).toBe('baseUrl: http://localhost')
    expect((artifact.source as Record<string, unknown>).testId).toBe('t-1')
  })

  it('stage drops the top-level runtime section (keep/drop table)', async () => {
    const store = new FsRunArtifactStore({ root, runId: 'run-1' })
    store.stage(stageDoc())

    const artifact = await readArtifact(root, 'run-1')
    expect(artifact).not.toHaveProperty('runtime')
  })

  it('finalize merges terminal errors + finalizedAt onto the staged document without clobbering config/source', async () => {
    const store = new FsRunArtifactStore({ root, runId: 'run-1' })
    store.stage(stageDoc())

    const errors: RunArtifactTerminalError[] = [
      { code: 'setup-error', message: 'boom', phase: 'per-test-setup' },
    ]
    store.finalize({ errors, finalizedAt: '2026-07-09T00:00:00.000Z' })

    const artifact = await readArtifact(root, 'run-1')
    // Config + source survive the finalize merge.
    expect((artifact.config as Record<string, unknown>).rawConfigContent).toBe('baseUrl: http://localhost')
    expect((artifact.source as Record<string, unknown>).testId).toBe('t-1')
    // Errors + finalizedAt land; runtime is still absent.
    expect(artifact.errors).toEqual(errors)
    expect(artifact.finalizedAt).toBe('2026-07-09T00:00:00.000Z')
    expect(artifact).not.toHaveProperty('runtime')
  })

  it('finalize before any stage starts a fresh schema-stamped document (crash-before-stage)', async () => {
    const store = new FsRunArtifactStore({ root, runId: 'run-1' })
    store.finalize({ finalizedAt: '2026-07-09T00:00:00.000Z' })

    const artifact = await readArtifact(root, 'run-1')
    expect(artifact.schemaVersion).toBe(RUN_ARTIFACT_SCHEMA_VERSION)
    expect(artifact.finalizedAt).toBe('2026-07-09T00:00:00.000Z')
  })

  it('neutralizes a traversal-shaped runId via slugBranch so the artifact stays under runs/', async () => {
    const evilRunId = '../../etc/run-1'
    const store = new FsRunArtifactStore({ root, runId: evilRunId })
    store.stage(stageDoc())

    // The file is reachable only through the slugged segment under runs/ — never outside root.
    const artifact = await readArtifact(root, evilRunId)
    expect(artifact.schemaVersion).toBe(RUN_ARTIFACT_SCHEMA_VERSION)
    const slug = slugBranch(evilRunId)
    expect(slug).not.toContain('..')
    expect(slug).not.toContain('/')
  })
})
