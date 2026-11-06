---
name: agent-qa-authoring
description: Use when creating, editing, validating, or running agent-qa tests, suites, or hooks. Prefer agent-qa MCP tools, enforce canonical agent-qa IDs, and use the bundled schema reference to avoid hallucinated config keys or YAML fields.
metadata:
  short-description: Author agent-qa tests safely
---

# agent-qa Authoring

## Workflow

1. Discover the surface from the protocol itself: `tools/list` names every tool, and every caller
   sees and may call the same set. For the full picture — the capability catalog and this
   workspace's posture — run `npx agent-qa init --agent`, which prints one JSON document and writes
   nothing.
2. Read the workspace posture from that same manifest: whether this workspace has a configuration
   that reads. No MCP tool reads configuration.
3. Load `references/agent-qa-contracts.json` when you need exact schema fields or ID contracts.
4. Never mint an ID and never hand-write one. IDs are minted host-side where the entity is written:
   name what you want, then read the id back off the entity card `agent_qa_get_entity` returns.
5. Never validate an ID by hand either. The one URI codec validates every `agentqa://` reference as
   it is parsed, including the one `agent_qa_get_entity` resolves — a reference that comes back
   resolved is a reference that was well-formed.
6. Validate before you write. `agent_qa_refine_test`'s verify arm returns the same verdict that
   gates the write; there is no standalone linter over pasted text, on purpose, because a second
   validator can disagree with the one that gates.
7. Authoring changes apply in the call, and each answer names what it wrote:
   - A new test or suite file: `agent_qa_write_test`, which names the suite file the draft joins and
     writes it unless a keep-gate rejected it. Its `written` receipt names the file it wrote, or why
     none was written, with the draft's disposition and the four keep-gate results: that is how well
     the written test was verified.
     - If it answers `refused` with `statedValueRefusal`, the draft lost a value the request stated
       (a quoted string, number, price or date): show the user its `stage` and each of its
       `missingValues`, and stop. Never reword the request to get past the check; asking again in
       their own words is the user's call.
   - An edit to a test: `agent_qa_refine_test`.
   - A new hook or another configuration change: `agent_qa_change_config`, which writes the change
     and answers the files and fields it changed.
   - Each change is on disk when the call answers; nothing waits for a second call. `git status`
     and `git diff` show what changed, and `git restore` reverts a file.
8. There is no delete verb on any surface, by rule rather than by omission. Removing a test, a suite
   or a hook is a repository edit a person makes.
9. Editing an existing hook has no tool yet: it is an edit to `workspace.hooksFile` in the workspace
   until the owning milestone rules on the verb.
10. Keep file paths matched by `workspace.testMatch` or `workspace.suiteMatch`.

## Required ID Contracts

- Test IDs: `t_` + 10 id-agent words.
- Suite IDs: `s_` + 10 id-agent words.
- Hook IDs: `h_` + 10 id-agent words.
- Run IDs: `r_` + 10 id-agent words.
- Observation IDs: `obs_` + 10 id-agent words.

## Before Running

- Verify the draft first (step 6).
- Start runs with `agent_qa_start_run` rather than shelling out, and name the test files to run
  with `patterns` (paths or globs).
- A run starts in the call, with no prompt.
- `agent_qa_list_runs` enumerates recent runs; `agent_qa_get_run_digest` reports one.

## Secrets

- Only the values in the file `workspace.secretsFile` names are secrets. agent-qa replaces each one
  with `[secret:<name>]` in the text it sends to a model and in the records, logs and output it
  writes, and never restores it.
- To type a secret in a step, write `{{secret:<name>}}`. Never write `[secret:<name>]` in a step: it
  would type the placeholder, so the action is refused.
- Nothing else is masked: not `workspace.envFile` values, environment variables, cookies, saved auth
  state or emails, and not screenshots or recordings. The one exception: the dashboard's model
  connection check keeps the key or header value it is testing out of the provider's error message.
  Use temporary, limited test credentials.

## Remote browsers

A web test can run in a browser agent-qa does not launch: a Playwright server or a CDP (Chrome
DevTools Protocol) endpoint, listed by name under `registry.remotes` in `agent-qa.config.yaml`.

