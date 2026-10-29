// Where the card's `url` comes from.
//
// the URL is CONFIG-DERIVED and absent by default. The configuration a function-layer op
// can see is `ConfigReaderPort.getMasked()` — a flat, dot-path, already-masked list — and that
// is deliberately the only route. The alternative, a second port that read the raw resolved
// config, would have made the T-384-07 masking optional at exactly the seam it exists to
// protect, and "optional masking is not masking".
//
// Reading through the masker has a consequence worth stating plainly, because it decides this
// module's central rule. `services.dashboard.baseUrl`'s leaf name is registered in the CLI
// masker's address set, so a base carrying a path, userinfo, query or fragment is REDUCED to
// its origin and the entry is flagged `masked: true`. A reduced base is not the operator's
// base: rendering a link against it would silently drop the path prefix and point every card
// at a route the dashboard does not serve. So an entry whose value is not verbatim is treated
// as NO base at all, and the card's `url` is omitted — the same state as an unconfigured
// dashboard, which is the honest one. The masker's own flag is what makes this decidable; the
// producer never inspects the value's characters to guess.

import type {
  EntityDescriptor,
  MaskedResolvedConfig,
  QuarantineEntryState,
} from '@vostride/agent-qa-schema'

import type { FunctionDeps } from '../spec.js'

/** The two dot-paths D-10 reads, spelled once. */
export const DASHBOARD_BASE_URL_CONFIG_KEY = 'services.dashboard.baseUrl'
export const DASHBOARD_WORKSPACE_CONFIG_KEY = 'services.dashboard.workspace'

/** A configured dashboard, as the card producer needs it: both halves, both verbatim. */
export interface DashboardUrlBase {
  readonly baseUrl: string
  readonly workspace: string
}

/**
 * One entry's verbatim value, or `undefined` when there is no such entry or the masker
 * altered it.
 *
 * The `masked` flag is read rather than the value, because `masked: true` means exactly one
 * thing — "this is not the operator's raw value" — and that is the only question this module
 * has. A value-shaped test (does it look like a placeholder? does it look like an origin?)
 * would be the producer second-guessing the masker, and would still be wrong for the reduced
 * case, which looks like a perfectly good URL.
 */
function verbatim(masked: MaskedResolvedConfig, key: string): string | undefined {
  const entry = masked.entries.find((candidate) => candidate.key === key)
  if (entry === undefined || entry.masked) return undefined
  return entry.value.trim() === '' ? undefined : entry.value
}

/**
 * The configured dashboard base, or `undefined` — the v52 default.
 *
 * BOTH halves are required. A base with no workspace cannot render `:workspace`, and a
 * workspace with no base has nowhere to point; either alone would have to be completed by a
 * guess, and a guessed link is the dead link D-10 forbids.
 */
export function readDashboardUrlBase(
  masked: MaskedResolvedConfig,
): DashboardUrlBase | undefined {
  const baseUrl = verbatim(masked, DASHBOARD_BASE_URL_CONFIG_KEY)
  const workspace = verbatim(masked, DASHBOARD_WORKSPACE_CONFIG_KEY)
  if (baseUrl === undefined || workspace === undefined) return undefined
  return { baseUrl, workspace }
}

/** Everything the producer needs beyond the descriptor itself. */
export interface EntityCardContext {
  readonly urlBase?: DashboardUrlBase
  /**
   * The committed quarantine ledger's folded entries, when this render needs them.
   *
   * Read at the OP boundary and handed to the producer as a value, exactly like `urlBase` — the
   * producer takes no ports, which is what makes ENTY-02's "two renders of unchanged state are
   * deeply equal" a fact about the parameter list. Absent means no quarantine port is bound, or
   * no test is being rendered; the producer treats both as `active`.
   */
  readonly quarantine?: readonly QuarantineEntryState[]
}

/**
 * Build the render context for one op invocation.
 *
 * A configuration read failure is deliberately NOT swallowed into "no dashboard configured".
 * The two states are different — one is a deliberate default and the other is a broken
 * project — and a card that quietly dropped its link because the config file could not be
 * parsed would hide the breakage behind D-10's expected absence.
 *
 * The quarantine read is SCOPED to renders that contain a test, and the descriptors are taken as
 * a parameter for exactly that reason. Only a `TST` card's status can depend on the ledger, so a
 * `MEM` or `RUN` render must not be able to fail because a committed file somebody hand-edited
 * no longer parses. When a test IS in the set the read happens once for the whole render — one
 * fold, so two cards in one disambiguation set cannot disagree — and a refusal PROPAGATES:
 * answering `active` there would say "this test is not quarantined" about a ledger nobody could
 * open, which is the silent flip this phase exists to prevent.
 */
export async function readEntityCardContext(
  deps: FunctionDeps,
  descriptors: readonly EntityDescriptor[],
): Promise<EntityCardContext> {
  const urlBase = readDashboardUrlBase(await deps.config.getMasked())
  const needsQuarantine = descriptors.some((descriptor) => descriptor.kind === 'TST')
  const quarantine = needsQuarantine ? await deps.quarantine?.list() : undefined
  return {
    ...(urlBase === undefined ? {} : { urlBase }),
    ...(quarantine === undefined ? {} : { quarantine }),
  }
}
