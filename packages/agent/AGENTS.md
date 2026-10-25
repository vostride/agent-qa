# agent-qa package instructions: @vostride/agent-qa-agent

## Scope

This package owns provider-neutral and storage-neutral agent port contracts for
knowledge curation, tool execution, agent persistence, jobs and clock access.
It defines abstract seams consumed by storage implementations and must not
contain concrete runtime adapters.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`
- `src/ports/knowledge.ts`
- `src/ports/tools.ts`
- `src/ports/persistence.ts`
- `src/ports/clock.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-agent test`
- Typecheck: `pnpm --filter @vostride/agent-qa-agent typecheck`
- Build: `pnpm --filter @vostride/agent-qa-agent build`
