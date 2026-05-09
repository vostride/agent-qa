# agent-qa package instructions: @vostride/agent-qa-dashboard

Inherit the root `agent-qa/AGENTS.md` branding, security, and release rules.

## Scope

This package owns the local dashboard server, SQLite database, routes, run queue,
dashboard reporter, test and suite file managers, live editor sessions, Appium
ownership, and dashboard-started MCP service lifecycle.

## Read First

- `package.json`
- `src/server/routes.ts`
- `src/server/server.ts`
- `src/db/database.ts`
- `src/execution/test-runner.ts`
- `src/live-editor/session-manager.ts`
- `src/reporter/dashboard-reporter.ts`
- Relevant `src/__tests__/*.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-dashboard test`
- Typecheck: `pnpm --filter @vostride/agent-qa-dashboard typecheck`
- Build: `pnpm --filter @vostride/agent-qa-dashboard build`

## Local Rules

- Keep SQLite migrations and runtime database paths backward-aware.
- Route handlers must validate input with existing schemas and must not leak
  secrets in JSON responses.
- Preserve dashboard reporter contracts consumed by the UI.
- Live editor sessions must clean up processes, sockets, Appium sessions, and
  run state on disconnect or cancellation.
- Dashboard-owned MCP and Appium lifecycles should remain explicit and
  observable.
- File manager changes must preserve canonical IDs and workspace path safety.

## Verification

Run focused server checks:

```bash
pnpm --filter @vostride/agent-qa-dashboard test
pnpm --filter @vostride/agent-qa-dashboard typecheck
```
