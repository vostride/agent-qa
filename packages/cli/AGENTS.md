# agent-qa package instructions: agent-qa

## Scope

This package owns the public `agent-qa` CLI, Commander command registration,
config loading, init/auth/run/dashboard/mcp command UX, device and target
commands, validation commands, and packaged skills.

## Read First

- `package.json`
- `src/cli.ts`
- `src/config.ts`
- `src/commands/init.ts`
- `src/commands/auth.ts`
- `src/commands/run.ts`
- `src/commands/dashboard.ts`
- `src/commands/mcp.ts`
- `scripts/copy-skills.mjs`
- Relevant `src/__tests__/*.test.ts`

## Commands

- Test: `pnpm --filter agent-qa test`
- Typecheck: `pnpm --filter agent-qa typecheck`
- Build: `pnpm --filter agent-qa build`
- Copy packaged skills: `pnpm --filter agent-qa copy:skills`
