# agent-qa package instructions: @vostride/agent-qa-plugin-steel

## Scope

This package is agent-qa's Steel plugin. It creates a Steel browser session with a session id it
chooses before a test connects, releases the session after, and answers with the session's CDP
URL. Its account check lists sessions without opening one. It is built only with
`@vostride/agent-qa-plugin-kit` and depends on no other agent-qa package. Steel's API key is a
credential: it is sent only as the `steel-api-key` header and in the masked connect URL, and never
logged.

## Read First

- `package.json`
- `src/plugin.ts`
- `src/steel-api.ts`
- `src/__tests__/fake-steel-api.ts`
- `src/__tests__/steel-plugin.test.ts`
- `src/__tests__/steel-check.test.ts`
- `README.md` and `skill/SKILL.md`, which document every option and setting

## Commands

- Test: `pnpm --filter @vostride/agent-qa-plugin-steel test`
- Typecheck: `pnpm --filter @vostride/agent-qa-plugin-steel typecheck`
- Build: `pnpm --filter @vostride/agent-qa-plugin-steel build`
