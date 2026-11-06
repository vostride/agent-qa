---
name: agent-qa-plugin-browserstack
description: Use when configuring agent-qa web or device tests to run on BrowserStack through the BrowserStack plugin, or when a BrowserStack remote is refused.
---

# BrowserStack remotes for agent-qa

The BrowserStack plugin runs an agent-qa web test on a BrowserStack browser over the Playwright
protocol, and a device test on a BrowserStack Android or iOS device over Appium. It returns each
session's BrowserStack dashboard link and marks the session passed or failed when the test ends.

## Declare the plugin

```yaml
plugins:
  - name: browserstack
    package: "@vostride/agent-qa-plugin-browserstack"
    options:
      username: "{{secret:BROWSERSTACK_USERNAME}}"
      accessKey: "{{secret:BROWSERSTACK_ACCESS_KEY}}"
```

- `username` and `accessKey` are credentials. Write them as `{{secret:<name>}}` references to
  names in the file `workspace.secretsFile` names. Never write the values in the config.
- `apiUrl`, `appApiUrl`, `hubUrl` and `playwrightUrl` default to BrowserStack's own endpoints.
  Leave them unset unless BrowserStack tells you otherwise.
- Install the package at the exact version of agent-qa the project runs:
  `npm install --save-dev --save-exact @vostride/agent-qa-plugin-browserstack@<agent-qa version>`.
  `agent-qa plugins list` prints that line when the package is missing or the version differs.

## A web remote

```yaml
registry:
  remotes:
    - name: browserstack
      plugin: browserstack
      settings:
        os: Windows
        osVersion: "11"
```

- `use.browser.remote: browserstack` in the config, a suite or a test runs the test there.
- Settings: `os` (default `OS X`), `osVersion` (default `Sequoia`), `browser`, `browserVersion`,
  `project` (default `agent-qa`), `build` (default the run id) and `extra`, merged last into the
  capabilities.
- `browser` follows the test's engine by default: `chrome` for Chromium, `playwright-firefox` for
  Firefox, `playwright-webkit` for WebKit. A browser that cannot run the test's engine is refused
  at `settings.browser`.
- Web tests use the Playwright protocol, so BrowserStack must list agent-qa's Playwright version.
  The plugin carries BrowserStack's list. When agent-qa's major.minor is not on it, every web test
  on BrowserStack is refused with kind `version` and one line naming both versions. Run the test
  here or on another remote until a plugin release adds the version.

## A device remote

```yaml
registry:
  remotes:
    - name: browserstack-devices
      plugin: browserstack
      settings:
        appiumVersion: "3.5.2"
  devices:
    bs-pixel:
      platform: android
      remote: browserstack-devices
      model: Google Pixel 9
      os: "15"
  targets:
    shop-android:
      platform: android
      appPackage: com.example.shop
      device: bs-pixel
      app:
        ref: bs://f7c874f21852ba57957a3fdc33f47514288c4ba4
```

- The session asks BrowserStack's hub with `bstack:options`: the credentials, `appiumVersion`,
  `projectName`, `buildName` (the run id) and `sessionName` (the test's name).
- `appiumVersion` is the device's own `bstack:options.appiumVersion`, then
  `settings.appiumVersion`, then the plugin's default, `3.5.2`.
- `project`, `build` and `extra` work as on a web remote; `extra` merges into `bstack:options`.

## Apps

- `app.ref` wins. When a target sets it (a `bs://` id from an earlier upload, or an `https` URL),
  BrowserStack installs that app and nothing is uploaded.
- The plugin's `uploadApp` takes the target's `app.path`. It uploads the file once per content,
  under the custom id `agent-qa-<first 32 hex of the file's SHA-256>`, and reuses the newest
  upload listed under that id after that. It answers the `bs://` ref the session installs.
  BrowserStack keeps an upload for 30 days.

## BrowserStack Local

Use BrowserStack Local when the target is reachable only from this machine, for example
`localhost` or a host behind a VPN.

```yaml
plugins:
  - name: browserstack
    package: "@vostride/agent-qa-plugin-browserstack"
    options:
      username: "{{secret:BROWSERSTACK_USERNAME}}"
      accessKey: "{{secret:BROWSERSTACK_ACCESS_KEY}}"
      local: true
```

- `local: true` starts the plugin's own tunnel on the run's first acquire, with a fresh identifier
  (or `localIdentifier` when set too), and every web and device session of the run asks for it.
  The plugin stops the tunnel when the run ends, on stdin close and on `SIGTERM`.
- `localIdentifier` alone uses a tunnel you already run under that identifier; nothing is started.
- The tunnel comes from BrowserStack's `browserstack-local` package, which finds or downloads
  BrowserStack's binary. `localBinary` names a binary to run instead and needs `local: true`.
- The tunnel logs to a fresh file under the temp directory, never into the project.
- A tunnel that cannot start refuses the session with kind `unreachable` at path `options.local`,
  or `options.localBinary` when that is set; the line names the tunnel's log.
- Before it starts the tunnel, the plugin checks that this machine can run the binary. A binary
  this machine cannot run refuses the session the same way, and the line's fix follows the cause:
  - `EBADARCH`, a Mac binary built for another CPU: install Rosetta
    (`softwareupdate --install-rosetta --agree-to-license`) or set `localBinary` to a binary
    built for this Mac. `browserstack-local` downloads BrowserStack's Intel build on every Mac,
    which an Apple Silicon Mac runs only under Rosetta.
  - `ENOENT`, a path that does not exist: set `localBinary` to the path of a BrowserStackLocal
    binary.
  - `EACCES`, a file that is not executable: make it executable, or set `localBinary` to one that
    is.
  - Any other failure: set `localBinary` to a binary this machine can run.
- BrowserStack's tunnel binary takes the access key as `--key` on its command line, by
  BrowserStack's design, so other users of the same machine can read it with `ps`.

## Links and marks

- When a session starts, the plugin returns its dashboard link to agent-qa: BrowserStack's
  `browser_url`, which needs a BrowserStack login. The shareable `public_url` is never returned.
- A passed test is marked `passed`. A failed test, or agent-qa's own error, is marked `failed`
  with the reason. A cancelled test stays unmarked.
- A web session is found through BrowserStack's REST API: the one running session in the build
  named for the run, whose name is the test's and that started after agent-qa asked for it. When
  none or several match, the test gets no link and the session stays unmarked, with one line on
  the plugin's stderr. A guessed session is never marked.

## When a remote is refused

- `auth`: BrowserStack refused the username or access key. Check the secrets' values.
- `capacity`: BrowserStack answered 429. The account's parallel sessions are in use, or the API
  rate limit was hit. Wait, or lower the run's concurrency.
- `version`: BrowserStack does not list agent-qa's Playwright version. Web tests cannot run there.
- `refused` with a path such as `settings.browser` or `apiUrl`: that field is wrong. The line says
  why.
- `refused` with no path: BrowserStack answered another error. The line has its status and
  message.
- `unreachable`: BrowserStack could not be reached. Check the network. At path `options.local` or
  `options.localBinary`, the BrowserStack Local tunnel did not start; its log is named in the
  line, and when this machine cannot run the binary, the line also says how to fix it.

## Check and describe

- `agent-qa doctor` runs the plugin's account check. It reads the Automate and App Automate plans
  and reports running, allowed and queued parallel sessions for each. It warns when the
  credentials are refused, when a product is not on the account and when BrowserStack does not
  list agent-qa's Playwright version. It opens no session.
- `agent-qa plugins describe <entry> --json` lists every option and setting with its type,
  default and description.
