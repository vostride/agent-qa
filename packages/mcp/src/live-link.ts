// Every host renders tool-result text, so the tokenless link rides every carrier result (SEP-1730).

// Trailing slashes collapse so one dashboard has one address; the run id is percent-encoded anyway.
export function liveRunLinkOf(base: string, runId: string): string {
  return `${base.replace(/\/+$/u, '')}/runs/${encodeURIComponent(runId)}/live`
}

/**
 * The human-readable line a carrier result carries when a base exists.
 *
 * AN EXPORTED TEMPLATE RATHER THAN A STRING EACH CALL SITE COMPOSES, so a cell asserts the SAME
 * sentence the surface prints. Two carriers and two hosts print this; four hand-written spellings
 * would be four things to keep in step, and the drift would be invisible because nobody diffs two
 * tool results.
 *
 * IT NAMES BOTH READINGS OF THE ONE PAGE — watching a run that is going, and reviewing one that has
 * finished — because the address is the same either way and a line that promised only "live" would
 * read as broken the moment the run ended, which is precisely when a person follows it.
 */
export function liveLinkLine(url: string): string {
  return `watch live or review: ${url}`
}

// Names the config knob and holds no URL: a fabricated address is worse than none.
export const LIVE_LINK_ABSENT_LINE = 'no dashboard configured — set services.dashboard.baseUrl'

// A base exists but the result names no run: no knob to set and no URL.
export const LIVE_LINK_NO_RUN_LINE
  = 'no run to link to — this result names no run id'

/**
 * How a HOST answers "which dashboard is this process pointed at".
 *
 * A FACTORY, NOT A STRING, on `commands/dashboard.ts`'s own reasoning about the same value: the
 * server has not bound a port when the host is composed, and an ephemeral port (`port: 0`) is a
 * real posture in this suite and in tests. A value captured at composition time would be a guess; a
 * factory read per result is the truth.
 *
 * `undefined` is the degenerate case rather than a second branch: a host that supplies no supplier
 * at all and a supplier that answers `undefined` are the same fact — no dashboard — and they take
 * the same path to the same line.
 */
export interface LiveLinkSupplier {
  readonly dashboardBaseUrl: () => string | undefined
}

// The base is tested first: with none anywhere, the missing config is the actionable line.
export function liveLinkLineFor(
  base: string | undefined,
  runId: string | undefined,
): string {
  if (base === undefined || base.trim() === '') return LIVE_LINK_ABSENT_LINE
  if (runId === undefined || runId === '') return LIVE_LINK_NO_RUN_LINE
  return liveLinkLine(liveRunLinkOf(base.trim(), runId))
}
