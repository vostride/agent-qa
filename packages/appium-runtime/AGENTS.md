# agent-qa package instructions: @vostride/agent-qa-appium-runtime

## Scope

This package depends on Appium and the UiAutomator2 and XCUITest drivers at
exact versions and exports `startAppiumServer`, which prepares a temporary
`APPIUM_HOME` linking the two drivers and starts that Appium server on
loopback. It also pins, at exact versions, Appium's own `@appium/*` packages,
which Appium and its packages ask for by range, so an install resolves the
versions this release ran on; no source imports them.

## Read First

- `package.json`
- `src/index.ts`
- `src/start-appium-server.ts`
- `src/appium-home.ts`
- `src/bundled-appium.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-appium-runtime test`
- Typecheck: `pnpm --filter @vostride/agent-qa-appium-runtime typecheck`
- Build: `pnpm --filter @vostride/agent-qa-appium-runtime build`
