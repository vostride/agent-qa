import type { CodingAgent } from './agent-setup-manifest.js'
import type { InitStepName, InitStepRecord } from './init-steps.js'

export interface InitNextStep {
  command: string
  description: string
}

export interface InitNextStepModel {
  name: string
  provider: string
  status: 'ready' | 'pending'
  subscription: boolean
  pluginInstalled: boolean
}

export interface InitNextStepFacts {
  steps: readonly InitStepRecord[]
  model?: InitNextStepModel
  web: boolean
  mobile: boolean
  // The coding agents whose setup went through.
  agents: readonly CodingAgent[]
  dashboard: 'starting' | { command: string }
}

export const SUBSCRIPTION_PLUGIN_COMMAND =
  'npx agent-qa plugins add @vostride/agent-qa-subscription-auth'
export const EXAMPLES_RUN_COMMAND = 'npx agent-qa run suites/examples.suite.yaml'
export const DASHBOARD_COMMAND = 'npx agent-qa dashboard'
export const INIT_COMMAND = 'npx agent-qa init'
export const CODING_AGENT_HINT =
  'Your coding agent can use agent-qa now: ask it to run the examples.'
export const CODEX_TRUST_HINT =
  'Codex reads .codex/config.toml only in a trusted folder: trust this folder when Codex asks.'

const AUTH_LOGIN_DESCRIPTION = 'Sign in with your subscription'

function authLoginCommand(name: string): string {
  return `npx agent-qa auth login --config ${name}`
}

const STEP_DESCRIPTIONS: Record<InitStepName, string> = {
  'package-json': 'Write package.json',
  scaffold: 'Write the scaffold',
  install: 'Install the dependencies',
  chromium: 'Install the browser the examples run in',
  skills: 'Set up the coding agents',
  validate: 'Check the config and the tests',
  dashboard: 'Open the dashboard',
}

// Only what is left: what failed first, then what was skipped, then what the model still needs.
export function initNextSteps(facts: InitNextStepFacts): {
  steps: InitNextStep[]
  hints: string[]
} {
  const steps: InitNextStep[] = []
  const add = (command: string, description: string): void => {
    if (!steps.some((step) => step.command === command)) steps.push({ command, description })
  }
  const fromRecords = (outcome: InitStepRecord['outcome']): void => {
    for (const record of facts.steps) {
      if (record.outcome !== outcome || record.command === undefined) continue
      add(record.command, STEP_DESCRIPTIONS[record.name])
    }
  }
  fromRecords('failed')
  fromRecords('skipped')

  // Without the scaffold there is no config to run, sign in to or open, so init comes again.
  const unscaffolded = facts.steps.some(
    (record) => record.name === 'scaffold' && record.outcome !== 'done',
  )
  if (unscaffolded) {
    add(INIT_COMMAND, 'Set up the folder once the step above is fixed')
    return { steps, hints: [] }
  }

  const { model } = facts
  const install = facts.steps.find((record) => record.name === 'install')
  // A failed or declared-only install already lists the command that puts the plugin in.
  const installPending =
    install !== undefined && install.outcome !== 'done' && install.command !== undefined
  if (model?.subscription === true && !model.pluginInstalled && !installPending) {
    add(SUBSCRIPTION_PLUGIN_COMMAND, 'Install the subscription sign-in plugin')
  }
  if (model?.subscription === true && model.status === 'pending') {
    add(authLoginCommand(model.name), AUTH_LOGIN_DESCRIPTION)
  }
  if (facts.mobile) {
    add('npx agent-qa install-mobile-drivers --all', 'Install mobile driver support')
  }
  if (facts.dashboard === 'starting') {
    if (facts.web) add(EXAMPLES_RUN_COMMAND, 'Run the examples in the dashboard, or:')
  } else {
    if (facts.web) {
      add(
        EXAMPLES_RUN_COMMAND,
        "Run the examples: one passes, one fails on the playground's deliberate bug (exit 1)",
      )
    }
    add(facts.dashboard.command, STEP_DESCRIPTIONS.dashboard)
  }

  const hints: string[] = []
  if (facts.agents.length > 0) hints.push(CODING_AGENT_HINT)
  if (facts.agents.includes('codex')) hints.push(CODEX_TRUST_HINT)
  return { steps, hints }
}

// A description that ends in a colon introduces its command; the others stay in the document.
export function nextStepLines(steps: readonly InitNextStep[]): string[] {
  return steps.flatMap((step) =>
    step.description.endsWith(':') ? [step.description, step.command] : [step.command],
  )
}
