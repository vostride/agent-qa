#!/usr/bin/env bash
# Runs the pinned MCP conformance suite against the built binary and reds only on a new failure.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── The pins. Every one of these is a deliberate-commit knob, not a default. ────────────────────
CONFORMANCE_PIN="0.2.0-alpha.11"
REQUIREMENTS_REVISION="2026-07-28"
# The frozen denominator: the `server` scenarios the pinned requirements list.
FROZEN_REQUIRED_SERVER_SCENARIOS=37
# Required (37) + not-scored (13: 10 tasks-extension, 3 pending). Everything the run must execute.
FROZEN_EXECUTED_SCENARIOS=50
BASELINE_REL="packages/mcp/conformance-baseline.yaml"
BASELINE="$ROOT/$BASELINE_REL"

MODE="run"
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --selftest) MODE="selftest" ;;
    --mint-baseline) MODE="mint" ;;
    --no-build) DO_BUILD=0 ;;
    *) echo "FATAL: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

fatal() { echo "FATAL: $*" >&2; exit 1; }
note() { echo "[mcp-conformance] $*" >&2; }

# PORTABLE FORM, DELIBERATELY. `mktemp -d -t <prefix>` is a BSD idiom: on macOS it appends random
# characters to the prefix, and on GNU coreutils the same call FAILS with "too few X's in template".
# This script runs on the operator's mac AND on the ubuntu CI runner, and a guard that only works on
# one platform is the exact shape of a defect this project has already shipped once.
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/mcp-conformance.XXXXXXXX")"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  # The sandbox holds the fixture and the results tree. It is removed unconditionally: a results
  # tree left behind in a CI workspace is an artifact nobody asked for.
  if [ -n "${SANDBOX:-}" ] && [ -d "$SANDBOX" ]; then rm -rf "$SANDBOX"; fi
}
trap cleanup EXIT

# Helper programs are files, never shell strings, so quoting cannot mangle them.
cat > "$SANDBOX/required.mjs" <<'REQUIRED_MJS'
// Print the frozen required SERVER scenario list, one per line, read from the suite's OWN shipped
// requirements file. Restating the list here would be a second copy free to disagree with the tool.
import { readFileSync } from 'node:fs'
const text = readFileSync(process.argv[2], 'utf8')
const out = []
let inServer = false
for (const line of text.split('\n')) {
  if (/^server:\s*$/.test(line)) { inServer = true; continue }
  if (!inServer) continue
  const m = line.match(/^ {2}- (\S+)\s*$/)
  if (m) { out.push(m[1]); continue }
  if (/^\S/.test(line)) inServer = false
}
process.stdout.write(out.join('\n') + (out.length ? '\n' : ''))
REQUIRED_MJS

cat > "$SANDBOX/scan.mjs" <<'SCAN_MJS'
// Read a conformance results tree and answer two questions with ONE traversal:
//   --score    raw counts over the required set, using the tool's own scenario verdict rule
//              (a scenario passes iff it has zero FAILURE checks and at least one SUCCESS check)
//   --mint     the baseline body: one `scenario:check-id` entry per failing check
// A check counts as a baseline-relevant failure at FAILURE *or* WARNING, because that is the
// predicate the tool's own expected-failures evaluator uses. A scenario can therefore be a green
// tick in the printed summary and still owe a baseline entry.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
const [, , mode, resultsDir, requiredFile] = process.argv
const required = readFileSync(requiredFile, 'utf8').split('\n').filter(Boolean)
const byScenario = new Map()
if (existsSync(resultsDir)) {
  for (const dir of readdirSync(resultsDir)) {
    const p = `${resultsDir}/${dir}/checks.json`
    if (!existsSync(p)) continue
    const scenario = dir.replace(/^server-/, '').replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, '')
    byScenario.set(scenario, JSON.parse(readFileSync(p, 'utf8')))
  }
}
if (mode === '--executed') {
  process.stdout.write(String(byScenario.size) + '\n')
} else if (mode === '--missing') {
  process.stdout.write(required.filter((s) => !byScenario.has(s)).join('\n') + '\n')
} else if (mode === '--score') {
  let passed = 0
  for (const s of required) {
    const checks = byScenario.get(s)
    if (!checks) continue
    const ok = checks.filter((c) => c.status === 'SUCCESS').length
    const bad = checks.filter((c) => c.status === 'FAILURE').length
    if (bad === 0 && ok > 0) passed += 1
  }
  process.stdout.write(`${passed} ${required.length}\n`)
} else if (mode === '--mint') {
  const lines = []
  for (const s of required) {
    const checks = byScenario.get(s)
    if (!checks) continue
    const seen = new Set()
    for (const c of checks) {
      if (c.status !== 'FAILURE' && c.status !== 'WARNING') continue
      if (seen.has(c.id)) continue
      seen.add(c.id)
      // NO SPACE after the colon: `- scenario:check-id` is a YAML scalar, `- scenario: check-id`
      // is a map and the tool refuses the file.
      lines.push(`  - ${s}:${c.id}`)
    }
  }
  process.stdout.write(lines.join('\n') + '\n')
} else {
  process.stderr.write(`unknown mode ${mode}\n`)
  process.exit(2)
}
SCAN_MJS

