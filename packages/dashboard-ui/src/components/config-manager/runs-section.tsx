import { DEFAULT_PARALLEL_WORKERS } from "@vostride/agent-qa-schema"

import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import type { ConfigFieldParse } from "@/hooks/use-config-autosave"
import { RUNS_FIELD_HELP, RUNS_FIELD_LABELS } from "@/lib/config-copy"

function runsField(leaf: "parallel" | "workers" | "buildTag"): ConfigFieldTarget {
  return { segments: ["use", leaf], tab: "execution", pattern: `use.${leaf}` }
}

const WORKER_RULES = { min: 1, integer: true } as const

// The schema trims the build tag and refuses an empty one, so blank input unsets it.
function parseBuildTag(raw: string): ConfigFieldParse {
  const value = raw.trim()
  return value === "" ? { valid: true, unset: true } : { valid: true, value }
}

export function RunsSection() {
  return (
    <>
      <ConfigField
        field={runsField("parallel")}
        label={RUNS_FIELD_LABELS.parallel}
        kind="switch"
        help={RUNS_FIELD_HELP.parallel}
        defaultChecked={false}
      />
      <ConfigField
        field={runsField("workers")}
        label={RUNS_FIELD_LABELS.workers}
        kind="number"
        number={WORKER_RULES}
        help={RUNS_FIELD_HELP.workers}
        placeholder={String(DEFAULT_PARALLEL_WORKERS)}
      />
      <ConfigField
        field={runsField("buildTag")}
        label={RUNS_FIELD_LABELS.buildTag}
        kind="text"
        help={RUNS_FIELD_HELP.buildTag}
        parse={parseBuildTag}
      />
    </>
  )
}
