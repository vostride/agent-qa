# agent-qa package instructions: @vostride/agent-qa-plugin-browserstack

## Scope

This package is agent-qa's BrowserStack plugin. It answers a web test with BrowserStack's
Playwright URL, whose `caps` query carries BrowserStack's capabilities, and refuses a web test
when BrowserStack does not list agent-qa's Playwright version. It is built only with
`@vostride/agent-qa-plugin-kit` and depends on no other agent-qa package. The username and
access key are credentials: they travel only inside the masked Playwright URL and are never
logged.

## Read First

- `package.json`
- `src/plugin.ts`
- `src/options.ts`
- `src/web.ts`
- `src/playwright-versions.ts`
- `src/__tests__/web-acquire.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-plugin-browserstack test`
- Typecheck: `pnpm --filter @vostride/agent-qa-plugin-browserstack typecheck`
- Build: `pnpm --filter @vostride/agent-qa-plugin-browserstack build`
