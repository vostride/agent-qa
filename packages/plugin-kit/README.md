# @vostride/agent-qa-plugin-kit

The kit for writing agent-qa plugins. It holds the plugin protocol, `definePlugin`, the stdio loop a
plugin runs, credential marks, the build-time manifest and schema emitter, and a `testing` entry with a
conformance runner and a loopback fake for vendor APIs.

agent-qa's own plugins are built with exactly this kit and run the same conformance suite under
`pnpm test`. There is no create command: copy the example below, or read a first-party plugin.

## What a plugin is

A remote plugin connects agent-qa to a browser or device service. It does the steps that differ per
service: create a session before agent-qa connects and delete it afterwards, mint or sign the connection,
build it from a few settings, upload an app, run a tunnel, and mark the session and link to it.

Everything else stays agent-qa's: connecting through Playwright or WebdriverIO, credentials and masking,
refusals and failure kinds, the heartbeat and release on exit.

A plugin is an npm package, or a folder with a package.json, whose package.json carries a manifest. agent-qa
starts it as a separate Node process and talks to it over stdin and stdout. Its code never runs inside
agent-qa's process.

A project enables a plugin once in the `plugins` list, with the account `options`, and each remote names
the entry and adds its own `settings`:

```yaml
plugins:
  - name: acme
    package: "@acme/agent-qa-plugin-acme"
    options:
      apiKey: "{{secret:ACME_API_KEY}}"

registry:
  remotes:
    - name: acme-eu
      plugin: acme
      settings: { region: eu }
```

## Install

Add the kit as a regular dependency, not a peer or dev dependency:

```bash
npm install @vostride/agent-qa-plugin-kit
```

Import `z` from the kit, not from `zod`. `credential()` marks a field in the kit's own schema registry, and
the emitter reads that registry, so the marks survive only when your schemas use the kit's `z`.

## Define the plugin

Keep the definition in a module of its own. `definePlugin` has no side effects, so the emitter and your
tests can import the definition without starting the plugin.

```ts
// src/plugin.ts
import { credential, definePlugin, PluginError, z } from '@vostride/agent-qa-plugin-kit'

export default definePlugin({
  options: z.strictObject({
    apiKey: credential('The Acme API key'),
    endpoint: z.url().default('https://api.acme.example').describe('The Acme API'),
  }),
  settings: z.strictObject({
    region: z.enum(['eu', 'us']).default('eu').describe('Where the browser runs'),
  }),
  serves: ['cdp'],
  skill: './skill',

  async acquire({ options, settings }, ctx) {
    ctx.progress({ message: 'creating a browser' })
    const response = await fetch(`${options.endpoint}/browsers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ region: settings.region }),
      signal: ctx.signal,
    })
    if (response.status === 401) {
      throw new PluginError('Acme refused the API key', { kind: 'auth', path: 'options.apiKey' })
    }
    if (!response.ok) {
      throw new PluginError(`Acme answered ${response.status}`, { kind: 'unreachable' })
    }
    const browser = (await response.json()) as { id: string; cdpUrl: string }
    return {
      handle: { id: browser.id },
      protocol: 'cdp',
      url: browser.cdpUrl,
      mask: [browser.cdpUrl],
    }
  },

  async release({ options, handle }) {
    const { id } = handle as { id: string }
    const response = await fetch(`${options.endpoint}/browsers/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${options.apiKey}` },
    })
    if (!response.ok && response.status !== 404) {
      throw new PluginError(`Acme answered ${response.status}`, { kind: 'unreachable' })
    }
  },
})
```

```ts
// src/main.ts
import { runPlugin } from '@vostride/agent-qa-plugin-kit'
import plugin from './plugin.js'

