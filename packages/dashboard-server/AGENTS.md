# agent-qa package instructions: @vostride/agent-qa-dashboard

## Scope

This package owns the local dashboard server, SQLite database, routes, run queue,
dashboard reporter, test and suite file managers, live editor sessions, Appium
ownership, and dashboard-started MCP service lifecycle.

## Read First

- `package.json`
- `src/server/routes.ts`
- `src/server/server.ts`
- `src/db/database.ts`
- `src/execution/execution-backend.ts`
- `src/execution/in-process-backend.ts`
- `src/live-editor/session-manager.ts`
- `src/reporter/dashboard-subscriber.ts`
- `src/run-service/run-service-routes.ts`
- Relevant `src/__tests__/*.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-dashboard test`
- Typecheck: `pnpm --filter @vostride/agent-qa-dashboard typecheck`
- Build: `pnpm --filter @vostride/agent-qa-dashboard build`
