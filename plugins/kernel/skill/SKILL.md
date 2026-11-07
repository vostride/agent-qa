---
name: agent-qa-plugin-kernel
description: Use when configuring agent-qa web tests to run in Kernel cloud browsers through the Kernel plugin, or when a Kernel remote is refused.
---

# Kernel remotes for agent-qa

The Kernel plugin gives an agent-qa web test a Kernel cloud browser. Before the test connects it
creates a browser, or takes one from a browser pool. After the test it deletes the browser, or
returns it to the pool. Kernel runs Chromium only.

## Declare the plugin and a remote

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

- The `plugins` entry holds the account: `apiKey`, and `apiUrl`, which defaults to Kernel's API.
  Write the key as a `{{secret:<name>}}` reference to a name in the file `workspace.secretsFile`
  names. Never write the key itself in the config.
- The remote holds one place: `plugin` names the `plugins` entry, and `settings` hold that place's
  Kernel settings.
- `use.browser.remote: kernel` in the config, a suite or a test runs the test there.
- Add the plugin with `npx agent-qa plugins add @vostride/agent-qa-plugin-kernel`: it pins the
  package at the project's agent-qa version and writes the `plugins` entry. `agent-qa plugins list`
  prints that line when the package is missing or the version differs.

## Settings

- `headless` (default `true`): `false` gives a headful browser.
- `timeoutSeconds` (default `60`, 10 to 259200): how long Kernel keeps the browser once agent-qa's
  connection drops.
- `stealth`, `region`, `proxy`, `viewport` (`width`, `height`, `refreshRate`): Kernel's own create
  fields.
- `pool`: a browser pool's id or name. The remote then takes a warm browser from the pool instead
  of creating one, and waits while the pool is empty. The pool's configuration sets the browser,
  so `stealth`, `region`, `proxy` and `viewport` are refused on a remote with `pool`.
- `profile`: a Kernel profile's name, or `{ id: <profile id> }`. It loads read-only: nothing the
  test does is saved back. It needs `context: reuse` on the remote, because the profile lives in
  the browser's first context:

  ```yaml
  - name: kernel-signed-in
    plugin: kernel
    context: reuse
    settings:
      profile: shop-test-user
  ```

- `extra`: any other Kernel request field. It is merged last, so it overrides the settings above.

After a test in a new context, a pooled browser goes back to the pool for reuse. After a test with
`context: reuse`, it is discarded, so the next test gets a clean one.

Kernel has no session page, so a Kernel test shows no session link. The live view URL of a headful
browser carries a credential, so agent-qa masks it and never shows it.

## When a remote is refused

- `auth`: Kernel refused the API key. Check the secret's value.
- `capacity`: Kernel answered 429 or 529. The account has no free sessions, or is rate limited.
  Wait, lower the run's concurrency, or use a pool.
- `refused` with path `settings.profile`: the remote sets `profile` without `context: reuse`.
- `refused` with another `settings.<field>` path: that field is wrong for this remote. The line
  says why.
- `unreachable`: Kernel could not be reached. Check the network.

## Check and describe

- `agent-qa doctor` runs the plugin's account check. It reads the browser list to prove the key,
  the organization's free sessions when the key may read them, and each pool a remote names. It
  creates no browser.
- `agent-qa plugins describe <entry> --json` lists every option and setting with its type,
  default and description.
