import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import {
  ACCESSIBILITY_ALL_RULES_TEXT,
  ACCESSIBILITY_FIELD_HELP,
  ACCESSIBILITY_FIELD_LABELS,
  ACCESSIBILITY_FIELD_PLACEHOLDERS,
  ACCESSIBILITY_RUN_AFTER_LABELS,
  ACCESSIBILITY_STANDARD_LABELS,
} from "@/lib/config-copy"
import { REQUIRED_SIBLING_BLOCKS } from "@/lib/config-fields"

type AccessibilityLeaf = keyof typeof ACCESSIBILITY_FIELD_LABELS

function accessibilityField(leaf: AccessibilityLeaf): ConfigFieldTarget {
  return {
    segments: ["services", "accessibility", leaf],
    tab: "execution",
    pattern: `services.accessibility.${leaf}`,
  }
}

function optionsOf(labels: Readonly<Record<string, string>>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }))
}

function standardOptions() {
  return optionsOf(ACCESSIBILITY_STANDARD_LABELS)
}

function runAfterOptions() {
  return optionsOf(ACCESSIBILITY_RUN_AFTER_LABELS)
}

export function AccessibilitySection() {
  return (
    <>
      <ConfigField
        field={accessibilityField("enabled")}
        label={ACCESSIBILITY_FIELD_LABELS.enabled}
        kind="switch"
        defaultChecked={REQUIRED_SIBLING_BLOCKS["services.accessibility"].enabled}
      />
      <ConfigField
        field={accessibilityField("standard")}
        label={ACCESSIBILITY_FIELD_LABELS.standard}
        kind="select"
        options={standardOptions()}
        placeholder={ACCESSIBILITY_ALL_RULES_TEXT()}
      />
      <ConfigField
        field={accessibilityField("runAfter")}
        label={ACCESSIBILITY_FIELD_LABELS.runAfter}
        kind="select"
        options={runAfterOptions()}
        placeholder={ACCESSIBILITY_RUN_AFTER_LABELS["every-step"]}
      />
      <ConfigField
        field={accessibilityField("failOnViolation")}
        label={ACCESSIBILITY_FIELD_LABELS.failOnViolation}
        kind="switch"
        defaultChecked={false}
      />
      <ConfigField
        field={accessibilityField("disableRules")}
        label={ACCESSIBILITY_FIELD_LABELS.disableRules}
        kind="list"
        help={ACCESSIBILITY_FIELD_HELP.disableRules}
        placeholder={ACCESSIBILITY_FIELD_PLACEHOLDERS.disableRules}
      />
      <ConfigField
        field={accessibilityField("exclude")}
        label={ACCESSIBILITY_FIELD_LABELS.exclude}
        kind="list"
        help={ACCESSIBILITY_FIELD_HELP.exclude}
        placeholder={ACCESSIBILITY_FIELD_PLACEHOLDERS.exclude}
      />
    </>
  )
}
