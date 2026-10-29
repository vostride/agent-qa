// A base the masker reduced is not the operator's base, so the card's `url` is omitted.

import type {
  EntityDescriptor,
  MaskedResolvedConfig,
  QuarantineEntryState,
} from '@vostride/agent-qa-schema'

import type { FunctionDeps } from '../spec.js'

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

// Base and workspace are both required; either alone would need a guess.
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
  // Read at the op boundary so the producer takes no ports; absent renders as `active`.
  readonly quarantine?: readonly QuarantineEntryState[]
}

// A config read failure propagates, and the quarantine read runs only for renders with a test.
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
