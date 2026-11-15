import { ConfigField } from "@/components/config-manager/config-field"
import { LOGGING_FIELD_HELP, LOGGING_FIELD_LABELS, LOGGING_LEVEL_LABELS } from "@/lib/config-copy"

function levelOptions() {
  return Object.entries(LOGGING_LEVEL_LABELS).map(([value, label]) => ({ value, label }))
}

export function LoggingSection() {
  return (
    <ConfigField
      field={{ segments: ["services", "logging", "level"], tab: "project", pattern: "services.logging.level" }}
      label={LOGGING_FIELD_LABELS.level}
      kind="select"
      help={LOGGING_FIELD_HELP.level}
      options={levelOptions()}
      placeholder={LOGGING_LEVEL_LABELS.warn}
    />
  )
}
