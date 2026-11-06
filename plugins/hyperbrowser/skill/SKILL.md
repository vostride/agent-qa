---
name: agent-qa-plugin-hyperbrowser
description: Use when configuring agent-qa web tests to run in Hyperbrowser cloud browsers through the Hyperbrowser plugin, or when a Hyperbrowser remote is refused.
---

# Hyperbrowser remotes for agent-qa

The Hyperbrowser plugin gives an agent-qa web test a Hyperbrowser browser session. Before the test
connects it creates a session through Hyperbrowser's API, and after the test it stops the session.
Hyperbrowser runs Chromium only. Stealth, proxies, CAPTCHA solving, ad, tracker and annoyance
blocking and cookie auto-accept are off unless a setting turns them on, so a test sees the app the
way its users do.

## Declare the plugin and a remote

```yaml
plugins:
  - name: hyperbrowser
    package: "@vostride/agent-qa-plugin-hyperbrowser"
    options:
      apiKey: "{{secret:HYPERBROWSER_API_KEY}}"

registry:
  remotes:
    - name: hyperbrowser
      plugin: hyperbrowser
    - name: hyperbrowser-unrecorded
      plugin: hyperbrowser
      settings:
        recording: false
```

- The `plugins` entry holds the account: `apiKey`, which is required, and `apiUrl`, which defaults
  to `https://api.hyperbrowser.ai`. Write the key as a `{{secret:<name>}}` reference to a name in
  the file `workspace.secretsFile` names. Never write the key itself in the config.
- The remote holds one place: `plugin` names the `plugins` entry, and `settings` hold that place's
  Hyperbrowser settings.
- `use.browser.remote: hyperbrowser` in the config, a suite or a test runs the test there.
- Install the package at the exact version of agent-qa the project runs:
  `npm install --save-dev --save-exact @vostride/agent-qa-plugin-hyperbrowser@<agent-qa version>`.
  `agent-qa plugins list` prints that line when the package is missing or the version differs.

## Settings

- `timeoutMinutes` (default `720`, 1 to 720): minutes before Hyperbrowser stops the session. It
  overrides the team default in Hyperbrowser's settings. The plugin never asks for keep-alive, so
  Hyperbrowser also stops a session whose connection drops, and agent-qa stops every session after
  its test.
- `recording` (unset by default): Hyperbrowser's web recording. Unset keeps the account's default,
  which records. `recording: false` turns it off.
- `stealth`, `solveCaptchas`, `adblock`, `trackers`, `annoyances`, `acceptCookies` (each default
  `false`): Hyperbrowser's stealth mode, CAPTCHA solving, ad, tracker and annoyance blocking and
  automatic acceptance of cookie banners.
- `proxy` (default `false`): `true`, or `{ country, state, city }` with any of the three. Proxies
  and CAPTCHA solving need a paid Hyperbrowser plan.
- `screen` (`{ width, height }` in pixels), `region` (for example `us-east` or `europe-west`),
  `extensions` (extension ids): Hyperbrowser's own create fields, sent only when set.
- `profile`: a Hyperbrowser profile id. It loads read-only: nothing the test does is saved back. It
  needs `context: reuse` on the remote, because the profile lives in the browser's first context:

  ```yaml
  - name: hyperbrowser-signed-in
    plugin: hyperbrowser
    context: reuse
    settings:
      profile: <Hyperbrowser profile id>
  ```

- `extra`: any other Hyperbrowser request field. It is merged last, so it overrides the settings
  above. Video replay is `extra: { enableVideoWebRecording: true }`, and needs recording on.
  Enterprise proxy servers go here as `proxyServer`, `proxyServerUsername` and
  `proxyServerPassword`; write the password as a `{{secret:<name>}}` reference.

## When a remote is refused

- `auth`: Hyperbrowser refused the API key. Check the secret's value.
- `capacity`: Hyperbrowser answered 429. The account has no free sessions, or is rate limited.
  Wait, or lower the run's concurrency.
- `refused` with `Hyperbrowser answered 403 to POST /api/session: <reason>`: a feature the remote
  turns on is not on the plan, for example `Proxy usage requires a paid plan`. Turn that setting
  off, or change the plan.
- `refused` with path `settings.profile`: the remote sets `profile` without `context: reuse`. Add
  `context: reuse` to the remote.
- `refused` with path `settings.timeoutMinutes`: the lifetime is outside 1 to 720. Set a value in
  that range, or leave it out for 720.
- `refused` naming a browser or platform: Hyperbrowser runs Chromium web tests only. Use
  `use.browser.name: chromium`, or another remote.
- `refused` at `options.apiUrl`: the endpoint must use `https://` with no user or password, unless
  it points at this machine.
- `unreachable`: Hyperbrowser could not be reached. Check the network and `apiUrl`.

## Recording

Hyperbrowser records sessions by default and keeps the replay on its dashboard, behind its login.
agent-qa's masking does not reach that replay, so a secret a test types may show in it. Set
`recording: false` on the remote to turn recording off. The session link opens the session's page
in Hyperbrowser's dashboard. Hyperbrowser's live view URL and the session token let anyone who has
them watch and drive the session, so agent-qa masks both and never shows them as the link.

## Check and describe

- `agent-qa doctor` runs the plugin's account check. It reads the active sessions to prove the key,
  reports how many there are, and opens none.
- `agent-qa plugins describe hyperbrowser --json` lists every option and setting with its type,
  default and description.
