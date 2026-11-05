import { PluginError, z } from '@vostride/agent-qa-plugin-kit'
import { browserStackApiFor } from './browserstack-api.js'
import { failureText } from './devices.js'
import type { BrowserStackOptions } from './options.js'
import {
  BROWSERSTACK_PLAYWRIGHT_VERSIONS,
  listedPlaywright,
  playwrightMajorMinor,
} from './playwright-versions.js'

const PlanSchema = z.object({
  parallel_sessions_running: z.number(),
  parallel_sessions_max_allowed: z.number(),
  queued_sessions: z.number(),
})

type PlanRead =
  | { kind: 'plan'; line: string }
  | { kind: 'refused' }
  | { kind: 'warn'; line: string }

export interface CheckAccountInput {
  options: BrowserStackOptions
  playwrightVersion: string
  signal: AbortSignal
}

async function readPlan(product: string, read: () => Promise<unknown>): Promise<PlanRead> {
  let answer: unknown
  try {
    answer = await read()
  } catch (error) {
    if (error instanceof PluginError && error.kind === 'auth') return { kind: 'refused' }
    return { kind: 'warn', line: `${product} plan not readable: ${failureText(error)}` }
  }
  if (answer === undefined) return { kind: 'warn', line: `${product} is not on this account` }
  const plan = PlanSchema.safeParse(answer)
  if (!plan.success) {
    return {
      kind: 'warn',
      line: `${product} plan not readable: BrowserStack answered another shape`,
    }
  }
  const { parallel_sessions_running: running, parallel_sessions_max_allowed: allowed } = plan.data
  const queued = plan.data.queued_sessions
  return {
    kind: 'plan',
    line: `${product}: ${String(running)} of ${String(allowed)} parallel sessions running, ${String(queued)} queued`,
  }
}

function playwrightLine(version: string): string | undefined {
  if (listedPlaywright(version)) return undefined
  const first = BROWSERSTACK_PLAYWRIGHT_VERSIONS[0]
  const last = BROWSERSTACK_PLAYWRIGHT_VERSIONS[BROWSERSTACK_PLAYWRIGHT_VERSIONS.length - 1]
  const ours = playwrightMajorMinor(version)
  if (ours === undefined) {
    return `BrowserStack lists Playwright ${first} to ${last}, and agent-qa's Playwright version is unknown; web tests on BrowserStack are refused until it is known.`
  }
  return `BrowserStack lists Playwright ${first} to ${last}, not ${ours}; web tests on BrowserStack are refused until it does.`
}

// Reads only the two plan endpoints, so checking an account never opens a session.
export async function checkAccount(
  input: CheckAccountInput,
): Promise<{ state: 'ok' | 'warn'; lines: string[] }> {
  const api = browserStackApiFor(input.options)
  const reads = await Promise.all([
    readPlan('Automate', () => api.automatePlan(input.signal)),
    readPlan('App Automate', () => api.appAutomatePlan(input.signal)),
  ])
  const version = playwrightLine(input.playwrightVersion)
  const extra = version === undefined ? [] : [version]
  if (reads.some((read) => read.kind === 'refused')) {
    return { state: 'warn', lines: ['the username or access key was refused', ...extra] }
  }
  const lines = reads.flatMap((read) => (read.kind === 'refused' ? [] : [read.line]))
  const warned = extra.length > 0 || reads.some((read) => read.kind === 'warn')
  return { state: warned ? 'warn' : 'ok', lines: [...lines, ...extra] }
}
