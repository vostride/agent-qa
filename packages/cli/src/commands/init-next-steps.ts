import type { CodingAgent } from './agent-setup-manifest.js'
import { guideLines, type VersionMove } from './agent-qa-upgrade.js'
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

export interface InitExampleFiles {
  starter: boolean
  suite: boolean
  bug: boolean
}

export interface InitNextStepFacts {
  steps: readonly InitStepRecord[]
  model?: InitNextStepModel
  web: boolean
  // The example files on disk after a run that kept some of them: a re-run, or a fresh init
  // over a suite file. A run that wrote every example gives none.
  examples?: InitExampleFiles
  // The mobile runtimes whose starter can run: a device was written and the app is in place.
  // A re-run gives none.
  mobileStarters?: readonly ('android' | 'ios')[]
  // The coding agents whose setup went through.
  agents: readonly CodingAgent[]
  dashboard: 'starting' | { command: string }
  // The version move a re-run knows of.
  upgrade?: VersionMove
}

// The example files the next steps name. init.ts writes them at these paths.
export const EXAMPLE_PATHS = {
  starter: 'tests/examples/komazon-cart-total.yaml',
  suite: 'suites/examples.suite.yaml',
  bug: 'tests/examples/komazon-cart-total-bug.yaml',
  androidStarter: 'tests/examples/playground-android-open-komazon.yaml',
  iosStarter: 'tests/examples/playground-ios-open-komazon.yaml',
} as const

export const SUBSCRIPTION_PLUGIN_COMMAND =
  'npx agent-qa plugins add @vostride/agent-qa-subscription-auth'
const STARTER_RUN_COMMAND = `npx agent-qa run ${EXAMPLE_PATHS.starter}`
const ANDROID_STARTER_RUN_COMMAND = `npx agent-qa run ${EXAMPLE_PATHS.androidStarter}`
const IOS_STARTER_RUN_COMMAND = `npx agent-qa run ${EXAMPLE_PATHS.iosStarter}`
// In the order they are listed, each with the description it has when another starter leads.
const MOBILE_STARTERS = [
  {
    runtime: 'android',
    command: ANDROID_STARTER_RUN_COMMAND,
    description: 'Run the Android starter on the Playground app:',
  },
  {
    runtime: 'ios',
    command: IOS_STARTER_RUN_COMMAND,
    description: 'Run the iOS starter on the Playground app:',
  },
] as const
export const EXAMPLES_RUN_COMMAND = `npx agent-qa run ${EXAMPLE_PATHS.suite}`
const BUG_STARTER_RUN_COMMAND = `npx agent-qa run ${EXAMPLE_PATHS.bug}`
export const DASHBOARD_COMMAND = 'npx agent-qa dashboard'
export const INIT_COMMAND = 'npx agent-qa init'
const CODING_AGENT_READY = 'Your coding agent can use agent-qa now'
export const CODING_AGENT_HINT = `${CODING_AGENT_READY}: ask it to run the starter test.`
const CODING_AGENT_EXAMPLES_HINT = `${CODING_AGENT_READY}: ask it to run the examples.`
export const CODEX_TRUST_HINT =
  'Codex reads .codex/config.toml only in a trusted folder: trust this folder when Codex asks.'

const AUTH_LOGIN_DESCRIPTION = 'Sign in with your subscription'

function authLoginCommand(name: string): string {
  return `npx agent-qa auth login --config ${name}`
}

const STEP_DESCRIPTIONS: Record<InitStepName, string> = {
  model: 'Set the model',
  upgrade: 'Upgrade agent-qa',
  deps: "Install agent-qa's missing packages",
  'package-json': 'Write package.json',
  scaffold: 'Write the scaffold',
  install: 'Install the dependencies',
  chromium: 'Install the browser the examples run in',
  'playground-app': 'Download the Playground app',
  skills: 'Set up the coding agents',
  mcp: "Restore the coding agents' MCP entries",
  'agents-md': "Restore agent-qa's block in AGENTS.md and the knowledge guide",
  browsers: "Install Chromium for agent-qa's Playwright",
  gitignore: "Restore init's .gitignore block",
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

  // Without the scaffold there is no config to run, sign in to or open, so init comes again. A
  // re-run, which writes no package.json, starts from a config.
  const fresh = facts.steps.some((record) => record.name === 'package-json')
  const unscaffolded =
    fresh && facts.steps.some((record) => record.name === 'scaffold' && record.outcome !== 'done')
  if (unscaffolded) {
    add(INIT_COMMAND, 'Set up the folder once the step above is fixed')
    return { steps, hints: [] }
  }

  const { model } = facts
  // A failed or declared-only install, or a deps row left to run, already lists the command that
  // puts the plugin in.
  const installPending = facts.steps.some(
    (record) =>
      (record.name === 'install' || record.name === 'deps') &&
      record.outcome !== 'done' &&
      record.command !== undefined,
  )
  if (model?.subscription === true && !model.pluginInstalled && !installPending) {
    add(SUBSCRIPTION_PLUGIN_COMMAND, 'Install the subscription sign-in plugin')
  }
  if (model?.subscription === true && model.status === 'pending') {
    add(authLoginCommand(model.name), AUTH_LOGIN_DESCRIPTION)
  }
  // With no examples fact, this run wrote every example.
  const examples = facts.examples ?? { starter: true, suite: true, bug: true }
  const lead =
    facts.dashboard === 'starting'
      ? 'Run the starter test in the dashboard, or:'
      : 'Start with the two-step test, which passes:'
  // The web starter leads, and without it the first mobile starter does.
  const webStarter = facts.web && examples.starter
  if (webStarter) add(STARTER_RUN_COMMAND, lead)
  const mobile = MOBILE_STARTERS.filter((starter) =>
    (facts.mobileStarters ?? []).includes(starter.runtime),
  )
  for (const [index, starter] of mobile.entries()) {
    add(starter.command, index === 0 && !webStarter ? lead : starter.description)
  }
  if (facts.web) {
    // A suite file that was kept may be an older init's, which does not pass.
    if (examples.suite) {
      add(
        EXAMPLES_RUN_COMMAND,
        facts.examples === undefined
          ? 'Then run the suite of three Komazon tests, which passes:'
          : 'Run the example suite:',
      )
    }
    if (examples.bug) {
      add(
        BUG_STARTER_RUN_COMMAND,
        "Run the test that fails on the playground's deliberate bug (exit 1):",
      )
    }
  }
  if (facts.dashboard !== 'starting') add(facts.dashboard.command, STEP_DESCRIPTIONS.dashboard)

  const hints: string[] = facts.upgrade === undefined ? [] : guideLines(facts.upgrade)
  if (facts.agents.length > 0) {
    const listed = (command: string): boolean => steps.some((step) => step.command === command)
    const starters = [STARTER_RUN_COMMAND, ANDROID_STARTER_RUN_COMMAND, IOS_STARTER_RUN_COMMAND]
    if (starters.some(listed)) hints.push(CODING_AGENT_HINT)
    else if (listed(EXAMPLES_RUN_COMMAND) || listed(BUG_STARTER_RUN_COMMAND)) {
      hints.push(CODING_AGENT_EXAMPLES_HINT)
    } else hints.push(`${CODING_AGENT_READY}.`)
  }
  if (facts.agents.includes('codex')) hints.push(CODEX_TRUST_HINT)
  return { steps, hints }
}

// A description that ends in a colon introduces its command; the others stay in the document.
export function nextStepLines(steps: readonly InitNextStep[]): string[] {
  return steps.flatMap((step) =>
    step.description.endsWith(':') ? [step.description, step.command] : [step.command],
  )
}
