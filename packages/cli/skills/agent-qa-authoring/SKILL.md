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
  `workspace.secretsFile` names, quoted in YAML. The strict parse refuses a literal value under a
  header or query name that carries a credential word such as `token`, `key`, `secret`,
  `password`, `cookie`, `authorization` or `jwt`: in nested maps, inside a JSON value and in the
  url's own query.
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

## Do Not

- Do not invent config keys.
- Do not use legacy root config buckets.
- Do not hand-write IDs.
- Do not mutate files outside the configured workspace patterns.
