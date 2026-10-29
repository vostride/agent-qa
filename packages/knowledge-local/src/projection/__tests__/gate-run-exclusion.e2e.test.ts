// Each predicate must find its known members first; the substrate scan catches unnamed consumers.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** The repo root, found by walking up to the directory that holds `packages/`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let hops = 0; hops < 12; hops += 1) {
    try {
      if (statSync(join(dir, 'packages')).isDirectory() && statSync(join(dir, 'pnpm-workspace.yaml')).isFile()) {
        return dir
      }
    } catch {
      // keep walking
    }
    dir = dirname(dir)
  }
  throw new Error('the census could not locate the workspace root')
}

const ROOT = repoRoot()

// Every first-party, non-test `.ts` file under `packages/*/src`. The scan's whole universe.
function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(full)
        continue
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(full)
    }
  }
  for (const pkg of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const src = join(ROOT, 'packages', pkg.name, 'src')
    try {
      if (statSync(src).isDirectory()) walk(src)
    } catch {
      // a package with no `src/`
    }
  }
  return found.sort()
}

/**
 * The lines of a file that are CODE, not prose.
 *
 * This repository documents heavily, and the exclusion is discussed in comments in files that
 * never touch it. A scan that counted prose would pin a set of paragraphs; what has to be pinned
 * is a set of behaviours.
 */
function codeLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
}

function repoRelative(path: string): string {
  return relative(ROOT, path).split(sep).join('/')
}

/** Files with a CODE reference to one of `patterns`. */
function filesReferencing(patterns: readonly RegExp[]): string[] {
  return sourceFiles()
    .filter((path) => codeLines(path).some((line) => patterns.some((pattern) => pattern.test(line))))
    .map(repoRelative)
}

// ---- predicate 1: the marker vocabulary --------------------------------------------------------

// SUBSTRING, NOT WORD-BOUNDED, AND THE DIFFERENCE WAS MEASURED. `/\bgateRun\b/` drops five files
// whose only code references are `gateRuns`, `gateRunIds`, `gateRunHandoff`, `gateRunStartInput` —
// every one of them a real site in the marker's own chain. The self-check cell below caught nothing
// when the boundary form was used, because the five known members it interrogates all happen to
// spell the bare identifier: a narrowing that misses a member the self-check does not name is
// invisible to it. So the predicate over-includes on purpose. Over-inclusion costs a row in the
// classification table; under-inclusion silently drops a consumer, which is the failure this census
// exists to make impossible. The `NOT NARROWER` cell below pins that choice.
const MARKER_PATTERNS = [/gateRun/, /excludedFromOutcomes/] as const

/** The boundary form the census deliberately does NOT use. Kept so the choice stays measurable. */
const NARROWED_MARKER_PATTERNS = [/\bgateRun\b/, /\bexcludedFromOutcomes\b/] as const

// `consumer` decides, `carrier` moves the marker, `producer` mints it; every file needs one.
const MARKER_CENSUS: Readonly<Record<string, 'consumer' | 'carrier' | 'producer'>> = {
  // THE ONE EXCLUSION GATE. Everything the flake tables and the candidacy inputs are computed from
  // passes through this one `excluded ? [] : handoff.tests` line.
  'packages/knowledge-local/src/projection/run-outcomes.ts': 'consumer',

  // Carriers: the marker's representations, none of which decides anything with it.
  'packages/schema/src/functions/runs.ts': 'carrier',
  'packages/schema/src/handoff/completed-run-handoff.ts': 'carrier',
  'packages/schema/src/handoff/load-completed-run-handoff.ts': 'carrier',
  'packages/schema/src/job/analyze-run-payload.ts': 'carrier',
  'packages/schema/src/authoring/draft-receipt.ts': 'carrier',
  'packages/runner/src/run/ports.ts': 'carrier',
  'packages/runner/src/run/handoff-assembly.ts': 'carrier',
  // Spreads the markers from `RunConfig` onto the post-verdict step and decides nothing.
  'packages/runner/src/run/shell.ts': 'carrier',
  'packages/agent/src/functions/ops/runs-start.ts': 'carrier',
  'packages/agent/src/functions/ops/runs-get.ts': 'carrier',
  // Restates the markers as a reason on the read DTO; gates no table and no enqueue.
  'packages/agent/src/functions/ops/runs-post-processing.ts': 'carrier',
  'packages/agent/src/jobs/kinds.ts': 'carrier',
  // Reads either marker to enqueue no `analyze-run`: a decision, so a consumer.
  'packages/cli/src/curation/post-verdict-step.ts': 'consumer',
  // The durable continuation validates the loaded handoff before publishing or recovering an
  // intent. Either marker refuses lifecycle ownership; the step keeps its enqueue decision. This
  // is a consumer, not a carrier.
  'packages/cli/src/curation/post-verdict-continuation.ts': 'consumer',
  'packages/cli/src/commands/run.ts': 'carrier',
  // Carries the markers onto the run in process.
  'packages/agent-local/src/composition/run-invocation-core.ts': 'carrier',
  // Hands the request's flag to the run record and decides nothing.
  'packages/cli/src/composition/in-process-run-execution.ts': 'carrier',

  // Producers: the sites that put the marker on a request in the first place.
  'packages/agent/src/authoring/stability-gates.ts': 'producer',
  'packages/agent/src/authoring/verify-draft.ts': 'producer',
  'packages/agent/src/authoring/repair.ts': 'producer',
  'packages/agent/src/authoring/loop.ts': 'producer',
  'packages/agent/src/functions/ops/authoring-draft-write.ts': 'producer',
  'packages/agent/src/functions/ops/authoring-verify-draft.ts': 'producer',
}

