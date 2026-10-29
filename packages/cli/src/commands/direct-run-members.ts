import { workspaceRelativeIdentityPath } from '@vostride/agent-qa-core'
import type { ParsedTestBinding } from '@vostride/agent-qa-core'
import { memberStepText } from '@vostride/agent-qa-runner'
import type { RunMemberDescriptor } from '@vostride/agent-qa-runner'

export interface DirectRunMembers {
  members: RunMemberDescriptor[]
  digestMembers: Array<{ testFileContent: string }>
}

/**
 * Build direct-run descriptors from parser-minted bindings without re-deriving source identity.
 * `filePath` is REQUIRED since 381-01: ABRF-02 stable test identity is the source file plus test
 * identity, so every downstream handoff and projection must copy the binding's file — never some
 * other file the composition root happened to have in hand.
 *
 * the descriptor's identity leg is the WORKSPACE-RELATIVE form of that same
 * binding path, minted through core's one exported `workspaceRelativeIdentityPath`. This is a
 * NORMALIZATION of the binding's own file, not a second source of identity — the ABRF-02 law above
 * still holds. It has to happen here rather than at the call site because this is the unit the
 * cross-root differential can drive: a mint hidden inside `run.ts`'s composition closure cannot be
 * pinned by a test, and an unpinned identity rule is how the absolute-path defect survived to
 * verification in the first place.
 *
 * The bindings themselves KEEP their absolute paths: everything that reads bytes off disk (the
 * parser, the upload-path resolver, artifact capture) runs off the binding, not off the descriptor.
 *
 * @throws when a binding's file resolves outside `configDir` — an escaping file mints no identity.
 */
export function buildDirectRunMembers(
  bindings: ParsedTestBinding[],
  configDir: string,
): DirectRunMembers {
  return {
    members: bindings.map(({ test, filePath }, testIndex) => ({
      testId: (test as any)['test-id'] ?? test.name,
      testIndex,
      name: test.name,
      // NO failFastGroup — the single-test path runs all members then aggregates.
      filePath: workspaceRelativeIdentityPath(configDir, filePath),
      totalSteps: test.steps.length,
      // the raw texts member-runner will announce at stepStarted; the shell masks them.
      stepTexts: test.steps.map((step) => memberStepText(step)),
    })),
    digestMembers: bindings.map(({ fileContent }) => ({ testFileContent: fileContent })),
  }
}
