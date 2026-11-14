import { describe, expect, it } from 'vitest'

import { dashboardOpenPath } from '../commands/dashboard.js'
import {
  CODEX_TRUST_HINT,
  CODING_AGENT_HINT,
  dashboardPage,
  initNextSteps,
  nextStepLines,
  type InitNextStepFacts,
  type InitNextStepModel,
} from '../commands/init-next-steps.js'
import type { InitStepRecord } from '../commands/init-steps.js'

const DASHBOARD = 'npx agent-qa dashboard'
const RUN_STARTER = 'npx agent-qa run tests/examples/komazon-cart-total.yaml'
const RUN_ANDROID_STARTER = 'npx agent-qa run tests/examples/playground-android-open-komazon.yaml'
const RUN_IOS_STARTER = 'npx agent-qa run tests/examples/playground-ios-open-komazon.yaml'
const IN_THE_DASHBOARD = 'Run a test in the dashboard:'
const FROM_THE_TERMINAL = 'Run a test from the terminal:'
const ADD_MODEL = 'Add the model in the dashboard:'
const FINISH_MODEL = 'Finish setting up the model in the dashboard:'
const READY_LINE = 'Your coding agent can use agent-qa now.'

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
    webStarter: true,
    agents: [],
    ...overrides,
  }
}

function commands(input: InitNextStepFacts): string[] {
  return initNextSteps(input).steps.map((step) => step.command)
}

describe('the next steps are what is left, then the dashboard, then the terminal', () => {
  it('web alone with nothing left lists the dashboard group, then the web starter in the terminal group', () => {
    const { steps } = initNextSteps(facts())

    expect(steps).toEqual([
      { command: DASHBOARD, description: IN_THE_DASHBOARD },
      { command: RUN_STARTER, description: FROM_THE_TERMINAL },
    ])
    expect(nextStepLines(steps)).toEqual([
      IN_THE_DASHBOARD,
      DASHBOARD,
      '',
      FROM_THE_TERMINAL,
      RUN_STARTER,
    ])
  })

  it('web with Android and iOS lists the three starters in the terminal group, in the order web, Android, iOS', () => {
    const { steps } = initNextSteps(facts({ mobileStarters: ['ios', 'android'] }))

    expect(steps).toEqual([
      { command: DASHBOARD, description: IN_THE_DASHBOARD },
      { command: RUN_STARTER, description: FROM_THE_TERMINAL },
      { command: RUN_ANDROID_STARTER, description: FROM_THE_TERMINAL },
      { command: RUN_IOS_STARTER, description: FROM_THE_TERMINAL },
    ])
    expect(nextStepLines(steps)).toEqual([
      IN_THE_DASHBOARD,
      DASHBOARD,
      '',
      FROM_THE_TERMINAL,
      RUN_STARTER,
      RUN_ANDROID_STARTER,
      RUN_IOS_STARTER,
    ])
  })

  it('mobile alone lists the Android starter, then the iOS starter', () => {
    expect(commands(facts({ webStarter: false, mobileStarters: ['ios', 'android'] }))).toEqual([
      DASHBOARD,
      RUN_ANDROID_STARTER,
      RUN_IOS_STARTER,
    ])
  })

  it('a runtime that is not among the starters that can run gets no command', () => {
    expect(commands(facts({ webStarter: false, mobileStarters: ['ios'] }))).toEqual([
      DASHBOARD,
      RUN_IOS_STARTER,
    ])
  })

  it('with no starter that can run, lists the dashboard group alone and no terminal description', () => {
    const { steps } = initNextSteps(facts({ webStarter: false }))

    expect(steps).toEqual([{ command: DASHBOARD, description: IN_THE_DASHBOARD }])
    expect(nextStepLines(steps)).toEqual([IN_THE_DASHBOARD, DASHBOARD])
  })

  it('names no suite and no [Bug] test', () => {
    const all = commands(facts({ mobileStarters: ['android', 'ios'] }))

    expect(all.join('\n')).not.toMatch(/examples\.suite|-bug\.yaml/u)
  })

  it('a failed Playground app download adds no step, and no command names the app', () => {
    const failed: InitStepRecord = {
      name: 'playground-app',
      outcome: 'failed',
      reason: 'The Playground app for Android was not downloaded: fetch failed.',
    }
    const steps = [...DONE.slice(0, 4), failed, ...DONE.slice(4)]
    const next = initNextSteps(facts({ steps }))

    expect(next.steps).toEqual(initNextSteps(facts()).steps)
    expect(next.steps.filter((step) => /app-bundles|playground-app/u.test(step.command))).toEqual(
      [],
    )
  })
})

