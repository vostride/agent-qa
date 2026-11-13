# agent-qa package instructions: agent-qa

## Scope

This package owns the public `agent-qa` CLI, Commander command registration,
config loading, init/auth/run/dashboard/mcp command UX, device and target
commands, validation commands, and packaged skills. It also owns the skills
installer, which writes the skills, the MCP entries and the `AGENTS.md` block
into a project folder and records them in its manifest, and
`agent-qa skills uninstall`, which removes what that manifest lists.

`agent-qa init` sets up the folder it runs in. In a terminal it asks the
platform, the model and the coding agents on a Clack rail; with `--yes`,
`--json`, in CI or without a terminal it asks nothing and prints plain lines.
It runs its steps through one runner, one line each, and an interactive init
ends by starting the dashboard unless `--no-dashboard` is given. With `--json`
it prints one JSON document on stdout on every exit.
`agent-qa init --capabilities` prints the JSON capability manifest and writes
nothing.

When Android or iOS is chosen, a fresh init also sets up the Playground app as
the project's mobile example. Each chosen runtime gets its target,
`playground-android` or `playground-ios`, pointing at its app under
`app-bundles/`, and three example tests under `tests/examples/`: a starter, a
cart-total test and a `[Bug]` test. Init lists this machine's emulators and
simulators, picks one per runtime without asking (a running one first,
otherwise the newest OS), writes it under `registry.devices` and binds the
runtime's target to it. A phone attached over USB is never picked. A runtime
with no emulator or simulator to pick still gets its target and tests, and one
line saying how to add one. A `playground-app` step, after the Chromium step,
downloads the pinned Playground build for each chosen runtime, checks its
sha256 and puts it under `app-bundles/`: the APK as it is, and the iOS build
unzipped as `Playground.app`. Init adds no `.gitignore` line for the folder.
Without `--force`, an app that is already there is kept and nothing is
requested. A download that fails is a failed step whose line names the file
and the release; init carries on and exits 3, and there is no retry command
and no download at run time. The next steps name a runtime's starter only when
it has a device and its app arrived. The pin is
`src/commands/playground-app-pin.ts`: it names one Playground release and
moves only with an agent-qa release, after the example tests pass on the new
build. A re-run does none of this and fetches nothing. `agent-qa init --force`
is a fresh init, not a re-run: it fetches the app again and replaces the one
in `app-bundles/`, `Playground.app` as a whole, only once the new bytes match
the pinned sha256.

On a folder that already has `agent-qa.config.yaml`, `agent-qa init` re-runs
setup instead. It prints a short summary of the project's agent-qa version, a
newer published version when npm answers in time, the model and the coding
agents, asks which coding agents to set up, then shows one menu of rows
(`upgrade`, `deps`, `skills`, `mcp`, `agents-md`, `browsers`, `gitignore`,
`scaffold`), each pre-checked when running it would change something.
`--setup <rows|all|none>` answers the menu, and `--yes` and runs without a
terminal take the pre-checks. A version move that can break the config is
never pre-checked and never taken by `all`; only naming its row in `--setup`
runs it. The `upgrade` row bumps agent-qa and its plugins to the latest exact
version, installs them and hands the rest of the run to the new copy. `--llm`,
`--model` and `--base-url` set the model. Validate always runs, then the next
steps, and an interactive re-run opens the dashboard only while the model is
pending. With `--json` a re-run also prints one JSON document on every exit.
The menu's checks live in `src/commands/setup-rows.ts`, and doctor uses the
same ones.

`agent-qa doctor` prints one row per check, with a fix under every warning and
failure. `--json` prints `{ "format": 1, "ok", "rows" }` instead. It exits 3
when a row fails and 0 otherwise, and 2 for its own usage errors. A row the
re-run menu can fix names `npx agent-qa init --setup <row>` as its fix.

agent-qa reports its own errors and coarse traces to Sentry from every command
when a release baked in a DSN and the project's `analytics.privacy` is not
`true`; a source checkout's DSN is blank, so it reports nothing. The root
`preAction` hook decides once, before the action runs, through
`src/composition/error-reporting-start.ts`: from the root `--config`, or for
`mcp` from the project it resolves. No config file means on, an unreadable one
means off, and a long-lived process never reads the flag again.
`src/composition/error-reporting.ts` holds the only import of `@sentry/node`,
a dynamic one, so nothing loads when reporting is off; a static import
anywhere the CLI reaches would load it on every invocation. The spans are the
command, each run, test, step and model call, and each MCP tool call. A report
carries the anonymous analytics id as its Sentry user id, and a span as its
`user.id` attribute: the id this process's analytics events carry. Both carry
the analytics base properties under their analytics names, as tags on a report
and attributes on a span: `agent_qa_version`, `surface`, `runtime_context`,
`is_internal` when true and `agent_product` when known. agent-qa sets nothing
else on the user. With reporting on, the reporter starts the process's one
identity resolution, held in `src/composition/analytics-identity.ts`, and
`composeAnalyticsHost` reuses it, so a report and an analytics event carry one
id; outside CI, a host resolves its own identity when that resolution gave
none. With reporting and analytics both off, nothing reads or writes the
identity file. The resolution keeps its one-second cut-off, and neither the
reporter's start nor a span waits for it. An error captured while it is
pending waits for it, until that cut-off at most and always inside the
2-second settle budget. A span that ends first leaves without the id,
`runtime_context`, `is_internal` and `agent_product`, and a resolution that
fails or is cut off sends reports without them. Every
report is masked at the transport, once per envelope, by the saved
credentials, the declared secrets and the masks bound with `bindMask`: those
bound when the report was captured or one of its breadcrumbs was recorded,
those bound at send, and those that ended in the last minute, up to a hundred
and always the newest. A run binds its redactor
while it lasts, and so does a dashboard live-editor session, through the
server's `bindSessionMask` option. The home folder then reads `~`, and an
envelope that cannot be masked is dropped. `settleReporting` is the one step
that drains analytics and flushes reports before an exit, inside one 2-second
budget. A capture never changes an exit code: agent-qa's own
`uncaughtException` and `unhandledRejection` handlers, installed only when
reporting is on, exit 1 as Node does. agent-qa prints nothing about reporting.

## Read First

- `package.json`
- `src/cli.ts`
- `src/cli-error-handler.ts`
- `src/composition/error-reporting.ts`
- `src/composition/error-reporting-start.ts`
- `src/config.ts`
- `src/commands/init.ts`
- `src/commands/init-steps.ts`
- `src/commands/init-devices.ts`
- `src/commands/playground-app.ts`
- `src/commands/playground-app-pin.ts`
- `src/commands/init-rerun.ts`
- `src/commands/setup-rows.ts`
- `src/commands/doctor.ts`
- `src/init-ui/`
- `src/commands/auth.ts`
- `src/commands/run.ts`
- `src/commands/dashboard.ts`
- `src/commands/mcp.ts`
- `src/commands/agent-setup.ts`
- `src/commands/skills.ts`
- `scripts/copy-skills.mjs`
- Relevant `src/__tests__/*.test.ts`

## Commands

- Test: `pnpm --filter agent-qa test`
- Typecheck: `pnpm --filter agent-qa typecheck`
- Build: `pnpm --filter agent-qa build`
- Copy packaged skills: `pnpm --filter agent-qa copy:skills`
