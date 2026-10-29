// The PERMANENT link-out to the dashboard's live page.
//
// WHY THIS FILE EXISTS. `app-resource.ts` is the App channel: it mints a short-lived credential and
// hands it to a host that negotiated the Apps extension. This file is the OTHER half of the same
// promise, and it is the half that has to work everywhere. D-09 rules that the link-out rides EVERY
// carrier result — for an App-capable host and an App-less one alike — which is what makes "never a
// broken embed" a structural property rather than something anybody detects. A host that renders no
// App still receives a working address a person can open; a host that renders the App receives both,
// so a person can still pop out to the full two-pane dashboard surface.
//
// THE LINK IS TOKENLESS, AND THAT IS THE WHOLE OF D-08. It targets `/runs/:id/live` — the page the
// dashboard already serves, which mints its OWN `liveUrl` locally when somebody opens it while the
// run is going, and shows 403 D-12's terminal state with the run-detail affordance afterwards. So
// "permanent" is honest: the page outlives the token by construction. The two rejected shapes are
// worth naming, because both are what a reader would reach for first. A raw tokened embed URL is
// dead in five minutes, dead with the process that minted it, and is a live credential parked in a
// conversation transcript — T-408-12 exactly. A run-detail link is durable and never live, so it
// answers a different question than the one the line is offered for.
//
// ONE COMPOSED STRING, AND THAT IS WHY THERE IS NO BUILDER HERE. D-08 rates the link REVERSIBLE
// precisely because it is one composition of a base and a run id; a link object, a route table or a
// second addressing vocabulary would each make it something a later phase has to migrate rather
// than re-spell.
//
// THE BASE IS SUPPLIED, NEVER DISCOVERED HERE. Which base is correct is a COMPOSITION fact — the
// operator's configured `services.dashboard.baseUrl` first, this process's own bound origin second
// (`commands/dashboard.ts`'s overlay law: the overlay fills an ABSENCE and never replaces a
// presence, because a configured base is somebody pointing at a reverse proxy, a tunnel or a path
// prefix). This package holds no config reader and no server, so it takes the answer as a supplier
// and never as a string: on the dashboard host the origin does not exist until a port is bound.
//
// AND WHEN THERE IS NO BASE ANYWHERE, THE LINE IS A NAMED ABSENCE (RESEARCH Open Question 3). A
// standalone `agent-qa mcp` with no configured dashboard has nothing to link to, and a fabricated
// URL there would be exactly the dishonesty this milestone removes: a link that reads as an
// affordance and answers nothing. `LIVE_LINK_ABSENT_LINE` says what is missing and names the config
// knob that supplies a base, and contains no address at all.
//
// AND THERE ARE TWO ABSENCES, NOT ONE. A missing base and a
// missing run id are different facts with different remedies, so they carry different sentences —
// `LIVE_LINK_ABSENT_LINE` and `LIVE_LINK_NO_RUN_LINE`. Collapsing them is how a host that HAD a
// dashboard configured came to be told, on a model-readable channel, to configure it.
//
// Protocol grounding. SEP-1730 puts extensions outside every conformance tier — a host owes the
// Apps extension nothing — which is the protocol-level reason this line exists at all: the ONLY
// thing every host is obliged to render is a tool result's text, so the affordance that must never
// break has to ride there. SEP-2575 (the stateless protocol) is why the line is composed per result
// rather than announced once at connection: there is no session to have told a client about a base
// in. SEP-2549's cache hints are irrelevant to it by the same token — the line carries no
// credential and no freshness claim, so it neither needs nor offers one.

/**
 * The tokenless dashboard live page for one run: `<base>/runs/<runId>/live`.
 *
 * TRAILING SLASHES ARE COLLAPSED rather than tolerated. An operator writing
 * `baseUrl: http://dash.internal/` is writing the same base as one who did not, and a `//` in the
 * middle of a path is a different path to some proxies — so the composition normalises instead of
 * producing two addresses for one dashboard.
 *
 * THE RUN ID IS PERCENT-ENCODED, which is a no-op for every id this system mints (`runIdSchema`
 * refuses any id the path layer would have to rewrite) and is written anyway: this function is
 * exported, and a caller composing a link for an id that came from somewhere else should not be the
 * one place a path segment escapes unencoded.
 */
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

/**
 * What a carrier result says when no dashboard base exists ANYWHERE (RESEARCH Open Question 3).
 *
 * It names the config knob an operator sets to point this host at a dashboard (the 387 D-10
 * mechanism). It contains no URL — an absence that fabricated an address would be worse than no
 * line at all.
 */
export const LIVE_LINK_ABSENT_LINE = 'no dashboard configured — set services.dashboard.baseUrl'

/**
 * What a carrier result says when a dashboard base EXISTS but this result names no run to link to
 *
 * A SECOND NAMED ABSENCE, BECAUSE THERE ARE TWO DISTINCT FACTS. `carrierRunIdOf`
 * (`catalog.ts`) is DEFENSIVE ON BOTH ARMS by design and can honestly answer `undefined` — the
 * `runIdFrom: 'output'` arm reads an op's own result, which is a `RunStartAcknowledgement` today
 * and could be a fold's arm tomorrow, and the documented treatment of a shape it cannot read is a
 * named absence rather than a crash. Until this constant existed, that arm printed
 * `LIVE_LINK_ABSENT_LINE` — so a host that HAS `services.dashboard.baseUrl` set told the caller,
 * and the model reading the result, to set a value already set and pointed at the wrong knob. That
 * is a FALSE STATEMENT on a model-readable channel in a milestone whose law is honest absence, and
 * a wrong sentence is worse than a vague one because a model will act on it.
 *
 * IT NAMES NO CONFIG KNOB, deliberately: there is nothing for the operator to set. The dashboard is
 * configured; this particular result simply is not about a run. And it CONTAINS NO URL, the same
 * property `LIVE_LINK_ABSENT_LINE` above is held to — an absence that fabricated an address would
 * be the dishonesty this file exists to remove.
 */
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

/**
 * The one line a carrier result carries, given whatever the host's supplier answers.
 *
 * COMPOSED HERE so the "base or named absence" decision has exactly one implementation. It is the
 * decision the whole file exists for, and a second copy of it — in the catalog, in a command, in a
 * later carrier — is the copy that fabricates a URL from an empty string.
 *
 * A BLANK BASE IS AN ABSENT BASE. A configured `baseUrl: ""` (or a whitespace-only one) is somebody
 * who has not pointed this host anywhere, and composing `"/runs/x/live"` from it would produce a
 * relative fragment that reads as a link in a transcript and resolves against nothing.
 *
 * THE GUARD ORDER IS THE FIX, NOT AN ACCIDENT. The BASE is tested
 * first: with no base anywhere, "no dashboard configured" is the true and the more actionable
 * sentence whatever the run id is, so the both-absent case answers with the fact an operator can do
 * something about. Only with a base PRESENT does a missing run id become the fact worth naming, and
 * that arm answers `LIVE_LINK_NO_RUN_LINE`. Swapping these two lines back reinstates the false
 * sentence a configured host used to receive.
 */
export function liveLinkLineFor(
  base: string | undefined,
  runId: string | undefined,
): string {
  if (base === undefined || base.trim() === '') return LIVE_LINK_ABSENT_LINE
  if (runId === undefined || runId === '') return LIVE_LINK_NO_RUN_LINE
  return liveLinkLine(liveRunLinkOf(base.trim(), runId))
}
