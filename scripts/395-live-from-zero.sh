#!/usr/bin/env bash
#
# 395-live-from-zero.sh — phase 395's LIVE lane for CFGM-05 (scaffold from zero).
#
# ================================================================================================
# WHAT THIS LANE FOUND, STATED FIRST BECAUSE IT IS THE RESULT RATHER THAN A CAVEAT
# ================================================================================================
#
# D-16 asks for "the full CFGM-05 sentence on a fresh temp workspace: zero config, scaffold the
# local demo app from scratch, accept, authoring proceeds". When this lane was written the sentence
# could not complete at all: `config.project.scaffold` was UNREACHABLE THROUGH CHAT from both
# directions at once. 395-12 opened ARM B. Both arms are recorded here because the ladder is only
# legible against what it used to be.
#
#   ARM A — A GENUINELY ZERO-CONFIG PROJECT HAS NO MODEL, SO NOTHING PLANS. STILL TRUE, AND OUT OF
#     THIS PHASE'S SCOPE. The pre-dispatch scaffold route fires only on a PLANNED
#     `authoring.draft.write` step (`turn-engine.ts`, the `step.functionId ===
#     AUTHORING_DRAFT_WRITE_FUNCTION_ID` arm). Planning needs a chat model;
#     `resolveCliChatCapabilities` builds one out of `registry.llms` + `use.llm` READ FROM THE
#     PROJECT CONFIG, and answers `undefined` when there is none. A project with no config file
#     therefore has no planner, so no `authoring.draft.write` is ever planned, so the route never
#     runs; the session header records it as `"model": "unbound"`. That is a question about MODEL
#     RESOLUTION — where a project's LLM binding may live — which WINDOWS 130 and 133 park for the
#     phases that own it. It is not a config-mutation defect and 395-12 did not touch it. LEG 2
#     measures it unchanged.
#
#   ARM B — ANY CONFIG FILE AT ALL MADE THE SCAFFOLD REFUSE. CLOSED BY 395-12. `already-configured`
#     was keyed on a config file EXISTING, so the only project that could reach the op through a
#     chat turn — one carrying the `registry.llms` entry arm A needs — was precisely the project it
#     refused. The predicate is now a configuration this scaffold would OVERWRITE: a DECLARED TARGET
#     REGISTRY. A config file with no targets is MERGED, one inserted entry, no other byte moved.
#     LEG 3 measures the road that opened.
#
# The two arms used to close on each other, and every hermetic cell in 395-08 was green because each
# held ONE side fixed: the route cells injected `configuredTargets` and never asked where a model
# came from, and the CLI scaffold cells drove the op against a config-less fixture and never asked
# how a turn reached it. The composition is the only place the pincer was visible, which is what
# D-16's live leg is for — and it is why this lane is re-pinned rather than retired.
#
# AND THE LOCAL APP IS NOT EXPRESSIBLE THROUGH THE GATE EVEN IF THE PINCER OPENED. `parseHostnameToken`
# is a positive rule about what a hostname IS: `127.0.0.1` fails because its final label is not
# alphabetic, `localhost:8931` fails because it has no dot, and D-13's derivation is pinned to
# `https://<domain>` with no port. There is no spelling of `http://127.0.0.1:8931/form.html` that
# the shipped gate accepts and the shipped derivation reproduces. LEG 1 measures that through the
# real producer rather than asserting it, and it is a SEPARATE rung from the pincer: opening the
# pincer would not make D-16's "scaffold the local demo app" expressible.
#
# 2026-10-02 (Phase 432 plan 41): RUNG 1 IS CLOSED. 432-05 (#134) admits the local spellings with
# scheme and port kept, so LEG 1 is re-authored to measure that; see its header. 432-11/13 also
# removed every approval: the scaffold writes in its own call and nothing asks, so LEG 5's driver
# answers no confirm and LEG 6 grades a prompt-free ask road. Legs 2-4 are not re-authored here:
# their proposal-era expectations are recorded as an open item for the phase's script owner.
#
# 2026-10-02 (Phase 432 plan 44): LEGS 3 AND 4 ARE RE-AUTHORED FOR THE PROMPT-FREE BUILD, STATICALLY
# (this lane was not driven: it needs a real model and is unobserved for 433). The scaffold now
# WRITES in its own call (432-11): LEG 3's scaffold arm grades the config file CHANGING by one merged
# target with ZERO commits and no proposal store, the scaffold receipt `applied` in the session, and
# the summary line on the transcript as the receipt shown where a surface exists. `config.proposal.
# apply`, the v48 gate's `Denied …` sentence and a filed proposal are now REDs: each would be the
# deleted proposal road coming back. LEG 4 no longer expects a fail-closed gate (432-13/19 deleted it):
# it grades that the configured project is NOT scaffolded (no scaffold receipt, config bytes kept),
# commits nothing and refuses with neither from-zero sentence; whatever the authoring turn then does
# against the live model is recorded, not graded. LEG 2 needed no change: it never reached a gate.
#
# ================================================================================================
# SO WHAT THIS SCRIPT IS
# ================================================================================================
#
# A REGRESSION INSTRUMENT OVER A MEASURED LADDER, not a wish that the sentence completes. Each leg
# records the outcome the shipped build ACTUALLY produces, with the rung named, so that the day a
# rung is closed this lane reds and says which one moved. A lane whose every leg is written to pass
# proves less than one that can fail in a named direction, so each leg below states its red.
#
# THREE PROJECTS, ONE UTTERANCE SHAPE, THREE DIFFERENT DURABLE OUTCOMES (legs 2/3/4). That triple is
# what makes this an instrument rather than an assertion: a route that had stopped working would
# collapse them onto each other, and a route that refused on WORDING rather than on the PROJECT
# would make legs 3 and 4 agree. The refusal's precondition being the project — 395-08's load-bearing
# decision — is therefore measured live, from outside, over three real chat sessions.
#
# VERDICTS COME OUT OF THE PERSISTED SESSION JSONL, NEVER OUT OF THE TRANSCRIPT (the 392/394 lesson)
# — WITH EXACTLY ONE EXCEPTION, NAMED HERE RATHER THAN DISCOVERED IN A LEG.
# `.agent-qa/sessions/<id>.jsonl` carries `stage_outcome`, `mark_unhandled` and `turn_complete` rows
# and the session header's `model` field; those are what every assertion below reads. The transcript
# is captured for the receipt and is never a verdict input — readline's own re-render of the line
# being typed spells the same bytes a turn boundary does (394's CR-03), so a transcript read is an
# instrument this lane declines to build.
#
#   THE ONE EXCEPTION — LEG 3's D-14 RENDER CLAIM (395-13). The claim is *the person can read the
#   proposal at the moment they are asked to approve it*, and its subject is THE PERSON'S SCREEN.
#   The session jsonl deliberately does not carry it: D-18 makes the log a MAP — which op ran and
#   how it went — so a render is exactly the thing that log is designed not to hold. Asserting this
#   clause anywhere else would be asserting a proxy for it. 395-VERIFICATION found the gap by
#   grepping a transcript for precisely this reason, and scored SC-5 failed on it.
#
#   ITS CR-03 BOUND, STATED RATHER THAN IGNORED. Readline re-renders the line being typed, so a
#   transcript grep for anything a PERSON could have typed is unsound. The two strings this
#   exception greps are neither: `configure this project for https://agent-qa.test as target
#   agent-qa-test` is the PROPOSAL's own summary line, composed by `construct.ts` from D-13's
#   derivation, and `config.proposal.apply` is a function id the gate spells. Nothing this lane
#   types into stdin contains either. NO OTHER LEG GAINS A TRANSCRIPT READ, and this one reads the
#   transcript for ONE claim while every other verdict it records still comes out of the jsonl.
#
#   2026-10-02 (432-44): there is no ask any more. The summary line is the scaffold's own RECEIPT,
#   shown where a surface exists the moment the change lands (432-11), and `config.proposal.apply`
#   is now read only as a regression: a deleted verb named on the screen.
#
# LOCAL ONLY, AND THE ONE NON-LOCAL-LOOKING NAME IS A NON-RESOLVING RESERVED ONE. P-08 forbids
# driving automation against a third-party production site. The local demo app at
# 127.0.0.1:8931 is this lane's only network subject. Legs 3 and 4 need a token the hostname gate
# ACCEPTS in order to reach the scaffold arm at all, and they use `agent-qa.test`: RFC 6761 reserves
# `.test` and guarantees it does not resolve, so the derived `https://agent-qa.test` addresses
# nothing at all. Before 432 both legs refused before any navigation; since 432-11/13 LEG 3's
# scaffold arm goes on to author against that target in the same turn, so the token's non-resolution
# is now load-bearing rather than a precaution — any gate run it starts addresses nothing.
#
# Usage:
#   bash scripts/395-live-from-zero.sh
#   LIVE_FROM_ZERO_SELFTEST=neutered bash scripts/395-live-from-zero.sh   # must exit 1
#   LIVE_FROM_ZERO_AUTHOR=1 bash scripts/395-live-from-zero.sh            # adds LEG 5 (browsers)

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPER_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
DEMO_INIT="${LIVE_FROM_ZERO_DEMO:-$SUPER_ROOT/demo/init}"
DEMO_MODULES="${LIVE_FROM_ZERO_DEMO_MODULES:-$SUPER_ROOT/demo/node_modules}"
CLI_ENTRY="$REPO_ROOT/packages/cli/dist/cli.js"
AGENT_DIST="$REPO_ROOT/packages/agent/dist/index.js"
FORM_URL="http://127.0.0.1:8931/form.html"

