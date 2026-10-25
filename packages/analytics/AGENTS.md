# agent-qa package instructions: @vostride/agent-qa-analytics

## Scope

This package is the product-analytics home. It owns the `AnalyticsPort` and
`AnalyticsTransport` interfaces, the closed typed event union, the PostHog
transport, and `composeAnalytics` — the one place the opt-out decision is made;
opted out or keyless, it composes a port with no transport. Hosts bind it at
their composition roots; the agent's function layer never sees it.

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
