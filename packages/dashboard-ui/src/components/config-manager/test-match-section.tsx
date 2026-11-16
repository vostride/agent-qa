import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import type { ConfigFieldParse } from "@/hooks/use-config-autosave"
import {
  SUITE_MATCH_REQUIRED_ERROR,
  TEST_DISCOVERY_FIELD_HELP,
  TEST_DISCOVERY_FIELD_LABELS,
  TEST_MATCH_REQUIRED_ERROR,
} from "@/lib/config-copy"
import { textToList } from "@/lib/config-fields"

type DiscoveryLeaf = keyof typeof TEST_DISCOVERY_FIELD_LABELS

function discoveryField(leaf: DiscoveryLeaf): ConfigFieldTarget {
  return { segments: ["workspace", leaf], tab: "project", pattern: `workspace.${leaf}` }
}

// The schema needs at least one pattern, so an emptied list stays a draft instead of writing.
function requiredList(error: () => string) {
  return (raw: string): ConfigFieldParse => {
    const items = textToList(raw)
    return items.length === 0 ? { valid: false, error: error() } : { valid: true, value: items }
  }
}

const parseTestMatch = requiredList(() => TEST_MATCH_REQUIRED_ERROR())
const parseSuiteMatch = requiredList(() => SUITE_MATCH_REQUIRED_ERROR())

export function TestMatchSection() {
  return (
    <>
      <ConfigField
        field={discoveryField("testMatch")}
        label={TEST_DISCOVERY_FIELD_LABELS.testMatch}
        kind="list"
        help={TEST_DISCOVERY_FIELD_HELP.testMatch}
        placeholder="tests/**/*.yaml"
        parse={parseTestMatch}
      />
      <ConfigField
        field={discoveryField("suiteMatch")}
        label={TEST_DISCOVERY_FIELD_LABELS.suiteMatch}
        kind="list"
        help={TEST_DISCOVERY_FIELD_HELP.suiteMatch}
        placeholder="tests/**/*.suite.yaml"
        parse={parseSuiteMatch}
      />
      <ConfigField
        field={discoveryField("testPathIgnore")}
        label={TEST_DISCOVERY_FIELD_LABELS.testPathIgnore}
        kind="list"
        help={TEST_DISCOVERY_FIELD_HELP.testPathIgnore}
        placeholder="**/node_modules/**"
      />
    </>
  )
}