SELFTEST="${LIVE_FROM_ZERO_SELFTEST:-}"
RUN_AUTHOR="${LIVE_FROM_ZERO_AUTHOR:-0}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/395-live-from-zero.XXXXXX")"
TRANSCRIPTS="$WORK/transcripts"
mkdir -p "$TRANSCRIPTS"

banner() { printf '\n=== %s\n' "$*"; }
fatal() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

LEG_NAMES=(); LEG_VERDICTS=(); LEG_WHYS=()
record_leg() {
  LEG_NAMES+=("$1"); LEG_VERDICTS+=("$2"); LEG_WHYS+=("$3")
  printf '\n>>> LEG %-34s %s\n    %s\n' "$1" "$2" "$3"
}

SERVER_PID=""
cleanup() {
  local rc=$?
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  printf '\ntranscripts and workspaces kept at: %s\n' "$WORK"
  exit "$rc"
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------------------
# LEG 0 — preflight. Everything below reads a BUILT dist, so a stale one measures a previous build
# while every source path in the output says otherwise. Proven by grepping a real exported
# identifier out of the artifact, never by trusting that a build ran.
# ------------------------------------------------------------------------------------------------

banner 'LEG 0 — preflight'

[ -f "$CLI_ENTRY" ] || fatal "the CLI dist is absent at $CLI_ENTRY — run 'pnpm turbo run build --force' first"
[ -f "$AGENT_DIST" ] || fatal "the agent dist is absent at $AGENT_DIST — run 'pnpm turbo run build --force' first"
[ -d "$DEMO_INIT" ] || fatal "the demo harness is absent at $DEMO_INIT (override with LIVE_FROM_ZERO_DEMO)"
[ -d "$DEMO_MODULES" ] || fatal "the demo's node_modules is absent at $DEMO_MODULES (override with LIVE_FROM_ZERO_DEMO_MODULES) — the temp projects symlink it so the subscription auth plugin resolves"

# THE FRESHNESS PROOF, over identifiers 395 introduced. `parseHostnameToken` is the LEG 1 subject and
# `config.project.scaffold` is the op legs 3 and 4 turn on; a dist predating this phase carries
# neither, and a dist predating 395-08 carries only the second.
for identifier in parseHostnameToken 'config.project.scaffold' resolveWriteTestRoute; do
  count="$(grep -c -- "$identifier" "$AGENT_DIST")"
  [ "$count" -ge 1 ] \
    || fatal "the agent dist does not contain '$identifier' — it predates this phase. Rebuild with 'pnpm turbo run build --force' before running this lane."
  printf 'dist freshness: %-28s %s occurrence(s) in packages/agent/dist/index.js\n' "$identifier" "$count"
done

command -v curl >/dev/null || fatal 'curl is required'
command -v git >/dev/null || fatal 'git is required'

start_server() {
  ( cd "$DEMO_INIT" && node scripts/serve-local-form.mjs >"$WORK/server.log" 2>&1 ) &
  SERVER_PID=$!
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS -o /dev/null "$FORM_URL" 2>/dev/null; then
      printf 'local-form server answering %s after %s probe(s)\n' "$FORM_URL" "$attempt"
      return 0
    fi
    sleep 0.25
  done
  fatal "the local demo app never answered $FORM_URL (see $WORK/server.log)"
}

if curl -fsS -o /dev/null "$FORM_URL" 2>/dev/null; then
  printf 'local-form server was ALREADY answering %s — this lane did not start it and will not stop it\n' "$FORM_URL"
else
  start_server
fi

# ------------------------------------------------------------------------------------------------
# the temp-project builders
# ------------------------------------------------------------------------------------------------
#
# GIT IDENTITY IS PASSED PER COMMAND WITH `-c`, NEVER SET GLOBALLY (RESEARCH Pitfall 7). A bare temp
# repo inherits whatever the machine's global config says, which on a machine with none at all makes
# every commit fail — and the failure would surface from inside the apply, reading as a product
# defect. `-c` scopes the identity to this lane's own commits and leaves the operator's config alone.
GIT_ID=(-c user.name='agent-qa 395 lane' -c user.email='395-lane@agent-qa.invalid')

new_project() { # $1 = name -> prints the path
  local dir="$WORK/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q .
  # The auth plugin is resolved from the config file's own directory, so the temp project needs the
  # package on a resolution path of its own. A symlink rather than an install: this lane must not
  # spend a package manager's time, and the plugin it borrows is the one the demo already trusts.
  ln -sfn "$DEMO_MODULES" "$dir/node_modules"
  printf '%s' "$dir"
}

# The demo config with its targets emptied — the ONLY project shape in which the planner can bind
# and the scaffold arm is reachable. Derived from the committed demo config through the same YAML
# library the product parses with, so this lane cannot invent a config shape the product would
# reject for a reason unrelated to what is being measured.
# `node -e <script> a b c` PUTS THE FIRST USER ARGUMENT AT argv[1], NOT argv[2]. There is no script
# path in the vector under `-e`, and the obvious off-by-one reads the SOURCE config's path as the
# yaml library and dies with MODULE_NOT_FOUND. Measured on this lane's first run; recorded because
# the same mistake is one keystroke away in every `node -e` helper below.
write_config() { # $1 = project dir, $2 = 'no-targets' | 'local-form'
  node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const [source, shape, yamlLib, destination] = process.argv.slice(1)
const YAML = require(yamlLib)
const doc = YAML.parse(readFileSync(source, "utf8"))
doc.registry.targets = shape === "local-form"
  ? { "local-form": { platform: "web", url: "http://127.0.0.1:8931/form.html" } }
  : {}
delete doc.registry.devices
doc.knowledge = { dir: "agent-qa-knowledge" }
writeFileSync(destination, YAML.stringify(doc))
' "$DEMO_INIT/agent-qa.config.yaml" "$2" "$YAML_LIB" "$1/agent-qa.config.yaml" \
    || fatal "could not derive the lane config for $1"
  cp "$DEMO_INIT/hooks.yaml" "$1/hooks.yaml"
  mkdir -p "$1/agent-qa-knowledge" "$1/tests" "$1/suites"
  # `workspace.envFile` and `workspace.secretsFile` are declared by the demo config this lane derives
  # from, and a run REFUSES when a declared file is absent ("It may be empty, but it must exist").
  # BOTH WERE MEASURED THE HARD WAY, ONE PER DRIVE: LEG 5's first drive reached a real gate run and
  # died `RunProducedNoEventsError` on the secrets file, and its second died the same way on the env
  # file. From outside the process both read as an authoring failure, and both are facts about THIS
  # LANE's fixture rather than about the product — which is why the leg's RED arm prints the failure
  # class rather than a verdict about the loop.
  : >"$1/.env"
  : >"$1/.env.secrets.local"
}

YAML_LIB="$(node -e "console.log(require.resolve('yaml', { paths: ['$REPO_ROOT/packages/cli'] }))")" \
  || fatal 'could not resolve the yaml library the product parses with'

seal_project() { # $1 = project dir — one commit, so a later commit count is a lane measurement
  git -C "$1" "${GIT_ID[@]}" add -A >/dev/null
  git -C "$1" "${GIT_ID[@]}" commit -q -m 'seed: the state this lane starts from'
}

# One chat session, driven with piped stdin, and the SESSION FILE is the answer.
#
# PIPED STDIN IS DELIBERATE FOR LEGS 2-4 AND NAMED AS A BOUND. Under pipes the execution context
# resolves `local-headless`. 2026-10-02 (432-44): no context gates anything any more and nothing asks
# (432-13/19), so the bound no longer stops a turn; it only means no person is at the terminal. LEG 5
# spawns through `expect(1)` for a real pty, on 394's measured precedent.
drive_chat() { # $1 = project dir, $2 = utterance, $3 = transcript label -> prints the session id
  local dir="$1" utterance="$2" label="$3"
  ( cd "$dir" && printf '%s\n/quit\n' "$utterance" \
      | timeout "${LIVE_FROM_ZERO_TURN_TIMEOUT:-900}" node "$CLI_ENTRY" chat ) \
    >"$TRANSCRIPTS/$label.txt" 2>&1
  local newest
  newest="$(ls -t "$dir/.agent-qa/sessions/"*.jsonl 2>/dev/null | head -1)"
  [ -n "$newest" ] || return 1
  printf '%s' "$newest"
}

# Every read of a session file goes through here, so no leg parses JSONL by hand.
session_query() { # $1 = session file, $2 = one of: model | planner | reason | receipts | status
  node -e '
const { readFileSync } = require("node:fs")
// argv[1] is the FIRST user argument under `-e` — see the note on write_config.
const rows = readFileSync(process.argv[1], "utf8").split("\n").filter((line) => line !== "")
  .map((line) => JSON.parse(line))
const header = rows[0]
const first = rows.find((row) => row.kind === "user_message")
const turn = first === undefined ? undefined : first.turnId
const of = (kind) => rows.find((row) => row.kind === kind && row.turnId === turn)
switch (process.argv[2]) {
  case "model": process.stdout.write(String(header.model ?? "")); break
  case "planner": {
    const row = rows.find((r) => r.kind === "stage_outcome" && r.stage === "planner" && r.turnId === turn)
    process.stdout.write(String(row === undefined ? "" : row.outcome)); break
  }
  case "reason": process.stdout.write(String(of("mark_unhandled")?.reason ?? "")); break
  case "receipts": process.stdout.write(rows.filter((r) => r.kind === "clause_receipt" && r.turnId === turn).map((r) => `${r.functionId}:${r.status}`).join(",")); break
  case "status": process.stdout.write(String(of("turn_complete")?.status ?? "")); break
}
' "$1" "$2"
}

commit_count() { git -C "$1" rev-list --count HEAD; }

# ------------------------------------------------------------------------------------------------
# LEG 1 — the local app IS expressible through the shipped hostname gate (D-13/D-15, #134)
# ------------------------------------------------------------------------------------------------
#
# 2026-10-02 (Phase 432 plan 41): RUNG 1 IS CLOSED, AND THIS LEG IS RE-AUTHORED IN THE DIRECTION OF
# THE FIX, as it was written to be. Until 432-05 every spelling of the local demo app came back
# `not-a-hostname`. 432-05 (#134, C432-LOCALHOST-ORIGIN) parses origins instead: `localhost`, IPv4
# loopback and `[::1]` are admitted as typed, an explicit http/https scheme and a non-default port
# are kept, and loopback target names start with a letter (`ip-127-0-0-1`, `localhost`) with the
# port appended. 432-11 then made the scaffold WRITE in its own call: a served probe answers
# `applied`, not `proposed`, and the config file changes on disk with no Git commit.
#
# ONE FRESH `no-targets` PROJECT PER PROBE (432-41). A served probe now WRITES a target into its
# project, and the scaffold refuses a project that already declares one (`already-configured`), so
# probes sharing one project would grade each other. Each probe seeds its own.
#
# THE CONTROL IS STILL BUILT INTO THE MECHANISM. A non-loopback IP literal and a spelling the URL
# parser would rewrite into loopback stay refused `not-a-hostname` (`192.168.0.1`,
# `http://127.1:8931`), while every local spelling and both real domains are served. A gate that
# stopped refusing collapses the two sets, and a gate that refused everything collapses them the
# other way. Every served answer is checked for its whole `for <base URL> as target <name>` clause,
# so the derivation — scheme and port included — is read out of the product's own summary line.
#
# WHAT MAKES THIS LEG RED (432-41): a local spelling refused again (#134 regressed), a refused
# spelling served (the loopback rule widened), a derivation naming a different base URL or target,
# or a Git commit appearing (the scaffold writes files and commits nothing).
#
# THE TEXT BELOW, UP TO THE BANNER, IS THE 395 RECORD OF THE RUNG BEFORE IT CLOSED.
#
# THROUGH THE REAL REGISTERED OP ON THE SHIPPED CLI SURFACE, not through a copy of the rule and not
# through the predicate in isolation. `parseHostnameToken` is deliberately NOT on `packages/agent`'s
# barrel — the FUNC-01/SC1 export set only shrinks — and reaching around that to import an internal
# symbol would be this lane inventing a surface nobody ships. `agent-qa fn config.project.scaffold`
# is the surface a person has, so that is what is asked.
#
# THE CONTROL IS BUILT INTO THE MECHANISM, WHICH IS WHY THIS SHAPE IS BETTER THAN THE PREDICATE. The
# hostname gate is the FIRST thing the op checks (395-08's cell (S2): the gate sits above CFGM-04's
# re-read). So in ONE project, one call apart, a local address comes back `not-a-hostname` and a
# real domain gets PAST the gate. A gate that had stopped refusing collapses those two answers onto
# each other, and a gate that refused everything collapses them the other way. Neither can look
# like a pass.
#
# RE-PINNED BY 395-12 — THE CONTROL ARMS NOW ANSWER `proposed`, NOT `already-configured`. This
# project is `no-targets`: a config file with an empty target registry. Until 395-12 the op refused
# it for the file's mere EXISTENCE; the narrowed predicate refuses only a configuration this
# scaffold would OVERWRITE — a declared target registry — so a real domain here is now MERGED into
# the person's own config and answers `proposed`. The movement is the fix, and this is the leg
# recording it. The `already-configured` road is still measured, hermetically, by
# `config-scaffold.test.ts` cell (9) and `scaffold-derivation.test.ts` cell (S3), both of which
# were re-fixtured onto a target-DECLARING config in the same commit.
#
# AND THE CONTROL ARM STILL CARRIES THE DERIVATION. The proposal's own summary line names the target
# name D-13 derived — `booking-com`, `agent-qa-test` — so this leg reads the derivation's answer out
# of the product's own words rather than asserting it against a literal it typed.
#
# WHAT MAKES THIS LEG RED: a gate that started accepting IPv4 literals or bare `localhost` (rung 1
# closed — re-author this leg against the new behaviour), a derivation that stopped producing the
# pinned target name (the D-13 pin regressed), or a control domain that stopped being served in a
# zero-target project (395-12's narrowing regressed, and SC-5's entry point closed again). It reds in the direction of the fix and says which.

banner 'LEG 1 — is the local demo app expressible through the D-15 gate?'

LEG1_OUT="$WORK/leg1.txt"
: >"$LEG1_OUT"
LEG1_RC=0
LEG1_PROBES=0

probe_gate() { # $1 = domain token, $2 = expected reason or outcome, $3 = optional substring the answer must carry
  local answer reason project before after
  LEG1_PROBES=$((LEG1_PROBES + 1))
  project="$(new_project "gate-probe-$LEG1_PROBES")"
  write_config "$project" no-targets
  seal_project "$project"
  before="$(commit_count "$project")"
  answer="$( cd "$project" && timeout 300 node "$CLI_ENTRY" fn config.project.scaffold \
    --input "$(node -e 'process.stdout.write(JSON.stringify({ domain: process.argv[1] }))' "$1")" 2>&1 )"
  after="$(commit_count "$project")"
  # THE VERDICT IS `reason` WHEN THERE IS ONE AND `outcome` OTHERWISE (395-12). A refusal carries
  # both; a served scaffold carries only `outcome: applied` (432-11; `proposed` before it).
  reason="$(printf '%s' "$answer" | node -e '
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const text = chunks.join("")
  const start = text.indexOf("{")
  try {
    const parsed = JSON.parse(text.slice(start))
    process.stdout.write(String(parsed.reason ?? parsed.outcome ?? ""))
  } catch { process.stdout.write("") }
})' )"
  printf '  %-38s -> %s\n' "$1" "${reason:-<unparsable>}" | tee -a "$LEG1_OUT"
  if [ "$after" != "$before" ]; then
    printf '    UNEXPECTED: a Git commit appeared (commits %s -> %s)\n' "$before" "$after" | tee -a "$LEG1_OUT"
    LEG1_RC=1
  fi
  if [ "$reason" != "$2" ]; then
    printf '    UNEXPECTED: expected %s\n' "$2" | tee -a "$LEG1_OUT"
    LEG1_RC=1
    return
  fi
  if [ -n "${3:-}" ]; then
    case "$answer" in
      *"$3"*) ;;
      *) printf '    UNEXPECTED: the answer does not carry %s\n' "$3" | tee -a "$LEG1_OUT"; LEG1_RC=1 ;;
    esac
  fi
}

