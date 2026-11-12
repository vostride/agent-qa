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

const RUN_STARTER = 'npx agent-qa run tests/examples/komazon-cart-total.yaml'
const RUN_SUITE = 'npx agent-qa run suites/examples.suite.yaml'
const RUN_BUG_STARTER = 'npx agent-qa run tests/examples/komazon-cart-total-bug.yaml'
const BUG_STARTER_DESCRIPTION =
  "Run the test that fails on the playground's deliberate bug (exit 1):"

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
  it('a failed pnpm install, a pending Claude subscription and no dashboard list the install, the auth login line, the run and the dashboard', () => {
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

  it('a pending subscription gives one auth login line, described as its sign-in', () => {
    const { steps } = initNextSteps(facts({ model: CLAUDE_PENDING }))

    expect(steps).toEqual([
      {
        command: 'npx agent-qa auth login --config claude-code',
        description: 'Sign in with your subscription',
      },
      {
        command: 'npx agent-qa run suites/examples.suite.yaml',
        description: 'Run the examples in the dashboard, or:',
      },
    ])
  })

  it('a ready subscription gives no auth login line', () => {
    expect(commands(facts({ model: CLAUDE_READY }))).not.toContain(
      'npx agent-qa auth login --config claude-code',
    )
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

describe("a re-run's next steps", () => {
  const RERUN_DONE: InitStepRecord[] = [
    { name: 'deps', outcome: 'skipped', reason: 'current' },
    { name: 'browsers', outcome: 'skipped', reason: 'current' },
    { name: 'gitignore', outcome: 'skipped', reason: 'current' },
    { name: 'scaffold', outcome: 'skipped', reason: 'current' },
    { name: 'validate', outcome: 'done' },
  ]
  const rerunFacts = (overrides: Partial<InitNextStepFacts> = {}): InitNextStepFacts =>
    facts({
      steps: RERUN_DONE,
      model: GEMINI_READY,
      dashboard: { command: 'npx agent-qa dashboard' },
      examples: { starter: true, suite: true, bug: true },
      ...overrides,
    })

  it('a scaffold row that is current never asks for init again', () => {
    expect(commands(rerunFacts())).toEqual([
      RUN_STARTER,
      RUN_SUITE,
      RUN_BUG_STARTER,
      'npx agent-qa dashboard',
    ])
  })

  it('each example file the project holds gets its command, introduced, starter first and the dashboard last', () => {
    const { steps } = initNextSteps(rerunFacts())

    expect(steps).toEqual([
      { command: RUN_STARTER, description: 'Start with the two-step test, which passes:' },
      { command: RUN_SUITE, description: 'Run the example suite:' },
      { command: RUN_BUG_STARTER, description: BUG_STARTER_DESCRIPTION },
      { command: 'npx agent-qa dashboard', description: 'Open the dashboard' },
    ])
    expect(nextStepLines(steps)).toEqual([
      'Start with the two-step test, which passes:',
      RUN_STARTER,
      'Run the example suite:',
      RUN_SUITE,
      BUG_STARTER_DESCRIPTION,
      RUN_BUG_STARTER,
      'npx agent-qa dashboard',
    ])
  })

  it('a project without the starter file gets no starter command, and still the suite and the [Bug] test', () => {
    expect(commands(rerunFacts({ examples: { starter: false, suite: true, bug: true } }))).toEqual([
      RUN_SUITE,
      RUN_BUG_STARTER,
      'npx agent-qa dashboard',
    ])
  })

  it('a project with none of the example files gets no example command', () => {
    expect(
      commands(rerunFacts({ examples: { starter: false, suite: false, bug: false } })),
    ).toEqual(['npx agent-qa dashboard'])
  })

  it('the suite is described with no claim that it passes, since a project keeps the suite an older init wrote', () => {
    const suite = initNextSteps(rerunFacts()).steps.find((step) => step.command === RUN_SUITE)

    expect(suite?.description).toBe('Run the example suite:')
    expect(suite?.description).not.toMatch(/pass/iu)
  })

  it('with the dashboard starting, the starter is introduced as the test to run in the dashboard', () => {
    expect(initNextSteps(rerunFacts({ dashboard: 'starting' })).steps).toEqual([
      { command: RUN_STARTER, description: 'Run the starter test in the dashboard, or:' },
      { command: RUN_SUITE, description: 'Run the example suite:' },
      { command: RUN_BUG_STARTER, description: BUG_STARTER_DESCRIPTION },
    ])
  })

  it('a row left unchecked lists its --setup command with the row description, after a failed row', () => {
    const steps = withRecord(
      withRecord(RERUN_DONE, {
        name: 'gitignore',
        outcome: 'skipped',
        reason: 'not selected',
        command: 'npx agent-qa init --setup gitignore',
      }),
      {
        name: 'browsers',
        outcome: 'failed',
        reason: 'Chromium download failed twice',
        command: 'npx agent-qa init --setup browsers',
      },
    )

    expect(initNextSteps(rerunFacts({ steps })).steps.slice(0, 2)).toEqual([
      {
        command: 'npx agent-qa init --setup browsers',
        description: "Install Chromium for agent-qa's Playwright",
      },
      {
        command: 'npx agent-qa init --setup gitignore',
        description: "Restore init's .gitignore block",
      },
    ])
  })

  it('a deps row left to run already lists the command that puts the subscription plugin in', () => {
    const steps = withRecord(RERUN_DONE, {
      name: 'deps',
      outcome: 'skipped',
      reason: 'not selected',
      command: 'npx agent-qa init --setup deps',
    })

    expect(
      commands(rerunFacts({ steps, model: { ...CLAUDE_PENDING, pluginInstalled: false } })),
    ).not.toContain('npx agent-qa plugins add @vostride/agent-qa-subscription-auth')
  })

  it('a breaking version move puts the guide line and one URL per step under the box', () => {
    const upgrade = {
      from: '0.3.0',
      to: '0.5.0',
      breaking: true,
      links: [
        'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4',
        'https://vostride.com/docs/agent-qa/migrate/v0-4-to-v0-5',
      ],
    }

    expect(initNextSteps(rerunFacts({ upgrade, agents: ['claude-code'] })).hints).toEqual([
      'agent-qa 0.5.0 can change your config. To upgrade, point your coding agent at',
      'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4',
      'https://vostride.com/docs/agent-qa/migrate/v0-4-to-v0-5',
      CODING_AGENT_HINT,
    ])
  })

  it('a patch move adds no guide line', () => {
    const upgrade = {
      from: '0.3.0',
      to: '0.3.2',
      breaking: false,
      links: ['https://github.com/vostride/agent-qa/releases/tag/v0.3.2'],
    }

    expect(initNextSteps(rerunFacts({ upgrade })).hints).toEqual([])
  })
})
