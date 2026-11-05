# agent-qa package instructions: @vostride/agent-qa-plugin-kit

## Scope

This package is what plugin authors build with: the public plugin protocol, `definePlugin`,
the stdio loop a plugin runs, and the testing helpers. agent-qa's host and every plugin use
it, so a change here changes the protocol for both sides. It carries no vendor code and no
`@vostride/agent-qa-*` runtime dependency.

## Read First

- `package.json`
- `src/protocol/messages.ts`
- `src/protocol/manifest.ts`
- `src/protocol/framing.ts`
- `src/define-plugin.ts`
- `src/run-plugin.ts`
- `src/testing/scripted-plugin.ts`
- `src/__tests__/stdio-loop.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-plugin-kit test`
- Typecheck: `pnpm --filter @vostride/agent-qa-plugin-kit typecheck`
- Build: `pnpm --filter @vostride/agent-qa-plugin-kit build`
