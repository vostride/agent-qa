// THE `agent-qa run` PARITY DIFFERENTIAL — the committed half (Phase 401 plan 11).
//
// WHY A CELL AND NOT A PROCEDURE. Plan 11 extracts the whole in-process run execution out of
// `run.ts`. A refactor that is supposed to change nothing observable has nothing to go red first,
// so its acceptance bar is a parity reading — and a parity reading that lives only in a plan's
// `<action>` and a SUMMARY table passes identically whether the measurement happened, was skipped,
// or was invented. Worse than a command that cannot fail: there is no command at all.
//
// The five pre-existing door suites this plan re-runs (`run-gate.e2e`, `run-gate-suite.e2e`,
// `run-markers`, `run-door-invocation-census`, `run-session-exit-codes`) range NONE of stderr
// bytes, reporter ordering, run-directory contents or the `--all` exit-code fold. A botched
// extraction on any of those axes would ship green without this file.
//
// THE GOLDEN IS THE PRE-EXTRACTION TREE. `__fixtures__/run-parity-golden.json` was captured by
// `node scripts/401-11-capture-parity.mjs --write` on a `pnpm build --force` dist built BEFORE a
// single line of the extraction was written, and committed in its own commit ahead of the refactor
// commit. If this cell reds, the extraction changed observable behaviour: fix the extraction.
// REGENERATING THE GOLDEN IS A PLAN-LEVEL FAILURE, not a fix.
//
// ONE SCRUBBER. The generator exports it and this file imports it (below), so a golden and a
// reading can never be scrubbed by two rules that quietly disagree.
//
// RUNS ON `dist`. Every `<verify>` line that includes this file runs `pnpm build --force` first: a
// reading taken on a stale dist compares two copies of the previous build and calls it a
// measurement.
//
// ONE RATIFIED RELAXATION, AND ONLY ON THE INVENTORY AXIS (405-02). `runDirFiles` is an inventory,
// and a later phase that ships a new run-directory member ON PURPOSE is not extraction drift. The
// rule above still holds — the golden was NOT regenerated for it — because a wholesale re-capture
// would blind this instrument to the drift it exists to catch. Instead the generator carries
// `POST_GOLDEN_RUN_DIR_ADDITIONS`, an explicitly named list (file + the plan that added it + why),
// and the inventory comparison below subtracts those names FROM BOTH SIDES. A removal from the
// golden inventory still reds; an addition nobody declared still reds; the other five
// discriminators are untouched and stay byte-exact.
//
// Phase 418-05 intentionally discloses the resolved canary ablation cap. Only the
// two affected golden stderr fields gained that exact line; the historical capture
// was not regenerated, and every comparison below remains byte-exact.
// Phase 420-20 D-19 adds the cached provisional trust-prior text to those same two
// stderr fields. All other historical data and the six exact comparisons are retained.
// Phase 427-04 D-24 adds the recorded all-zero curation line to those same two stderr
// fields: a clean fold that committed nothing now records its five zero buckets.
// Phase 432-09 D-25 removes the `proposals: 0 pending` clause from the exit line in those
// same two stderr fields: nothing waits on a human, so the line counts no proposal.
// Phase 432-13 D-14 removes the run gate: a start writes no `run:start` decision, so the golden
// inventory's `execution_audit.jsonl` is not written by these runs any more. It is a declared
// REMOVAL, subtracted from the golden side only and asserted absent on the actual side, so the file
// coming back undeclared still reds. The historical capture was not regenerated.
// Phase 433-35 (G-433-11, F-433-44): a browser that never launches fails its member with the cause
// instead of cancelling the run, so the direct run prints `FAIL`, the cause and its run id, and the
// `--all` direct run's second member is skipped with events rather than dropped. Only the
// single-test stdout and the `--all` stdout and eventTypes fields changed, by hand; the historical
// capture was not regenerated, and stderr and exit codes are unchanged.
// Phase 436-09 D-06 prints the effective planner limits before the first test of each run, so
// the three stdout fields gained `Limits: 30 actions, 30 planning turns per step` ahead of each
// `Running N test(s)...` line, by hand; the historical capture was not regenerated.
// Phase 444-14 D-22: in the `ci` and `cloud` contexts each pending stage on the exit line states
// its resume limit. The golden is a local reading and the capture inherits the caller's `CI`, so
// the two affected stderr fields are read with that suffix in the context the run resolves (444-21);
// the historical capture was not regenerated, and every comparison remains byte-exact.

import { existsSync, readFileSync } from 'node:fs'
import { resolveRunExecutionContext } from '@vostride/agent-qa-agent-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLI_DIST,
  PARITY_GOLDEN_PATH,
  PARITY_INVOCATIONS,
  POST_GOLDEN_RUN_DIR_ADDITIONS,
  assertGoldenNonVacuous,
  captureInvocation,
  scrubTranscript,
  staleDeclaredAdditions,
  withoutDeclaredRunDirAdditions,
} from '../../../../../scripts/401-11-capture-parity.mjs'
import type { ParityGolden, ParityReading } from '../../../../../scripts/401-11-capture-parity.mjs'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

/**
 * The golden is checked for non-vacuity ON LOAD rather than trusted for being a file: a golden
 * captured from a broken build (empty stdout, a run that never started) would make every
 * comparison below trivially true, which is the failure this whole instrument exists to prevent.
 */