runPlugin(plugin)
```

- `options` holds what the account needs and comes from the `plugins` entry. `settings` holds what one
  place needs and comes from each remote. The plugin decides what both hold, and agent-qa checks them
  against the schemas the plugin ships.
- `serves` lists the protocols the plugin answers with: `playwright`, `cdp` or `appium`.
- `acquire` and `release` are required. `initialize`, `shutdown`, `check`, `uploadApp`, `started` and
  `end` are optional, and the methods you implement are the methods the manifest declares.
- Every handler takes `(input, ctx)`. `ctx.signal` aborts when agent-qa cancels the call, so pass it to
  every request. `ctx.progress({ message, queued?, percent? })` reports a queue position or an upload
  percentage, which agent-qa shows as it waits. `ctx.runFacts` holds the run facts the plugin declared.
- Throw `PluginError` with one line and a failure kind: `unreachable`, `auth`, `capacity`, `timeout`,
  `version`, `refused`, `ended` or `lost`. Add `path` (for example `settings.region`) when an option or a
  setting is at fault, so the refusal points at the config line. Add `handle` when the service had already
  created something.

## Build

Build with `tsdown`, then emit the schemas and the manifest from the built definition with a three-line
script:

```js
// scripts/emit.mjs
import { emitPluginFiles } from '@vostride/agent-qa-plugin-kit'
import plugin from '../dist/plugin.js'
emitPluginFiles({ definition: plugin, packageDir: process.cwd() })
```

```json
{
  "scripts": {
    "build": "tsdown && node scripts/emit.mjs"
  }
}
```

`emitPluginFiles` writes `dist/options.schema.json` and `dist/settings.schema.json` as JSON Schema draft
2020-12, with `"credential": true` on every marked field, and writes the manifest into package.json. It
leaves package.json untouched when the manifest already matches. Commit the manifest it writes.

The manifest sits in package.json under `"agent-qa": { "plugin": { … } }`:

```json
{
  "name": "@acme/agent-qa-plugin-acme",
  "keywords": ["agent-qa-plugin"],
  "files": ["dist", "skill"],
  "agent-qa": {
    "plugin": {
      "kind": "remote",
      "runs": "process",
      "protocol": 1,
      "entry": "./dist/main.js",
      "serves": ["cdp"],
      "methods": [],
      "options": "./dist/options.schema.json",
      "settings": "./dist/settings.schema.json",
      "skill": "./skill"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `kind`, `runs` | `remote` and `process` for every plugin built with the kit |
| `protocol` | The protocol version the plugin speaks |
| `entry` | The file agent-qa starts with Node |
| `serves` | The protocols its answers use: `playwright`, `cdp` or `appium` |
| `methods` | The optional methods it implements: `check`, `uploadApp`, `started` and `end` |
| `options`, `settings` | The JSON Schema files for the entry's options and a remote's settings |
| `runFacts` | Optional: the run facts it needs, from `testName`, `runId` and `failure` |
| `skill` | Optional: the folder holding its skill for coding agents |

agent-qa reads the manifest without running the plugin. Every path in it must resolve inside the package
after real paths are resolved. Add the `agent-qa-plugin` keyword so people can find the package on npm.

## The protocol in brief

The protocol is newline-delimited JSON-RPC 2.0 over the plugin's stdin and stdout, versioned by an
integer. Protocol 1 is the first. The kit reads and writes every message, so a plugin built with it only
implements handlers.

| Method | Called |
|---|---|
| `initialize` | Once, first, with the offered protocol versions, agent-qa's pid and versions, and the entry's options with their secrets resolved. It makes no vendor calls |
| `check` | By doctor, to check the account without opening a paid session |
| `acquire` | For each session: create it and answer the protocol, URL, headers, capabilities, values to mask and a link |
| `uploadApp` | For a device remote whose test has an app file: upload it and answer a reference |
| `started` | Once the session is open, with its session id |
| `end` | When the test ends, with its outcome |
| `release` | To delete the session, by its handle |
| `shutdown` | Once, last |

`$/cancel` cancels a call that missed its deadline, and `$/progress` carries the plugin's progress
reports. The full protocol, with every field, deadline and error code, is agent-qa's plugin specification,
`spec/v3/remote-plugins.md`.

## Rules

- **stdout carries only protocol messages.** Anything else on stdout stops the plugin. The kit sends
  `console.log`, `console.info`, `console.debug`, `console.warn` and `process.stdout.write` to stderr. A
  child process the plugin starts, such as a tunnel, must not inherit stdout.
- **stderr is the plugin's log.** agent-qa masks it and shows it only at debug level, and its first line
  becomes a failed call's reason.
- **A handle is self-contained JSON.** agent-qa keeps it and passes it back to `started`, `end` and
  `release`. After a crash, a fresh process with the same options releases it, so a handle carries
  everything `release` needs besides the options.
- **Release is idempotent.** A second release of the same handle, or a release of something already
  gone, succeeds.
- **An acquire that fails after the service created something returns its handle** in the `PluginError`,
  so agent-qa releases it. agent-qa never retries an acquire, and neither should a plugin, unless the
  service makes the create idempotent.
- **Cancels are always answered.** The kit answers a cancelled call with its result if it finishes inside
  the grace, otherwise with a cancel error that carries the handle if one exists. A handle that arrives
  later is released by the kit.
- **The kit releases on its own.** When stdin closes, agent-qa's pid dies or the process gets SIGTERM, the
  kit stops answering and aborts the `ctx.signal` of every call still running, except `release` and
  `shutdown`. It waits for those calls within its bound and releases every handle it still holds,
  including one a running call returns. Then it runs `shutdown` once and exits. It ignores SIGINT,
  because agent-qa runs the shutdown.
- **Secrets arrive only in messages.** The plugin's environment is only the path, home, temp, locale,
  time zone, proxy and certificate variables. Read credentials from `options` and `settings`, never from
  environment variables.
- **Deadlines.** `initialize` gets 10 s, `check` 15 s, `acquire` the remote's `connectTimeout` (5 minutes
  by default), `uploadApp` the remote's `uploadTimeout` (10 minutes by default), and `started`, `end`,
  `release` and `shutdown` 30 s, or 5 s when agent-qa is stopping on a signal.

## Run facts

Session facts reach every plugin: the platform, and the browser engine or the merged capabilities. Run
facts reach only a plugin that declares them in `runFacts`:

| Fact | Where it arrives |
|---|---|
| `testName` | `acquire`'s `run.testName` |
| `runId` | `initialize`'s `runFacts.runId`, and `ctx.runFacts` in every handler |
| `failure` | `end`'s `reason`: the failure's masked first line |

doctor and `agent-qa plugins describe` show what each plugin receives. Declare only what you use.

## The skill

A plugin may ship one skill for coding agents: plain files, with no code, in the folder the manifest's
`skill` names. Put a `SKILL.md` with a `name` and a `description` in its front matter, and list the folder
in the package's `files`. agent-qa's skills installer installs the skills of the plugins a config lists,
beside agent-qa's own, in a folder named after the plugin.

## Compatibility

- A plugin must speak protocol N or N-1, where N is the newest protocol agent-qa speaks. Once N+1 ships,
  an N-1 plugin is refused with a line naming the kit version to rebuild with. Rebuilding with a newer kit
  is the whole upgrade.
- Do not declare `peerDependencies` on agent-qa or the kit. Semver ranges refuse prereleases, and the
  protocol number, not a version range, decides what works together.

## Naming

Name the package `agent-qa-plugin-<id>` or `@scope/agent-qa-plugin-<id>`. This is a convention, documented
here and never enforced: agent-qa takes a `plugins` entry's `package` exactly as written and never adds a
prefix or guesses a name.

## Node only

A plugin runs on Node, with agent-qa's own Node binary and Node 24 or later. Its entry is a JavaScript
module. Other languages may come later through the documented protocol.

## Developing with a path entry

While you develop, point an entry at the plugin's folder with `path` instead of `package`:

```yaml
plugins:
  - name: acme
    path: ./tools/acme-plugin
    options:
      apiKey: "{{secret:ACME_API_KEY}}"
```

- The folder must be inside the config's folder, after both are resolved to real paths, so a symlink out
  of the project is refused.
- Its package.json carries the same manifest as a published plugin, and its entry is built and ready to
  run.
- A path plugin is checked by protocol like any third-party plugin.
- A plugin elsewhere in a monorepo is a workspace package, named with `package`.

## Testing

The `testing` entry runs a plugin the way agent-qa does. Build before testing, because the runner starts
the built entry.

```ts
import { fileURLToPath } from 'node:url'
import {
  expectManifestCurrent,
  runConformance,
  startLoopbackFake,
} from '@vostride/agent-qa-plugin-kit/testing'
import { expect, it } from 'vitest'
import plugin from '../plugin.js'

const packageDir = fileURLToPath(new URL('../..', import.meta.url))

it('keeps the committed manifest current', () => {
  expectManifestCurrent(packageDir, plugin)
})

it('passes conformance against a loopback fake of the Acme API', async () => {
  const api = await startLoopbackFake({
    routes: {
      'POST /browsers': [{ status: 201, json: { id: 'b-1', cdpUrl: 'ws://127.0.0.1:9/b-1' } }],
      'DELETE /browsers/:id': [{ status: 204 }],
    },
  })
  try {
    const report = await runConformance({
      packageDir,
      options: { apiKey: 'test-key', endpoint: api.url },
      settings: { region: 'eu' },
    })
    expect(report.checks.filter((check) => !check.ok)).toEqual([])
  } finally {
    await api.close()
  }
})
```

### runConformance

`runConformance({ packageDir, options, settings?, session?, host?, quick?, timeoutMs? })` reads the
package's manifest, starts its entry with Node and reports each check by name as
`{ name, ok, detail? }`, with `ok` true only when every check passed:

| Check | What passes |
|---|---|
| `manifest` | The manifest parses; `entry`, both schema files and `skill` resolve inside the package; both schemas are JSON naming draft 2020-12. Nothing is started when this fails |
| `handshake` | `initialize` answers protocol 1, with the manifest's `serves` and `methods` |
| `unknown-method` | A request for an unknown method is answered `-32601` |
| `idempotent-release` | An `acquire` succeeds, and two releases of its handle both answer `{}` |
| `answered-cancel` | An `acquire` cancelled at once is answered within 5 s, with a result or a cancel error |
| `clean-stdout` | Every stdout line was a JSON-RPC message |
| `exit-on-stdin-close` | The process exits within 5 s of its stdin closing |

- `options` and `settings` are sent as given, so point the plugin's endpoint at a loopback fake.
- `session` is the session `acquire` asks for, by default a new Chromium web session.
- `host` is merged over the identity `initialize` sends: `pid` is the runner's own pid, `agentQaVersion`
  is the kit's version, and `playwrightVersion` and `webdriverioVersion` are `'unknown'`, the value agent-qa
  sends when that library is not installed. A plugin that checks the host's Playwright version can be given
  one: `host: { playwrightVersion: '1.63.0' }`.
- `quick: true` runs only the checks that need no network: `manifest`, `handshake` (where a well-formed
  `initialize` refusal also passes), `unknown-method`, `clean-stdout` and `exit-on-stdin-close`. It never
  calls `acquire`.
- `timeoutMs` bounds each call, 10 s by default.

`expectManifestCurrent(packageDir, definition)` throws, naming the fields, when the manifest in
package.json differs from the one the emitter would write.

### startLoopbackFake

`startLoopbackFake({ routes })` starts an HTTP server on 127.0.0.1 only and answers from a script:

- A route key is `'METHOD /path'`, and a `:name` segment matches any one segment.
- A route is a list of replies, served one per request in order, with the last repeated once the list
  runs out, or a function from the request to a reply.
- A reply is `{ status, json?, text?, headers? }`, or `'hold'`, which never answers until the fake closes.
- A request no route matches is answered 404 with `{ message: 'no route' }`.

It returns `{ url, origin, requests, routeCalls(key), close() }`. `url` is `http://127.0.0.1:<port>`.
`requests` records the method, path, query, route params, headers and parsed JSON body of every request,
and `routeCalls(key)` lists the requests one route answered.

## agent-qa plugin validate

`agent-qa plugin validate <path|package>` checks a plugin the way agent-qa will load it: the manifest, both
schemas, the credential marks, the skill, and a quick conformance pass that never calls `acquire`. Run it
before you publish.