// ---- predicate 2: the outcome substrate (the transitive half) ----------------------------------

// Ranged by symbol, because the main consumer never names the marker; a new writer is caught here.
const SUBSTRATE_PATTERNS = [
  /\bprojectRunOutcomes\b/,
  /\bapplyRunOutcomes\b/,
  /\bsuiteFingerprintDeltas\b/,
  /\bapplySuiteFingerprints\b/,
  /\bfoldSuiteFingerprints\b/,
  /\bfoldRunOutcomes\b/,
] as const

const SUBSTRATE_CENSUS: Readonly<Record<string, string>> = {
  'packages/knowledge-local/src/projection/run-outcomes.ts':
    'THE gate: `excluded ? [] : handoff.tests`, and both tables are written from its output',
  'packages/knowledge-local/src/projection/suite-fingerprints.ts':
    'the CARRIED decision — computes from an already-gated member list, and takes `excluded` as an argument on its standalone door',
  'packages/knowledge-local/src/index.ts':
    'the barrel — re-exports only; no call site',
  'packages/cli/src/curation/curation-tail.ts':
    'the post-run fold entry: hands the handoff to `foldRunOutcomes`, which gates it',
  'packages/agent-local/src/composition/compose-local-agent.ts':
    'publishes `foldRunOutcomes` as a curation capability — a pass-through with no call site of its own',
}

