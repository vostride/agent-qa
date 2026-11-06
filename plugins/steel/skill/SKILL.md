---
name: agent-qa-plugin-steel
description: Use when configuring agent-qa web tests to run in Steel cloud browsers through the Steel plugin, or when a Steel remote is refused.
---

# Steel remotes for agent-qa

The Steel plugin gives an agent-qa web test a Steel browser session. Before the test connects it
creates a session through Steel's API, and after the test it releases the session. Steel runs
Chromium only. CAPTCHA solving, ad blocking, Steel's proxies and Steel's fingerprint injection are
off unless a setting turns them on, so a test sees the app the way its users do.

## Declare the plugin and a remote

```yaml
plugins:
  - name: steel
    package: "@vostride/agent-qa-plugin-steel"
    options:
      apiKey: "{{secret:STEEL_API_KEY}}"

registry:
  remotes:
    - name: steel
      plugin: steel
      settings:
        idleMinutes: 5
```

- The `plugins` entry holds the account: `apiKey`, and `apiUrl`, which defaults to
  `https://api.steel.dev`. Write the key as a `{{secret:<name>}}` reference to a name in the file
  `workspace.secretsFile` names. Never write the key itself in the config.
- The remote holds one place: `plugin` names the `plugins` entry, and `settings` hold that place's
  Steel settings.
- `use.browser.remote: steel` in the config, a suite or a test runs the test there.
- Install the package at the exact version of agent-qa the project runs:
  `npm install --save-dev --save-exact @vostride/agent-qa-plugin-steel@<agent-qa version>`.
  `agent-qa plugins list` prints that line when the package is missing or the version differs.
- For a self-hosted steel-browser, set `apiUrl` to its loopback `http://` address, leave out
  `apiKey`, and set `use.workers: 1`: it serves one session at a time, and releasing one ends
  whatever session is active. It returns no session link.

## Settings

- `timeoutMinutes` (default `1440`, 1 to 1440): minutes before Steel ends the session. Steel's
  plans cap it: Launch at 15, Scale at 60, Enterprise at up to 1440.
- `idleMinutes` (default `5`, 1 to 60): minutes with no CDP command before Steel ends the session.
  agent-qa's heartbeat keeps a running test from going idle.
- `solveCaptcha` (default `false`), `blockAds` (default `false`): Steel's CAPTCHA solving and ad
  blocking.
- `fingerprint` (default `false`): Steel's fingerprint injection. The plugin always tells Steel to
  skip it unless this is `true`.
- `proxy` (default `false`): `true`, or Steel's proxy object, sent as `useProxy`.
- `proxyUrl`: your own proxy, `http(s)://user:password@host:port`, a credential. Write it as a
  `{{secret:<name>}}` reference. It is sent instead of Steel's proxy, so do not also set `proxy`.
- `dimensions` (`{ width, height }`), `region` (for example `us-east`), `extensions` (extension
  ids): Steel's own create fields.
- `profile`: a Steel profile id. It loads read-only: nothing the test does is saved back. It needs
  `context: reuse` on the remote, because the profile lives in the browser's first context:

  ```yaml
  - name: steel-signed-in
    plugin: steel
    context: reuse
    settings:
      profile: <Steel profile id>
  ```

- `extra`: any other Steel request field. It is merged last, so it overrides the settings above.

## When a remote is refused

- `auth`: Steel refused the API key. Check the secret's value.
- `capacity`: Steel answered 429. The account has no free sessions, or is rate limited. Wait, or
  lower the run's concurrency.
- `refused` whose line ends `set settings.timeoutMinutes to the cap`: Steel refused the create with
  `400` or `422`, and its reason may be the plan capping sessions below the lifetime asked for. Set
  `timeoutMinutes` to the plan's cap, for example `15` on Launch. A `400` or `422` whose reason
  names another field ends without this, so fix the field it names.
- `refused` with path `settings.profile`: the remote sets `profile` without `context: reuse`. Add
  `context: reuse` to the remote.
- `refused` with path `settings.proxyUrl`: the remote sets both `proxy` and `proxyUrl`. Keep one.
- `refused` naming a browser or platform: Steel runs Chromium web tests only. Use
  `use.browser.name: chromium`, or another remote.
- `refused` with `Unrecognized key: "recording"`: Steel has no switch to turn recording off, so
  the plugin has no `recording` setting. Remove it.
- `refused` at `options.apiUrl`: the endpoint must use `https://` with no user or password, unless
  it points at this machine.
- `unreachable`: Steel could not be reached. Check the network, or that a self-hosted
  steel-browser is running.

## Recording

Steel records every session and keeps the replay on its dashboard, behind its login. agent-qa's
masking does not reach that replay, so a secret a test types may show in it. Steel offers no switch
to turn recording off. The session link opens the session's page in Steel's dashboard. Steel's
debug URL lets anyone who has it drive the session, so agent-qa masks it and never shows it.

## Check and describe

- `agent-qa doctor` runs the plugin's account check. It lists sessions to prove the key and opens
  none.
- `agent-qa plugins describe steel --json` lists every option and setting with its type, default
  and description.
