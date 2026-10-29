// THE DISPATCH-SCOPED GRANT OVERLAY (Phase 401 plan 08 — D-08, RESEARCH Pitfall 6), RE-SPELLED AS
// ITS ABSENCE (432-18, D-15).
//
// The overlay was an in-memory union placed in front of the committed grant ledger's reader: an
// open authoring dispatch contributed one `run:start` grant to the run gate, scoped to the dispatch's
// own async call tree (401-13, CR-03). These cells measured its arithmetic — nothing at rest, the
// grant inside the scope, nothing for an unrelated caller, read at answer time, overlapping scopes,
// a continuation that outlived the scope, a thrown dispatch, the union with the ledger, one action
// class, a scope API that names nothing — and the one seam that carried its reader to the run gate.
//
// 432-13 deleted the run gate and 432-18 deletes the ledger, its reader and the overlay
// (`composition/dispatch-grants.ts`). Every arithmetic claim lost its subject. What is measured now:
//
//   - the module is gone and the agent-local barrel publishes no overlay,
//   - the composition binds no overlay and no dispatch scope onto the authoring shelf,
//   - `createLocalRunInvocation` hands its host the request and nothing else — no reader, no `gate`
//     argument — whether or not anything is "open" (the carriage cells, re-spelled),
//   - nothing durable is minted: no `grants.jsonl` appears.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RunsStartInput } from '@vostride/agent-qa-schema'

import * as agentLocal from '../../index.js'
import { createLocalRunInvocation } from '../compose-local-agent.js'
import type { RunExecutionPort } from '../compose-local-agent.js'

const COMPOSITION = new URL('../compose-local-agent.ts', import.meta.url)

/** First-party source lines with comments stripped, so a dated note cannot satisfy a code claim. */
function codeLines(url: URL): readonly string[] {
  return readFileSync(url, 'utf8').split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
}

/** A host that records every argument list it is handed and reports a run id it never ran. */
function recordingExecution(): { port: RunExecutionPort; calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    port: {
      execute(...args: [RunsStartInput]) {
        calls.push(args)
        return Promise.resolve({ runId: 'r_never-ran' as never })
      },
    },
  }
}

/**
 * Start a run through the binding and swallow the evidence check (`RunProducedNoEventsError`): the
 * host is handed its arguments BEFORE that check, which is the only thing these cells are about.
 */
async function startIgnoringEvidence(start: () => Promise<unknown>): Promise<void> {
  try {
    await start()
  } catch {
    // the evidence check, deliberately unmeasured here
  }
}

describe('there is no dispatch-scoped grant overlay', () => {
  it('the overlay module is deleted and the barrel publishes none', () => {
    expect(existsSync(new URL('../dispatch-grants.ts', import.meta.url))).toBe(false)
    const exported = Object.keys(agentLocal)
    expect(exported.length, 'the barrel is empty, so the census would be vacuous').toBeGreaterThan(0)
    expect(exported.filter((name) => /dispatchgrant/i.test(name))).toEqual([])
  })

  // RE-SPELLED 2026-10-01 (432-18) from 'ONE OVERLAY PER COMPOSITION — the shelf and the run gate
  // cannot be handed different objects': the composition now hands both of them nothing.
  it('NO OVERLAY PER COMPOSITION — the shelf binds no dispatch scope and the run door no reader', () => {
    const code = codeLines(COMPOSITION).join('\n')
    expect(code).not.toContain('createDispatchGrants(')
    expect(code).not.toContain('readerOver(')
    expect(code).not.toContain('dispatchGrants')
    expect(code).not.toContain('resolveRunGrants')
    expect(code).not.toContain('createStandingApprovalReader')
    expect(code).not.toContain('createGrantOperations')
  })
})

describe('the composition carries nothing to the run host but the request', () => {
  // RE-SPELLED 2026-10-01 (432-18) from "THE READER HANDED OVER IS THE OVERLAY'S, resolved per run":
  // there is no reader to resolve, so each run hands the host exactly one argument, the request.
  it('THE HOST IS HANDED THE REQUEST AND NOTHING ELSE, run after run', async () => {
    const execution = recordingExecution()
    const invocation = createLocalRunInvocation({
      agentQaRoot: '/nowhere/.agent-qa',
      execution: execution.port,
    })

    await startIgnoringEvidence(() => invocation.start({ patterns: ['tests/a.yaml'] }))
    await startIgnoringEvidence(() => invocation.start({ patterns: ['tests/b.yaml'] }))

    expect(execution.calls).toEqual([
      [{ patterns: ['tests/a.yaml'] }],
      [{ patterns: ['tests/b.yaml'] }],
    ])
  })

  // RE-SPELLED 2026-10-01 (432-18) from 'NO RESOLVER, NO FIELD — a composition that supplies none
  // hands the host nothing': the binding no longer accepts a resolver at all.
  it('NO RESOLVER, NO FIELD — the binding takes no grant resolver, and a run mints nothing durable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-grants-absent-'))
    try {
      const execution = recordingExecution()
      const input = {
        agentQaRoot: join(root, '.agent-qa'),
        execution: execution.port,
        // A smuggled pre-432 field is ignored rather than carried.
        ...({ resolveRunGrants: () => { throw new Error('a grant resolver was consulted') } } as object),
      } as Parameters<typeof createLocalRunInvocation>[0]
      await startIgnoringEvidence(() => createLocalRunInvocation(input).start({ patterns: ['tests/a.yaml'] }))
      expect(execution.calls).toEqual([[{ patterns: ['tests/a.yaml'] }]])
      expect(existsSync(join(root, 'agent-qa-knowledge', 'grants.jsonl'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
