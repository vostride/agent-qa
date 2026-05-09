import { describe, expect, it } from 'vitest'
import { syncExternalHooks, syncExternalSteps, type EditorStep, type LiveHookExecution } from '../hooks/use-live-editor'

const SETUP_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const NEXT_HOOK_ID = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'

function makeStep(
  id: string,
  instruction: string,
  overrides: Partial<EditorStep> = {},
): EditorStep {
  return {
    id,
    draftId: id,
    instruction,
    status: 'idle',
    phases: [],
    executionHistory: [],
    consoleLogs: [],
    networkLogs: [],
    variableSnapshot: null,
    originalStepName: null,
    subActionsData: null,
    executionLogs: [],
    executionGeneration: 0,
    ...overrides,
  }
}

function makeHook(
  id: string,
  name: string,
  phase: 'setup' | 'teardown',
  overrides: Partial<LiveHookExecution> = {},
): LiveHookExecution {
  return {
    id,
    name,
    phase,
    status: 'pending',
    stdout: null,
    stderr: null,
    variables: null,
    ...overrides,
  }
}

describe('syncExternalSteps', () => {
  it('preserves step identity and live state across in-place instruction edits', () => {
    const prev = [
      makeStep('step-a', 'Open login page', {
        status: 'passed',
        phases: [{ phase: 'plan', text: 'Use the login route', timestamp: '2026-04-16T00:00:00.000Z' }],
      }),
      makeStep('step-b', 'Enter credentials'),
    ]

    const next = syncExternalSteps(prev, [
      { draftId: 'step-a', instruction: 'Open the login page' },
      { draftId: 'step-b', instruction: 'Enter credentials' },
    ])

    expect(next[0].id).toBe('step-a')
    expect(next[0].draftId).toBe('step-a')
    expect(next[0].instruction).toBe('Open the login page')
    expect(next[0].status).toBe('passed')
    expect(next[0].phases[0]?.text).toBe('Use the login route')
  })

  it('reorders external steps by draft id without dropping step state', () => {
    const prev = [
      makeStep('step-a', 'Open login page', { status: 'passed' }),
      makeStep('step-b', 'Enter credentials', { status: 'failed', error: 'Missing field' }),
    ]

    const next = syncExternalSteps(prev, [
      { draftId: 'step-b', instruction: 'Enter credentials' },
      { draftId: 'step-a', instruction: 'Open login page' },
    ])

    expect(next.map((step) => step.id)).toEqual(['step-b', 'step-a'])
    expect(next[0].status).toBe('failed')
    expect(next[0].error).toBe('Missing field')
    expect(next[1].status).toBe('passed')
  })
})

describe('syncExternalHooks', () => {
  it('preserves hook identity and execution state across hook list refreshes', () => {
    const prev = [
      makeHook(SETUP_HOOK_ID, 'Seed Auth', 'setup', {
        status: 'passed',
        variables: { AUTH_TOKEN: 'hook-token' },
      }),
    ]

    const next = syncExternalHooks(prev, [SETUP_HOOK_ID], 'setup')

    expect(next[0].id).toBe(SETUP_HOOK_ID)
    expect(next[0].name).toBe('Seed Auth')
    expect(next[0].status).toBe('passed')
    expect(next[0].variables?.AUTH_TOKEN).toBe('hook-token')
  })

  it('rebuilds hook rows when the configured hook names change', () => {
    const prev = [
      makeHook(SETUP_HOOK_ID, 'Seed Auth', 'setup', { status: 'passed' }),
    ]

    const next = syncExternalHooks(prev, [NEXT_HOOK_ID], 'setup')

    expect(next).toHaveLength(1)
    expect(next[0].name).toBe(NEXT_HOOK_ID)
    expect(next[0].status).toBe('pending')
    expect(next[0].id).toBe(NEXT_HOOK_ID)
  })
})
