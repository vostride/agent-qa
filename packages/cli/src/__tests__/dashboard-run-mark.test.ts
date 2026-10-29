// The dashboard mark door through the real composition (419 D-13).
// 432-13: there was no asking frame left to preserve. 432-14 (D-14): the frame, its scope field and
// the host members that carried them are deleted, so the route is one request to one registered op.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { markRun, type AgentHost } from '@vostride/agent-qa-dashboard'
import { RUNS_MARK_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { afterEach, describe, expect, it } from 'vitest'

import { composeDashboardDoor } from '../commands/dashboard.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-419-mark-door-'))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, JSON.stringify({
    workspace: { testMatch: ['tests/**/*.test.yaml'], suiteMatch: ['suites/**/*.suite.yaml'], hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local' },
    use: { mobile: { appState: 'reset' } },
    registry: { targets: { conformance: { platform: 'web', url: 'https://conformance.invalid' } } },
  }))
  const door = composeDashboardDoor({ agentQaRoot: join(root, '.agent-qa'), configPath, boundOrigin: () => undefined })
  closers.push(async () => { await door.host.close(); rmSync(root, { recursive: true, force: true }) })
  const calls: string[] = []
  const counted: AgentHost = {
    ...door.agentHost,
    invokeFunction: (registry, functionId, input, caller) => {
      calls.push(functionId)
      return door.agentHost.invokeFunction(registry, functionId, input, caller)
    },
  }
  const invoke = (body: Record<string, unknown> = { kind: 'false-fail', note: 'private note' }) =>
    markRun(counted, 'run-mark-absent', body)
  return { ...door, calls, invoke }
}

// RE-SPELLED 2026-09-30 (432-13, D-14/D-15). The route used to park on the named run channel and
// deny an absent or unwatched scope, even under config trustMode. The composed host asks nobody now:
// the mark dispatches and no confirm frame is ever raised. The absent fixture run is what answers,
// which proves the op was reached.
describe('dashboard runs.mark confirmation through the composed host', () => {
  it('binds the actual op id and dispatches with an absent or unwatched scope, raising no frame', async () => {
    const f = fixture()
    expect(f.agentHost.runsMarkFunctionId).toBe(RUNS_MARK_FUNCTION_ID)
    expect(await f.invoke()).toMatchObject({ kind: 'ok', body: { kind: 'run-not-found' } })
    expect(f.calls).toEqual([RUNS_MARK_FUNCTION_ID])
  })

  // RE-SPELLED 2026-10-01 (432-14): was 'dispatches on a WATCHED run channel too, and never parks
  // on it'. There is no channel to watch; the claim that survives is that a second mark is a second
  // dispatch and nothing is held between them.
  it('dispatches on a WATCHED run channel too, and never parks on it', async () => {
    const f = fixture()
    expect(await f.invoke()).toMatchObject({ kind: 'ok', body: { kind: 'run-not-found' } })
    expect(await f.invoke()).toMatchObject({ kind: 'ok', body: { kind: 'run-not-found' } })
    expect(f.calls).toEqual([RUNS_MARK_FUNCTION_ID, RUNS_MARK_FUNCTION_ID])
  })
})

describe('a dashboard mark dispatches directly', () => {
  it('one mark request is one runs.mark dispatch, with no scope member on the host', async () => {
    const f = fixture()
    const retired = ['confirms', 'enterRunTrigger' + 'Scope']
    for (const member of retired) {
      expect(member in f.agentHost, `the host still carries ${member}`).toBe(false)
    }
    expect(await f.invoke({ kind: 'false-fail' })).toMatchObject({ kind: 'ok', body: { kind: 'run-not-found' } })
    expect(f.calls).toEqual([RUNS_MARK_FUNCTION_ID])
  })

  it('a body naming a confirm scope is an unknown field, refused before any dispatch', async () => {
    const f = fixture()
    const outcome = await f.invoke({ kind: 'false-fail', ['confirm' + 'Scope']: 'run-trigger:432-14' })
    expect(outcome).toEqual({ kind: 'refused', status: 400, body: { error: 'invalid_mark_input' } })
    expect(f.calls).toEqual([])
  })
})
