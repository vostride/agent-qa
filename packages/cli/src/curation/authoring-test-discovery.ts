import { readFileSync } from 'node:fs'

import { parseTestFile } from '@vostride/agent-qa-core'
import type { AuthoringTestRef } from '@vostride/agent-qa-agent-local'

// Returns file and name identities only, never test content; unreadable files are omitted.
export function discoverAuthoringKnownTests(
  testFilePaths: readonly string[],
): AuthoringTestRef[] {
  const refs: AuthoringTestRef[] = []
  for (const filePath of testFilePaths) {
    try {
      const parsed = parseTestFile(readFileSync(filePath, 'utf8'), filePath)
      if (parsed.errors.length > 0) continue
      refs.push(...parsed.tests.map((test) => ({ filePath, testName: test.name })))
    } catch {
      // Discovery is advisory: one unreadable or malformed file cannot block the authoring port.
    }
  }
  return refs
}
