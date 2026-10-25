# agent-qa package instructions: @vostride/agent-qa-runner-local

## Scope

This package is the host-adapter home for runner persistence. It owns the host
APIs the storage-neutral `@vostride/agent-qa-runner` package deliberately
excludes: the filesystem action-plan cache (`FsActionCache`, behind the runner
`ActionPlanCache` port), git-branch detection and the branch write-skip
policy, saved browser storage states, the run event log, handoffs, run
artifacts, evidence blobs, sharp screenshot compression, build ordinals and
build tags, and Docker hook execution.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`
- `src/fs-action-cache.ts`
- `src/storage-state-store.ts`
- `src/branch-resolver.ts`
- `src/write-policy.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-runner-local test`
- Typecheck: `pnpm --filter @vostride/agent-qa-runner-local typecheck`
- Build: `pnpm --filter @vostride/agent-qa-runner-local build`
