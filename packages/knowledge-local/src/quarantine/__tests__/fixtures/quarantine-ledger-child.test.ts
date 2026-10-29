// Markers publish by temp then rename, and every wait is bounded.

import { existsSync, renameSync, writeFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { quarantineIdentityKey } from '../../identity.js'
import {
  appendQuarantineEvents,
  foldQuarantineLedgerState,
  readQuarantineLedger,
} from '../../ledger.js'
import {
  QuarantineLeaseHeldError,
  createQuarantineOperations,
} from '../../operations.js'
import {
  CLI_OWNER,
  CONTESTED,
  QUARANTINE_CHILD_ENV,
  burstEvent,
  enteredEvent,
  parseQuarantineChildRole,
  renewedEvent,
  steppingClock,
  writerIdentity,
} from './cross-process-contract.js'

const childMode = process.env[QUARANTINE_CHILD_ENV.gate] === '1'

/** Bounds every poll in this file. Generous, because the failure it prevents is an unbounded one. */
const WAIT_TIMEOUT_MS = 45_000
const POLL_MS = 5

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

/** Published in one step, so the parent cannot observe a marker that is not yet a marker. */
function publishMarker(path: string, body: string): void {
  const staging = `${path}.${String(process.pid)}.tmp`
  writeFileSync(staging, body, 'utf8')
  renameSync(staging, path)
}

async function waitFor(description: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  for (;;) {
    if (ready()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

// Contract paths are already workspace-relative, so the mint is the identity function.
function mintIdentityPath(filePath: string): string {
  return filePath
}

interface ChildContext {
  root: string
  reportPath: string
  readyPath: string
  goPath: string
}

function readContext(): ChildContext {
  return {
    root: requiredEnv(QUARANTINE_CHILD_ENV.root),
    reportPath: requiredEnv(QUARANTINE_CHILD_ENV.report),
    readyPath: requiredEnv(QUARANTINE_CHILD_ENV.ready),
    goPath: requiredEnv(QUARANTINE_CHILD_ENV.go),
  }
}

/**
 * The CLI-shaped composition: no `resolveWriterAuthority`, so every verb call acquires the MRSW
 * writer lease itself and gives it back. This is exactly what `composeLocalAgent` builds for the
 * in-process CLI host.
 */
function cliShapedOperations(context: ChildContext): ReturnType<typeof createQuarantineOperations> {
  return createQuarantineOperations({
    resolveKnowledgeRoot: () => context.root,
    now: steppingClock(1),
    mintIdentityPath,
  })
}

/**
 * ROLE `serialized-add`. Hammer the real verb while the parent holds the lease, and count what the
 * exclusion actually did.
 *
 * The retry loop is the honest part: `acquireWriterLease` answers `held` against a FRESH holder and
 * this verb refuses typed rather than queueing (see `QuarantineLeaseHeldError`), so a concurrent
 * CLI writer does not wait — it is told to come back. Counting those refusals is how this process
 * proves it was genuinely inside the contended window rather than politely after it.
 */
async function runSerializedAdd(context: ChildContext): Promise<Record<string, unknown>> {
  const insidePath = requiredEnv(QUARANTINE_CHILD_ENV.inside)
  const insideDonePath = requiredEnv(QUARANTINE_CHILD_ENV.insideDone)
  const rounds = Number(requiredEnv(QUARANTINE_CHILD_ENV.rounds))
  const operations = cliShapedOperations(context)

  let heldRefusals = 0
  let heldRefusalsWhileParentInside = 0

  async function addWithRetry(
    input: Parameters<typeof operations.add>[0],
  ): Promise<'entered' | 'renewed'> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    for (;;) {
      try {
        return (await operations.add(input)).kind
      } catch (error) {
        if (!(error instanceof QuarantineLeaseHeldError)) throw error
        heldRefusals += 1
        // Read BOTH markers at the refusal instant: "the parent was inside its own serialized
        // section when this call was refused" is the simultaneity claim, and it has to be
        // observed rather than inferred from the fact that a refusal happened at all.
        if (existsSync(insidePath) && !existsSync(insideDonePath)) {
          heldRefusalsWhileParentInside += 1
        }
        if (Date.now() > deadline) {
          throw new Error(`lease never became available after ${String(heldRefusals)} refusals`)
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    }
  }

  publishMarker(context.readyPath, 'ready\n')
  await waitFor('the parent to release the child', () => existsSync(context.goPath))

  const startedAt = Date.now()
  // No owner ON PURPOSE: the parent claimed this entry, and a renewal that named nobody must
  // leave that claim standing. If serialization failed, the entry would carry two openings.
  const contestedOutcome = await addWithRetry({ ...CONTESTED })
  const blockedMs = Date.now() - startedAt

  const appended: string[] = []
  for (let index = 0; index < rounds; index += 1) {
    const identity = writerIdentity('child', index)
    await addWithRetry({ ...identity, owner: CLI_OWNER })
    appended.push(identity.testName)
  }

  return {
    role: 'serialized-add',
    pid: process.pid,
    failed: false,
    heldRefusals,
    heldRefusalsWhileParentInside,
    blockedMs,
    contestedOutcome,
    appended,
  }
}

// `operations.add`'s cycle with no lease and a barrier before the append, forcing a lost update.
async function runUnserializedCycle(context: ChildContext): Promise<Record<string, unknown>> {
  const foldedPath = requiredEnv(QUARANTINE_CHILD_ENV.folded)
  const resumePath = requiredEnv(QUARANTINE_CHILD_ENV.resume)
  const now = steppingClock(1)

  publishMarker(context.readyPath, 'ready\n')
  await waitFor('the parent to release the child', () => existsSync(context.goPath))

  const at = now()
  const read = readQuarantineLedger(context.root)
  const entries = foldQuarantineLedgerState(read.events, at)
  const key = quarantineIdentityKey(CONTESTED)
  const entry = entries.find((candidate) => quarantineIdentityKey(candidate) === key)
  // `operations.add`'s own routing, verbatim: an OPEN window (suppressing or lapsed) extends,
  // anything else opens. This is why a stale fold can never author `entered` over a release —
  // pre-release state is `quarantined`, which routes here to `renewed`.
  const decision = entry !== undefined && entry.state !== 'released' ? 'renewed' : 'entered'
  const observedState = entry?.state ?? 'absent'
  const foldedAtMs = Date.now()

  publishMarker(foldedPath, `${JSON.stringify({ decision, observedState })}\n`)
  await waitFor('the parent to write into the fold/append window', () => existsSync(resumePath))

  const event = decision === 'renewed'
    ? renewedEvent(CONTESTED, at)
    : enteredEvent(CONTESTED, at, CLI_OWNER)
  const outcome = appendQuarantineEvents(context.root, [event])
  const appendedAtMs = Date.now()

  return {
    role: 'unserialized-cycle',
    pid: process.pid,
    failed: false,
    observedState,
    decision,
    appendKind: outcome.kind,
    foldedAtMs,
    appendedAtMs,
  }
}

/**
 * ROLE `append-burst`. The TEARING leg, with no serialization anywhere on either side.
 *
 * Phase 1 is strict alternation — neither side writes round i+1 until it has SEEN the other's
 * round i — so the committed line order is interleaved BY CONSTRUCTION rather than by luck.
 * Phase 2 is a free burst from both processes at once, which is where simultaneity actually lives.
 * The two phases answer different questions and neither substitutes for the other.
 */
async function runAppendBurst(context: ChildContext): Promise<Record<string, unknown>> {
  const rounds = Number(requiredEnv(QUARANTINE_CHILD_ENV.rounds))
  const burst = Number(requiredEnv(QUARANTINE_CHILD_ENV.burst))
  const resumePath = requiredEnv(QUARANTINE_CHILD_ENV.resume)

  function committedTestNames(): Set<string> {
    return new Set(readQuarantineLedger(context.root).events.map((event) => event.testName))
  }

  publishMarker(context.readyPath, 'ready\n')
  await waitFor('the parent to release the child', () => existsSync(context.goPath))

  for (let index = 0; index < rounds; index += 1) {
    await waitFor(
      `the parent's alternation line ${String(index)}`,
      () => committedTestNames().has(`parent-burst-${String(index)}`),
    )
    appendQuarantineEvents(context.root, [burstEvent('child', index)])
  }

  await waitFor('the parent to open the free burst', () => existsSync(resumePath))
  for (let index = rounds; index < rounds + burst; index += 1) {
    appendQuarantineEvents(context.root, [burstEvent('child', index)])
  }

  return { role: 'append-burst', pid: process.pid, failed: false, lines: rounds + burst }
}

describe('quarantine ledger child role selector', () => {
  it('accepts every role it knows', () => {
    expect(parseQuarantineChildRole('serialized-add')).toBe('serialized-add')
    expect(parseQuarantineChildRole('unserialized-cycle')).toBe('unserialized-cycle')
    expect(parseQuarantineChildRole('append-burst')).toBe('append-burst')
  })

  it('refuses an unknown role before any ledger is opened', () => {
    expect(() => parseQuarantineChildRole('not-a-role')).toThrow('not-a-role')
  })

  it('refuses a missing role rather than defaulting to one', () => {
    expect(() => parseQuarantineChildRole(undefined)).toThrow('undefined')
  })
})

describe.skipIf(!childMode)('quarantine ledger child', () => {
  it('writes the same committed ledger as its parent', async () => {
    // Both resolved BEFORE the try: a child that cannot even read its own inputs has nowhere
    // legitimate to publish a report to, and a catch that referenced them would fault instead.
    const role = parseQuarantineChildRole(process.env[QUARANTINE_CHILD_ENV.role])
    const context = readContext()
    try {
      const report = role === 'serialized-add'
        ? await runSerializedAdd(context)
        : role === 'unserialized-cycle'
          ? await runUnserializedCycle(context)
          : await runAppendBurst(context)
      publishMarker(context.reportPath, `${JSON.stringify(report)}\n`)
    } catch (error) {
      publishMarker(
        context.reportPath,
        `${JSON.stringify({ role, failed: true, message: String(error) })}\n`,
      )
      throw error
    }
  }, 120_000)
})
