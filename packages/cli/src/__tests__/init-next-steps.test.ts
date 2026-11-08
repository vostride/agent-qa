import { describe, expect, it } from 'vitest'

import {
  CODEX_TRUST_HINT,
  CODING_AGENT_HINT,
  initNextSteps,
  nextStepLines,
  type InitNextStepFacts,
  type InitNextStepModel,
} from '../commands/init-next-steps.js'
import type { InitStepRecord } from '../commands/init-steps.js'

const CLAUDE_PENDING: InitNextStepModel = {
  name: 'claude-code',
  provider: 'anthropic-subscription',
  status: 'pending',
  subscription: true,
  pluginInstalled: true,
}
const CLAUDE_READY: InitNextStepModel = { ...CLAUDE_PENDING, status: 'ready' }
const GEMINI_READY: InitNextStepModel = {
  name: 'gemini',
  provider: 'gemini',
  status: 'ready',
  subscription: false,
  pluginInstalled: false,
}

const DONE: InitStepRecord[] = [
  { name: 'package-json', outcome: 'done' },
  { name: 'scaffold', outcome: 'done' },
  { name: 'install', outcome: 'done' },
  { name: 'chromium', outcome: 'done' },
  { name: 'skills', outcome: 'done' },
  { name: 'validate', outcome: 'done' },
  { name: 'sign-in', outcome: 'done' },
]

function withRecord(records: readonly InitStepRecord[], record: InitStepRecord): InitStepRecord[] {
  return records.map((entry) => (entry.name === record.name ? record : entry))
}

function facts(overrides: Partial<InitNextStepFacts> = {}): InitNextStepFacts {
  return {
    steps: DONE,
    model: CLAUDE_READY,
    web: true,
    mobile: false,
    agents: [],
    dashboard: 'starting',
    ...overrides,
  }
}

function commands(input: InitNextStepFacts): string[] {
  return initNextSteps(input).steps.map((step) => step.command)
}

