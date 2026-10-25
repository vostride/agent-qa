# agent-qa package instructions: @vostride/agent-qa-eval-local

## Scope

This package is the storageImplementation home for local eval filesystem IO. It
binds eval read ports and owns cassette bundle writes under runtime workdirs.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-eval-local test`
- Typecheck: `pnpm --filter @vostride/agent-qa-eval-local typecheck`
- Build: `pnpm --filter @vostride/agent-qa-eval-local build`