cat > "$SANDBOX/entries.mjs" <<'ENTRIES_MJS'
// Count the `scenario` / `scenario:check-id` entries the committed baseline declares under
// `server:`. Used by gate G5 against the number the tool reports as MATCHED this run.
import { readFileSync } from 'node:fs'
const text = readFileSync(process.argv[2], 'utf8')
let inServer = false
let n = 0
for (const line of text.split('\n')) {
  if (/^server:\s*$/.test(line)) { inServer = true; continue }
  if (!inServer) continue
  if (/^ {2}- \S+\s*$/.test(line)) { n += 1; continue }
  if (/^\S/.test(line)) inServer = false
}
process.stdout.write(String(n) + '\n')
ENTRIES_MJS

cat > "$SANDBOX/freeport.mjs" <<'FREEPORT_MJS'
import { createServer } from 'node:net'
const s = createServer()
s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => process.stdout.write(String(port))) })
FREEPORT_MJS

# ── Step 1: build the workspace. A conformance run against a stale `dist` measures the previous
# implementation and reports a confident number — the documented stale-dist trap.
if [ "$DO_BUILD" -eq 1 ]; then
  note "building the workspace (the binary under test is packages/cli/dist/cli.js)"
  (cd "$ROOT" && pnpm build >/dev/null)
fi
BINARY="$ROOT/packages/cli/dist/cli.js"
[ -f "$BINARY" ] || fatal "the built binary is missing at $BINARY — run pnpm build"

# ── Step 2: fetch the pinned referee. Loud on a network failure by construction.
note "installing @modelcontextprotocol/conformance@$CONFORMANCE_PIN"
mkdir -p "$SANDBOX/referee"
printf '{"name":"conformance-referee","private":true,"version":"0.0.0"}\n' > "$SANDBOX/referee/package.json"
(cd "$SANDBOX/referee" && npm install --silent --no-audit --no-fund \
  "@modelcontextprotocol/conformance@$CONFORMANCE_PIN" >/dev/null) \
  || fatal "could not install @modelcontextprotocol/conformance@$CONFORMANCE_PIN — registry unreachable or the pin was yanked. This job does NOT pass when it cannot fetch its own referee."
CONFORMANCE="$SANDBOX/referee/node_modules/.bin/conformance"
REQUIREMENTS_YAML="$SANDBOX/referee/node_modules/@modelcontextprotocol/conformance/requirements/$REQUIREMENTS_REVISION.yaml"
[ -x "$CONFORMANCE" ] || fatal "the conformance binary is missing at $CONFORMANCE"
[ -f "$REQUIREMENTS_YAML" ] || fatal "the frozen requirement set $REQUIREMENTS_REVISION is missing from the pinned package"
INSTALLED_PIN="$("$CONFORMANCE" --version)"
[ "$INSTALLED_PIN" = "$CONFORMANCE_PIN" ] \
  || fatal "the installed referee reports $INSTALLED_PIN, not the pin $CONFORMANCE_PIN"

# ── Gate G1: the frozen denominator, read from the suite's own shipped data.
node "$SANDBOX/required.mjs" "$REQUIREMENTS_YAML" > "$SANDBOX/required.txt"
REQUIRED_COUNT="$(grep -c '' "$SANDBOX/required.txt" || true)"
[ "$REQUIRED_COUNT" -eq "$FROZEN_REQUIRED_SERVER_SCENARIOS" ] \
  || fatal "G1: requirements $REQUIREMENTS_REVISION lists $REQUIRED_COUNT server scenarios, the frozen denominator is $FROZEN_REQUIRED_SERVER_SCENARIOS. A pin bump changed the set — re-mint the baseline and update the frozen counts in a deliberate commit."