```yaml
registry:
  remotes:
    - name: grid
      protocol: playwright
      url: wss://grid.example.com/playwright
      query:
        token: "{{secret:GRID_TOKEN}}"
```

- `name`: a lowercase slug, unique in the list. `local` is reserved for this machine.
- `protocol`: `playwright` for a Playwright server (`ws://` or `wss://`), or `cdp` for a CDP
  endpoint (`ws://`, `wss://`, `http://` or `https://`; Chromium only).
- `url`: the endpoint, with its scheme, host and port written out. `{{secret:<name>}}` and
  `{{playwright:version}}` may appear only in its path and query, never as `user:password@`.
- `query` (optional): parameters added to the url when agent-qa connects. A value is a string, or
  a nested map sent as JSON.
- `headers` (optional): headers sent when agent-qa connects.
- `basicAuth` (optional): `user` and `password`, the password a `{{secret:<name>}}` reference. Use
  it or an `Authorization` header, not both.
- `connectTimeout` (optional): a duration such as `45s` that bounds the connect only; `5m` by
  default.
- `context` (optional, `cdp` only): `new`, the default, opens agent-qa's own context; `reuse` uses
  the browser's first context.

Credentials:

- Write every credential as a `{{secret:<name>}}` reference to a name in the file
  `workspace.secretsFile` names, quoted in YAML. The strict parse refuses a literal string or
  number under a header or query name that carries a credential word such as `token`, `key`,
  `secret`, `password`, `cookie`, `authorization` or `jwt`: in nested maps, inside a JSON value and
  in the url's own query. Strings and numbers there must be references; `true`, `false` or `null`
  under such a name is accepted.
- A credential goes over `ws://` or `http://` only to this machine; use `wss://` or `https://`.
- A remote's secrets serve its connection only. Steps, expected values, target urls and hooks
  cannot use them.

Picking a remote:

- `use.browser.remote: <name>` picks a remote, and `local` means this machine. Set it under
  `use.browser` in `agent-qa.config.yaml` (the project default), in a suite or in a test.
- The suite's pick wins, then the test's, then the config's; with none, the test runs here. A suite
  runs in one place, so when it names none, its members must agree.
- No run flag or environment variable moves a test; the files decide.
- `agent_qa_change_config` can set `use.browser.remote` but never changes `registry.remotes` or
  `plugins`; a person edits those in the file.

## Devices

A mobile test runs on a device named under `registry.devices` in `agent-qa.config.yaml`: an
Android emulator, a phone plugged into this machine or an iOS simulator, or a device on an Appium
server agent-qa does not start, listed under `registry.remotes` with `protocol: appium`.

```yaml
registry:
  remotes:
    - name: farm
      protocol: appium
      url: https://farm.example.com/wd/hub
      basicAuth:
        user: "{{secret:FARM_USER}}"
        password: "{{secret:FARM_KEY}}"
  devices:
    pixel:
      platform: android
      model: Pixel 8
    iphone:
      platform: ios
      model: iPhone 16
      os: "18.4"
    galaxy-farm:
      platform: android
      remote: farm
      model: Samsung Galaxy S24
      os: "14"
  targets:
    shop-android:
      platform: android
      appPackage: com.example.shop
      device: pixel
      app:
        path: builds/shop.apk
        ref: shop-latest
    shop-ios:
      platform: ios
      bundleId: com.example.shop
      device: iphone
      app:
        path: builds/Shop.app
```

- `platform`: `android` or `ios`.
- `model`: what people call the device, such as `Pixel 8`, `SM-S921B` or `iPhone 16`.
- `os` (optional): the Android or iOS version, written as quoted text such as `os: "17.10"`. YAML
  reads an unquoted `17.10` as the number 17.1, so a number is refused.
- `id` (optional): an Android serial or a simulator udid. Set it only when two identical units are
  attached at once; it is the one place a machine id appears.
- `remote` (optional): the name of a `registry.remotes` entry with `protocol: appium`. A device
  with no remote runs on this machine.
