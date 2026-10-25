# agent-qa package instructions: @vostride/agent-qa-core

## Scope

This package owns the shared core: the config, test, suite, registry, services,
use and workspace schemas and the retired-key list, the YAML parser, auth and
auth state, hooks, IDs, logging, mobile shared contracts, providers, suite
helpers, validation, the version check, workspace and runtime paths, agent
types and the token budget, and the public TypeScript exports.

## Read First

- `package.json`
- `src/index.ts`
- `src/schema/index.ts`
- `src/schema/config-schema.ts`
- `src/schema/retired-keys.ts`
- `src/auth/resolver.ts`
- Relevant `src/__tests__/*.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-core test`
- Typecheck: `pnpm --filter @vostride/agent-qa-core typecheck`
- Build: `pnpm --filter @vostride/agent-qa-core build`
