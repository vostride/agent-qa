// The tail's settlement is a deferred the cell controls, so `execute()` resolving first shows.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { CliRunOutcome } from '../composition/in-process-run-execution.js'
import { runInProcessCliRun } from '../composition/in-process-run-execution.js'
import {
  CountingTarget,
  createInProcessFixture,
  eventTypes,
  removeInProcessFixtures,
} from '../composition/__tests__/in-process-run-fixture.js'
import { closeTestRunRecords, testRunRecord } from '../composition/__tests__/in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

// Every drive call carries a record; each cell closes the ones it opened.
afterEach(() => { closeTestRunRecords() })

/** A promise the cell settles by hand — the deferred the whole ordering claim rests on. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fixtureOptions(fixture: { configPath: string; agentQaRoot: string; project: string }): {
  configPath: string
  agentQaRoot: string
} {
  // An empty browsers root, so a member's failure is the fixture's, not the machine's.
  const browsersRoot = join(fixture.project, 'no-browsers')
  if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  return { configPath: fixture.configPath, agentQaRoot: fixture.agentQaRoot }
}

const targets: CountingTarget[] = []

afterEach(async () => {
  for (const target of targets.splice(0)) await target.close()
})
afterAll(() => { removeInProcessFixtures() })

async function project(): Promise<ReturnType<typeof createInProcessFixture>> {
  const target = new CountingTarget()
  await target.listen()
  targets.push(target)
  return createInProcessFixture({ origin: target.origin, environment: 'local' })
}

describe('the detached post-run leg', () => {
  it('resolves execute() BEFORE the tail settles',
    async () => {
      const fixture = await project()
      const gate = deferred()
      let tailEntered = false

      const outcome: CliRunOutcome = await runInProcessCliRun(
        {
          runRecord: testRunRecord(),
          ...fixtureOptions(fixture),
          executionContext: 'local-headless',
          postRunTail: async () => {
            tailEntered = true
            await gate.promise
          },
        },
        { patterns: [fixture.suitePattern] },
      )

      // (1) The run really happened, so nothing below is a claim about an absence.
      expect(eventTypes(fixture as never), 'the run must have started for any of this to mean anything')
        .toContain('runStarted')
      expect(outcome.exitCode, 'a non-zero exit code is a real run, not an error').toBeTypeOf('number')

      // (2) `execute()` returned while the tail is parked; an awaited drain would block it.
      expect(tailEntered, 'the tail was started, not merely declared').toBe(true)
      expect(outcome.settled, 'the in-flight leg is exposed so a caller MAY wait').toBeDefined()

      gate.resolve()
      await outcome.settled
    }, 120_000)

  it('runs afterVerdict to completion BEFORE the tail starts — never concurrently', async () => {
    const fixture = await project()
    const order: string[] = []
    const gate = deferred()

    const outcome = await runInProcessCliRun(
      {
        runRecord: testRunRecord(),
        ...fixtureOptions(fixture),
        executionContext: 'local-headless',
        afterVerdict: async (context) => {
          order.push('afterVerdict:start')
          await new Promise((resolve) => setTimeout(resolve, 10))
          order.push('afterVerdict:end')
          return context.exitCode
        },
        postRunTail: async () => {
          order.push('tail:start')
          await gate.promise
          order.push('tail:end')
        },
      },
      { patterns: [fixture.suitePattern] },
    )

    // The `--all` fold and the drain can never race: a door supplying both gets them in sequence.
    expect(order).toEqual(['afterVerdict:start', 'afterVerdict:end', 'tail:start'])
    gate.resolve()
    await outcome.settled
    expect(order).toEqual(['afterVerdict:start', 'afterVerdict:end', 'tail:start', 'tail:end'])
  }, 120_000)

  it('catches a THROWING tail and warns by name', async () => {
    const fixture = await project()
    const warnings: string[] = []

    const outcome = await runInProcessCliRun(
      {
        runRecord: testRunRecord(),
        ...fixtureOptions(fixture),
        executionContext: 'local-headless',
        warn: (message) => { warnings.push(message) },
        postRunTail: async () => {
          throw new Error('the queue database is unreadable')
        },
      },
      { patterns: [fixture.suitePattern] },
    )

    // Post-processing never costs the verdict, so a rejected detached leg must not be unhandled.
    await expect(outcome.settled, 'the exposed promise never rejects').resolves.toBeUndefined()
    const named = warnings.filter((message) => message.includes('the post-run tail did not complete'))
    expect(named, 'the failure is NAMED, not silently absorbed').toHaveLength(1)
    expect(named[0]).toContain('the queue database is unreadable')
    expect(named[0]).toContain(outcome.runId)
  }, 120_000)

  it('a door with NO postRunTail closes out in the drive\'s own finally, exactly as before',
    async () => {
      const fixture = await project()
      const warnings: string[] = []

      const outcome = await runInProcessCliRun(
        {
          runRecord: testRunRecord(),
          ...fixtureOptions(fixture),
          executionContext: 'local-headless',
          warn: (message) => { warnings.push(message) },
          afterVerdict: (context) => context.exitCode,
        },
        { patterns: [fixture.suitePattern] },
      )

      expect(outcome.settled, 'no leg was started, so there is nothing to expose').toBeUndefined()
      // An ordinary run takes no lease, so the no-leak backstop prints no `released untaken` line.
      expect(warnings.filter((message) => message.includes('released untaken'))).toEqual([])
    }, 120_000)

  it('the tail sees the post-verdict handoff, and taking the lease is what acquires it', async () => {
    const fixture = await project()
    let taken: unknown
    let secondTake: unknown

    const outcome = await runInProcessCliRun(
      {
        runRecord: testRunRecord(),
        ...fixtureOptions(fixture),
        executionContext: 'local-headless',
        postRunTail: async (context) => {
          // `undefined` means another holder or detached; pumping anyway would consult twice.
          taken = context.postVerdict.takeAcquiredLease()
          secondTake = context.postVerdict.takeAcquiredLease()
        },
      },
      { patterns: [fixture.suitePattern] },
    )
    await outcome.settled

    // Nobody else is running against this fixture's brand-new knowledge root, so the step read the
    // lease as free and the pump's request is what minted it.
    expect(taken, 'a free lease at the verdict means THIS process pumps, under an authority it took')
      .toEqual(expect.objectContaining({ leaseId: expect.any(String), epoch: expect.any(Number) }))
    expect(secondTake, 'take-ONCE: two callers each believing they hold the lease is the defect')
      .toBeUndefined()
  }, 120_000)
})
