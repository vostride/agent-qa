# agent-qa package instructions: @vostride/agent-qa-knowledge-local

## Scope

This package implements the local memidex knowledge store: event-sourced
bundles, the derived sqlite index and retrieval. `createLocalKnowledgeStore`
(`src/curator/knowledge-store.ts`) implements `KnowledgePort` over it.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`
- `src/artifact-copy.ts`
- `src/bundle-publish.ts`
- `src/bundle-append.ts`
- `src/bundle-read.ts`
- `src/curator/knowledge-store.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-knowledge-local test`
- Typecheck: `pnpm --filter @vostride/agent-qa-knowledge-local typecheck`
- Build: `pnpm --filter @vostride/agent-qa-knowledge-local build`
