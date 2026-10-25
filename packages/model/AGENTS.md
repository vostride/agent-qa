# agent-qa package instructions: @vostride/agent-qa-model

## Scope

This package is the sole modelOwner. It owns provider SDK adapters, provider
registry resolution, compatible-provider transport, model validation,
capability-aware profile resolution, and the central BYOM-reliability language
model middleware stack.

## Read First

- `package.json`
- `src/index.ts`
- `src/registry.ts`
- `src/middleware.ts`
- `src/ownership-contract.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-model test`
- Typecheck: `pnpm --filter @vostride/agent-qa-model typecheck`
- Build: `pnpm --filter @vostride/agent-qa-model build`
