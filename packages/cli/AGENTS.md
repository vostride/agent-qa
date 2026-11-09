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

## Read First

- `package.json`
- `src/cli.ts`
- `src/cli-error-handler.ts`
- `src/config.ts`
- `src/commands/init.ts`
- `src/commands/init-steps.ts`
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