describe('a model finished in the dashboard', () => {
  it('a page that adds a model gives one command that opens it in double quotes, described as adding the model', () => {
    const page = '/config/models?add=openai-compatible-key&name=my-key'

    expect(initNextSteps(facts({ model: GEMINI_READY, modelPage: page })).steps).toEqual([
      {
        command: `npx agent-qa dashboard --open "${page}"`,
        description: ADD_MODEL,
      },
      { command: DASHBOARD, description: IN_THE_DASHBOARD },
      { command: RUN_STARTER, description: FROM_THE_TERMINAL },
    ])
  })

  it('the plain model page is described as finishing the model', () => {
    expect(initNextSteps(facts({ modelPage: '/config/models' })).steps[0]).toEqual({
      command: 'npx agent-qa dashboard --open "/config/models"',
      description: FINISH_MODEL,
    })
  })

  it('comes after what is left and before the dashboard group, each group under a blank line', () => {
    const steps = withRecord(DONE, {
      name: 'chromium',
      outcome: 'skipped',
      reason: '--no-browsers',
      command: 'npx agent-qa install-browsers --chromium',
    })
    const next = initNextSteps(facts({ steps, model: CLAUDE_PENDING, modelPage: '/config/models' }))

    expect(nextStepLines(next.steps)).toEqual([
      'npx agent-qa install-browsers --chromium',
      'npx agent-qa auth login --config claude-code',
      '',
      FINISH_MODEL,
      'npx agent-qa dashboard --open "/config/models"',
      '',
      IN_THE_DASHBOARD,
      DASHBOARD,
      '',
      FROM_THE_TERMINAL,
      RUN_STARTER,
    ])
  })

  it('no model page gives no model step', () => {
    expect(commands(facts()).some((command) => command.includes('--open'))).toBe(false)
  })
})