const golden: ParityGolden = assertGoldenNonVacuous(
  JSON.parse(readFileSync(PARITY_GOLDEN_PATH, 'utf8')) as ParityGolden,
)

function goldenFor(id: string): ParityReading {
  const reading = golden.readings.find((entry) => entry.id === id)
  if (reading === undefined) throw new Error(`no golden reading for "${id}"`)
  return reading
}

const CI_RESUME_LIMIT = {
  analysis: " (resumes only if this workspace's .agent-qa/ is kept and a later run or the daemon picks it up)",
  curation: " (resumes only if this workspace's .agent-qa/ is kept and a later local run picks it up)",
}

function stderrInRunContext(stderr: string): string {
  const context = resolveRunExecutionContext()
  if (context !== 'ci' && context !== 'cloud') return stderr
  return stderr
    .split('\n')
    .map((line) =>
      line.startsWith('post-processing — ')
        ? line
            .replace('analysis: pending · ', `analysis: pending${CI_RESUME_LIMIT.analysis} · `)
            .replace('curation: pending · ', `curation: pending${CI_RESUME_LIMIT.curation} · `)
        : line,
    )
    .join('\n')
}

/**
 * Every run-dir file name any invocation below actually produced, and how many invocations ran.
 *
 * The staleness cell needs both: an unobserved declared addition is only meaningful evidence when
 * every invocation ran, so a filtered run (`-t`) reports nothing rather than a false red.
 */
const observedRunDirFiles = new Set<string>()
let invocationsMeasured = 0

/** Golden run-dir members a later phase stopped writing on purpose — see the header. */
const RETIRED_RUN_DIR_FILES: readonly string[] = ['execution_audit.jsonl']

describe('agent-qa run parity across the in-process extraction (401-11)', () => {
  it('the instrument itself is real: the shipped binary exists and the scrubber is the generator’s', () => {
    // Without this, a missing dist would make every reading below an identical empty transcript —
    // and a locally re-declared scrubber would make "byte-identical" a statement about two copies
    // of the same bug.
    expect(existsSync(CLI_DIST)).toBe(true)
    expect(typeof scrubTranscript).toBe('function')
    expect(
      scrubTranscript('ran in 1.25s under /tmp/x', {
        project: '/tmp/x',
        tmp: '/tmp',
        repoRoot: '/repo',
      }),
    ).toBe('ran in <DUR> under <PROJECT>')
  })

  for (const invocation of PARITY_INVOCATIONS) {
    it(
      `\`agent-qa run ${invocation.args.join(' ')}\` is byte-identical to the pre-extraction reading`,
      async () => {
        const expected = goldenFor(invocation.id)
        const actual = await captureInvocation(invocation)

        // RECORDED BEFORE THE ASSERTIONS, not after. The staleness cell below reads these, and a
        // cell that recorded only on success would let a red inventory assertion silently disarm
        // the staleness check — the two failures would mask each other exactly when both are true.
        for (const name of actual.runDirFiles) observedRunDirFiles.add(name)
        invocationsMeasured += 1

        // Six discriminators, asserted separately so a red NAMES the axis that moved rather than
        // dumping one object diff. Exit code LAST is deliberate elsewhere in this phase (a code
        // alone is satisfiable by two different worlds); here the reporter transcript comes first
        // because it is the axis a person actually reads.
        expect(actual.stdout).toBe(expected.stdout)
        expect(actual.stderr).toBe(stderrInRunContext(expected.stderr))
        expect(actual.eventTypes).toEqual([...expected.eventTypes])
        expect(actual.targetHits).toEqual([...expected.targetHits])
        // THE ONE FILTERED AXIS — see the header. Subtracted from BOTH sides, so a removal from
        // the golden inventory and an undeclared addition each still red.
        for (const retired of RETIRED_RUN_DIR_FILES) expect(actual.runDirFiles).not.toContain(retired)
        const expectedFiles = expected.runDirFiles.filter((name) => !RETIRED_RUN_DIR_FILES.includes(name))
        expect(withoutDeclaredRunDirAdditions(actual.runDirFiles))
          .toEqual(withoutDeclaredRunDirAdditions([...expectedFiles].sort()))
        expect(actual.exitCode).toBe(expected.exitCode)
      },
      180_000,
    )
  }

  it('every declared post-golden run-dir addition is still being written', () => {
    // THE SHRINKING DIRECTION, on the surface-firewall ledger's reasoning: an allowance for a file
    // nothing writes any more is a permanent blind spot in the inventory axis — the one place a
    // real regression could hide behind a name a person once justified. So it fails here, and the
    // phase that stops writing the file has to delete its entry in the same commit.
    //
    // ASSERTED ONLY ON A FULL RUN. Under `-t` some invocations never execute, and an addition that
    // only one of them produces would look stale for a reason that has nothing to do with the code.
    if (invocationsMeasured !== PARITY_INVOCATIONS.length) return

    expect(staleDeclaredAdditions([...observedRunDirFiles]).map((entry) => entry.file)).toEqual([])
    // 2026-10-16 (442-10, D-17): run-config.json is the only declared addition.
    expect(POST_GOLDEN_RUN_DIR_ADDITIONS.map((entry) => entry.file)).toEqual(['run-config.json'])
  })
})
