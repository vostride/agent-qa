import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  asRunId,
  RunsMarkOutcomeSchema,
} from '@vostride/agent-qa-schema'
import { markFixture } from '../../gates/__tests__/feedback-fixture.js'
import { createRunsCommand, renderMarkOutcome } from '../runs.js'
import * as host from '../../composition/local-agent-host.js'

describe('runs mark thin client', () => {
  let root: string | undefined
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; if (root) rmSync(root, { recursive: true, force: true }) })
  const program = () => {
    const runs = createRunsCommand().exitOverride().configureOutput({ writeErr: () => {} })
    for (const sub of runs.commands) sub.exitOverride().configureOutput({ writeErr: () => {} })
    return new Command().exitOverride().option('--config <path>').addCommand(runs)
  }

  // RE-SPELLED 2026-09-30. The tracer answered a `[y/N]` prompt on a terminal
  // stream and asserted the prompt named `fn:runs.mark`; the no-TTY cell asserted `Denied runs.mark`
  // even under configured trustMode. `runs mark` asks nobody now: the terminal stream is handed to
  // the door and never written, and the no-TTY mark applies with the one call.
  it('tracer: confirmed-bug goes through the real function door with no confirmation asked', async () => {
    const f = markFixture(); root = f.root
    // there is no terminal confirm factory any more. A port that records any
    // ask is smuggled past the input type, which no longer declares one; nothing may read it.
    let prompt = ''
    const compose = host.composeCliLocalAgent
    vi.spyOn(host, 'composeCliLocalAgent').mockImplementation(options => compose({ ...options,
      ...{ confirm: { surface: 'tty-prompt', ask: (action: { name: string }) => { prompt += action.name; return true } } } as object,
      resolveExecutionContext: () => 'local-interactive',
    }))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await program().parseAsync(['--config', f.configPath, 'runs', 'mark', f.handoff.runId, '--kind', 'confirmed-bug',
      '--json'], { from: 'user' })
    expect(errors.mock.calls).toEqual([])
    expect(prompt).toBe('')
    const result = RunsMarkOutcomeSchema.parse(JSON.parse(String(output.mock.calls.at(-1)?.[0])))
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, origin: 'user', disposition: { kind: 'confirmed-bug' } } })
    expect(readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('applies a no-TTY mark with no credential and no confirmation', async () => {
    const f = markFixture(); root = f.root
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await program().parseAsync(['--config', f.configPath, 'runs', 'mark', f.handoff.runId, '--kind', 'confirmed-bug'], { from: 'user' })
    expect(errors.mock.calls).toEqual([])
    expect(process.exitCode).not.toBe(1)
    expect(readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('refuses confirmed-pass with the three supported kinds before any op runs', async () => {
    const cmd = program().configureOutput({ writeErr: () => {} })
    await expect(cmd.parseAsync(['runs', 'mark', 'unused', '--kind', 'confirmed-pass'], { from: 'user' }))
      .rejects.toThrow(/false-fail.*false-pass.*confirmed-bug/)
  })

  // the terminal receipt names what the fix changed; a pre-432 drafted receipt
  // read back from a ledger says it was drafted and names no proposal to act on.
  it('renders an applied receipt with the records or file it changed, and a historical draft without a proposal id', () => {
    const base = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION as typeof MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_0123456789ab', runId: asRunId('run-render'), runSlug: 'run-render',
      testIndex: 0, kind: 'false-fail' as const, origin: 'user' as const, ordinal: 2, markedAt: 0,
      evidence: { confirmed: 1, overturned: 0 } }
    expect(renderMarkOutcome({ kind: 'marked', receipt: { ...base, disposition: { kind: 'applied', fix: 'fact',
      change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_a', 'mem_b'] } } } }))
      .toBe('marked false-fail on run-render test 0 · applied fact: changed mem_a, mem_b · receipt mark_0123456789ab #2')
    expect(renderMarkOutcome({ kind: 'marked', receipt: { ...base, stepIndex: 3, disposition: { kind: 'applied', fix: 'test-edit',
      change: { kind: 'test-file', filePath: 'tests/checkout.yaml', contentDigest: 'abc' } } } }))
      .toBe('marked false-fail on run-render test 0 step 3 · applied test-edit: wrote tests/checkout.yaml · receipt mark_0123456789ab #2')
    const historical = renderMarkOutcome({ kind: 'marked', receipt: { ...base, disposition: { kind: 'drafted', fix: 'fact',
      proposalId: 'prop_0123456789ab', proposalKind: 'knowledge' } } })
    expect(historical).toContain('drafted: fact (recorded before fixes applied directly)')
    expect(historical).not.toContain('prop_')
  })
})
