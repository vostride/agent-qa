# @vostride/agent-qa-plugin-hyperbrowser

The agent-qa plugin for [Hyperbrowser](https://hyperbrowser.ai) cloud browsers. Before a web test
connects, it creates a Hyperbrowser session and answers agent-qa with the session's CDP URL, and
after the test it stops the session. Hyperbrowser runs Chromium only.

## Install

Add the plugin from the project's folder:

```bash
npx agent-qa plugins add @vostride/agent-qa-plugin-hyperbrowser
```

It installs the plugin at the version of agent-qa the project runs, through the project's package
manager, and adds its `plugins` entry. `agent-qa plugins list` prints this line when the package is
missing or its version differs from agent-qa's.

## Configure

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

A test runs there with `use.browser.remote: hyperbrowser` in the config, a suite or the test.

### Options

Options belong to the `plugins` entry and describe the account.

| Option   | Default                       | Meaning                                                                                                |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apiKey` | -                             | The Hyperbrowser API key, a credential, required. Write it as a `{{secret:<name>}}` reference.         |
| `apiUrl` | `https://api.hyperbrowser.ai` | Hyperbrowser's API. It must use `https://` with no user or password, unless it points at this machine. |

The key is sent only as the `x-api-key` header. It never appears in a message, a log or a check
line.

### Settings

Settings belong to each remote and describe one place.

| Setting          | Default | Meaning                                                                                                                                                                        |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timeoutMinutes` | `720`   | Minutes before Hyperbrowser stops the session (1 to 720), always sent as `timeoutMinutes`. It overrides the team default in Hyperbrowser's settings.                           |
| `recording`      | -       | Hyperbrowser's web recording, sent as `enableWebRecording` when set. Unset keeps the account's default, which records. `false` turns it off.                                   |
| `stealth`        | `false` | Hyperbrowser's stealth mode, sent as `useStealth`.                                                                                                                             |
| `proxy`          | `false` | Hyperbrowser's proxy: `true`, or `{ country, state, city }` with any of the three. Sent as `useProxy`, with `proxyCountry`, `proxyState` and `proxyCity` for the fields given. |
| `solveCaptchas`  | `false` | Hyperbrowser's CAPTCHA solving, sent as `solveCaptchas`.                                                                                                                       |
| `adblock`        | `false` | Hyperbrowser's ad blocking, sent as `adblock`.                                                                                                                                 |
| `trackers`       | `false` | Hyperbrowser's tracker blocking, sent as `trackers`.                                                                                                                           |
| `annoyances`     | `false` | Hyperbrowser's annoyance blocking, sent as `annoyances`.                                                                                                                       |
| `acceptCookies`  | `false` | Hyperbrowser's automatic acceptance of cookie banners, sent as `acceptCookies`.                                                                                                |
| `screen`         | -       | The browser screen, `{ width, height }` in pixels, sent as `screen`. Unset keeps Hyperbrowser's default.                                                                       |
| `region`         | -       | The Hyperbrowser region, for example `us-east` or `europe-west`, sent as `region`.                                                                                             |
| `profile`        | -       | A Hyperbrowser profile id, loaded read-only and sent as `profile: { id, persistChanges: false }`. Needs `context: reuse`.                                                      |
| `extensions`     | -       | Hyperbrowser extension ids loaded into the browser, sent as `extensionIds`.                                                                                                    |
| `extra`          | -       | Any other Hyperbrowser request field, merged last.                                                                                                                             |

`agent-qa plugins describe hyperbrowser` prints the same tables from the schemas the package ships,
and `--json` prints them as JSON.

## How the request body is built

The create request (`POST /api/session`) is built in this order, each part overriding the one
before:

1. the lifetime, `timeoutMinutes`;
2. the features that change the page: stealth, proxies, CAPTCHA solving, ad, tracker and annoyance
   blocking and cookie auto-accept. Each is sent off unless a setting turns it on, because a test
   should see the app the way its users do;
3. the proxy fields: `proxy: true` sends `useProxy: true`, and a proxy object also sends
   `proxyCountry`, `proxyState` and `proxyCity` for the fields it gives;
4. the other settings above, in Hyperbrowser's field names, each only when it is set;
5. `extra`, last, so a pass-through key overrides both a default and a setting.

For example, `settings: { extra: { useUltraStealth: true } }` asks for Hyperbrowser's Enterprise
stealth mode. Hyperbrowser's own proxy servers for Enterprise accounts go through `extra` too.
agent-qa refuses a password there unless it is a `{{secret:<name>}}` reference:

```yaml
settings:
  extra:
    proxyServer: "http://proxy.example.com:8080"
    proxyServerUsername: "<proxy user>"
    proxyServerPassword: "{{secret:HYPERBROWSER_PROXY_PASSWORD}}"
```

Proxies and CAPTCHA solving need a paid Hyperbrowser plan. When a feature is not on the plan,
Hyperbrowser refuses the create, as described under Failures.

## Lifetime and disconnects

By default the plugin asks for a 720-minute session, the longest Hyperbrowser allows.
`timeoutMinutes` lowers it; a value outside 1 to 720 is refused with path
`settings.timeoutMinutes` before any session is created.

The plugin never asks Hyperbrowser for keep-alive, so Hyperbrowser stops a session whose connection
drops. A session left behind by a killed job, where agent-qa and the plugin die together, stops
when its connection does. A session whose create was still in flight when the job was killed was
never connected and has no idle timeout, so it runs until `timeoutMinutes`; lower
`timeoutMinutes` to bound it. agent-qa also stops every session itself after the test; the
lifetime only bounds a session that agent-qa could not stop.

## Recording

Hyperbrowser records sessions by default and keeps the replay on its dashboard, behind its login.
agent-qa's masking does not reach that replay, so a secret a test types may show in it. Set
`recording: false` on a remote to turn recording off for its sessions:

```yaml
registry:
  remotes:
    - name: hyperbrowser-unrecorded
      plugin: hyperbrowser
      settings:
        recording: false
```

Video replay is off unless you ask for it with `extra: { enableVideoWebRecording: true }`. It needs
web recording, so do not combine it with `recording: false`.

## Profiles

`profile` loads a Hyperbrowser profile by id, and the plugin sends `persistChanges: false`, so
nothing a test does is saved back. A profile lives in the browser's first context, so the remote
needs `context: reuse`. Without it, the remote is refused with kind `refused` and path
`settings.profile`.

## Failures

| Hyperbrowser answer   | Kind          |
| --------------------- | ------------- |
| no answer             | `unreachable` |
| `401`                 | `auth`        |
| `429`                 | `capacity`    |
| any other non-success | `refused`     |

Each failure is one line naming the status, the request and Hyperbrowser's reason, with the
`Retry-After` wait on a `429`. A `403` most often means a feature is not on the plan, for example
`Hyperbrowser answered 403 to POST /api/session: Proxy usage requires a paid plan`; turn the
setting off or change the plan.

Hyperbrowser chooses the session id, so a create that fails has no session to stop. When
Hyperbrowser answers a session without a `wsEndpoint`, the remote is refused and agent-qa stops
the session by the id it answered.

On release, `2xx` and `404` both count as stopped, so stopping a session Hyperbrowser already
stopped after a disconnect succeeds.

## Links and the live view

The session link is the session's page in Hyperbrowser's dashboard, which sits behind
Hyperbrowser's login and shows the replay. The plugin returns it only when it is an `https://` URL.

Hyperbrowser's live view URL and the session token let anyone who has them watch and drive the
session, so both are credentials: the plugin adds them, with the CDP URL, to the values agent-qa
masks, and never returns either as the link.

## Account check

`agent-qa doctor` runs the plugin's `check`, which reads the active sessions with
`GET /api/sessions?status=active&page=1` and opens none:

- An accepted key reads `the API key was accepted`, followed by the number of active sessions
  when Hyperbrowser gives it, for example `2 active sessions`.
- A refused key warns `the API key was refused`.
- Any other failure warns with its one line, for example
  `Hyperbrowser could not be reached at <apiUrl>`.

## License

FSL-1.1-ALv2. See `LICENSE.md` and `NOTICE.md` in the package.
