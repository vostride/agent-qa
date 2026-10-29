// The answering surface survives the two places it can be lost.
//
// SINCE 432-13 neither place exists on a shipped road: run composition no longer reads
// the presentation confirm, and no door hands the op gate a port because there is no op gate. Both
// describes were re-spelled to measure that absence the same way — by driving the seam and reading
// what landed on disk — with a port that records being asked. SINCE 432-14 the run hooks
// cannot even be handed a port: the presentation confirm contract and its CLI producer are deleted.
// SINCE 432-16 the composition cannot be handed one either: `confirm` and `chatConfirm`
// are gone from both composition inputs, so the second describe smuggles its ports past the type as
// excess fields and pins that nothing reads them. SINCE 432-19 the confirm port,
// its answering-surface vocabulary, the gate and the execution-audit row are all deleted, so the
// ports here are a local shape and "no prompted row" is read as "no execution-audit row at all".
// The history below is kept as written.
//
// The gate now records the surface the composition DECLARED rather than the mechanism rung (e) used
// to hardcode. Declaring it is a compile obligation — `packages/safety/src/ports/__tests__/
// confirm-surface.test-d.ts` pins that half — but two things can still carry an honest declaration
// and land a dishonest row, and neither is a type error, because both still satisfy `ConfirmPort`:
//
//   (1) A DECORATOR that names a surface of its own instead of forwarding the one it wraps. There
//       are three over this port today (`timedConfirm`, `decorateConfirmForHuman`'s unmasking
//       implementation, and the dashboard's run-gate forwarder) and each is an independent chance
//       to drop the value.
//   (2) THE TWO-PORT SEAM in `compose-local-agent.ts` — `chatConfirmPort ?? input.confirm` — where
//       two ports meet and one wins at call time. A surface resolved anywhere but ON the winning
//       port is a second fact free to disagree with it.
//
// Both are measured here by DRIVING them and reading the row a person audits off disk, never by
// inspecting the port object: an assertion on `port.surface` would pass on a decorator that
// forwards the field and then delegates to something else entirely.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
} from '../composition/local-agent-host.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** The confirm shape an old host bound (safety no longer publishes it, 432-19). */
interface ConfirmPort {
  readonly surface: 'tty-prompt' | 'browser-click'
  readonly ask: (action: { readonly name: string }) => boolean
}

/** The legacy execution-audit row, by the two fields these cells read. Nothing writes one. */
interface LegacyExecutionAuditRow {
  readonly outcome?: unknown
  readonly trustSource?: unknown
}

function auditRowsAt(dir: string): LegacyExecutionAuditRow[] {
  return readFileSync(join(dir, 'execution_audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LegacyExecutionAuditRow)
}

/** A confirm binding that records being asked, declaring the surface it stands in for. */
function recording(surface: 'tty-prompt' | 'browser-click', calls: string[]): ConfirmPort {
  return { surface, ask: (action) => { calls.push(`${surface}:${action.name}`); return true } }
}

function auditRowsIfAny(dir: string): LegacyExecutionAuditRow[] {
  try {
    return auditRowsAt(dir)
  } catch {
    return []
  }
}

// the describe 'a decorator forwards the surface of the port it
// wraps' is deleted with the per-run hook registrar it drove.

describe('the two-port seam names the port that actually answered', () => {
  // `compose-local-agent.ts` resolves `chatConfirmPort ?? input.confirm` once, at composition time,
  // and hands the winner to the op-level gate. Both arms are driven here over the SAME workspace and
  // the SAME ask-tier op, with the two ports declaring DIFFERENT surfaces — so the row is the only
  // thing that can tell them apart, and a surface resolved beside the `??` rather than on the port
  // would answer the same way in both.
  function workspace(): { configPath: string; agentQaRoot: string } {
    const root = tempDir('confirm-seam-')
    const configPath = join(root, 'agent-qa.config.yaml')
    const agentQaRoot = join(root, '.agent-qa')
    writeFileSync(configPath, 'workspace:\n  testMatch:\n    - tests/**/*.yaml\n')
    mkdirSync(agentQaRoot, { recursive: true })
    return { configPath, agentQaRoot }
  }

  async function revokeThrough(input: {
    readonly chat?: ConfirmPort
    readonly door: ConfirmPort
  }): Promise<LegacyExecutionAuditRow[]> {
    const ws = workspace()
    const chat = input.chat
    // neither input declares these any more, so they can only arrive as excess fields.
    const smuggled = {
      confirm: input.door,
      ...(chat === undefined ? {} : { chatConfirm: () => chat }),
    }
    const host = composeCliLocalAgent({
      agentQaRoot: ws.agentQaRoot,
      configPath: ws.configPath,
      ...smuggled,
    })
    try {
      await runSafetyScope({ executionContext: 'local-interactive' }, async () => {
        // the subject was `grants.revoke` over a grant that did not exist; the
        // op is deleted with the ledger, so the subject is a direct change over a record that does
        // not exist. It answers target-not-found and writes nothing, and it was an ask-free class
        // before 432 as well, so the cell still measures only whether a port is consulted.
        await invokeFunction(
          host.registry,
          'knowledge.forget',
          { target: { grain: 'record', recordId: 'rec-not-in-this-workspace' } },
          CLI_FUNCTION_CALLER,
        ).catch(() => undefined)
      })
    } finally {
      await host.close()
    }
    return auditRowsIfAny(ws.agentQaRoot)
  }

  // RE-SPELLED 2026-09-30: the `??` seam is gone. `composeCliLocalAgent` forwards neither
  // port and `invokeFunction` asks nobody, so neither arm is consulted and the op writes no row.
  // the ports are smuggled as excess fields; the claim is unchanged.
  it('asks NEITHER port, whichever is bound, and writes no prompted row', async () => {
    const calls: string[] = []
    const withChat = await revokeThrough({
      chat: recording('browser-click', calls),
      door: recording('tty-prompt', calls),
    })
    const doorOnly = await revokeThrough({ door: recording('tty-prompt', calls) })

    expect(calls).toEqual([])
    expect(withChat.filter((row) => row.outcome === 'prompted-approved')).toEqual([])
    expect(doorOnly.filter((row) => row.outcome === 'prompted-approved')).toEqual([])
    // and no execution-audit row of any outcome, on either arm.
    expect(withChat).toEqual([])
    expect(doorOnly).toEqual([])
  })
})
