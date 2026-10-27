import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import { TIMEOUT_FIELD_HELP, TIMEOUT_FIELD_LABELS } from "@/lib/config-copy"
import { REQUIRED_SIBLING_BLOCKS } from "@/lib/config-fields"

type TimeoutLeaf = keyof typeof TIMEOUT_FIELD_LABELS

const TIMEOUT_LEAVES = ["step", "test", "navigation"] as const satisfies readonly TimeoutLeaf[]
const TIMEOUT_DEFAULTS = REQUIRED_SIBLING_BLOCKS["use.timeout"]
const TIMEOUT_HELP: Partial<Record<TimeoutLeaf, string>> = TIMEOUT_FIELD_HELP

function timeoutField(leaf: TimeoutLeaf): ConfigFieldTarget {
  return { segments: ["use", "timeout", leaf], tab: "execution", pattern: `use.timeout.${leaf}` }
}

export function TimeoutSection() {
  return (
    <>
      {TIMEOUT_LEAVES.map((leaf) => (
        <ConfigField
          key={leaf}
          field={timeoutField(leaf)}
          label={TIMEOUT_FIELD_LABELS[leaf]}
          help={TIMEOUT_HELP[leaf]}
          kind="duration"
          placeholder={TIMEOUT_DEFAULTS[leaf]}
        />
      ))}
    </>
  )
}