# The five spellings of the local demo app a person could reasonably type: all served, as typed.
probe_gate '127.0.0.1:8931' applied 'for https://127.0.0.1:8931 as target ip-127-0-0-1-8931'
probe_gate '127.0.0.1' applied 'for https://127.0.0.1 as target ip-127-0-0-1'
probe_gate 'localhost:8931' applied 'for https://localhost:8931 as target localhost-8931'
probe_gate 'localhost' applied 'for https://localhost as target localhost'
probe_gate 'http://127.0.0.1:8931/form.html' applied 'for http://127.0.0.1:8931 as target ip-127-0-0-1-8931'
# The refusals that keep the gate a gate: a non-loopback IP, and a spelling the URL parser would
# rewrite into loopback.
probe_gate '192.168.0.1' not-a-hostname
probe_gate 'http://127.1:8931' not-a-hostname
# The controls: real hostnames are served as before, with the D-13 derivation in the summary line.
probe_gate 'booking.com' applied 'for https://booking.com as target booking-com'
probe_gate 'agent-qa.test' applied 'for https://agent-qa.test as target agent-qa-test'

if [ "$LEG1_RC" -eq 0 ]; then
  record_leg 'L1 local-app expressibility' 'PASS' \
    'RUNG 1 IS CLOSED, AS MEASURED THROUGH THE REGISTERED OP (432-05 #134, 432-11): every spelling of the local demo app is served `applied`, with its scheme and port kept and the derived target named in the product`s own summary line (`ip-127-0-0-1-8931`, `localhost-8931`, ...); `192.168.0.1` and the rewritten `http://127.1:8931` stay refused `not-a-hostname`; both control domains are served; and no probe made a Git commit. D-16`s "scaffold the LOCAL app" is expressible.'