- `capabilities` (optional): Appium capabilities, merged after agent-qa's own and then the
  remote's `capabilities`. Maps merge key by key, and `null` removes a key. A key carries a
  prefix such as `appium:` unless it is a W3C one such as `platformName` or `browserName`. The
  driver (`appium:automationName`) and a mobile browser (`browserName`) go here.
- App ids (`appPackage`, `appActivity`, `bundleId`) live on the target, never on the device.

Capabilities:

- Write every credential as a `{{secret:<name>}}` reference, quoted in YAML. The strict parse
  refuses a literal under a capability name that carries a credential word, at any depth.
  `appium:keystorePath`, `appium:keyAlias` and `appium:sendKeyStrategy` are settings, not
  credentials; `appium:keystorePassword` and `appium:keyPassword` are credentials.
- Secrets in a device's `capabilities` or a target's app `ref` serve the connection only. Steps,
  expected values, target urls and hooks cannot use them.
- A capability that contradicts the device or its target is refused before the session opens,
  with one line naming both places: `platformName` or a driver for the other platform;
  `appium:deviceName`, `appium:platformVersion` or `appium:udid` against `model`, `os` or `id`;
  `appium:appPackage`, `appium:appActivity` or `appium:bundleId` against the target; and
  `appium:noReset` or `appium:fullReset` against `use.mobile.appState`.

Finding a device on this machine:

- iOS: a simulator whose name is the `model`, on `os` when set. A plugged-in iPhone is never used.
- Android: a phone by the model it reports (`adb devices -l` prints `model:SM_S921B`), or an
  emulator or AVD by its AVD name or its device profile.
- Case is ignored, and spaces, `_` and `-` count as the same. `os: "18"` matches 18.2.
- When several match, the newest OS wins, then a running one; if that still leaves more than one,
  the test is refused and `id` picks one. With no `model`, the one running device of that platform
  is used.
- A matching simulator or AVD that is not running is started; agent-qa never creates one. When
  nothing matches, the test is refused before it starts with one line listing what this machine
  has.
- `npx agent-qa devices` shows each device and what this machine has (attached phones with their
  model, AVDs and simulators), so you can copy the `model` to write. A device on a remote shows
  the remote's name and origin, or its name and plugins entry.
  `npx agent-qa devices list --json` prints the same as JSON.

Picking a device:

- A mobile target names its default device with `device`. Its `app` holds `path`, the file
  installed on devices here, and `ref`, what a remote server installs.
- A test runs on `--device`, else the `device` under its own `use`, else its target's `device`. A
  suite runs on one device: `--device`, else the `device` under the suite's `use`, else the one
  device its members agree on. That `device` goes under `use` in a suite or test, never in
  `agent-qa.config.yaml`.
- `--device` picks devices on this machine only; naming a device that has a `remote` is refused.
  To send a test to a remote device, set `device` under `use` in its suite or test.
- `AGENT_QA_APPIUM_URL` names your own Appium on this machine, for devices without a remote. A host
  other than loopback is refused: list that server under `registry.remotes` instead. Without it,
  a device here uses the dashboard's Appium or the one agent-qa starts. A device with a `remote`
  always uses its remote, and agent-qa starts no Appium for it.

On a remote Appium server:

- `model` is sent as `appium:deviceName` and `os` as `appium:platformVersion`, both unread, so the
  server's own matching applies; `id` is sent as `appium:udid`. For a server that selects devices
  another way, leave `model` out and set its own key in `capabilities`, as you do for its real or
  virtual device flag.
- The target's app `ref`, an https URL or the server's own reference, is sent as `appium:app`; an
  `appium:app` in the device's or remote's capabilities wins. agent-qa itself uploads no app, so
  a remote device whose target's `app` has only a `path` is refused.
- Android emulators and devices and iOS simulators are proven by agent-qa's own tests. Real
  iPhones behind a remote server work through capabilities and are not proven by agent-qa's tests.
- `agent_qa_change_config` never changes a device's `remote` or `capabilities` or a target's app
  `ref`; a person edits those in the file.

## Do Not

- Do not invent config keys.
- Do not use legacy root config buckets.
- Do not hand-write IDs.
- Do not mutate files outside the configured workspace patterns.
