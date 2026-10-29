import { workspaceRelativeIdentityPath } from '@vostride/agent-qa-core'
import type { ParsedTestBinding } from '@vostride/agent-qa-core'
import { memberStepText } from '@vostride/agent-qa-runner'
import type { RunMemberDescriptor } from '@vostride/agent-qa-runner'

export interface DirectRunMembers {
  members: RunMemberDescriptor[]
  digestMembers: Array<{ testFileContent: string }>
}

// Identity is the binding's own file made workspace-relative; the bindings keep absolute paths.
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
      // The raw texts member-runner announces at `stepStarted`; the shell masks them.
      stepTexts: test.steps.map((step) => memberStepText(step)),
    })),
    digestMembers: bindings.map(({ fileContent }) => ({ testFileContent: fileContent })),
  }
}