describe('the gate-run exclusion consumer census is frozen and self-checking', () => {
  it('THE MARKER PREDICATE FINDS ITS OWN KNOWN MEMBERS before it is trusted', () => {
    // A predicate narrowed — to one package, to one directory, to a stricter word boundary — that
    // no longer sees the file the exclusion actually lives in must fail HERE, loudly, rather than
    // reporting a clean scan of nothing. These five are the chain's ends and its middle.
    const known = [
      'packages/knowledge-local/src/projection/run-outcomes.ts',
      'packages/runner/src/run/handoff-assembly.ts',
      'packages/schema/src/handoff/completed-run-handoff.ts',
      'packages/agent-local/src/composition/run-invocation-core.ts',
      'packages/agent/src/authoring/stability-gates.ts',
    ]
    for (const member of known) {
      const hits = codeLines(join(ROOT, member))
        .filter((line) => MARKER_PATTERNS.some((pattern) => pattern.test(line)))
      expect(hits.length, `${member} must be visible to the marker predicate`).toBeGreaterThan(0)
    }
    // And the universe it scans is a real one, not an empty walk.
    expect(sourceFiles().length).toBeGreaterThan(500)
  })

  it('THE PREDICATE IS NOT NARROWER THAN THE VOCABULARY — the boundary form drops real sites', () => {
    // Measured, not asserted from memory: the word-bounded form finds strictly fewer files, and
    // every file it drops is a real site in the marker's chain. This cell is what makes the
    // over-inclusive choice above a decision rather than an accident, and it reds if somebody
    // "tidies" the predicate into the boundary form.
    const broad = filesReferencing(MARKER_PATTERNS)
    const narrow = filesReferencing(NARROWED_MARKER_PATTERNS)
    const dropped = broad.filter((file) => !narrow.includes(file))

    expect(narrow.length).toBeLessThan(broad.length)
    expect(dropped.sort()).toEqual([
      'packages/agent/src/authoring/loop.ts',
      'packages/agent/src/authoring/verify-draft.ts',
      'packages/agent/src/functions/ops/authoring-draft-write.ts',
      'packages/agent/src/functions/ops/authoring-verify-draft.ts',
      'packages/schema/src/authoring/draft-receipt.ts',
    ])
  })

  it('THE MARKER SCAN EQUALS THE FROZEN CENSUS — n in, n classified, no silent drops', () => {
    const discovered = filesReferencing(MARKER_PATTERNS)
    const classified = Object.keys(MARKER_CENSUS).sort()

    expect(discovered.sort()).toEqual(classified)
    // Every discovered file is classified, and none is dropped.
    expect(discovered.length).toBe(Object.keys(MARKER_CENSUS).length)
  })

  it('EXACTLY ONE MARKER CONSUMER PER DECISION, and each names the decision it gates', () => {
    const consumers = Object.entries(MARKER_CENSUS)
      .filter(([, role]) => role === 'consumer')
      .map(([file]) => file)
      .sort()
    // Each consumer answers a different question over disjoint substrate, so all are named in full.
    expect(consumers).toEqual([
      'packages/cli/src/curation/post-verdict-continuation.ts',
      'packages/cli/src/curation/post-verdict-step.ts',
      'packages/knowledge-local/src/projection/run-outcomes.ts',
    ])
    const continuation = readFileSync(
      join(ROOT, 'packages/cli/src/curation/post-verdict-continuation.ts'), 'utf8',
    )
    expect(continuation).not.toContain('projectRunOutcomes')
    expect(continuation).not.toContain('run_test_outcomes')
    expect(continuation, 'continuation delegates publication to the existing step').not.toContain('queue.enqueue')
    // The disjointness, measured rather than asserted in prose: the enqueue gate names no outcome
    // substrate, and the outcome gate names no queue.
    const step = readFileSync(join(ROOT, 'packages/cli/src/curation/post-verdict-step.ts'), 'utf8')
    expect(step, 'the enqueue gate must not reach into run outcomes').not.toContain('projectRunOutcomes')
    expect(step).not.toContain('run_test_outcomes')
    const outcomes = readFileSync(
      join(ROOT, 'packages/knowledge-local/src/projection/run-outcomes.ts'),
      'utf8',
    )
    // `queue.enqueue` rather than the job KIND: `run-outcomes.ts` names `analyze-run` in prose —
    // it explains where an authored verdict comes from — and a probe that forbade the word would
    // be forbidding the explanation rather than the reach.
    expect(
      outcomes,
      'the outcome gate must not reach into the durable queue',
    ).not.toContain('queue.enqueue')
  })

  it('A MARKER GREP IS NOT A CENSUS — the carried consumer names neither marker in code', () => {
    // The census's own witness that predicate 1 is incomplete, and the reason predicate 2 exists.
    // `suite-fingerprints.ts` computes the fingerprint table from the gated member list and takes
    // the exclusion decision as an ARGUMENT on its standalone door; it mentions the marker only in
    // prose. A one-hop census would have reported clean with this file outside it.
    const carriedConsumer = 'packages/knowledge-local/src/projection/suite-fingerprints.ts'
    expect(filesReferencing(MARKER_PATTERNS)).not.toContain(carriedConsumer)
    expect(Object.keys(SUBSTRATE_CENSUS)).toContain(carriedConsumer)
    // It really is about the markers — the prose is there, only the code is not.
    expect(readFileSync(join(ROOT, carriedConsumer), 'utf8')).toContain('excludedFromOutcomes')
  })

  it('THE SUBSTRATE PREDICATE FINDS ITS OWN KNOWN MEMBERS before it is trusted', () => {
    for (const member of [
      'packages/knowledge-local/src/projection/run-outcomes.ts',
      'packages/knowledge-local/src/projection/suite-fingerprints.ts',
    ]) {
      const hits = codeLines(join(ROOT, member))
        .filter((line) => SUBSTRATE_PATTERNS.some((pattern) => pattern.test(line)))
      expect(hits.length, `${member} must be visible to the substrate predicate`).toBeGreaterThan(0)
    }
  })

  it('THE SUBSTRATE SCAN EQUALS THE FROZEN CENSUS — nothing writes these tables from outside', () => {
    // The transitive closure, mechanised: a new consumer either NAMES a marker (predicate 1) or
    // WRITES the substrate (this one). A door that did neither is not a consumer of run outcomes.
    expect(filesReferencing(SUBSTRATE_PATTERNS).sort())
      .toEqual(Object.keys(SUBSTRATE_CENSUS).sort())
  })
})