# The hermetic fixture, in a mktemp sandbox that is never the developer's own project.
FIXTURE="$SANDBOX/fixture"
mkdir -p "$FIXTURE/.agent-qa"
cat > "$FIXTURE/agent-qa.config.yaml" <<'FIXTURE_YAML'
# Hermetic conformance fixture. Minted per run, thrown away with the sandbox.
workspace:
  testMatch: ['tests/**/*.yaml']
  testPathIgnore: []
  suiteMatch: ['suites/**/*.suite.yaml']
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
use:
  mobile:
    appState: preserve
FIXTURE_YAML
# MCP masks with the declared secrets and needs a readable file; this one declares none.
: > "$FIXTURE/.env.secrets.local"

start_fixture_server() {
  PORT="$(node "$SANDBOX/freeport.mjs")"
  [ -n "$PORT" ] || fatal "could not obtain a free loopback port"
  ( cd "$FIXTURE" && exec node "$BINARY" mcp --http "$PORT" ) \
    > "$SANDBOX/server.out" 2> "$SANDBOX/server.err" &
  SERVER_PID=$!
  URL="http://127.0.0.1:$PORT/mcp"
  # Bounded readiness wait: generous for a cold runner, bounded so a dead server cannot wedge.
  local attempt=0
  while [ "$attempt" -lt 60 ]; do
    if kill -0 "$SERVER_PID" 2>/dev/null && curl -sf -o /dev/null \
        -X POST "$URL" \
        -H 'content-type: application/json' \
        -H 'accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'; then
      note "fixture server ready on $URL (pid $SERVER_PID)"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  echo "--- server stderr ---" >&2
  cat "$SANDBOX/server.err" >&2 || true
  fatal "the fixture server did not become ready on $URL within 30s"
}

# ── The vacuity gates, as ONE function, so `--selftest` fires the same code the real run does.
# $1 results dir, $2 the run's stdout log (or "" to skip G5), $3 the baseline path (or "")
assert_not_vacuous() {
  local results="$1" log="$2" baseline="$3"
  local executed missing
  executed="$(node "$SANDBOX/scan.mjs" --executed "$results" "$SANDBOX/required.txt")"
  [ "$executed" -eq "$FROZEN_EXECUTED_SCENARIOS" ] \
    || fatal "G2: the run executed $executed scenarios, the frozen set is $FROZEN_EXECUTED_SCENARIOS. A job that runs fewer cases than it claims is a job that passes by running nothing."
  missing="$(node "$SANDBOX/scan.mjs" --missing "$results" "$SANDBOX/required.txt" | tr -d '\n')"
  [ -z "$missing" ] \
    || fatal "G3: required scenarios produced no result directory: $missing"
  local passed total
  read -r passed total <<EOF
$(node "$SANDBOX/scan.mjs" --score "$results" "$SANDBOX/required.txt")
EOF
  [ "$total" -eq "$FROZEN_REQUIRED_SERVER_SCENARIOS" ] \
    || fatal "G4: the score denominator is $total, the frozen denominator is $FROZEN_REQUIRED_SERVER_SCENARIOS"
  if [ -n "$log" ] && [ -n "$baseline" ]; then
    local declared matched
    declared="$(node "$SANDBOX/entries.mjs" "$baseline")"
    matched="$(grep -c '^  ~ ' "$log" || true)"
    [ "$declared" -eq "$matched" ] \
      || fatal "G5: the baseline declares $declared entries but the run matched $matched. An entry whose check id no longer exists is silently ignored by the tool — it is dead weight that can hide a real failure. Re-mint the baseline."
  fi
  SCORE_PASSED="$passed"
  SCORE_TOTAL="$total"
}

