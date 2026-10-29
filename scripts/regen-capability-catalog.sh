#!/usr/bin/env bash
# The one writer of the committed capability catalog; it refuses while the suite is otherwise red.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$ROOT/packages/cli"
SUITE_REL="src/__tests__/conformance/"
CATALOG_REL="packages/cli/capability-catalog/capability-catalog.json"
CATALOG="$ROOT/$CATALOG_REL"

# Exact full names of the cells allowed red; each one's subject is the artifact's freshness.
ALLOWED_RED_NAMES="the capability catalog regenerates byte-identically from the live seams into the committed artifact
committed artifacts carry the reviewed read contracts GOLDEN-CATALOG-COMPLETE: the committed golden ledger and capability catalog carry every addressed read op as the live tree declares it
LIVE-GUIDANCE: the guide, pointer and every source and packaged skill quote only live names LIVE-GUIDANCE-TOOLS: every agent_qa_* name is a projected tool whose ops the catalog carries
the /help census — one list of what chat understands set-equals the committed catalog's aliases plus the directives plus the passthrough
the chat host's discovery UX is a projection of the catalog offers every alias row in the form the shipped resolver actually answers
the committed catalogue describes only the live tree op rows are the live registry, tools are the twenty projected tools, and no row names a retired capability or a permission"
# Vacuity floor: a gate that collected nothing must not pass; raise it in the diff that adds cells.
FROZEN_MIN_TESTS=129
# The artifact's row floor, so a truncated or empty mint cannot be written; it follows the mint.
FROZEN_MIN_ROWS=52

EMIT_FLAG="AGENT_QA_398_CATALOG_EMIT"
EMIT_BEGIN="<<<398-01-CATALOG-BEGIN>>>"
EMIT_END="<<<398-01-CATALOG-END>>>"
SELFTEST_PROBE="$CLI_DIR/src/__tests__/conformance/regen-capability-catalog-selftest-probe.test.ts"

MODE="run"
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --write) MODE="write" ;;
    --selftest) MODE="selftest" ;;
    --gate-only) MODE="gate-only" ;;
    --no-build) DO_BUILD=0 ;;
    *) echo "FATAL: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

fatal() { echo "FATAL: $*" >&2; exit 1; }
note() { echo "[regen-capability-catalog] $*" >&2; }

# PORTABLE FORM, DELIBERATELY. `mktemp -d -t <prefix>` is a BSD idiom: on macOS it appends random
# characters to the prefix, on GNU coreutils the same call FAILS with "too few X's in template".
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/398regen.XXXXXXXX")"

cleanup() {
  # The probe is removed unconditionally and first: a selftest interrupted half way through must
  # not leave a deliberately failing test file in the suite.
  [ -f "$SELFTEST_PROBE" ] && rm -f "$SELFTEST_PROBE"
  [ -n "${SANDBOX:-}" ] && [ -d "$SANDBOX" ] && rm -rf "$SANDBOX"
  return 0
}
trap cleanup EXIT

