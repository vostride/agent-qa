# agent-qa package instructions: @vostride/agent-qa-agent

## Scope

This package owns the provider-neutral and storage-neutral agent layer: the
port contracts for knowledge, tools, persistence, the job store, replay gates,
authoring reads and the clock, and the typed function layer every host
composes (`src/functions/`: the registry, `invokeFunction` and the op specs).
The chat planner, authoring, analysis, explain, job queue, prompts and config
mutation are built on those ports. Concrete storage and host adapters live in
other packages.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`
- `src/functions/registry.ts`
- `src/functions/invoke.ts`
- `src/functions/spec.ts`
- `src/ports/knowledge.ts`
- `src/ports/tools.ts`
- `src/ports/persistence.ts`
- `src/ports/job-store.ts`
- `src/ports/authoring-read.ts`
- `src/ports/clock.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-agent test`
- Typecheck: `pnpm --filter @vostride/agent-qa-agent typecheck`
- Build: `pnpm --filter @vostride/agent-qa-agent build`