publish_score() {
  local exit_code="$1" declared="$2"
  local pct
  pct="$(node -e 'const [p,t]=process.argv.slice(1).map(Number);process.stdout.write(t?((100*p)/t).toFixed(1):"0.0")' "$SCORE_PASSED" "$SCORE_TOTAL")"
  # Raw counts always, the percentage only beside them: a rate alone hides a shrinking denominator.
  local headline="MCP conformance: ${SCORE_PASSED}/${SCORE_TOTAL} required server scenarios passed (${pct}%)"
  echo ""
  echo "$headline"
  echo "  suite pin            @modelcontextprotocol/conformance@$CONFORMANCE_PIN"
  echo "  requirement set      $REQUIREMENTS_REVISION (frozen)"
  echo "  scenarios executed   $FROZEN_EXECUTED_SCENARIOS ($FROZEN_REQUIRED_SERVER_SCENARIOS required + $((FROZEN_EXECUTED_SCENARIOS - FROZEN_REQUIRED_SERVER_SCENARIOS)) not scored)"
  echo "  baseline entries     $declared (declared in $BASELINE_REL, all matched this run)"
  echo "  ratchet exit code    $exit_code (0 = no NEW failure and no stale entry; the score never gates)"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### $headline"
      echo ""
      echo "| | |"
      echo "|---|---|"
      echo "| suite pin | \`@modelcontextprotocol/conformance@$CONFORMANCE_PIN\` |"
      echo "| requirement set | \`$REQUIREMENTS_REVISION\` (frozen) |"
      echo "| scenarios executed | $FROZEN_EXECUTED_SCENARIOS ($FROZEN_REQUIRED_SERVER_SCENARIOS required + $((FROZEN_EXECUTED_SCENARIOS - FROZEN_REQUIRED_SERVER_SCENARIOS)) not scored) |"
      echo "| baseline entries | $declared, all matched |"
      echo "| ratchet exit code | $exit_code |"
      echo ""
      echo "The score is published, never gated (D-18). This job reds only on a failure that is NOT"
      echo "in \`$BASELINE_REL\`, or on a baselined entry that has started passing."
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

# ── Mode: mint. Prints a fresh baseline body; the human writes the header and commits it.
if [ "$MODE" = "mint" ]; then
  start_fixture_server
  set +e
  "$CONFORMANCE" server --url "$URL" --requirements "$REQUIREMENTS_REVISION" \
    -o "$SANDBOX/results" > "$SANDBOX/mint.log" 2>&1
  set -e
  assert_not_vacuous "$SANDBOX/results" "" ""
  note "score at mint time: $SCORE_PASSED/$SCORE_TOTAL"
  echo "server:"
  node "$SANDBOX/scan.mjs" --mint "$SANDBOX/results" "$SANDBOX/required.txt"
  exit 0
fi

# ── Mode: selftest. Three proofs that this script can fail. Exit 0 iff every one behaved.
if [ "$MODE" = "selftest" ]; then
  note "selftest: four proofs, each of which must FAIL as required"

  # S1 — the referee against a port nothing is listening on. If this exits 0 the runner is not
  # actually talking to a server and every green run above it means nothing.
  DEAD_PORT="$(node "$SANDBOX/freeport.mjs")"
  set +e
  "$CONFORMANCE" server --url "http://127.0.0.1:$DEAD_PORT/mcp" --scenario tools-list \
    -o "$SANDBOX/s1" > "$SANDBOX/s1.log" 2>&1
  S1=$?
  set -e
  [ "$S1" -ne 0 ] || fatal "S1: the referee reported success against a DEAD PORT (exit $S1)"
  note "S1 dead port: exit $S1 (required nonzero) ✓"

  start_fixture_server

  # S2 — the executed-case pin, PROVEN by making the suite run a smaller set. One scenario instead
  # of fifty. G2 must fire. Without this proof the pin is a comment.
  set +e
  "$CONFORMANCE" server --url "$URL" --scenario tools-list -o "$SANDBOX/s2" > "$SANDBOX/s2.log" 2>&1
  set -e
  set +e
  ( assert_not_vacuous "$SANDBOX/s2" "" "" ) > "$SANDBOX/s2.gate" 2>&1
  S2=$?
  set -e
  [ "$S2" -ne 0 ] || fatal "S2: the vacuity gates PASSED over a run of one scenario — the executed-case pin is decoration"
  grep -q '^FATAL: G2:' "$SANDBOX/s2.gate" \
    || fatal "S2: the run of one scenario failed for the wrong reason: $(cat "$SANDBOX/s2.gate")"
  note "S2 truncated set (1 scenario, not $FROZEN_EXECUTED_SCENARIOS): exit $S2, G2 fired ✓"
  sed -n 's/^FATAL: /    /p' "$SANDBOX/s2.gate" >&2

  # S3 — the ratchet's boundary, driven in BOTH directions over a known-PASSING scenario.
  #      stale entry present  -> exit 1
  #      stale entry removed  -> exit 0
  printf 'server:\n  - tools-list\n' > "$SANDBOX/s3-stale.yaml"
  printf 'server: []\n' > "$SANDBOX/s3-clean.yaml"
  set +e
  "$CONFORMANCE" server --url "$URL" --scenario tools-list \
    --expected-failures "$SANDBOX/s3-stale.yaml" -o "$SANDBOX/s3a" > "$SANDBOX/s3a.log" 2>&1
  S3A=$?
  "$CONFORMANCE" server --url "$URL" --scenario tools-list \
    --expected-failures "$SANDBOX/s3-clean.yaml" -o "$SANDBOX/s3b" > "$SANDBOX/s3b.log" 2>&1
  S3B=$?
  set -e
  [ "$S3A" -eq 1 ] || fatal "S3: a baseline entry for a PASSING scenario exited $S3A, expected 1 (stale baseline)"
  grep -q 'Stale baseline entries' "$SANDBOX/s3a.log" \
    || fatal "S3: exit 1 arrived without the stale-baseline diagnosis"
  [ "$S3B" -eq 0 ] || fatal "S3: removing the stale entry exited $S3B, expected 0"
  note "S3 ratchet boundary: with the stale entry exit $S3A, without it exit $S3B ✓"

  # S4 — the dead-entry gate. An entry naming a check id that does not exist is IGNORED by the
  # suite: not a failure, not stale, no diagnostic, exit 0. That is how a renamed check turns a
  # baseline line into permanent cover for whatever fails in its place. G5 is the only thing that
  # notices, so G5 gets its own proof over a FULL run.
  [ -f "$BASELINE" ] || fatal "S4: the committed baseline is missing at $BASELINE_REL"
  cp "$BASELINE" "$SANDBOX/s4-baseline.yaml"
  printf '  - tools-list:this-check-id-does-not-exist\n' >> "$SANDBOX/s4-baseline.yaml"
  set +e
  "$CONFORMANCE" server --url "$URL" --requirements "$REQUIREMENTS_REVISION" \
    --expected-failures "$SANDBOX/s4-baseline.yaml" -o "$SANDBOX/s4" > "$SANDBOX/s4.log" 2>&1
  S4_TOOL=$?
  ( assert_not_vacuous "$SANDBOX/s4" "$SANDBOX/s4.log" "$SANDBOX/s4-baseline.yaml" ) > "$SANDBOX/s4.gate" 2>&1
  S4=$?
  set -e
  [ "$S4_TOOL" -eq 0 ] \
    || fatal "S4: the suite itself reported the dead entry (exit $S4_TOOL) — G5 may be redundant, re-read the tool's evaluator before deleting it"
  [ "$S4" -ne 0 ] || fatal "S4: a baseline entry matching NO check passed the vacuity gates — G5 is decoration"
  grep -q '^FATAL: G5:' "$SANDBOX/s4.gate" \
    || fatal "S4: the doctored baseline failed for the wrong reason: $(cat "$SANDBOX/s4.gate")"
  note "S4 dead baseline entry: the suite exited $S4_TOOL (silent), G5 fired ✓"
  sed -n 's/^FATAL: /    /p' "$SANDBOX/s4.gate" >&2

  note "selftest: all four proofs failed as required"
  exit 0
fi

# ── Mode: run (default).
[ -f "$BASELINE" ] || fatal "the committed baseline is missing at $BASELINE_REL"
DECLARED_ENTRIES="$(node "$SANDBOX/entries.mjs" "$BASELINE")"
[ "$DECLARED_ENTRIES" -gt 0 ] \
  || fatal "the baseline declares zero entries — an empty baseline over a server with known structural failures is a file that cannot ratchet"

start_fixture_server
note "running $FROZEN_EXECUTED_SCENARIOS scenarios at requirements $REQUIREMENTS_REVISION"
set +e
"$CONFORMANCE" server \
  --url "$URL" \
  --requirements "$REQUIREMENTS_REVISION" \
  --expected-failures "$BASELINE" \
  -o "$SANDBOX/results" 2>&1 | tee "$SANDBOX/run.log"
RUN_EXIT="${PIPESTATUS[0]}"
set -e

# The gates run BEFORE the exit code is honoured, so "the job ran nothing" is never reported as
# "the job passed".
assert_not_vacuous "$SANDBOX/results" "$SANDBOX/run.log" "$BASELINE"
publish_score "$RUN_EXIT" "$DECLARED_ENTRIES"

exit "$RUN_EXIT"
