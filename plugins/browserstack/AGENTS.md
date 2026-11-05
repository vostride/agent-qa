# agent-qa package instructions: @vostride/agent-qa-plugin-browserstack

## Scope

This package is agent-qa's BrowserStack plugin. It answers a web test with BrowserStack's
Playwright URL, whose `caps` query carries BrowserStack's capabilities, and refuses a web test
when BrowserStack does not list agent-qa's Playwright version. `started` finds a web test's
Automate session through the REST API: the one running session in the build named for the run
whose name is the test's and that started after the acquire. It returns that session's
`browser_url` and `end` marks it; with no single match it links and marks nothing. It answers a
device test with BrowserStack's Appium hub and `bstack:options`, returns the App Automate
session's `browser_url` from `started` (never its `public_url`) and marks the session from
`end`.
`uploadApp` uploads a target's app once per content, under the custom id
`agent-qa-<first 32 hex of its SHA-256>`, and reuses the newest upload listed under it.
`check` reads the Automate and App Automate plans, opening no session, and warns when
BrowserStack does not list agent-qa's Playwright version. It is
built only with `@vostride/agent-qa-plugin-kit` and depends on no other agent-qa package. The
username and access key are credentials: they travel only inside the masked Playwright URL,
the `bstack:options` the host masks and the basic auth header, and are never logged.

## Read First

- `package.json`
- `src/plugin.ts`
- `src/options.ts`
- `src/web.ts`
- `src/devices.ts`
- `src/upload.ts`
- `src/check.ts`
- `src/browserstack-api.ts`
- `src/playwright-versions.ts`
- `src/__tests__/web-acquire.test.ts`
- `src/__tests__/web-marks.test.ts`
- `src/__tests__/device-acquire.test.ts`
- `src/__tests__/upload.test.ts`
- `src/__tests__/check.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-plugin-browserstack test`
- Typecheck: `pnpm --filter @vostride/agent-qa-plugin-browserstack typecheck`
- Build: `pnpm --filter @vostride/agent-qa-plugin-browserstack build`
