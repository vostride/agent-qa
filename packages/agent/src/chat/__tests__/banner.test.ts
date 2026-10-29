const RETIRED_PROPOSALS_LIST = 'proposals.list'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RUNS_DIGEST_FUNCTION_ID,
  RUNS_LIST_FUNCTION_ID,
} from '../../index.js'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { composeBanner } from '../banner.js'
import type { ChatInvokeBinding } from '../ports.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CALLER: FunctionCaller = {
  surface: 'chat',
  origin: 'human',
}

const RUN_SUMMARY = {
  runId: 'RUN-1',
  scope: 'default',
  buildOrdinal: 7,
  executionContext: 'local-interactive',
  aggregateVerdict: 'failed',
  startedAt: 1,
  endedAt: 2,
  testCount: 3,
}

interface Recorded {
  readonly calls: string[]
  readonly line: string | undefined
}

/** Drive the banner over a scripted registry, recording exactly which ops it reached. */
async function run(
  answers: Partial<Record<string, () => unknown>>,
): Promise<Recorded> {
  const calls: string[] = []
  const invoke: ChatInvokeBinding = async (functionId) => {
    calls.push(functionId)
    const answer = answers[functionId]
    if (answer === undefined) throw new Error(`FunctionNotBoundError: ${functionId}`)
    // The legacy verdict an unclassified op produces; the banner reads only the payload.
    return { payload: answer(), verdict: { status: 'executed', outcome: '' }, foldLines: [] }
  }
  const line = await composeBanner(invoke, CALLER)
  return { calls, line }
}

describe('the chat banner reads once and says at most one thing', () => {
  it('names no pending proposals and never reads the retired inbox op', async () => {
    const { line, calls } = await run({
      [RETIRED_PROPOSALS_LIST]: () => ({ entries: [{}, {}, {}] }),
      [RUNS_LIST_FUNCTION_ID]: () => [],
    })

    expect(calls).not.toContain(RETIRED_PROPOSALS_LIST)
    expect(line).toBeUndefined()
  })

  it('says nothing at all when the project is idle', async () => {
    const { line } = await run({
      [RUNS_LIST_FUNCTION_ID]: () => [],
    })

    // A line printed on every open would train a person to skip the banner.
    expect(line).toBeUndefined()
  })

  it('is ONE line when the digest has something to say', async () => {
    const { line } = await run({
      [RUNS_LIST_FUNCTION_ID]: () => [RUN_SUMMARY],
      [RUNS_DIGEST_FUNCTION_ID]: () => ({ lines: ['RUN-1: 2 failed, 1 passed'], runId: 'RUN-1' }),
    })

    expect(line).toBeDefined()
    expect(line).not.toContain('\n')
    expect(line).not.toMatch(/proposal/u)
    // The digest's OWN rendered line, carried across rather than re-derived. One renderer law:
    // the banner and `agent-qa digest` must not be two spellings of the same sentence.
    expect(line).toContain('RUN-1: 2 failed, 1 passed')
  })

  it('reads each composed op AT MOST ONCE per chat open', async () => {
    const { calls } = await run({
      [RUNS_LIST_FUNCTION_ID]: () => [RUN_SUMMARY],
      [RUNS_DIGEST_FUNCTION_ID]: () => ({ lines: ['RUN-1: green'], runId: 'RUN-1' }),
    })

    // One read per id: a duplicate read is the first step towards a poll.
    for (const id of new Set(calls)) {
      expect(calls.filter((call) => call === id), id).toHaveLength(1)
    }
    expect(calls).toEqual([
      RUNS_LIST_FUNCTION_ID,
      RUNS_DIGEST_FUNCTION_ID,
    ])
  })

  it('degrades to no banner when a read is refused, rather than failing chat open', async () => {
    const { line } = await run({ [RUNS_LIST_FUNCTION_ID]: () => [] })

    expect(line).toBeUndefined()
  })

  it('says nothing when only the digest half is refused', async () => {
    const { line } = await run({
      [RUNS_LIST_FUNCTION_ID]: () => [RUN_SUMMARY],
    })

    expect(line).toBeUndefined()
  })

  it('holds no timer of any kind — a source pin, because a poll passes every case above', () => {
    // The behavioural assertions cannot see this. A banner that scheduled a re-read for 30s later
    // would return the right line NOW and keep the project's stores warm forever after, and every
    // spy count in this file would still be 1. So the absence of a scheduler is pinned as text.
    const source = readFileSync(join(__dirname, '..', 'banner.ts'), 'utf8')
    for (const scheduler of ['setInterval', 'setTimeout', 'setImmediate', 'watch(']) {
      expect({ scheduler, present: source.includes(scheduler) })
        .toEqual({ scheduler, present: false })
    }
  })

  it('skips the digest entirely when there is no run to digest', async () => {
    const { calls } = await run({
      [RUNS_LIST_FUNCTION_ID]: () => [],
    })

    // `runs.digest` is per-RUN, so a project with no runs has nothing to ask it about. Calling it
    // with an invented id would be a read whose refusal this file would then have to explain away.
    expect(calls).not.toContain(RUNS_DIGEST_FUNCTION_ID)
  })
})
