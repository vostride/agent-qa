import {
  configTabPath,
  resolveLegacyConfigLink,
  type ConfigSectionId,
  type ConfigTab,
} from '@/lib/config-tabs'
import { shouldRouteRunToLive } from '@/lib/status'

import type { RunStatus } from '@vostride/agent-qa-schema'

export const routes = {
  runs: '/runs',
  tests: '/tests',
  testNew: '/tests/new',
  hooks: '/hooks',
  hookNew: '/hooks/new',
  insights: '/insights',
  config: '/config',

  runDetail: (id: string) => `/runs/${encodeURIComponent(id)}`,
  runLive: (id: string) => `/runs/${id}/live`,
  runDetailOrLive: (id: string, status: string) =>
    shouldRouteRunToLive(status) ? `/runs/${id}/live` : `/runs/${id}`,
  testView: (testId: string) => `/test/${testId}`,
  testEdit: (testId: string) => `/test/${testId}/edit`,
  testEditLive: (testId: string) => `/test/${testId}/edit?live=1`,
  hookView: (hookId: string) => `/hook/${hookId}`,
  hookEdit: (hookId: string) => `/hook/${hookId}/edit`,
  suites: '/suites',
  suiteNew: '/suites/new',
  suiteView: (suiteId: string) => `/suite/${suiteId}`,
  suiteEdit: (suiteId: string) => `/suite/${suiteId}/edit`,
  configTab: (tab: ConfigTab, section?: ConfigSectionId) => configTabPath(tab, section),
  configItem: (bucket: string, item: string) => {
    const link = resolveLegacyConfigLink(new URLSearchParams({ bucket, item }))
    return link.kind === 'mapped' ? configTabPath(link.tab, link.section) : configTabPath('models')
  },

  // The run id is encoded because it is opaque; the sha passes verbatim, as the store validates it.
  runArtifact: (runId: string, sha: string) => `/api/runs/${encodeURIComponent(runId)}/artifacts/${sha}`,
} as const

// Tells run detail not to bounce to `/live` on a stale row; kept out of the URL so links stay true.
export interface RunDetailNavigationState {
  readonly arrivedOnVerdict: RunStatus
}

/** The closed set `RunStatus` is, restated as values so the reader below can check membership. */
const RUN_STATUS_WORDS: readonly string[] = ['passed', 'failed', 'healed', 'timeout', 'cancelled']

/**
 * Read {@link RunDetailNavigationState} off whatever `useLocation().state` happens to hold.
 *
 * IT NEVER THROWS AND IT NEVER GUESSES. History state is attacker-adjacent — it survives a reload,
 * it is restored from the session history entry a person may have crafted, and React Router types
 * it `any`. Anything that is not the exact shape carrying a word from the closed `RunStatus` set
 * answers `undefined`, which lands the caller on the ordinary "opened directly" path. The failure
 * mode of a wrong answer here is a page that refuses to bounce a genuinely running run, so the
 * check is membership in the vocabulary rather than `typeof === 'string'`.
 */
export function arrivedOnVerdictFrom(state: unknown): RunStatus | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const word = (state as { arrivedOnVerdict?: unknown }).arrivedOnVerdict
  if (typeof word !== 'string' || !RUN_STATUS_WORDS.includes(word)) return undefined
  return word as RunStatus
}

// The row trails the verdict envelope by milliseconds, so the page re-asks briefly, never blocks.
export const VERDICT_ROW_CATCH_UP_MS = 250
export const VERDICT_ROW_CATCH_UP_MAX = 8