else
  record_leg 'L1 local-app expressibility' 'RED' \
    "the gate's answers moved — see $LEG1_OUT. A local spelling refused again means #134 regressed; a refused spelling served means the loopback rule widened; a different summary line means the derivation moved; a Git commit means the scaffold started committing."
fi

# ------------------------------------------------------------------------------------------------
# LEG 2 — ARM A: a genuinely zero-config project (the literal D-16 sentence)
# ------------------------------------------------------------------------------------------------
#
# UNCHANGED BY 395-12, AND THE LEG SAYS WHOSE QUESTION IT IS NOW. This rung is about MODEL
# RESOLUTION — whether a project can carry an LLM binding outside the config file — which WINDOWS
# 130 and 133 park for the phases that own it. 395-12 closed the scaffold's half of the pincer and
# deliberately did not invent a provider default (D-13's prohibition one field over), so a project
# with no model anywhere still cannot chat about anything. That is honest residue, not a defect of
# this phase.
#
# WHAT MAKES THIS LEG RED: a build in which a zero-config project DOES bind a model (WINDOWS 130/133
# answered — re-author this leg against the new behaviour) or in which the scaffold route fires
# without one. Either is the fix, and this leg names it.
#
# THE EVIDENCE IS THE PRODUCT'S OWN WORD FOR IT. `"model": "unbound"` is written into the session
# header by the chat surface itself, so this leg does not have to infer "there was no planner" from
# an absence — it reads the field that says so, and reads `stage_outcome planner: unresolved` beside
# it.

banner 'LEG 2 — ARM A: zero config, one utterance naming the local app'

P2="$(new_project zero-config)"
seal_project "$P2"
P2_BEFORE="$(commit_count "$P2")"
S2="$(drive_chat "$P2" 'write a test for the login flow at 127.0.0.1:8931' leg2-zero-config)"

if [ -z "${S2:-}" ]; then
  record_leg 'L2 arm A (zero config)' 'RED' 'no session JSONL was written at all — the chat surface did not reach a usable state, so this leg took no reading'
else
  L2_MODEL="$(session_query "$S2" model)"
  L2_PLANNER="$(session_query "$S2" planner)"
  L2_REASON="$(session_query "$S2" reason)"
  L2_STATUS="$(session_query "$S2" status)"
  P2_AFTER="$(commit_count "$P2")"
  printf '  session   %s\n  model     %s\n  planner   %s\n  status    %s\n  reason    %s\n  commits   %s -> %s\n' \
    "$S2" "$L2_MODEL" "$L2_PLANNER" "$L2_STATUS" "$L2_REASON" "$P2_BEFORE" "$P2_AFTER"
  if [ "$L2_MODEL" = 'unbound' ] && [ "$L2_PLANNER" = 'unresolved' ] && [ "$P2_AFTER" = "$P2_BEFORE" ]; then
    record_leg 'L2 arm A (zero config)' 'PASS' \
      "RUNG 2 MEASURED, AND IT IS NOT THIS PHASE'S RUNG. A project with no config has no \`registry.llms\`, so \`resolveCliChatCapabilities\` answers undefined and the session records \`model: unbound\`; the planner stage resolves \`unresolved\`, no \`authoring.draft.write\` is ever planned, and the pre-dispatch scaffold route therefore never runs. That is WINDOWS 130/133's parked question about MODEL RESOLUTION — 395-12 closed the scaffold's half of the pincer and declined to invent a provider default. The turn's own sentence blames the BUILD ('No capability in this build handles…') when the fact is that this PROJECT has no model — recorded as a second, smaller finding. Nothing was committed."
  else
    record_leg 'L2 arm A (zero config)' 'RED' \
      "the zero-config arm moved: model='$L2_MODEL' planner='$L2_PLANNER' commits $P2_BEFORE->$P2_AFTER. A bound model here means WINDOWS 130/133's model-resolution question has been answered and the literal D-16 sentence may now be reachable end to end — re-author this leg against the new behaviour. A commit here means a refusal mutated the repository, which is a different and worse finding."
  fi
fi

