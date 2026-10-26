# agent-qa package instructions: @vostride/agent-qa-eval-local

## Scope

This package is the storageImplementation home for local eval filesystem IO. It
owns the cassette, replay-record, score and report stores, the judge binding and
the replay composition under the runtime workdir.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-eval-local test`
- Typecheck: `pnpm --filter @vostride/agent-qa-eval-local typecheck`
- Build: `pnpm --filter @vostride/agent-qa-eval-local build`
