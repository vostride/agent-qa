# agent-qa package instructions: @vostride/agent-qa-web

## Scope

This package owns browser automation through Playwright, page observation (ARIA
snapshot, element enrichment and scroll capture), action validation, smart
waits, scrolling helpers, screenshots, and accessibility checks.

## Read First

- `package.json`
- `src/adapter.ts`
- `src/action-validator.ts`
- `src/element-resolver.ts`
- `src/observer.ts`
- `src/accessibility.ts`
- Relevant `src/__tests__/*.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-web test`
- Typecheck: `pnpm --filter @vostride/agent-qa-web typecheck`
- Build: `pnpm --filter @vostride/agent-qa-web build`
