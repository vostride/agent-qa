# agent-qa package instructions: @vostride/agent-qa-plugin-kernel

## Scope

This package is agent-qa's Kernel plugin. It creates a Kernel browser, or acquires one from a
browser pool, before a test connects, deletes it or returns it to the pool after, and answers
with the browser's CDP URL. Its account check reads Kernel without creating a browser. It is
built only with `@vostride/agent-qa-plugin-kit` and depends on no other agent-qa package.
Kernel's API key is a credential: it is sent only as the Bearer header and never logged or
returned.

## Read First

- `package.json`
- `src/plugin.ts`
- `src/kernel-api.ts`
- `src/__tests__/fake-kernel-api.ts`
- `src/__tests__/kernel-plugin.test.ts`
- `README.md` and `skill/SKILL.md`, which document every option and setting

## Commands

- Test: `pnpm --filter @vostride/agent-qa-plugin-kernel test`
- Typecheck: `pnpm --filter @vostride/agent-qa-plugin-kernel typecheck`
- Build: `pnpm --filter @vostride/agent-qa-plugin-kernel build`