# ── Helper programs. Written to files, never passed as shell strings: a quoted argument mangled by
# the shell is how a harness ends up measuring an implementation nobody wrote.
cat > "$SANDBOX/classify.mjs" <<'CLASSIFY_MJS'
// Read vitest's JSON report and classify the failures against the allowed-red list.
// Prints `TOTAL=<n>`, then one `UNEXPECTED <full name>` line per failure outside the list, one
// `ALLOWED <full name>` line per failure inside it, and one `MISSINGALLOWED <full name>` line per
// list entry naming a cell THIS RUN DID NOT CONTAIN. That last line is the list's own self-check:
// an allow-list entry for a renamed or deleted cell is a hole nothing will ever fire through, so
// nothing would ever reveal it. Decides nothing; bash decides.
import { readFileSync } from 'node:fs'
const [, , reportPath, allowedPath] = process.argv
let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (err) {
  process.stdout.write(`UNREADABLE ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(0)
}
const allowed = readFileSync(allowedPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
const results = Array.isArray(report.testResults) ? report.testResults : []
process.stdout.write(`TOTAL=${Number(report.numTotalTests ?? 0)}\n`)
const collected = new Set()
for (const file of results) {
  for (const assertion of file.assertionResults ?? []) {
    const name = String(assertion.fullName ?? '')
    collected.add(name)
    if (assertion.status !== 'failed') continue
    process.stdout.write(`${allowed.includes(name) ? 'ALLOWED' : 'UNEXPECTED'} ${name}\n`)
  }
}
for (const name of allowed) {
  if (!collected.has(name)) process.stdout.write(`MISSINGALLOWED ${name}\n`)
}
CLASSIFY_MJS

cat > "$SANDBOX/inspect.mjs" <<'INSPECT_MJS'
// Answer, with ONE parse, every question a truncated mint would fail: is it valid JSON at all, how
// many rows does it carry, and does its own count sentence agree.
import { readFileSync } from 'node:fs'
try {
  const catalog = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const rows = Array.isArray(catalog.rows) ? catalog.rows.length : -1
  process.stdout.write(`ROWS=${rows}\nCOUNT=${Number(catalog.rowCount ?? -1)}\n`)
} catch (err) {
  process.stdout.write(
    `ROWS=-1\nCOUNT=-1\n`
    + `ERROR=${err instanceof Error ? err.message : err}\n`,
  )
}
INSPECT_MJS

cat > "$SANDBOX/probe.test.ts" <<'PROBE_TS'
// TRANSIENT — written by `scripts/regen-capability-catalog.sh --selftest` and removed by its EXIT trap.
//
// The gate this script carries refuses to regenerate the catalog while the conformance suite is red
// for any reason other than the freshness cell itself. This file is the deliberate other reason:
// it fails by name, so the selftest can observe the refusal fire instead of assuming it would.
import { describe, expect, it } from 'vitest'

describe('regen selftest probe', () => {
  it('fails on purpose so the refuse-while-red gate can be observed firing', () => {
    expect('the regen gate must refuse while this is red').toBe('and it must say which cell')
  })
})
PROBE_TS

# ── The gate ────────────────────────────────────────────────────────────────────────────────────
#
# Runs the conformance suite and refuses on any failure outside the allowed-red list. Those legs are
# NOT filtered out by the runner: they stay in and their failures are classified by name. That is
# stricter than an exclusion — an exclusion would also hide one of them breaking for a reason having
# nothing to do with the artifact's contents.
run_gate() {
  local report="$SANDBOX/results.$$.json"
  note "gate: running the conformance suite"
  # The exit code is read from the process, never through a pipe, and a red suite is EXPECTED here
  # (the freshness cell) so the run itself must not abort the script under `set -e`.
  (cd "$CLI_DIR" && npx vitest run "$SUITE_REL" --reporter=json --outputFile="$report") \
    > "$SANDBOX/gate.stdout" 2>&1 || true

  [ -f "$report" ] || fatal "the suite produced no JSON report — it did not run at all"

  printf '%s\n' "$ALLOWED_RED_NAMES" > "$SANDBOX/allowed-red.txt"

  local classified
  classified="$(node "$SANDBOX/classify.mjs" "$report" "$SANDBOX/allowed-red.txt")"

  case "$classified" in
    UNREADABLE*) fatal "the suite's JSON report could not be read: ${classified#UNREADABLE }" ;;
  esac

  # THE ALLOW-LIST'S OWN CHECK, before any verdict is read off it. An entry naming a cell that no
  # longer exists is a permission granted to nothing — invisible, because a hole nothing fires
  # through never reports.
  local missing_allowed
  missing_allowed="$(printf '%s\n' "$classified" | sed -n 's/^MISSINGALLOWED //p')"
  if [ -n "$missing_allowed" ]; then
    echo "FATAL: the allowed-red list names cells this suite does not contain:" >&2
    printf '  - %s\n' "$missing_allowed" >&2
    echo "An allow-list entry for a renamed or deleted cell is a hole nothing can fire through." >&2
    echo "Fix the name in ALLOWED_RED_NAMES, or remove the entry." >&2
    exit 1
  fi

  local total
  total="$(printf '%s\n' "$classified" | sed -n 's/^TOTAL=//p')"
  [ -n "$total" ] || fatal "the suite's JSON report carried no test total"
  if [ "$total" -lt "$FROZEN_MIN_TESTS" ]; then
    fatal "the suite ran $total tests, fewer than the frozen floor of $FROZEN_MIN_TESTS — a gate that passes because nothing ran is not a gate"
  fi
  note "gate: $total tests collected"

  local unexpected
  unexpected="$(printf '%s\n' "$classified" | sed -n 's/^UNEXPECTED //p')"
  if [ -n "$unexpected" ]; then
    echo "FATAL: the conformance suite is red for a reason other than the capability catalog:" >&2
    printf '  - %s\n' "$unexpected" >&2
    echo "REFUSING to regenerate. A regeneration against a red tree records whatever that tree" >&2
    echo "declares, and the reviewer sees an artifact diff with no failing test beside it. Fix the" >&2
    echo "failures above first (D-01)." >&2
    exit 1
  fi

  local allowed
  allowed="$(printf '%s\n' "$classified" | sed -n 's/^ALLOWED //p')"
  if [ -n "$allowed" ]; then
    note "gate: only committed-artifact cells are red, as expected before a regeneration"
  else
    note "gate: no committed-artifact cell is red — the catalog already matches the tree"
  fi
  note "gate: PASSED — no failure outside the catalog"
}

# ── The mint ────────────────────────────────────────────────────────────────────────────────────
#
# One run of the same suite with the emit flag set. The suite PRINTS the catalog between sentinels;
# this function lifts it out and writes it into the sandbox. Nothing inside the suite writes a file.
#
# It sets a GLOBAL rather than printing the path, deliberately: `X="$(mint_catalog)"` would run this
# in a subshell, where `fatal`'s `exit 1` kills only that subshell — the script would sail on with
# an empty path and a vacuity gate that fired into the void.
MINTED=""
mint_catalog() {
  local out="$SANDBOX/minted.json"
  note "mint: emitting a fresh catalog from the composition root"
  # The mint runs only the emitting file: parallel workers' output corrupts the sentinel JSON.
  (cd "$CLI_DIR" && env "$EMIT_FLAG=1" npx vitest run "${SUITE_REL}catalog.test.ts" --disable-console-intercept) \
    > "$SANDBOX/mint.stdout" 2>&1 || true

  awk -v begin="$EMIT_BEGIN" -v end="$EMIT_END" \
    'index($0, begin) { capturing = 1; next } index($0, end) { capturing = 0 } capturing { print }' \
    "$SANDBOX/mint.stdout" > "$out"

  [ -s "$out" ] || fatal "the suite printed no catalog between the sentinels — is $EMIT_FLAG still read by catalog.ts?"

  local inspected rows count
  inspected="$(node "$SANDBOX/inspect.mjs" "$out")"
  rows="$(printf '%s\n' "$inspected" | sed -n 's/^ROWS=//p')"
  count="$(printf '%s\n' "$inspected" | sed -n 's/^COUNT=//p')"
  [ "$rows" -ge "$FROZEN_MIN_ROWS" ] \
    || fatal "the minted catalog carries $rows rows, fewer than the frozen floor of $FROZEN_MIN_ROWS ($(printf '%s' "$inspected" | tr '\n' ' '))"
  [ "$count" = "$rows" ] || fatal "the minted catalog's own count sentence ($count) disagrees with its rows ($rows)"
  note "mint: $rows rows"
  MINTED="$out"
}

build_workspace() {
  if [ "$DO_BUILD" -eq 0 ]; then
    note "build: SKIPPED (--no-build) — the catalog may be minted against a stale dist"
    return 0
  fi
  note "build: rebuilding the workspace in dependency order (stale dist would pin the last build)"
  (cd "$ROOT" && pnpm build) > "$SANDBOX/build.stdout" 2>&1 \
    || { cat "$SANDBOX/build.stdout" >&2; fatal "the workspace does not build"; }
}

# ── Modes ───────────────────────────────────────────────────────────────────────────────────────

if [ "$MODE" = "gate-only" ]; then
  build_workspace
  run_gate
  exit 0
fi

if [ "$MODE" = "selftest" ]; then
  note "selftest: proving the refuse-while-red gate can fire"
  build_workspace

  # LEG 1 — the clean tree. The gate must PASS. Without this leg a gate that refused unconditionally
  # would look identical to a gate that discriminates.
  if bash "$0" --gate-only --no-build > "$SANDBOX/selftest-clean.log" 2>&1; then
    note "selftest leg 1: clean tree -> gate PASSED (correct)"
  else
    cat "$SANDBOX/selftest-clean.log" >&2
    fatal "selftest leg 1: the gate refused a clean tree — it cannot discriminate, so its refusal in leg 2 would mean nothing"
  fi

  # LEG 2 — one deliberately failing cell, injected into the same suite. The gate must REFUSE, exit
  # 1, and NAME the cell it refused for.
  cp "$SANDBOX/probe.test.ts" "$SELFTEST_PROBE"
  set +e
  bash "$0" --gate-only --no-build > "$SANDBOX/selftest-red.log" 2>&1
  probe_status=$?
  set -e
  rm -f "$SELFTEST_PROBE"

  if [ "$probe_status" -ne 1 ]; then
    cat "$SANDBOX/selftest-red.log" >&2
    fatal "selftest leg 2: the gate exited $probe_status with a deliberately red suite; it must exit 1"
  fi
  grep -q "REFUSING to regenerate" "$SANDBOX/selftest-red.log" \
    || { cat "$SANDBOX/selftest-red.log" >&2; fatal "selftest leg 2: the gate exited 1 without saying it was refusing"; }
  grep -q "regen selftest probe" "$SANDBOX/selftest-red.log" \
    || { cat "$SANDBOX/selftest-red.log" >&2; fatal "selftest leg 2: the refusal did not NAME the failing cell"; }
  note "selftest leg 2: red tree -> gate REFUSED, exit 1, naming the cell (correct)"

  # LEG 3 — the probe removed. The gate must pass again, so the refusal was caused by the probe and
  # not by something the selftest broke on its way through.
  if bash "$0" --gate-only --no-build > "$SANDBOX/selftest-restored.log" 2>&1; then
    note "selftest leg 3: probe removed -> gate PASSED again (correct)"
  else
    cat "$SANDBOX/selftest-restored.log" >&2
    fatal "selftest leg 3: the gate still refuses after the probe was removed"
  fi

  if [ -f "$SELFTEST_PROBE" ]; then fatal "selftest: the probe file survived the run"; fi
  note "selftest: PASSED — the refusal fires on a red tree and only on a red tree"
  exit 0
fi

# ── run / write ─────────────────────────────────────────────────────────────────────────────────

build_workspace
run_gate
mint_catalog

if [ -f "$CATALOG" ]; then
  if diff -u "$CATALOG" "$MINTED" > "$SANDBOX/catalog.diff"; then
    note "diff: the committed catalog already matches the tree — nothing to change"
    exit 0
  fi
  echo "--- the committed catalog vs the live seams ---------------------------------------------"
  sed -e "s|^--- .*|--- committed  $CATALOG_REL|" -e "s|^+++ .*|+++ live       (minted from the composition root)|" \
    "$SANDBOX/catalog.diff"
  echo "----------------------------------------------------------------------------------------"
else
  note "diff: no committed catalog exists yet — this run would create it"
fi

if [ "$MODE" != "write" ]; then
  note "nothing was written. Re-run with --write to commit this catalog as a reviewed change."
  exit 0
fi

mkdir -p "$(dirname "$CATALOG")"
cp "$MINTED" "$CATALOG"
note "wrote $CATALOG_REL"
note "REVIEW THE DIFF ABOVE, then commit it. A catalog change is a capability change."
