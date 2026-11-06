# @vostride/agent-qa-plugin-browserstack

The agent-qa plugin for [BrowserStack](https://www.browserstack.com). It runs agent-qa web tests on
BrowserStack browsers over the Playwright protocol, and device tests on BrowserStack Android and
iOS devices over Appium. It uploads a target's app once per content, returns each session's
dashboard link and marks each session with the test's outcome.

## Install

Install the plugin at exactly the version of agent-qa the project runs:

```bash
npm install --save-dev --save-exact @vostride/agent-qa-plugin-browserstack@<agent-qa version>
```

`agent-qa plugins list` prints this line, with the version filled in, when the package is missing
or its version differs from agent-qa's.

## Configure

```yaml
plugins:
  - name: browserstack
    package: "@vostride/agent-qa-plugin-browserstack"
    options:
      username: "{{secret:BROWSERSTACK_USERNAME}}"
      accessKey: "{{secret:BROWSERSTACK_ACCESS_KEY}}"

registry:
  remotes:
    - name: browserstack
      plugin: browserstack
      settings:
        os: Windows
        osVersion: "11"
    - name: browserstack-devices
      plugin: browserstack
  devices:
    bs-pixel:
      platform: android
      remote: browserstack-devices
      model: Google Pixel 9
      os: "15"
```

A web test runs on BrowserStack with `use.browser.remote: browserstack` in the config, a suite or
the test. A device test runs there when its target's `device` is a device whose `remote` is a
BrowserStack remote.

### Options

Options belong to the `plugins` entry and describe the account.

| Option            | Default                                 | Meaning                                                              |
| ----------------- | --------------------------------------- | -------------------------------------------------------------------- |
| `username`        | required                                | The BrowserStack username, a credential.                             |
| `accessKey`       | required                                | The BrowserStack access key, a credential.                           |
| `apiUrl`          | `https://api.browserstack.com`          | The Automate API: web session lookups, marks and the plan.           |
| `appApiUrl`       | `https://api-cloud.browserstack.com`    | The App Automate API: uploads, device sessions, the plan.            |
| `hubUrl`          | `https://hub.browserstack.com/wd/hub`   | The Appium hub device sessions connect to.                           |
| `playwrightUrl`   | `wss://cdp.browserstack.com/playwright` | The Playwright endpoint web sessions connect to.                     |
| `local`           | `false`                                 | Start a BrowserStack Local tunnel for the run.                       |
| `localIdentifier` | -                                       | The tunnel's identifier; without `local`, a tunnel already running.  |
| `localBinary`     | -                                       | The BrowserStackLocal binary `local` runs, instead of the wrapper's. |

Write the credentials as `{{secret:<name>}}` references. The endpoints must use `https://`
(`wss://` for `playwrightUrl`) and carry no user or password, unless they point at this machine;
otherwise the entry is refused at the option's path. The credentials travel only in the masked
Playwright URL, in the `bstack:options` agent-qa masks and in the basic auth header of REST calls.
They never appear in a message, a log or an answer.

### Settings

Settings belong to each remote and describe one place.

| Setting          | Default    | Meaning                                                                               |
| ---------------- | ---------- | ------------------------------------------------------------------------------------- |
| `os`             | `OS X`     | The web session's operating system, for example `Windows`.                            |
| `osVersion`      | `Sequoia`  | The operating system version, for example `11` or `Sequoia`.                          |
| `browser`        | by engine  | `chrome`, `edge`, `playwright-chromium`, `playwright-firefox` or `playwright-webkit`. |
| `browserVersion` | -          | The Chrome or Edge version, for example `latest` or `latest-1`.                       |
| `project`        | `agent-qa` | The BrowserStack project sessions are filed under.                                    |
| `build`          | the run id | The BrowserStack build name.                                                          |
| `appiumVersion`  | `3.5.2`    | The Appium version device sessions ask for.                                           |
| `extra`          | -          | Capabilities merged last, overriding the ones above.                                  |

`agent-qa plugins describe browserstack` prints the same tables from the schemas the package
ships, and `--json` prints them as JSON.

## Web tests

A web acquire answers the Playwright URL with a `caps` query holding JSON capabilities:

- `browserstack.username` and `browserstack.accessKey`;
- `browser`: `settings.browser`, or by the test's engine, `chrome` for Chromium,
  `playwright-firefox` for Firefox and `playwright-webkit` for WebKit. A browser that cannot run
  the test's engine is refused at `settings.browser`;
- `os`, `os_version` and, when set, `browser_version`;
- `client.playwrightVersion`: agent-qa's Playwright version;
- `project`, `build` (the run id unless `settings.build` is set) and `name` (the test's name);
- `settings.extra`, merged last.

The query carries the access key, so agent-qa masks the whole URL.

### Playwright versions

BrowserStack runs a web session with the Playwright version its client asks for, and only versions
BrowserStack lists. No API lists them, so the plugin carries BrowserStack's list: today Playwright
1.59 to 1.63. When agent-qa's Playwright major.minor is not on the list, every web test on
BrowserStack is refused with kind `version`:

```text
BrowserStack lists Playwright 1.59 to 1.63, not 1.64, so web tests cannot run there yet; run this test here or on another remote.
```

The list moves with each plugin release, which follows agent-qa's version. When BrowserStack adds
a version, a plugin release adds it, and `agent-qa doctor` stops warning.

## Device tests

A device acquire answers `hubUrl` with `bstack:options` holding:

- `userName` and `accessKey`;
- `appiumVersion`: the device's own `bstack:options.appiumVersion`, then `settings.appiumVersion`,
  then the plugin's default, `3.5.2`;
- `projectName`, `buildName` (the run id unless `settings.build` is set) and `sessionName` (the
  test's name);
- `settings.extra`, merged last.

agent-qa adds the device's identity: `model` as `appium:deviceName` and `os` as
`appium:platformVersion`. The device's own `capabilities` are merged over the answer.

## Uploads and reuse

When a target sets `app.ref` (a `bs://` id or an `https` URL), BrowserStack installs that app and
the plugin uploads nothing.

The plugin's `uploadApp` takes the target's `app.path`:

1. it names the content with the custom id `agent-qa-<first 32 hex of the file's SHA-256>`;
2. it asks `GET app-automate/recent_apps/<custom id>` and reuses the newest upload listed there;
3. when nothing is listed, it checks that the file still has the size and SHA-256 agent-qa sent,
   refusing it at path `path` when it changed, then posts the file once to
   `POST app-automate/upload` with that custom id, reporting `uploading app (<n> MB)` and then
   `app uploaded` as progress.

It answers the `bs://` ref the session installs. The same file uploads once, and later runs reuse
it while BrowserStack keeps it, which is 30 days. A cancel stops the upload.

## Links and marks

When a session starts, the plugin returns its dashboard link, BrowserStack's `browser_url`. It needs
a BrowserStack login. The shareable `public_url` is never returned.

- A device session is read by its WebDriver session id from
  `GET app-automate/sessions/<id>.json`.
- A web session is found through the Automate REST API. The plugin lists running builds
  (`GET automate/builds.json`), keeps the build named for the run, lists its running sessions and
  keeps those with the test's name. It then reads each one's details and keeps those whose
  `created_at` is no more than 5 seconds before agent-qa asked for the session. When exactly one
  is left, that is the session. When none or several are left, the test gets no link and the
  session stays unmarked, with one line on the plugin's stderr. A guessed session is never marked.

When the test ends, the plugin marks the session:

| Outcome          | Mark                                             |
| ---------------- | ------------------------------------------------ |
| passed           | `passed`                                         |
| failed           | `failed`, with the reason, cut to 255 characters |
| agent-qa's error | `failed`, with agent-qa's sentence               |
| cancelled        | none                                             |

Marks go to `PUT automate/sessions/<id>.json` for web and `PUT app-automate/sessions/<id>.json`
for devices. A lookup or a mark that fails is one stderr line and never fails the test.

## Failures

| BrowserStack answer   | Kind          |
| --------------------- | ------------- |
| `401`                 | `auth`        |
| `429`                 | `capacity`    |
| no answer             | `unreachable` |
| any other non-success | `refused`     |

Each failure is one line naming the status, the request and BrowserStack's message, with
`retry after` on a `429`. A Playwright version BrowserStack does not list is kind `version`. A
setting or option that is wrong is kind `refused` with its path. A BrowserStack Local tunnel that
cannot start is kind `unreachable` at path `local`.

## Account check

`agent-qa doctor` runs the plugin's `check`, which opens no session:

- `GET automate/plan.json` and `GET app-automate/plan.json` report each product's sessions, for
  example `Automate: 1 of 5 parallel sessions running, 0 queued`.
- A `401` on either warns `the username or access key was refused`.
- A `404` warns that the product is not on the account, for example
  `App Automate is not on this account`.
- When BrowserStack does not list agent-qa's Playwright version, it warns
  `BrowserStack lists Playwright 1.59 to 1.63, not 1.64; web tests on BrowserStack are refused until it does.`

## BrowserStack Local

BrowserStack Local is a tunnel that lets BrowserStack's browsers and devices reach a target only
this machine can reach, such as `localhost` or a staging host behind a VPN.

- `local: true` makes the plugin start its own tunnel on the run's first acquire, with a fresh
  identifier, `agent-qa-<16 hex>`, or with `localIdentifier` when that is set too. The start
  counts against the acquire's deadline, and acquires that arrive while it starts wait for the
  same tunnel. Every web and device session of the run then asks for that tunnel:
  `browserstack.local` and `browserstack.localIdentifier` in the web capabilities, `local` and
  `localIdentifier` in `bstack:options`.
- `localIdentifier` without `local` asks every session for a tunnel that is already running
  under that identifier, and the plugin starts nothing.
- The tunnel comes from BrowserStack's `browserstack-local` package, pinned at `1.5.16`. It finds
  BrowserStack's binary in `~/.browserstack`, the working directory or the temp directory, and
  downloads it from BrowserStack over `https` when none is there. `localBinary` names a binary
  to run instead; it needs `local: true`. When that binary fails, the plugin stops; it never
  deletes the binary or downloads another one.
- The tunnel logs to a fresh file under the temp directory,
  `agent-qa-browserstack-local-<pid>-<random>.log`, readable only by you. Nothing is written to
  the project. When the tunnel cannot start, the refusal has kind `unreachable` at path `local`
  and names that log.
- Before it starts the tunnel, the plugin runs the binary once with `--version` to check that
  this machine can run it. `browserstack-local` downloads BrowserStack's Intel build on every Mac,
  which an Apple Silicon Mac runs only under Rosetta. A binary this machine cannot run refuses
  the session the same way, with kind `unreachable` at path `local`, naming the binary, the fix
  and the log. On macOS the fix is to install Rosetta
  (`softwareupdate --install-rosetta --agree-to-license`) or set `localBinary` to a binary this
  machine can run; on any other system it is to set `localBinary` to a binary this machine can
  run.
- The tunnel runs as a daemon outside the plugin's process group, so the plugin stops it itself:
  on `shutdown`, when agent-qa closes the plugin's stdin and on `SIGTERM`. A tunnel still starting
  then is aborted: the plugin kills the launch and runs the binary's `--daemon stop` for the
  tunnel's identifier, and stops the tunnel too if it connects meanwhile.
- The wrapper's own console output goes to the plugin's stderr, never to the protocol stream.

BrowserStack's tunnel binary takes the access key as `--key` on its command line. That is
BrowserStack's design, and it means other users of the same machine can read the key with `ps`
while the tunnel runs.

## License

FSL-1.1-ALv2. See `LICENSE.md` and `NOTICE.md` in the package.
