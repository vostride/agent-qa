# agent-qa package instructions: @vostride/agent-qa-runner

## Scope

This package owns provider-neutral and storage-neutral runner contracts:
`PlatformAdapter`, platform action projections, run result and trace DTOs, and
the read-only `KnowledgeHintReader` contract used by runner execution.

## Read First

- `package.json`
- `src/index.ts`
- `src/platform.ts`
- `src/knowledge-hint-reader.ts`
- `src/result.ts`
- `src/ownership-contract.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-runner test`
- Typecheck: `pnpm --filter @vostride/agent-qa-runner typecheck`
- Build: `pnpm --filter @vostride/agent-qa-runner build`
