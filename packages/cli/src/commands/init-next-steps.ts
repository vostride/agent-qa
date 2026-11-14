import { NAME_SLUG_PATTERN } from '@vostride/agent-qa-schema'

import type { CodingAgent } from './agent-setup-manifest.js'
import { guideLines, type VersionMove } from './agent-qa-upgrade.js'
import type { InitModelSetup, InitModelStatus } from './init-model-choice.js'
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
  // Web was chosen and the web starter's file is there.
  webStarter: boolean
  // The dashboard page that finishes the model's setup.
  modelPage?: string
  // The mobile runtimes whose starter can run: a device was written and the app is in place.
  // A re-run gives none.
  mobileStarters?: readonly ('android' | 'ios')[]
  // The coding agents whose setup went through.
  agents: readonly CodingAgent[]
  // The version move a re-run knows of.
  upgrade?: VersionMove
}

// The example files init writes at these paths.
export const EXAMPLE_PATHS = {
  starter: 'tests/examples/komazon-cart-total.yaml',
  suite: 'suites/examples.suite.yaml',
  bug: 'tests/examples/komazon-cart-total-bug.yaml',
  androidStarter: 'tests/examples/playground-android-open-komazon.yaml',
  iosStarter: 'tests/examples/playground-ios-open-komazon.yaml',
} as const

const SUBSCRIPTION_PLUGIN_COMMAND = 'npx agent-qa plugins add @vostride/agent-qa-subscription-auth'
const STARTER_RUN_COMMAND = `npx agent-qa run ${EXAMPLE_PATHS.starter}`
// In the order they are listed.
const MOBILE_STARTERS = [
  { runtime: 'android', command: `npx agent-qa run ${EXAMPLE_PATHS.androidStarter}` },
  { runtime: 'ios', command: `npx agent-qa run ${EXAMPLE_PATHS.iosStarter}` },
] as const
const DASHBOARD_COMMAND = 'npx agent-qa dashboard'
export const INIT_COMMAND = 'npx agent-qa init'
const IN_THE_DASHBOARD = 'Run a test in the dashboard:'
const FROM_THE_TERMINAL = 'Run a test from the terminal:'
const ADD_MODEL = 'Add the model in the dashboard:'
const FINISH_MODEL = 'Finish setting up the model in the dashboard:'
const CODING_AGENT_READY = 'Your coding agent can use agent-qa now'
export const CODING_AGENT_HINT = `${CODING_AGENT_READY}: ask it to run the starter test.`
export const CODEX_TRUST_HINT =
  'Codex reads .codex/config.toml only in a trusted folder: trust this folder when Codex asks.'

const AUTH_LOGIN_DESCRIPTION = 'Sign in with your subscription'
const MODEL_PAGE = '/config/models'

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
}

// The model page that finishes the setup, or none once the model is ready. A name outside the
// slug form is left out, so the page stays one argument that `dashboard --open` takes.
export function dashboardPage({
  model,
  dashboard,
}: {
  model: InitModelStatus['status']
  dashboard?: InitModelSetup['dashboard']
}): string | undefined {
  if (dashboard !== undefined) {
    const add = `${MODEL_PAGE}?add=${encodeURIComponent(dashboard.add)}`
    const { name } = dashboard
    return name !== undefined && NAME_SLUG_PATTERN.test(name)
      ? `${add}&name=${encodeURIComponent(name)}`
      : add
  }
  return model === 'pending' ? MODEL_PAGE : undefined
}

// What is left first: what failed, then what was skipped, then what the model still needs. Then
// the model page while the model is finished there, the dashboard, and the starters that can run.
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
  if (facts.modelPage !== undefined) {
    add(
      `${DASHBOARD_COMMAND} --open "${facts.modelPage}"`,
      facts.modelPage.includes('?add=') ? ADD_MODEL : FINISH_MODEL,
    )
  }
  add(DASHBOARD_COMMAND, IN_THE_DASHBOARD)
  if (facts.webStarter) add(STARTER_RUN_COMMAND, FROM_THE_TERMINAL)
  for (const starter of MOBILE_STARTERS) {
    if (facts.mobileStarters?.includes(starter.runtime) === true) {
      add(starter.command, FROM_THE_TERMINAL)
    }
  }

  const hints: string[] = facts.upgrade === undefined ? [] : guideLines(facts.upgrade)
  if (facts.agents.length > 0) {
    const starterListed = steps.some((step) => step.description === FROM_THE_TERMINAL)
    hints.push(starterListed ? CODING_AGENT_HINT : `${CODING_AGENT_READY}.`)
  }
  if (facts.agents.includes('codex')) hints.push(CODEX_TRUST_HINT)
  return { steps, hints }
}

// A description that ends in a colon is printed once above its group's commands, under an empty
// line unless it opens the box; the other descriptions stay in the document.
export function nextStepLines(steps: readonly InitNextStep[]): string[] {
  const lines: string[] = []
  steps.forEach((step, index) => {
    const opensGroup =
      step.description.endsWith(':') && steps[index - 1]?.description !== step.description
    if (opensGroup) {
      if (lines.length > 0) lines.push('')
      lines.push(step.description)
    }
    lines.push(step.command)
  })
  return lines
}
