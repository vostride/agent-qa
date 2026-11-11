// The CLI's one way to resolve the analytics identity, and the one resolution this process holds:
// the error reporter starts it when its reporting is on, and PostHog's host reuses it, so a report
// and an analytics event carry one id. A second resolution in CI would mint a second ci_ id.

import { resolveAnalyticsIdentity } from '@vostride/agent-qa-analytics'
import type { ResolvedAnalyticsIdentity } from '@vostride/agent-qa-analytics'

export const ANALYTICS_IDENTITY_TIMEOUT_MS = 1_000

export type HeldAnalyticsIdentity = Promise<ResolvedAnalyticsIdentity | undefined>

export interface ResolveCliAnalyticsIdentityInput {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly resolve?: typeof resolveAnalyticsIdentity
}

// Never rejects: a failure, or no answer within the cut-off, settles as undefined. The environment
// is read as the resolution starts, so the data home it names cannot change under it.
export function resolveCliAnalyticsIdentity(
  input: ResolveCliAnalyticsIdentityInput = {},
): HeldAnalyticsIdentity {
  const env = { ...(input.env ?? process.env) }
  // CI is the run detector's answer, reached through agent-local (the firewall).
  return import('@vostride/agent-qa-agent-local')
    .then(({ resolveRunExecutionContext }) => {
      const ci = resolveRunExecutionContext() === 'ci'
      const resolve = input.resolve ?? resolveAnalyticsIdentity
      return withTimeout(resolve({ env, ci }), ANALYTICS_IDENTITY_TIMEOUT_MS)
    })
    .catch(() => undefined)
}

let held: HeldAnalyticsIdentity | undefined

export function holdProcessAnalyticsIdentity(identity: HeldAnalyticsIdentity): void {
  held = identity
}

export function heldProcessAnalyticsIdentity(): HeldAnalyticsIdentity | undefined {
  return held
}

export function releaseProcessAnalyticsIdentity(): void {
  held = undefined
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('analytics identity timed out')), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}
