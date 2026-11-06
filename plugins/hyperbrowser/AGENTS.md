# agent-qa package instructions: @vostride/agent-qa-plugin-hyperbrowser

## Scope

This package is agent-qa's Hyperbrowser plugin. It creates a Hyperbrowser browser session before a
test connects, stops the session after, and answers with the session's CDP URL. Its account check
reads the active sessions without opening one. It is built only with
`@vostride/agent-qa-plugin-kit` and depends on no other agent-qa package. Hyperbrowser's API
key is a credential: it is sent only as the `x-api-key` header and never logged or returned.

## Read First

- `package.json`
- `src/plugin.ts`
- `src/hyperbrowser-api.ts`
- `src/__tests__/fake-hyperbrowser-api.ts`
- `src/__tests__/hyperbrowser-plugin.test.ts`
- `src/__tests__/hyperbrowser-check.test.ts`
- `README.md` and `skill/SKILL.md`, which document every option and setting

## Commands

- Test: `pnpm --filter @vostride/agent-qa-plugin-hyperbrowser test`
- Typecheck: `pnpm --filter @vostride/agent-qa-plugin-hyperbrowser typecheck`
- Build: `pnpm --filter @vostride/agent-qa-plugin-hyperbrowser build`
