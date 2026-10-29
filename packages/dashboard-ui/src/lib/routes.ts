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

  // hrefs are minted from this total map, never copied off a
  // store-written URL. An artifact is addressed by the `{ id, sha }` ref the projection carries;
  // the run id is encoded because it is opaque, and the sha is passed VERBATIM because the store
  // validates its 64-hex shape and re-casing it would change the content address itself.
  runArtifact: (runId: string, sha: string) => `/api/runs/${encodeURIComponent(runId)}/artifacts/${sha}`,
} as const

/**
 * THE ONE PIECE OF NAVIGATION STATE THIS APP CARRIES.
 *
 * The live page navigates to run detail the instant its reducer records the run's verdict. That
 * leaves run detail with a question it cannot answer from the run row alone: the row's status is
 * written by the dashboard subscriber's own `updateRun` at the SAME envelope the page navigated
 * on, and a `fetchRun` issued a millisecond later can legitimately still read `running`. A page
 * that bounced back to `/live` on that reading would ping-pong the viewer between two surfaces at
 * the exact moment their run ended — T-404-15, the failure D-07 exists to forbid.
 *
 * So the navigating page says so, in one field, and run detail reads it. This is deliberately NOT
 * a query parameter: a shareable URL that carries "I just watched this verdict land" would make a
 * pasted link claim something about the person who opened it that is simply untrue.
 */
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

/**
 * The cadence and the ceiling of run detail's row catch-up, for an arrival that carries a verdict.
 *
 * WHY A CATCH-UP AND NOT A WAIT. The subscriber's `updateRun` at `verdict` and this page's own
 * `fetchRun` race BY DESIGN — D-13 navigates on the ENVELOPE, which is the earliest honest moment,
 * and the durable row follows within milliseconds. The page therefore renders the row it has and
 * re-asks, rather than blocking on a row that is already on its way.
 *
 * 8 × 250 ms = two seconds, after which the page simply shows what it has. A row that has not
 * caught up in two seconds is not a race any more; it is a producer or a database that has a
 * different problem, and spinning forever on it would be the same dishonesty as the bounce.
 */
export const VERDICT_ROW_CATCH_UP_MS = 250
export const VERDICT_ROW_CATCH_UP_MAX = 8