# ------------------------------------------------------------------------------------------------
# LEG 3 — ARM B: the smallest project in which the route can reach the scaffold at all
# ------------------------------------------------------------------------------------------------
#
# THIS RUNG OPENED IN 395-12, AND THIS LEG MEASURES THE ROAD RATHER THAN THE WALL. A config file's
# mere existence no longer earns `already-configured`; the predicate is a DECLARED TARGET REGISTRY,
# and this project — the demo config with `registry.targets` emptied — declares none.
#
# RE-AUTHORED 2026-10-02 (432-44) FOR THE PROMPT-FREE BUILD. Until 432 the scaffold PROPOSED, the turn
# invoked `config.proposal.apply` in-turn, and under this lane's piped stdin (`local-headless`) the
# v48 gate denied it by name — that denial WAS the measurement. 432-11 made the scaffold WRITE in its
# own call and 432-13/19 deleted the gate: the route resolves `scaffold`, `config.project.scaffold`
# MERGES one target entry into the person's own config and answers `applied`, the scaffold receipt is
# logged and shown, and the SAME turn goes on to author against the target that now exists. So the
# scaffold arm now CHANGES the config file (one merged target), still commits NOTHING, and files no
# proposal. What the authoring step then does against the live model and the non-resolving
# `agent-qa.test` is recorded, not graded: this leg is about the route and the scaffold.
#
# THE OTHER ARM SURVIVES, AND IT IS STILL WINDOWS 131 (observed live). `resolveWriteTestRoute` reads
# the tokens of the intent THE MODEL EMITTED, not the utterance a person typed, so the identical
# request can reach the scaffold on one run and D-15's refusal on the next when the model
# paraphrases the site away. This leg records WHICH ARM it took rather than demanding one.
#
# WHAT MAKES THIS LEG RED — every direction named, because a leg that can only pass proves nothing:
#
#   * A COMMIT on either arm. agent-qa makes no Git commits (D-07).
#   * THE PROPOSAL ROAD COMING BACK: `config.proposal.apply` or the gate's `Denied …` sentence in the
#     turn, or anything filed under `.agent-qa/proposals/`. Each is a deleted surface returning.
#   * The scaffold arm leaving the config file byte-identical (the write did not land), or the refuse
#     arm changing it (a refusal moved a byte).
#   * `already has agent-qa.config.yaml` — the narrowing regressing to the file-existence predicate.
#   * `Config file not found` in the turn's own sentence — SC-5's third arm's symptom, by any road.
#   * The planner not binding, which would leave this leg unable to tell arm B from arm A.
#   * THE RECEIPT MISSING FROM THE TRANSCRIPT on the scaffold arm (D-14's surviving half: a person sees
#     the change the moment it lands). The reading can only be taken on the scaffold arm; on the
#     `d15-refuse` arm nothing was written, and the PASS sentence SAYS the reading was not taken.

banner 'LEG 3 — SC-5s serving class: config present so the planner binds, ZERO targets'

P3="$(new_project no-targets)"
write_config "$P3" no-targets
seal_project "$P3"
P3_BEFORE="$(commit_count "$P3")"
P3_DIGEST_BEFORE="$(shasum -a 256 "$P3/agent-qa.config.yaml" | awk '{print $1}')"
S3="$(drive_chat "$P3" 'write a test for agent-qa.test' leg3-no-targets)"

if [ -z "${S3:-}" ]; then
  record_leg 'L3 SC-5 serving class' 'RED' 'no session JSONL was written at all — this leg took no reading'
