# agent-qa package instructions: agent-qa

Inherit the root `agent-qa/AGENTS.md` branding, security, and release rules.

## Scope

This package owns the public `agent-qa` CLI, Commander command registration,
config loading, init/auth/run/dashboard/serve/mcp command UX, device and target
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

## Local Rules

- Commander global `--config <path>` is the project config file path. Avoid
  command-specific option names that collide with it unless parser behavior is
  explicitly tested.
- Keep command errors actionable and copy-pasteable.
- Init-generated config must remain schema-valid and should not install external
  plugins automatically.
- Auth commands must not print or persist secrets outside the existing auth
  store paths.
- Run command changes must preserve dashboard event, run ID, suite queue, and
  live-event environment behavior.
- Packaged skills come from the source `skills/` directory through `copy:skills`.

## Verification

Run focused CLI checks:

```bash
pnpm --filter agent-qa test
pnpm --filter agent-qa typecheck
pnpm --filter agent-qa copy:skills
```
