// Ports arrive as excess fields; the cells drive the seam and read disk to show none is asked.

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

// The confirm shape an old host bound; safety does not publish it.
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
    // Neither input declares these, so they can only arrive as excess fields.
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
        // A change over a missing record writes nothing, so only whether a port asks is measured.
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

  // `composeCliLocalAgent` forwards neither port and `invokeFunction` asks nobody: no row.
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
    // And no execution-audit row of any outcome, on either arm.
    expect(withChat).toEqual([])
    expect(doorOnly).toEqual([])
  })
})