describe('what is left comes first', () => {
  it('a failed pnpm install and a pending Claude subscription list the install and the auth login line before the groups', () => {
    const steps = withRecord(DONE, {
      name: 'install',
      outcome: 'failed',
      reason: 'pnpm exited 1',
      command: 'pnpm install',
    })

    expect(
      commands(facts({ steps, model: { ...CLAUDE_PENDING, pluginInstalled: false } })),
    ).toEqual([
      'pnpm install',
      'npx agent-qa auth login --config claude-code',
      DASHBOARD,
      RUN_STARTER,
    ])
  })

  it('a failed step, a skipped step, the plugin line and the sign-in line come in that order', () => {
    const steps = withRecord(
      withRecord(DONE, {
        name: 'validate',
        outcome: 'failed',
        reason: 'the config is not valid',
        command: 'npx agent-qa validate',
      }),
      {
        name: 'chromium',
        outcome: 'skipped',
        reason: '--no-browsers',
        command: 'npx agent-qa install-browsers --chromium',
      },
    )

    expect(
      commands(facts({ steps, model: { ...CLAUDE_PENDING, pluginInstalled: false } })),
    ).toEqual([
      'npx agent-qa validate',
      'npx agent-qa install-browsers --chromium',
      'npx agent-qa plugins add @vostride/agent-qa-subscription-auth',
      'npx agent-qa auth login --config claude-code',
      DASHBOARD,
      RUN_STARTER,
    ])
  })

  it('prints what is left as commands alone, with no blank line at the top of the box', () => {
    const steps = withRecord(DONE, {
      name: 'chromium',
      outcome: 'skipped',
      reason: '--no-browsers',
      command: 'npx agent-qa install-browsers --chromium',
    })

    expect(nextStepLines(initNextSteps(facts({ steps })).steps)).toEqual([
      'npx agent-qa install-browsers --chromium',
      '',
      IN_THE_DASHBOARD,
      DASHBOARD,
      '',
      FROM_THE_TERMINAL,
      RUN_STARTER,
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
      DASHBOARD,
      RUN_STARTER,
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

  it('a pending subscription gives one auth login line, described as its sign-in', () => {
    expect(initNextSteps(facts({ model: CLAUDE_PENDING })).steps[0]).toEqual({
      command: 'npx agent-qa auth login --config claude-code',
      description: 'Sign in with your subscription',
    })
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
    const pages = [undefined, '/config/models', '/config/models?add=anthropic-compatible-key']
    const plainInstalls = new Set(['pnpm install', 'yarn install'])
    let checked = 0
    for (const install of installs) {
      for (const chromium of chromiums) {
        for (const model of models) {
          for (const modelPage of pages) {
            for (const webStarter of [true, false]) {
              const steps = withRecord(withRecord(DONE, install), chromium)
              const input = facts({
                steps,
                webStarter,
                ...(modelPage === undefined ? {} : { modelPage }),
              })
              const all = commands(
                model === undefined
                  ? { ...input, model: undefined }
                  : {
                      ...input,
                      model,
                    },
              )
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

describe('the page a next step names', () => {
  it('is the model page while the model is pending', () => {
    expect(dashboardPage({ model: 'pending' })).toBe('/config/models')
  })

  it('is none once the model is ready', () => {
    expect(dashboardPage({ model: 'ready' })).toBeUndefined()
  })

  it('adds a saved compatible key by its name and a new endpoint by its kind', () => {
    const saved = { add: 'openai-compatible-key', name: 'work' }
    expect(dashboardPage({ model: 'pending', dashboard: saved })).toBe(
      '/config/models?add=openai-compatible-key&name=work',
    )
    const endpoint = { add: 'anthropic-compatible-key' }
    expect(dashboardPage({ model: 'pending', dashboard: endpoint })).toBe(
      '/config/models?add=anthropic-compatible-key',
    )
  })

  it('leaves out a name that is not a slug, so the page stays one plain argument', () => {
    expect(
      dashboardPage({
        model: 'pending',
        dashboard: { add: 'openai-compatible-key', name: 'Work Key"; rm -rf ~' },
      }),
    ).toBe('/config/models?add=openai-compatible-key')
  })

  it('is always one that dashboard --open takes', () => {
    const setups = [
      undefined,
      { add: 'openai-compatible-key' },
      { add: 'anthropic-compatible-key' },
      { add: 'openai-compatible-key', name: 'my-key.v2' },
      { add: 'anthropic-compatible-key', name: 'Not A Slug"$(x)' },
    ]
    for (const model of ['pending', 'ready'] as const) {
      for (const dashboard of setups) {
        const page = dashboardPage({ model, ...(dashboard === undefined ? {} : { dashboard }) })
        if (page !== undefined) expect(dashboardOpenPath(page)).toBe(page)
      }
    }
  })
})

describe('the lines under the box', () => {
  it('a scaffold that was not written lists only what failed and init again, with no hint', () => {
    const steps = withRecord(
      withRecord(DONE, { name: 'package-json', outcome: 'failed', reason: 'EACCES' }),
      { name: 'scaffold', outcome: 'skipped', reason: 'package.json was not written' },
    )
    const next = initNextSteps(
      facts({ steps, model: CLAUDE_PENDING, modelPage: '/config/models', agents: ['codex'] }),
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

  it('the coding agent hint asks for the starter test when one is listed, and is the plain ready line when none is', () => {
    expect(initNextSteps(facts({ agents: ['claude-code'] })).hints).toEqual([
      'Your coding agent can use agent-qa now: ask it to run the starter test.',
    ])
    expect(initNextSteps(facts({ webStarter: false, agents: ['claude-code'] })).hints).toEqual([
      READY_LINE,
    ])
  })

  it('a mobile starter listed alone gives the coding agent hint that asks for the starter test', () => {
    const next = initNextSteps(
      facts({ webStarter: false, mobileStarters: ['android'], agents: ['claude-code'] }),
    )

    expect(next.steps.map((step) => step.command)).toEqual([DASHBOARD, RUN_ANDROID_STARTER])
    expect(next.hints).toEqual([CODING_AGENT_HINT])
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
    facts({ steps: RERUN_DONE, model: GEMINI_READY, ...overrides })

  it('a scaffold row that is current never asks for init again', () => {
    expect(commands(rerunFacts())).toEqual([DASHBOARD, RUN_STARTER])
  })

  it('a project without the starter file gets no terminal group', () => {
    const { steps } = initNextSteps(rerunFacts({ webStarter: false }))

    expect(nextStepLines(steps)).toEqual([IN_THE_DASHBOARD, DASHBOARD])
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