else
  L3_MODEL="$(session_query "$S3" model)"
  L3_PLANNER="$(session_query "$S3" planner)"
  L3_REASON="$(session_query "$S3" reason)"
  L3_RECEIPTS="$(session_query "$S3" receipts)"
  L3_STATUS="$(session_query "$S3" status)"
  P3_AFTER="$(commit_count "$P3")"
  P3_DIGEST_AFTER="$(shasum -a 256 "$P3/agent-qa.config.yaml" | awk '{print $1}')"
  L3_PROPOSALS="$(ls "$P3/.agent-qa/proposals/" 2>/dev/null | wc -l | tr -d ' ')"
  printf '  session   %s\n  model     %s\n  planner   %s\n  status    %s\n  receipts  %s\n  reason    %s\n  commits   %s -> %s\n  config    %s -> %s\n  proposals %s filed\n' \
    "$S3" "$L3_MODEL" "$L3_PLANNER" "$L3_STATUS" "$L3_RECEIPTS" "$L3_REASON" "$P3_BEFORE" "$P3_AFTER" \
    "${P3_DIGEST_BEFORE:0:12}" "${P3_DIGEST_AFTER:0:12}" "${L3_PROPOSALS:-0}"

  L3_CONFIG_MOVED=0
  [ "$P3_DIGEST_AFTER" = "$P3_DIGEST_BEFORE" ] || L3_CONFIG_MOVED=1

  L3_TRANSCRIPT="$TRANSCRIPTS/leg3-no-targets.txt"
  L3_PROPOSAL_ROAD=0
  case "$L3_REASON" in *'config.proposal.apply'*|*'Denied '*) L3_PROPOSAL_ROAD=1 ;; esac
  [ "${L3_PROPOSALS:-0}" = '0' ] || L3_PROPOSAL_ROAD=1
  if [ -f "$L3_TRANSCRIPT" ] && grep -q -F 'config.proposal.apply' "$L3_TRANSCRIPT"; then L3_PROPOSAL_ROAD=1; fi

  L3_ARM='unrecognised'
  case ",$L3_RECEIPTS," in
    *',config.project.scaffold:executed,'*) L3_ARM='scaffold-applied' ;;
  esac
  if [ "$L3_ARM" = 'unrecognised' ]; then
    case "$L3_REASON" in
      *'I will not guess which site you meant'*) L3_ARM='d15-refuse (no hostname token in the emitted intent)' ;;
      *'already has agent-qa.config.yaml'*) L3_ARM='NARROWING-REGRESSED' ;;
      # The sentence `cli/src/config.ts` composes for a missing config; SC-5's third arm met it
      # through the (now deleted) grant read, and any road that reaches it from this turn is a RED.
      *'Config file not found'*) L3_ARM='CONFIG-NOT-FOUND' ;;
    esac
  fi

  # THE RECEIPT A PERSON SEES (D-14's surviving half). The scaffold's own summary line, composed by
  # `construct.ts` from D-13's derivation of this leg's fixed token, shown by the route's `present`
  # step the moment the write lands.
  L3_SUMMARY_LINE='configure this project for https://agent-qa.test as target agent-qa-test'
  L3_RENDER_READING='not-taken'
  L3_RENDER_LINE=0
  if [ "$L3_ARM" = 'scaffold-applied' ] && [ -f "$L3_TRANSCRIPT" ]; then
    L3_RENDER_READING='taken'
    L3_RENDER_LINE="$(grep -n -m1 -F "$L3_SUMMARY_LINE" "$L3_TRANSCRIPT" | cut -d: -f1)"
    L3_RENDER_LINE="${L3_RENDER_LINE:-0}"
    printf '  render    summary line at transcript line %s\n' "$L3_RENDER_LINE"
  fi
  if [ "$L3_RENDER_READING" = 'taken' ]; then
    L3_RENDER_SENTENCE="D-14's RENDER READING WAS TAKEN THIS RUN: the scaffold's own summary line stands at transcript line $L3_RENDER_LINE, so the person reads WHAT WAS WRITTEN the moment it lands — the receipt, now that nothing waits for an answer."
  else
    L3_RENDER_SENTENCE="D-14's RENDER READING WAS NOT TAKEN THIS RUN, and this leg says so rather than passing it silently: arm '$L3_ARM' wrote nothing, so there is no receipt to render. The reading is available only on the scaffold arm; re-drive to take it (WINDOWS 131 model nondeterminism)."
  fi

  if [ "$P3_AFTER" != "$P3_BEFORE" ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "THE TURN COMMITTED: commits $P3_BEFORE->$P3_AFTER on arm '$L3_ARM'. agent-qa makes no Git commits (D-07); a commit here is the retired one-commit apply returning."
  elif [ "$L3_PROPOSAL_ROAD" -eq 1 ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "THE PROPOSAL ROAD CAME BACK: the turn named \`config.proposal.apply\` or a gate denial ('$L3_REASON'), or filed ${L3_PROPOSALS:-0} proposal(s). 432 deleted the apply verb, the proposal store and the gate (D-05, D-15); the scaffold writes in its own call."
  elif [ "$L3_ARM" = 'CONFIG-NOT-FOUND' ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "THE TURN THREW \`Config file not found\` — '$L3_REASON'. SC-5's third arm met this sentence through the in-turn apply's grant read (395-12); both are deleted, so whatever reached it now is a new road to the config loader's fault surface (cli/src/config.ts)."
  elif [ "$L3_ARM" = 'NARROWING-REGRESSED' ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "THE NARROWING REGRESSED TO THE FILE-EXISTENCE PREDICATE: a project declaring ZERO targets earned \`already-configured\` — '$L3_REASON'. SC-5's entry point has closed again (WINDOWS 132 jaw 2)."
  elif [ "$L3_PLANNER" != 'resolved' ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "the planner did not bind (planner='$L3_PLANNER') in a project that carries the LLM entry — this leg cannot tell this rung from LEG 2's, so it took no reading at all"
  elif [ "$L3_ARM" = 'unrecognised' ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "the turn took no arm this leg recognises: receipts '$L3_RECEIPTS', reason '$L3_REASON'. The route's behaviour has moved and this leg must be re-authored against it."
  elif [ "$L3_ARM" = 'scaffold-applied' ] && [ "$L3_CONFIG_MOVED" -eq 0 ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "THE SCAFFOLD ANSWERED applied AND THE CONFIG FILE DID NOT MOVE (${P3_DIGEST_BEFORE:0:12}). A receipt for a write that did not land is the one claim a receipt must never make."
  elif [ "$L3_ARM" != 'scaffold-applied' ] && [ "$L3_CONFIG_MOVED" -eq 1 ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "A REFUSED FROM-ZERO TURN CHANGED THE CONFIG FILE: ${P3_DIGEST_BEFORE:0:12}->${P3_DIGEST_AFTER:0:12} on arm '$L3_ARM'. Every refusal lives above every mutation (395-06)."
  elif [ "$L3_RENDER_READING" = 'taken' ] && [ "${L3_RENDER_LINE:-0}" = '0' ]; then
    record_leg 'L3 SC-5 serving class' 'RED' \
      "THE RECEIPT IS GONE FROM THE TURN: the scaffold wrote the config, and its own summary line ('$L3_SUMMARY_LINE') appears NOWHERE in the transcript a person reads. A change made with no question asked must at least be SHOWN. Transcript: $L3_TRANSCRIPT"
  else
    record_leg 'L3 SC-5 serving class' 'PASS' \
      "RUNG 3 IS OPEN AND WRITES IN THE CALL, MEASURED LIVE (395-12, 432-11). The planner bound, and in a project that HAS a configuration and declares NO targets the turn took arm '$L3_ARM' (receipts: $L3_RECEIPTS; status '$L3_STATUS'). On the scaffold arm the op MERGED one target entry into the person's own config (${P3_DIGEST_BEFORE:0:12}->${P3_DIGEST_AFTER:0:12}) and the turn went on to author with nothing asked; on either arm ZERO commits and no proposal filed. The arm split is WINDOWS 131 live — the route reads the tokens of the intent the MODEL emitted. $L3_RENDER_SENTENCE"
  fi
fi

# ------------------------------------------------------------------------------------------------
# LEG 4 — THE DIRECTIONAL CONTROL: the same build, the same shape of utterance, a project that HAS
#         a target. This is what stops legs 2 and 3 from being a lane that refuses everything.
# ------------------------------------------------------------------------------------------------
#
# 395-08's load-bearing decision is that the route's refusal precondition is the PROJECT rather than
# the wording, proven hermetically by cell (R7) driving four utterances through two projects. THIS is
# that claim measured live, from outside the process, over real chat sessions against a real model:
# legs 3 and 4 differ in NOTHING but whether the project declares a target, and they must produce
# DIFFERENT durable outcomes.
#
# RE-AUTHORED 2026-10-02 (432-44). This leg used to expect the v48 gate to fail `authoring.draft.write`
# closed under piped stdin, by its `mutating-shared` tier. 432-13/19 deleted that gate, so nothing
# stops the authoring step any more and its outcome against the live model is recorded, not graded.
# The discrimination that survives is the route's: a configured project is NOT scaffolded (no
# scaffold receipt, the config file byte-identical), is refused with neither from-zero sentence, and
# — as everywhere — nothing is committed. An authored test file may now be WRITTEN (D-06); that is an
# uncommitted edit under `tests/`, not a change to the config or the history this leg reads.
#
# WHAT MAKES THIS LEG RED: a route that refused here with a from-zero sentence (the precondition would
# have become the wording, and 394's shipped authoring path would be broken for the majority of real
# requests), a scaffold that ran over a project that already declares the target, a gate denial or the
# deleted apply verb coming back, or a commit.

banner 'LEG 4 — the directional control: a project that HAS the local-form target'

P4="$(new_project local-form)"
write_config "$P4" local-form
seal_project "$P4"
P4_BEFORE="$(commit_count "$P4")"
P4_DIGEST_BEFORE="$(shasum -a 256 "$P4/agent-qa.config.yaml" | awk '{print $1}')"
S4="$(drive_chat "$P4" 'write a test for the login flow on local-form' leg4-local-form)"

if [ -z "${S4:-}" ]; then
  record_leg 'L4 directional control' 'RED' 'no session JSONL was written at all — this leg took no reading'
else
  L4_REASON="$(session_query "$S4" reason)"
  L4_RECEIPTS="$(session_query "$S4" receipts)"
  L4_STATUS="$(session_query "$S4" status)"
  P4_AFTER="$(commit_count "$P4")"
  P4_DIGEST_AFTER="$(shasum -a 256 "$P4/agent-qa.config.yaml" | awk '{print $1}')"
  printf '  session   %s\n  status    %s\n  receipts  %s\n  reason    %s\n  commits   %s -> %s\n  config    %s -> %s\n' \
    "$S4" "$L4_STATUS" "$L4_RECEIPTS" "$L4_REASON" "$P4_BEFORE" "$P4_AFTER" "${P4_DIGEST_BEFORE:0:12}" "${P4_DIGEST_AFTER:0:12}"
  L4_OK=1
  # The refusal, if any, must NOT be either of the two the from-zero arms produce. That is the whole
  # discrimination: same words, different project, different answer.
  case "$L4_REASON" in *'already has agent-qa.config.yaml'*) L4_OK=0 ;; esac
  case "$L4_REASON" in *'no agent-qa configuration'*) L4_OK=0 ;; esac
  case "$L4_REASON" in *'I will not guess which site you meant'*) L4_OK=0 ;; esac
  # Nothing is gated and the apply verb is deleted, so neither may appear.
  case "$L4_REASON" in *'Denied '*|*'config.proposal.apply'*) L4_OK=0 ;; esac
  # The configured project is not scaffolded: no scaffold receipt, and its config keeps its bytes.
  case ",$L4_RECEIPTS," in *',config.project.scaffold:'*) L4_OK=0 ;; esac
  [ "$P4_DIGEST_AFTER" = "$P4_DIGEST_BEFORE" ] || L4_OK=0
  [ "$P4_AFTER" = "$P4_BEFORE" ] || L4_OK=0
  if [ "$L4_OK" -eq 1 ]; then
    record_leg 'L4 directional control' 'PASS' \
      "THE ROUTE DISCRIMINATES ON THE PROJECT, MEASURED LIVE. The same build and the same shape of request, in a project that declares \`local-form\`, produced NEITHER of the two from-zero refusals, ran no scaffold over the configured project (config ${P4_DIGEST_BEFORE:0:12} kept) and committed nothing — so legs 2 and 3 are not a lane that refuses everything, and 395-08's decision that the refusal's precondition is the PROJECT rather than the wording holds outside the hermetic cells. Authoring outcome, recorded and not graded (no gate since 432): status='$L4_STATUS' receipts='$L4_RECEIPTS' reason='$L4_REASON'."
  else
    record_leg 'L4 directional control' 'RED' \
      "THE CONTROL COLLAPSED: a project that declares its target produced reason '$L4_REASON', receipts '$L4_RECEIPTS', config ${P4_DIGEST_BEFORE:0:12}->${P4_DIGEST_AFTER:0:12}, commits $P4_BEFORE->$P4_AFTER. Either the route's precondition has become the WORDING, a scaffold ran against a configured project, the deleted gate or apply verb came back, or the turn committed."
  fi
fi

# ------------------------------------------------------------------------------------------------
# LEG 5 — OPTIONAL: authoring proceeds through REAL gate runs against the LOCAL app, under a pty
# ------------------------------------------------------------------------------------------------
#
# D-16's sentence ends "authoring proceeds through real gate runs against the local app". The
# scaffold half of that sentence is unreachable (legs 2/3), so this half is measured on its own, in a
# project whose target IS the local demo app. It costs real browser runs and real model latency, so
# it is opt-in — AND THE SKIP IS ANNOUNCED, because a credential-or-cost guard that degrades to a
# silent no-op has produced green runs measuring nothing in this codebase before.
#
# A REAL PTY, on 394's measured precedent: vitest workers and pipes both resolved `local-headless`,
# and the gate denied `authoring.draft.write` before routing. 2026-10-02 (432-41): that gate is
# deleted; the pty stays because a person drives chat at a terminal, and the driver answers nothing
# (a retired approval prompt makes it exit 86 rather than be answered).

banner 'LEG 5 — authoring against the local app (optional)'

CHAT_ARRIVAL_EXP="$DEMO_INIT/scripts/394-chat-arrival.exp"
if [ "$RUN_AUTHOR" != '1' ]; then
  record_leg 'L5 authoring (local app)' 'SKIP' \
    'NOT RUN, AND SAYING SO: set LIVE_FROM_ZERO_AUTHOR=1 to drive it. It spawns a real `agent-qa chat` under `expect` in the local-form project and lets the authoring loop take its real gate runs against 127.0.0.1:8931, which costs browser runs and model latency. What it would add is the tail of D-16s sentence; what already holds that ground is 394s own lane (demo/init/scripts/drain-394-loop.sh, legs C and E), against the same local target.'
elif [ ! -x /usr/bin/expect ] || [ ! -f "$CHAT_ARRIVAL_EXP" ]; then
  record_leg 'L5 authoring (local app)' 'RED' \
    "requested but not runnable: /usr/bin/expect or $CHAT_ARRIVAL_EXP is absent. A leg asked for and not run is reported, never silently dropped."
else
  P5="$(new_project author-local-form)"
  write_config "$P5" local-form
  seal_project "$P5"
  ( cd "$P5" && /usr/bin/expect -f "$CHAT_ARRIVAL_EXP" "${LIVE_FROM_ZERO_AUTHOR_TIMEOUT:-2400}" \
      "$P5/agent-qa.config.yaml" 'write a test for the login flow on local-form' \
      'list the test runs recorded in this project' ) \
    >"$TRANSCRIPTS/leg5-authoring.txt" 2>&1
  L5_RC=$?
  S5="$(ls -t "$P5/.agent-qa/sessions/"*.jsonl 2>/dev/null | head -1)"
  if [ -z "${S5:-}" ]; then
    record_leg 'L5 authoring (local app)' 'RED' \
      "the drive exited $L5_RC and wrote no session JSONL — no reading was taken (transcript: $TRANSCRIPTS/leg5-authoring.txt)"
  else
    L5_RECEIPTS="$(session_query "$S5" receipts)"
    L5_STATUS="$(session_query "$S5" status)"
    L5_REASON="$(session_query "$S5" reason)"
    printf '  session   %s\n  drive rc  %s\n  status    %s\n  receipts  %s\n  reason    %s\n' \
      "$S5" "$L5_RC" "$L5_STATUS" "$L5_RECEIPTS" "$L5_REASON"
    case "$L5_RECEIPTS" in
      *authoring.draft.write:executed*)
        record_leg 'L5 authoring (local app)' 'PASS' \
          "AUTHORING PROCEEDED AGAINST THE LOCAL APP: the session's own clause receipt records \`authoring.draft.write\` EXECUTED in a project whose only target is $FORM_URL, driven on a real terminal with nothing asked. status='$L5_STATUS'"
        ;;
      *)
        # THE RUNG IS NAMED OUT OF THE TRANSCRIPT, not guessed. The CLI prints an op's failure class
        # under the receipt line, and a rung reported as "it failed" is a rung nobody can act on.
        L5_CLASS="$(LC_ALL=C sed $'s/\033\[[0-9;]*m//g' "$TRANSCRIPTS/leg5-authoring.txt" \
          | grep -oE '[A-Za-z]+Error' | head -1)"
        record_leg 'L5 authoring (local app)' 'RED' \
          "THE LADDER'S NEXT RUNG, RECORDED RATHER THAN SMOOTHED OVER: the session was driven on a real terminal and the authoring op still did not execute (a drive rc of 86 means a retired approval prompt rendered and was not answered). receipts='$L5_RECEIPTS' status='$L5_STATUS' failure class='${L5_CLASS:-unclassified}' reason='$L5_REASON' (drive rc $L5_RC). Transcript: $TRANSCRIPTS/leg5-authoring.txt"
        ;;
    esac
  fi
fi

# ------------------------------------------------------------------------------------------------
# LEG 6 — THE ASK ROAD, UNDER A REAL PTY: is the change SHOWN, with nothing asked?
# ------------------------------------------------------------------------------------------------
#
# 2026-10-02 (Phase 432 plan 41, D-14): THERE IS NO PROMPT ON THIS ROAD ANY MORE. `agent-qa ask`
# writes the scaffold in its own call and shows the change it made. The driver never writes to the
# pty and no longer declines; the grade (`395-leg6-grade.sh`) reads the child's exit status where
# it read the decline. PASS is the summary, file and diff render with no prompt, exit 0 and no Git
# commit; ANY retired approval prompt is RED; SKIP is unchanged in kind (no render at all, k=1). The
# text below, to the banner, is the 395 record of the road when it had a prompt.
#
# THE BOUND ROUND 4 STATED, CLOSED HERE AT k=1. 395-VERIFICATION drove `agent.ask` through the
# production composition with a STUB planner and measured the complete set of bytes reaching the
# person's terminal before the decision: one line, the approval prompt itself. Its own closing
# sentence names what it did not do — *"I did not drive `agent-qa ask` against a live planner"*. This
# leg spends that inch, on the shipped `dist/cli.js`, over a live model.
#
# A REAL PTY IS THE WHOLE POINT AND NOT AN IMPLEMENTATION DETAIL. `createTtyConfirmPort` returns a
# prompt only when both streams are TTYs; under the pipes legs 2-4 use, the gate denies in
# `local-headless` before any prompt exists and the ordering this leg is about cannot be observed at
# all. A piped version of this leg would be green and would measure nothing.
#
# IT DECLINES. The reading is about what was on the terminal BEFORE the decision, so answering yes
# would apply a configuration change and turn a measurement into a write.
#
# WHAT MAKES THIS LEG RED: a prompt reached with no render above it — i.e. the CR-03 state, on the
# shipped one-shot verb. Byte offsets, not booleans: the render markers must all fall BEFORE the
# prompt's offset, so a render that arrived after the ask reds exactly as a missing one does.
#
# WHAT MAKES IT SKIP, ANNOUNCED THE WAY L5's IS: the live planner declining to emit the `write_test`
# clause on this single utterance — its known k=1 nondeterminism, the same one SC-5's own lane lives
# with. A skip states the residual bound and names the hermetic cells that hold the ground
# ((A1)/(A2) in `packages/cli/src/composition/__tests__/ask-present-road.test.ts`), never silence.

banner 'LEG 6 — the ask road under a real pty: the change shown, nothing asked?'

ASK_PTY="$REPO_ROOT/scripts/395-ask-road-pty.py"
# ONE PRODUCER, TWO CALLERS (395-28 · CR-04). The other caller is
# `scripts/395-leg6-instrument-check.sh`, which proves each refusal in `leg6_grade` fires without
# needing a live planner. Sourced here rather than re-typed so the two can never drift.
# shellcheck source=./395-leg6-grade.sh
. "$REPO_ROOT/scripts/395-leg6-grade.sh"
if ! command -v python3 >/dev/null || [ ! -f "$ASK_PTY" ]; then
  record_leg 'L6 ask road (pty)' 'SKIP' \
    "NOT RUN, AND SAYING SO: python3 or $ASK_PTY is absent, and this leg needs a real pty. The standing hermetic evidence on the identical route is (A1)/(A2) in packages/cli/src/composition/__tests__/ask-present-road.test.ts, which drive the same production composition with nothing asked."
else
  P6="$(new_project ask-road)"
  write_config "$P6" no-targets
  seal_project "$P6"
  L6_COMMITS_BEFORE="$(commit_count "$P6")"
  L6_VERDICT="$(python3 "$ASK_PTY" "$P6" "$CLI_ENTRY" \
    'write a test for booking.com checkout' \
    "$TRANSCRIPTS/leg6-ask-road.txt" "${LIVE_FROM_ZERO_TURN_TIMEOUT:-900}" 2>&1 | grep '^L6-VERDICT' || true)"
  # Offsets out of the verdict line, so every branch below reads one measurement.
  L6_PROMPT="$(printf '%s' "$L6_VERDICT" | sed -n 's/.*prompt=\([-0-9]*\).*/\1/p')"
  L6_SUMMARY="$(printf '%s' "$L6_VERDICT" | sed -n 's/.*summary=\([-0-9]*\).*/\1/p')"
  L6_FILES="$(printf '%s' "$L6_VERDICT" | sed -n 's/.*files=\([-0-9]*\).*/\1/p')"
  L6_DIFF="$(printf '%s' "$L6_VERDICT" | sed -n 's/.*diff=\([-0-9]*\).*/\1/p')"
  # `timedout` (395-28 · CR-04) tells a hang from an exit; `status` is the child's real exit code,
  # graded in place of the `declined` field the driver no longer emits (432-41).
  L6_STATUS="$(printf '%s' "$L6_VERDICT" | sed -n 's/.*status=\([-0-9]*\).*/\1/p')"
  L6_TIMEDOUT="$(printf '%s' "$L6_VERDICT" | sed -n 's/.*timedout=\([-0-9]*\).*/\1/p')"
  L6_COMMITS_AFTER="$(commit_count "$P6")"
  printf '  verdict   %s\n  commits   %s -> %s\n  status    %s\n  timedout  %s\n  transcript %s\n' \
    "${L6_VERDICT:-<none>}" "$L6_COMMITS_BEFORE" "$L6_COMMITS_AFTER" \
    "${L6_STATUS:-<none>}" "${L6_TIMEDOUT:-<none>}" "$TRANSCRIPTS/leg6-ask-road.txt"

  # THE GRADING IS NOT HERE (395-28 · CR-04). It lives in `scripts/395-leg6-grade.sh`, sourced above,
  # because `scripts/395-leg6-instrument-check.sh` drives THAT function with injected measurements to
  # prove each of its refusals fires — with no live planner and in seconds. If the verdict logic were
  # inline here, the check could only prove a RE-TYPED SIBLING falsifiable, which is the exact
  # instrument failure this phase has spent the round removing from its own scripts.
  #
  # THIS BLOCK MEASURES; `leg6_grade` GRADES. Everything below the line is a reading.
  L6_KNOWN_CAUSE=0
  grep -q 'No capability in this build handles' "$TRANSCRIPTS/leg6-ask-road.txt" 2>/dev/null \
    && L6_KNOWN_CAUSE=1

  leg6_grade "$L6_VERDICT" "${L6_PROMPT:--1}" "${L6_SUMMARY:--1}" "${L6_FILES:--1}" \
    "${L6_DIFF:--1}" "${L6_STATUS:--1}" "${L6_TIMEDOUT:-0}" \
    "$L6_COMMITS_BEFORE" "$L6_COMMITS_AFTER" \
    "$TRANSCRIPTS/leg6-ask-road.txt" "$L6_KNOWN_CAUSE"
  record_leg 'L6 ask road (pty)' "$L6_GRADE_VERDICT" "$L6_GRADE_WHY"
fi

# ------------------------------------------------------------------------------------------------
# THE SELF-TEST — an instrument that cannot fail is not an instrument
# ------------------------------------------------------------------------------------------------
#
# Neuters LEG 1's control half by asking the gate about a token it must accept and grading the answer
# as though a refusal were expected. The lane must exit 1. Run it whenever this file is edited: it is
# the same discipline the phase's scan mutation driver (since removed) applied to itself, for the same reason.

if [ "$SELFTEST" = 'neutered' ]; then
  banner 'SELF-TEST — the lane is asked to grade a control it must refuse'
  # `booking.com` IS a hostname and this lane's LEG 1 knows it: the control arm asserts it reaches
  # `applied` (432-41 re-pin; `proposed` before 432-11). Asking the SAME `probe_gate` to expect `not-a-hostname` for it is the
  # measurement a lane that had stopped working would make, and it must not be able to report PASS.
  # Driven through the real helper rather than a re-typed copy, so what is proven falsifiable is the
  # instrument LEG 1 actually uses.
  LEG1_RC=0
  probe_gate 'booking.com' not-a-hostname
  if [ "$LEG1_RC" -eq 0 ]; then
    record_leg 'SELFTEST' 'RED' \
      'THE INSTRUMENT IS BLIND: `probe_gate` accepted a deliberately-wrong expectation for a token the gate demonstrably does not refuse. Every LEG 1 verdict above is therefore worthless.'
  else
    record_leg 'SELFTEST' 'RED' \
      'NEUTERED AS ASKED, AND REFUSED: `probe_gate` rejected the deliberately-wrong expectation, so LEG 1 is able to fail rather than able only to pass. This mode exits 1 BY DESIGN — a green here would be the finding.'
  fi
fi

# ------------------------------------------------------------------------------------------------
# the receipt
# ------------------------------------------------------------------------------------------------

banner 'RECEIPT'
LANE_RC=0
for index in "${!LEG_NAMES[@]}"; do
  printf '%-36s %s\n' "${LEG_NAMES[$index]}" "${LEG_VERDICTS[$index]}"
  [ "${LEG_VERDICTS[$index]}" = 'RED' ] && LANE_RC=1
done

printf '\n'
if [ "$LANE_RC" -eq 0 ]; then
  printf 'LANE GREEN — every leg measured what it was written to measure.\n'
  printf 'THE LADDER AFTER 395-12: rung 3 is OPEN — in a project that HAS a configuration and\n'
  printf 'declares no targets, the utterance reaches the real scaffold, which merges one target\n'
  printf 'entry in its own call with no commit (432-11). Rung 2 is UNCHANGED and is not this phase\n'
  printf 'to close: a project with no model anywhere still cannot chat (WINDOWS 130/133). Rung 1 is\n'
  printf 'CLOSED (432-05 #134): the local demo app is expressible through the D-15 hostname gate.\n'
  printf 'Green here means the LADDER is exactly where legs 1-3 say it is, and nothing more.\n'
else
  printf 'LANE RED — at least one leg moved. Read its WHY: each is written to name which rung changed.\n'
fi
printf 'transcripts: %s\n' "$TRANSCRIPTS"
exit "$LANE_RC"
