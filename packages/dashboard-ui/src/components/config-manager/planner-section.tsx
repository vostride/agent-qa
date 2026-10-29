
import { DEFAULT_PLANNER_LIMITS } from "@vostride/agent-qa-schema"

import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import { PLANNER_FIELD_HELP, PLANNER_FIELD_LABELS } from "@/lib/config-copy"
import { REQUIRED_SIBLING_BLOCKS } from "@/lib/config-fields"

type PlannerLeaf = keyof typeof PLANNER_FIELD_LABELS

const PLANNER_DEFAULTS = REQUIRED_SIBLING_BLOCKS["use.planner"]

function plannerField(leaf: PlannerLeaf): ConfigFieldTarget {
  return { segments: ["use", "planner", leaf], tab: "models", pattern: `use.planner.${leaf}` }
}

export function PlannerSection() {
  return (
    <>
      <ConfigField
        field={plannerField("maxActions")}
        label={PLANNER_FIELD_LABELS.maxActions}
        help={PLANNER_FIELD_HELP.maxActions}
        kind="number"
        placeholder={String(DEFAULT_PLANNER_LIMITS.maxActions)}
        number={{ min: 1, integer: true }}
      />
      <ConfigField
        field={plannerField("maxPlanningTurns")}
        label={PLANNER_FIELD_LABELS.maxPlanningTurns}
        help={PLANNER_FIELD_HELP.maxPlanningTurns}
        kind="number"
        placeholder={String(DEFAULT_PLANNER_LIMITS.maxPlanningTurns)}
        number={{ min: 1, integer: true }}
      />
      <ConfigField
        field={plannerField("previousStepCount")}
        label={PLANNER_FIELD_LABELS.previousStepCount}
        help={PLANNER_FIELD_HELP.previousStepCount}
        kind="number"
        placeholder={String(PLANNER_DEFAULTS.previousStepCount)}
        number={{ min: 0, integer: true }}
      />
    </>
  )
}