describe('the next steps are derived from what happened', () => {
  it('a failed pnpm install, a pending Claude subscription and no dashboard list the install, the sign-in, the run and the dashboard', () => {
    const steps = withRecord(DONE, {
      name: 'install',
      outcome: 'failed',
      reason: 'pnpm exited 1',
      command: 'pnpm install',
    })

    expect(
      commands(
        facts({
          steps,
          model: { ...CLAUDE_PENDING, pluginInstalled: false },
          dashboard: { command: 'npx agent-qa dashboard' },
        }),
      ),
    ).toEqual([
      'pnpm install',
      'npx agent-qa auth login --config claude-code',
      'npx agent-qa run suites/examples.suite.yaml',
      'npx agent-qa dashboard',
    ])
  })

  it('a run that went through with a ready model and the dashboard starting lists only the run, introduced', () => {
    const { steps } = initNextSteps(facts())

    expect(steps).toEqual([
      {
        command: 'npx agent-qa run suites/examples.suite.yaml',
        description: 'Run the examples in the dashboard, or:',
      },
    ])
    expect(nextStepLines(steps)).toEqual([
      'Run the examples in the dashboard, or:',
      'npx agent-qa run suites/examples.suite.yaml',
    ])
  })

  it('--no-browsers adds the Chromium command', () => {
    const steps = withRecord(DONE, {
      name: 'chromium',
      outcome: 'skipped',
      reason: '--no-browsers',
      command: 'npx agent-qa install-browsers --chromium',
    })

    expect(commands(facts({ steps }))).toEqual([
      'npx agent-qa install-browsers --chromium',
      'npx agent-qa run suites/examples.suite.yaml',
    ])
  })

  it('a subscription plugin missing after a finished install adds the plugins add line', () => {
    expect(
      commands(facts({ model: { ...CLAUDE_PENDING, pluginInstalled: false } })).slice(0, 2),
    ).toEqual([
      'npx agent-qa plugins add @vostride/agent-qa-subscription-auth',
      'npx agent-qa auth login --config claude-code',
    ])
  })

  it('a Mobile project adds the mobile drivers command', () => {
    expect(commands(facts({ mobile: true, web: false }))).toEqual([
      'npx agent-qa install-mobile-drivers --all',
    ])
  })

  it('--pm none puts the plain install first among the lines that did not fail, before validate', () => {
    let steps = withRecord(DONE, {
      name: 'install',
      outcome: 'skipped',
      reason: '--pm none',
      command: 'npm install',
    })
    steps = withRecord(steps, {
      name: 'validate',
      outcome: 'skipped',
      reason: 'install first (--pm none)',
      command: 'npx agent-qa validate',
    })
    steps = withRecord(steps, {
      name: 'chromium',
      outcome: 'failed',
      reason: 'Chromium download failed twice',
      command: 'npx agent-qa install-browsers --chromium',
    })

    expect(
      commands(facts({ steps, model: { ...CLAUDE_PENDING, pluginInstalled: false } })),
    ).toEqual([
      'npx agent-qa install-browsers --chromium',
      'npm install',
      'npx agent-qa validate',
      'npx agent-qa auth login --config claude-code',
      'npx agent-qa run suites/examples.suite.yaml',
    ])
  })

  it('a deferred sign-in and the pending model give one auth login line', () => {
    const steps = withRecord(DONE, {
      name: 'sign-in',
      outcome: 'skipped',
      reason: 'later',
      command: 'npx agent-qa auth login --config claude-code',
    })

    expect(commands(facts({ steps, model: CLAUDE_PENDING }))).toEqual([
      'npx agent-qa auth login --config claude-code',
      'npx agent-qa run suites/examples.suite.yaml',
    ])
  })

  it('every command is an npx agent-qa command or a plain install, and none names the config file or an unpinned install', () => {
    const installs: InitStepRecord[] = [
      { name: 'install', outcome: 'done' },
      { name: 'install', outcome: 'failed', reason: 'x', command: 'pnpm install' },
      { name: 'install', outcome: 'skipped', reason: '--pm none', command: 'yarn install' },
      { name: 'install', outcome: 'skipped', reason: 'already installed' },
    ]
    const chromiums: InitStepRecord[] = [
      { name: 'chromium', outcome: 'done' },
      {
        name: 'chromium',
        outcome: 'skipped',
        reason: '--no-browsers',
        command: 'npx agent-qa install-browsers --chromium',
      },
    ]
    const models = [
      undefined,
      GEMINI_READY,
      CLAUDE_READY,
      CLAUDE_PENDING,
      { ...CLAUDE_PENDING, pluginInstalled: false },
    ]
    const dashboards: InitNextStepFacts['dashboard'][] = [
      'starting',
      { command: 'npx agent-qa dashboard' },
    ]
    const plainInstalls = new Set(['pnpm install', 'yarn install'])
    let checked = 0
    for (const install of installs) {
      for (const chromium of chromiums) {
        for (const model of models) {
          for (const dashboard of dashboards) {
            for (const [web, mobile] of [
              [true, false],
              [false, true],
              [true, true],
            ] as const) {
              const steps = withRecord(withRecord(DONE, install), chromium)
              const input = facts({ steps, dashboard, web, mobile })
              const all = commands(model === undefined ? { ...input, model: undefined } : {
                ...input,
                model,
              })
              for (const command of all) {
                checked += 1
                expect(
                  command.startsWith('npx agent-qa ') || plainInstalls.has(command),
                  command,
                ).toBe(true)
                expect(command).not.toContain('--config agent-qa.config.yaml')
                expect(command).not.toMatch(/@latest|add -D|install agent-qa/u)
              }
              expect(new Set(all).size).toBe(all.length)
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('the lines under the box', () => {
  it('a scaffold that was not written lists only what failed and init again, with no hint', () => {
    const steps = withRecord(
      withRecord(DONE, { name: 'package-json', outcome: 'failed', reason: 'EACCES' }),
      { name: 'scaffold', outcome: 'skipped', reason: 'package.json was not written' },
    )
    const next = initNextSteps(
      facts({ steps, model: CLAUDE_PENDING, mobile: true, agents: ['codex'] }),
    )

    expect(next.steps).toEqual([
      {
        command: 'npx agent-qa init',
        description: 'Set up the folder once the step above is fixed',
      },
    ])
    expect(next.hints).toEqual([])
  })

  it('Codex chosen gives the coding agent hint and the Codex trust line', () => {
    expect(initNextSteps(facts({ agents: ['codex'] })).hints).toEqual([
      CODING_AGENT_HINT,
      CODEX_TRUST_HINT,
    ])
  })

  it('Claude Code alone gives only the coding agent hint', () => {
    expect(initNextSteps(facts({ agents: ['claude-code'] })).hints).toEqual([CODING_AGENT_HINT])
  })

  it('no coding agent gives no hint', () => {
    expect(initNextSteps(facts({ agents: [] })).hints).toEqual([])
  })
})
