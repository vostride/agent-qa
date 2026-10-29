import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  commitCurationDelta,
  drainQueue,
  openIndexWriter,
  readJobState,
  type AuthoredDeltaCheckpoint,
  type CommitCurationDependencies,
  type CommitCurationJob,
  type CommitCurationOutcome,
  type CuratorAuthor,
} from '@vostride/agent-qa-knowledge-local'
import { publishBundleForTest as publishBundle } from '@vostride/agent-qa-knowledge-local'
import { canonicalJson } from '@vostride/agent-qa-schema'

import { DRAIN_SESSION_RECEIPTS_FILE } from '../../daemon/drain-receipts.js'
import { DAEMON_EVENTS_FILE } from '../../daemon/events.js'
import {
  createScriptedAuthor,
  enqueueFixtureBytes,
  readFixture,
} from '../dual-host/fixtures.js'
import { canonicalBundleTree, orderedLogicalDump } from '../dual-host/logical-dump.js'
import {
  FENCING_ENV,
  writeDurableJson,
  type FencingPauseAt,
} from './spawn-helpers.js'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

function blockSynchronouslyUntil(file: string): void {
  const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  while (!existsSync(file)) Atomics.wait(sleepCell, 0, 0, 20)
}

function requestedPauseAt(): FencingPauseAt {
  const value = process.env[FENCING_ENV.pauseAt] ?? 'beforeCommitAuthorityEntry'
  if (
    value !== 'beforeCommitAuthorityEntry'
    && value !== 'afterIntentWritten'
    && value !== 'afterFinalAuthorityCompare'
    && value !== 'publish-rename'
    && value !== 'afterBundlePublished'
  ) {
    throw new Error(`unsupported fencing pause point: ${value}`)
  }
  return value
}

function currentAuthor(fixture: ReturnType<typeof readFixture>): CuratorAuthor {
  return createScriptedAuthor(fixture, [])
}

