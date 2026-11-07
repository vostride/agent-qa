# @vostride/agent-qa-plugin-kernel

The agent-qa plugin for [Kernel](https://www.kernel.sh) cloud browsers. Before a web test connects,
it creates a Kernel browser or takes one from a browser pool, and answers agent-qa with the
browser's CDP URL. After the test it deletes the browser, or returns it to the pool. Kernel runs
Chromium only.

## Install

Add the plugin from the project's folder:

```bash
npx agent-qa plugins add @vostride/agent-qa-plugin-kernel
```

It installs the plugin at the version of agent-qa the project runs, through the project's package
manager, and adds its `plugins` entry. `agent-qa plugins list` prints this line when the package is
missing or its version differs from agent-qa's.

## Configure

```yaml
plugins:
  - name: kernel
    package: "@vostride/agent-qa-plugin-kernel"
    options:
      apiKey: "{{secret:KERNEL_API_KEY}}"

registry:
  remotes:
    - name: kernel
      plugin: kernel
      settings:
        headless: true
        timeoutSeconds: 60
```

A test runs there with `use.browser.remote: kernel` in the config, a suite or the test.

### Options

Options belong to the `plugins` entry and describe the account.

| Option   | Default                    | Meaning                                                                                          |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `apiKey` | required                   | The Kernel API key, a credential. Write it as a `{{secret:<name>}}` reference.                   |
| `apiUrl` | `https://api.onkernel.com` | Kernel's API. It must use `https://` with no user or password, unless it points at this machine. |

The key is sent only as the `Authorization: Bearer` header. It never appears in a message, a log or
an answer.

### Settings

Settings belong to each remote and describe one place.

| Setting          | Default | Meaning                                                                                |
| ---------------- | ------- | -------------------------------------------------------------------------------------- |
| `headless`       | `true`  | `false` gives a headful browser. Kernel's own default is headful.                      |
| `timeoutSeconds` | `60`    | Seconds Kernel keeps the browser after agent-qa's connection drops (10 to 259200).     |
| `stealth`        | -       | Kernel's stealth mode.                                                                 |
| `region`         | -       | The Kernel region, for example `eu-west`.                                              |
| `proxy`          | -       | Kernel's proxy object, sent as given.                                                  |
| `viewport`       | -       | `width`, `height` and optional `refreshRate`, sent as `refresh_rate`.                  |
| `pool`           | -       | A browser pool's id or name to acquire from instead of creating a browser.             |
| `profile`        | -       | A profile's name, or `{ id: <profile id> }`, loaded read-only. Needs `context: reuse`. |
| `extra`          | -       | Any other Kernel request field, merged last.                                           |

`agent-qa plugins describe kernel` prints the same tables from the schemas the package ships, and
`--json` prints them as JSON.

## How the request body is built

The create request (`POST /browsers`) is built in three layers, each overriding the one before:

1. the defaults: `headless: true` and `timeout_seconds: 60`;
2. the curated settings above, in Kernel's field names (`timeoutSeconds` becomes
   `timeout_seconds`, `viewport.refreshRate` becomes `viewport.refresh_rate`, and `profile`
   becomes `profile: { name | id, save_changes: false }`);
3. `extra`, last, so a pass-through key overrides both a default and a curated setting.

For example, `settings: { headless: true, extra: { headless: false, kiosk_mode: true } }` creates a
headful browser in kiosk mode.

## Pools

With `pool`, the plugin acquires a browser with `POST /browser_pools/{pool}/acquire`. Kernel holds
that request open while the pool is empty and answers `204` when it times out. The plugin then asks
again, and reports `waiting for pool <pool>` to agent-qa after each `204`. Asks are at least a
second apart, so a short `acquire_timeout_seconds` in `extra` does not become a busy loop. The wait
ends when a browser is free or when agent-qa cancels it at the remote's `connectTimeout`.

- The acquire body holds only `profile` and `extra`. The pool's own configuration sets the browser,
  so `stealth`, `region`, `proxy` and `viewport` are refused on a remote with `pool`, and
  `headless` and `timeoutSeconds` do not apply.
- On release the plugin posts `{ session_id, reuse }` to `POST /browser_pools/{pool}/release`.
  `reuse` is `true` after a test in a new context, so the browser goes back to the pool. It is
  `false` after a test with `context: reuse`, so the browser is discarded.
- A browser the pool no longer has counts as released.

## Profiles

`profile` loads a Kernel profile with `save_changes: false`, so nothing a test does is saved back.
A profile lives in the browser's first context, so the remote needs `context: reuse`. Without it,
the remote is refused with kind `refused` and path `settings.profile`. With `pool`, the profile goes
into the acquire body, and Kernel discards such a browser after use.

## Failures

| Kernel answer         | Kind          |
| --------------------- | ------------- |
| `401`, `403`          | `auth`        |
| `429`, `529`          | `capacity`    |
| no answer             | `unreachable` |
| any other non-success | `refused`     |

Each failure is one line naming the status, the request and Kernel's message, with `Retry-After`
on a `429`. A browser that is already gone when the plugin deletes it counts as released.

## Links and the live view

Kernel documents no per-session page, so the plugin returns no session link. A headful browser's
live view URL carries a token, so it is a credential: the plugin adds it, with the CDP URL, to the
values agent-qa masks, and never returns it as a link.

## Account check

`agent-qa doctor` runs the plugin's `check`, which creates no browser:

- `GET /browsers?limit=1` proves the key. A refused key warns `the API key was refused`.
- `GET /org/limits` reports free sessions, for example `3 of 5 concurrent sessions free`. A key
  that may not read them reads `organization limits not readable with this key`, which does not
  warn.
- `GET /browser_pools/{pool}` for each pool a remote names reads `pool <pool> found`, or warns
  `pool <pool> not found`.

## License

FSL-1.1-ALv2. See `LICENSE.md` and `NOTICE.md` in the package.
