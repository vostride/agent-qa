# @vostride/agent-qa-plugin-steel

The agent-qa plugin for [Steel](https://steel.dev) cloud browsers. Before a web test connects, it
creates a Steel session and answers agent-qa with the session's CDP URL, and after the test it
releases the session. Steel runs Chromium only.

## Install

Install the plugin at exactly the version of agent-qa the project runs:

```bash
npm install --save-dev --save-exact @vostride/agent-qa-plugin-steel@<agent-qa version>
```

`agent-qa plugins list` prints this line, with the version filled in, when the package is missing
or its version differs from agent-qa's.

## Configure

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

A test runs there with `use.browser.remote: steel` in the config, a suite or the test.

### Options

Options belong to the `plugins` entry and describe the account.

| Option   | Default                 | Meaning                                                                                                                     |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apiKey` | -                       | The Steel API key, a credential. Write it as a `{{secret:<name>}}` reference. Leave it out for a self-hosted steel-browser. |
| `apiUrl` | `https://api.steel.dev` | Steel's API. It must use `https://` with no user or password, unless it points at this machine.                             |

The key is sent as the `steel-api-key` header and in the connect URL agent-qa receives, which
agent-qa masks. It never appears in a message, a log or a check line.

### Settings

Settings belong to each remote and describe one place.

| Setting          | Default | Meaning                                                                                                                 |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `timeoutMinutes` | `1440`  | Minutes before Steel ends the session (1 to 1440), sent as `timeout` in milliseconds. Your Steel plan may cap it lower. |
| `idleMinutes`    | `5`     | Minutes with no CDP command before Steel ends the session (1 to 60), sent as `inactivityTimeout` in milliseconds.       |
| `solveCaptcha`   | `false` | Steel's CAPTCHA solving, sent as `solveCaptcha`.                                                                        |
| `blockAds`       | `false` | Steel's ad blocking, sent as `blockAds`.                                                                                |
| `fingerprint`    | `false` | Steel's browser fingerprint injection, sent as `stealthConfig.skipFingerprintInjection`, the opposite value.            |
| `proxy`          | `false` | Steel's proxy: `true`, or Steel's proxy object. Sent as `useProxy`.                                                     |
| `proxyUrl`       | -       | Your own proxy, `http(s)://user:password@host:port`, a credential. Sent as `proxyUrl` instead of Steel's proxy.         |
| `dimensions`     | -       | The browser window, `{ width, height }` in pixels, sent as `dimensions`.                                                |
| `region`         | -       | The Steel region, for example `us-east`, sent as `region`.                                                              |
| `profile`        | -       | A Steel profile id, loaded read-only and sent as `profileId`. Needs `context: reuse`.                                   |
| `extensions`     | -       | Steel extension ids loaded into the browser, sent as `extensionIds`.                                                    |
| `extra`          | -       | Any other Steel request field, merged last.                                                                             |

`agent-qa plugins describe steel` prints the same tables from the schemas the package ships, and
`--json` prints them as JSON.

## How the request body is built

The create request (`POST /v1/sessions`) is built in this order, each part overriding the one
before:

1. `sessionId`, a UUID the plugin chooses, so it can release the session even when the create
   answer never arrives;
2. the lifetimes, `timeout` and `inactivityTimeout`, from `timeoutMinutes` and `idleMinutes`;
3. the features that change the page: CAPTCHA solving, ad blocking, Steel's fingerprint injection
   and Steel's proxies. Each is sent off unless a setting turns it on, because a test should see
   the app the way its users do. Steel injects fingerprints unless it is told not to, so the plugin
   always tells it, with `stealthConfig: { skipFingerprintInjection: true }` by default;
4. the other settings above, in Steel's field names. With `proxyUrl` the plugin sends your proxy
   and no `useProxy`. A remote that sets both `proxyUrl` and `proxy` is refused with path
   `settings.proxyUrl`;
5. `extra`, last, so a pass-through key overrides both a default and a setting.

For example, `settings: { extra: { solveCaptcha: true, headless: true } }` turns CAPTCHA solving on
and asks for a headless browser.

## Lifetime

By default the plugin asks for a 1440-minute session that ends after 5 idle minutes.

- Steel's plans cap the session lifetime: Launch at 15 minutes, Scale at 60 minutes and Enterprise
  at up to 1440 minutes. When Steel refuses the create with `400` or `422` while more than 15
  minutes were asked for, and its reason mentions a timeout, lifetime, duration, minutes, plan or
  limit, or gives no reason, the failure line ends
  `if your Steel plan caps sessions below <n> minutes, set settings.timeoutMinutes to the cap`.
  Set `timeoutMinutes` to your plan's cap. A refusal whose reason is about another field does not
  name `timeoutMinutes`.
- When Steel grants a shorter session than was asked for, the plugin writes
  `Steel granted a <n>-minute session; <m> minutes were asked for` to its log.
- Any CDP command resets the idle time. agent-qa's heartbeat keeps a running test from going idle.
- A session left behind by a killed job, where agent-qa and the plugin die together, ends within
  the idle time, so it stops billing within minutes.

agent-qa releases every session itself after the test; the lifetimes only bound a session that
agent-qa could not release.

## Recording

Steel records every session and keeps the replay on its dashboard, behind its login. agent-qa's
masking does not reach that replay, so a secret a test types may show in it. Steel offers no switch
to turn recording off, so the plugin has no `recording` setting, and a remote that sets one is
refused.

## Profiles

`profile` loads a Steel profile by id, and the plugin never asks Steel to persist it, so nothing a
test does is saved back. A profile lives in the browser's first context, so the remote needs
`context: reuse`. Without it, the remote is refused with kind `refused` and path
`settings.profile`.

## Self-hosted steel-browser

The plugin also drives a self-hosted [steel-browser](https://github.com/steel-dev/steel-browser):

```yaml
plugins:
  - name: steel-local
    package: "@vostride/agent-qa-plugin-steel"
    options:
      apiUrl: "http://localhost:3000"

registry:
  remotes:
    - name: steel-local
      plugin: steel-local

use:
  workers: 1
```

- Point `apiUrl` at it. Plain `http://` is allowed only for this machine.
- Leave out `apiKey`; the plugin then sends no key.
- Set `use.workers: 1`. A steel-browser serves one session at a time, and releasing a session ends
  whatever session is active, so two tests at once would end each other's browser.
- Its session page is plain `http://`, so the plugin returns no link for it.

## Failures

| Steel answer          | Kind          |
| --------------------- | ------------- |
| no answer             | `unreachable` |
| `401`                 | `auth`        |
| `429`                 | `capacity`    |
| any other non-success | `refused`     |

Each failure is one line naming the status, the request and Steel's message, with `Retry-After` on
a `429`. A create refused with `400` or `422` may also name `settings.timeoutMinutes`, as above.

A create Steel refuses with a `4xx` made no session, so it carries no handle and nothing is
released. Every other create failure (no answer, a `5xx`, or an answer the plugin cannot read)
carries the session's id, so agent-qa releases whatever Steel may have made.

On release, `2xx` and `404` both count as released. On any other answer the plugin reads the
session back, and counts it released when Steel no longer has it or no longer reports it live.

## Links and the debug URL

The session link is the session's page in Steel's dashboard, which sits behind Steel's login and
shows the replay. Steel's debug URL lets anyone who has it watch and drive the session, so it is a
credential: the plugin adds it, with the connect URL, to the values agent-qa masks, and never
returns it as the link.

## Account check

`agent-qa doctor` runs the plugin's `check`, which lists sessions with `GET /v1/sessions` and opens
none:

- An accepted key reads `the API key was accepted`.
- Without `apiKey`, a steel-browser that answers reads `Steel answered without an API key`, and a
  Steel that asks for a key warns `Steel asked for an API key; set options.apiKey`.
- A refused key warns `the API key was refused`.
- Any other failure warns with its one line, for example
  `Steel could not be reached at <apiUrl>`.

## License

FSL-1.1-ALv2. See `LICENSE.md` and `NOTICE.md` in the package.