function filesBelow(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = join(dir, entry.name)
      return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : []
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function byteTree(dir: string): readonly { path: string; bytes: string }[] {
  return filesBelow(dir).map((file) => ({
    path: relative(dir, file),
    bytes: readFileSync(file).toString('base64'),
  })).sort((left, right) => left.path.localeCompare(right.path))
}

function fileBytes(file: string): string | null {
  try {
    return readFileSync(file).toString('base64')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function nonHeartbeatEvents(agentQaRoot: string): readonly Record<string, unknown>[] {
  const file = join(agentQaRoot, DAEMON_EVENTS_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.kind !== 'lease-heartbeated')
}

function mutationSnapshot(
  knowledgeRoot: string,
  agentQaRoot: string,
  candidateId: string,
): string {
  const queueRoot = join(knowledgeRoot, 'memory', 'queue')
  return canonicalJson({
    bundles: canonicalBundleTree(knowledgeRoot),
    logicalIndex: orderedLogicalDump(knowledgeRoot),
    queueTree: byteTree(queueRoot),
    jobState: readJobState(knowledgeRoot, candidateId),
    intentTree: byteTree(join(queueRoot, 'journal')),
    drainSessionReceipts: fileBytes(join(agentQaRoot, DRAIN_SESSION_RECEIPTS_FILE)),
    nonHeartbeatEvents: nonHeartbeatEvents(agentQaRoot),
  })
}

export async function runPausedDrainerFixture(): Promise<void> {
  const root = requiredEnv(FENCING_ENV.root)
  const fixture = readFixture(requiredEnv(FENCING_ENV.fixture))
  const marker = requiredEnv(FENCING_ENV.marker)
  const permit = requiredEnv(FENCING_ENV.permit)
  const reportFile = requiredEnv(FENCING_ENV.report)
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const agentQaRoot = join(root, '.agent-qa')
  const control = process.env[FENCING_ENV.control] === '1'
  const pauseAt = requestedPauseAt()
  const candidateId = fixture.candidates[0]?.candidateId
  if (candidateId === undefined || fixture.candidates.length !== 1) {
    throw new Error('fencing fixture requires exactly one candidate')
  }

  openIndexWriter(knowledgeRoot).close()
  enqueueFixtureBytes(knowledgeRoot, fixture)

  let hookCount = 0
  let beforePublishRenameReached = false
  let retained: {
    deps: CommitCurationDependencies
    job: CommitCurationJob
    checkpoint: AuthoredDeltaCheckpoint
  } | undefined
  let firstOutcome: CommitCurationOutcome | undefined
  let secondOutcome: CommitCurationOutcome | undefined
  let firstSnapshot: string | undefined
  let secondSnapshot: string | undefined
  let publicationEntryCount = 0
  let retainedReferenceEquality = {
    deps: false,
    job: false,
    checkpoint: false,
  }

  const wrappedCommit = (
    deps: CommitCurationDependencies,
    job: CommitCurationJob,
    checkpoint: AuthoredDeltaCheckpoint,
  ): CommitCurationOutcome => {
    if (retained !== undefined) throw new Error('the real drain entered the commit wrapper twice')
    const originalHooks = deps.hooks
    const originalPublisher = deps.operations?.publishBundle ?? publishBundle
    if (control) {
      deps.hooks = {
        ...originalHooks,
        afterIntentWritten: () => {
          originalHooks?.afterIntentWritten?.()
          hookCount += 1
        },
      }
    } else if (pauseAt === 'beforeCommitAuthorityEntry') {
      deps.hooks = {
        ...originalHooks,
        beforeCommitAuthorityEntry: () => {
          originalHooks?.beforeCommitAuthorityEntry?.()
          hookCount += 1
          writeDurableJson(marker, {
            phase: 'beforeCommitAuthorityEntry',
            pid: process.pid,
            candidateId: job.candidateId,
            leaseId: job.leaseId,
            oldEpoch: deps.epoch,
          })
          blockSynchronouslyUntil(permit)
        },
        beforePublishRename: () => {
          beforePublishRenameReached = true
          throw new Error('stale drainer reached beforePublishRename')
        },
      }
    } else if (pauseAt === 'afterIntentWritten') {
      // The process stops holding a durable intent; the lease ages out and a successor takes it.
      deps.hooks = {
        ...originalHooks,
        afterIntentWritten: () => {
          originalHooks?.afterIntentWritten?.()
          hookCount += 1
          writeDurableJson(marker, {
            phase: 'afterIntentWritten',
            pid: process.pid,
            candidateId: job.candidateId,
            leaseId: job.leaseId,
            oldEpoch: deps.epoch,
          })
          blockSynchronouslyUntil(permit)
        },
        beforePublishRename: () => {
          beforePublishRenameReached = true
          throw new Error('reclaimed drainer reached beforePublishRename')
        },
      }
    } else if (pauseAt === 'afterFinalAuthorityCompare') {
      deps.hooks = {
        ...originalHooks,
        afterFinalAuthorityCompare: () => {
          originalHooks?.afterFinalAuthorityCompare?.()
          hookCount += 1
          writeDurableJson(marker, {
            phase: 'afterFinalAuthorityCompare',
            pid: process.pid,
            candidateId: job.candidateId,
            leaseId: job.leaseId,
            oldEpoch: deps.epoch,
          })
          blockSynchronouslyUntil(permit)
        },
        beforePublishRename: () => {
          originalHooks?.beforePublishRename?.()
          beforePublishRenameReached = true
        },
      }
    } else if (pauseAt === 'afterBundlePublished') {
      deps.hooks = {
        ...originalHooks,
        afterBundlePublished: (bundleId) => {
          originalHooks?.afterBundlePublished?.(bundleId)
          hookCount += 1
          writeDurableJson(marker, {
            phase: 'afterBundlePublished',
            pid: process.pid,
            candidateId: job.candidateId,
            bundleId,
            leaseId: job.leaseId,
            oldEpoch: deps.epoch,
          })
          blockSynchronouslyUntil(permit)
        },
      }
    } else {
      deps.hooks = {
        ...originalHooks,
        beforePublishRename: () => {
          originalHooks?.beforePublishRename?.()
          hookCount += 1
          beforePublishRenameReached = true
          writeDurableJson(marker, {
            phase: 'beforePublishRename',
            pid: process.pid,
            candidateId: job.candidateId,
            leaseId: job.leaseId,
            oldEpoch: deps.epoch,
          })
          blockSynchronouslyUntil(permit)
        },
      }
    }
    deps.operations = {
      ...deps.operations,
      publishBundle: (...args: Parameters<typeof publishBundle>) => {
        publicationEntryCount += 1
        return originalPublisher(...args)
      },
    }
    retained = { deps, job, checkpoint }
    retainedReferenceEquality = {
      deps: retained.deps === deps,
      job: retained.job === job,
      checkpoint: retained.checkpoint === checkpoint,
    }
    firstOutcome = commitCurationDelta(retained.deps, retained.job, retained.checkpoint)
    if (!control && pauseAt === 'beforeCommitAuthorityEntry') {
      firstSnapshot = mutationSnapshot(knowledgeRoot, agentQaRoot, candidateId)
      secondOutcome = commitCurationDelta(retained.deps, retained.job, retained.checkpoint)
      secondSnapshot = mutationSnapshot(knowledgeRoot, agentQaRoot, candidateId)
    }
    return firstOutcome
  }

  try {
    await drainQueue({
      knowledgeRoot,
      author: currentAuthor(fixture),
      executionContext: 'local-interactive',
      maintenance: 'skip',
      operations: { commitCurationDelta: wrappedCommit },
    })

    if (control) {
      if (retained === undefined || firstOutcome?.kind !== 'applied') {
        throw new Error(`control did not accept current authority: ${JSON.stringify(firstOutcome)}`)
      }
      writeDurableJson(reportFile, {
        failed: false,
        control: true,
        pauseAt,
        pid: process.pid,
        candidateId,
        oldEpoch: retained.deps.epoch,
        hookCount,
        acceptedKind: firstOutcome.kind,
        publicationEntryCount,
      })
      return
    }
    if (
      pauseAt === 'publish-rename'
      || pauseAt === 'afterFinalAuthorityCompare'
      || pauseAt === 'afterBundlePublished'
    ) {
      if (retained === undefined || firstOutcome?.kind !== 'applied') {
        throw new Error(
          `${pauseAt} holder did not complete: ${JSON.stringify(firstOutcome)}`,
        )
      }
      writeDurableJson(reportFile, {
        failed: false,
        pauseAt,
        pid: process.pid,
        candidateId,
        oldEpoch: retained.deps.epoch,
        hookCount,
        beforePublishRenameReached,
        acceptedKind: firstOutcome.kind,
        publicationEntryCount,
      })
      return
    }
    if (
      retained === undefined
      || firstOutcome?.kind !== 'abandoned-stale-epoch'
      || secondOutcome?.kind !== 'abandoned-stale-epoch'
    ) {
      throw new Error(`expected a real stale-epoch refusal, received ${JSON.stringify(firstOutcome)}`)
    }
    if (hookCount !== 1 || beforePublishRenameReached) {
      throw new Error(
        `invalid guard path: ${pauseAt}=${hookCount}, beforePublishRename=${beforePublishRenameReached}`,
      )
    }

    writeDurableJson(reportFile, {
      failed: true,
      pauseAt,
      pid: process.pid,
      candidateId,
      oldEpoch: retained.deps.epoch,
      exactInputRetained: true,
      retainedReferenceEquality,
      hookCount,
      beforePublishRenameReached,
      mutationFreeReplay: firstSnapshot === secondSnapshot,
      nonHeartbeatEventsUnchanged: firstSnapshot === secondSnapshot,
      publicationEntryCount,
      outcomes: [
        {
          guard: pauseAt === 'beforeCommitAuthorityEntry' ? 'beforePublish' : pauseAt,
          ...firstOutcome,
        },
        { guard: 'beforeWork', ...secondOutcome },
      ],
    })
    throw new Error(
      `expected fencing refusal: ${firstOutcome.kind} (observed ${firstOutcome.observedEpoch})`,
    )
  } catch (error) {
    if (!existsSync(reportFile)) {
      writeDurableJson(reportFile, {
        failed: true,
        pid: process.pid,
        candidateId,
        reason: error instanceof Error ? error.message : String(error),
        outcomes: firstOutcome === undefined ? [] : [firstOutcome],
      })
    }
    throw error
  }
}

if (process.env[FENCING_ENV.role] === 'paused-drainer') {
  void runPausedDrainerFixture().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
