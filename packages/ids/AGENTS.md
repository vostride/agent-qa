# agent-qa package instructions: @vostride/agent-qa-ids

## Scope

This package owns canonical persistent ID helpers. Changes here can affect tests,
suites, hooks, runs, observations, MCP tools, and dashboard authoring surfaces.

## Read First

- `package.json`
- `src/index.ts`
- `src/persistent-id.ts`
- `src/__tests__/persistent-id.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-ids test`
- Typecheck: `pnpm --filter @vostride/agent-qa-ids typecheck`
- Build: `pnpm --filter @vostride/agent-qa-ids build`
