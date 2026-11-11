# agent-qa package instructions: @vostride/agent-qa-analytics

## Scope

This package is the product-analytics home. It owns the `AnalyticsPort` and
`AnalyticsTransport` interfaces, the closed typed event union, the PostHog
transport, and `composeAnalytics` — the one place the opt-out decision is made;
opted out or keyless, it composes a port with no transport. Hosts bind it at
their composition roots; the agent's function layer never sees it. It also
holds the two generated, gitignored key files, `src/posthog-project.ts` and
`src/sentry-project.ts` (the DSN the CLI's error reporter reads), which
`scripts/ensure-posthog-project.cjs` creates blank when missing and a release
writes, so a source checkout sends nothing. `src/identity.ts` resolves the
anonymous id: the one stored in `analytics.json` under the data home, created
on first use, or in CI a new id for each process. A host resolves it once per
process, for analytics events and for the CLI's error reports alike.

## Read First

- `package.json`
- `src/index.ts`
- `src/compose.ts`
- `src/events.ts`
- `src/port.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-analytics test`
- Typecheck: `pnpm --filter @vostride/agent-qa-analytics typecheck`
- Build: `pnpm --filter @vostride/agent-qa-analytics build`
