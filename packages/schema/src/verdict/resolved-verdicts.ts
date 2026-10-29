// Consumers read verdicts only here, or two of them could resolve supersession differently.

import type { CompletedRunHandoff } from '../handoff/completed-run-handoff'
import type { PerTestOutcome } from '../handoff/per-test-outcome'
import type { RunAnalysisArtifact } from './analysis-artifact'
import type { Verdict } from './verdict'

// Mirrors the agent handler's floor projection member for member.
function needsVerdict(test: PerTestOutcome): boolean {
  return test.outcome !== 'passed' && test.outcome !== 'skipped' && test.outcome !== 'cancelled'
}

/**
 * The floor's minted `unknown`, byte-identical to the runner's `deterministicVerdict`
 * output for an absent signal (confidence 0, the fixed rationale template, empty evidence
 * arrays). Minted here rather than imported because the dependency points the other way —
 * the runner consumes schema — and the two spellings are pinned equal by test.
 */
function mintedUnknown(perTest: number): Verdict {
  return {
    class: 'unknown',
    producer: 'deterministic-classifier',
    confidence: 0,
    evidence: {
      citedSteps: [],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'no deterministic signal matched',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
  }
}

// A failed member with no persisted `rootCause` resolves to the minted `unknown`.
export function resolveRunVerdicts(
  artifact: RunAnalysisArtifact | undefined,
  handoff: CompletedRunHandoff,
): Verdict[] {
  if (artifact !== undefined) return [...artifact.verdicts]
  return handoff.tests
    .filter(needsVerdict)
    .map((test) => test.rootCause ?? mintedUnknown(test.testIndex))
}
