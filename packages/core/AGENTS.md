# agent-qa package instructions: @vostride/agent-qa-core

Inherit the root `agent-qa/AGENTS.md` branding, security, and release rules.

## Scope

This package owns the core runtime: schemas, parser, runner, reporters, auth,
cache, memory, analytics, hooks, mobile shared contracts, workspace paths,
artifacts, and public TypeScript exports.

## Read First

- `package.json`
- `src/index.ts`
- `src/schema/index.ts`
- `src/schema/config-schema.ts`
- `src/agent/runner.ts`
- `src/agent/failure-summary.ts`
- `src/auth/resolver.ts`
- `src/memory/index.ts`
- `src/analytics/service.ts`
- Relevant `src/__tests__/*.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-core test`
- Typecheck: `pnpm --filter @vostride/agent-qa-core typecheck`
- Build: `pnpm --filter @vostride/agent-qa-core build`

## Local Rules

- Treat schemas as the source of truth for config, test, suite, service, registry,
  and use blocks.
- Preserve public exports from `src/index.ts` unless a plan explicitly calls for a
  breaking migration.
- Do not log API keys, bearer tokens, subscription tokens, env secrets, or auth
  store contents.
- Keep auth, analytics, memory, reporter, and parser changes covered by focused
  tests.
- Prefer structured parsers and Zod schemas over ad hoc string manipulation.
- Keep runtime paths under existing `.agent-qa/` or configured workspace paths.

## Verification

Run focused tests for the changed subsystem first, then package checks:

```bash
pnpm --filter @vostride/agent-qa-core test
pnpm --filter @vostride/agent-qa-core typecheck
```
