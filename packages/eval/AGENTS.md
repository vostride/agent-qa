# agent-qa package instructions: @vostride/agent-qa-eval

## Scope

This package owns provider- and storage-neutral eval contracts: the cassette
contract, pure deterministic cassette extraction from in-memory run evidence,
offline decision replay, the matcher with its judge, and the report builder.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`
- `src/ports.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-eval test`
- Typecheck: `pnpm --filter @vostride/agent-qa-eval typecheck`
- Build: `pnpm --filter @vostride/agent-qa-eval build`
