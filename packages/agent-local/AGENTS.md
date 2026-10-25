# agent-qa package instructions: @vostride/agent-qa-agent-local

## Scope

This package is the storageImplementation home for local agent persistence. It
holds the local stores behind the neutral ports (`src/store/`: the sqlite job
store and the checkpoint store), session logs and run analysis persistence, and
the local composition root (`src/composition/`) that assembles the run session
and the function registry every host shares.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-agent-local test`
- Typecheck: `pnpm --filter @vostride/agent-qa-agent-local typecheck`
- Build: `pnpm --filter @vostride/agent-qa-agent-local build`
