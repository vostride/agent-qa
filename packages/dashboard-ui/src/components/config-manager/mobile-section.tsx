// The one mobile leaf is a select that saves the moment it changes.

import { ConfigField } from "@/components/config-manager/config-field"
import { useConfigAutosaveContext } from "@/hooks/use-config-autosave"
import { MOBILE_APP_STATE_HELP, MOBILE_APP_STATE_LABELS, MOBILE_FIELD_LABELS } from "@/lib/config-copy"

interface MobileSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const APP_STATE_REF = { segments: ["use", "mobile", "appState"], tab: "targets" } as const

const APP_STATE_OPTIONS = (Object.keys(MOBILE_APP_STATE_LABELS) as (keyof typeof MOBILE_APP_STATE_LABELS)[]).map(
  (value) => ({ value, label: MOBILE_APP_STATE_LABELS[value] }),
)

export function MobileSection(_props: MobileSectionProps) {
  const autosave = useConfigAutosaveContext()
  const unset = typeof autosave.valueOf(APP_STATE_REF) !== "string"
  return (
    <ConfigField
      field={{ ...APP_STATE_REF, pattern: "use.mobile.appState" }}
      label={MOBILE_FIELD_LABELS.appState}
      kind="select"
      options={APP_STATE_OPTIONS}
      help={unset ? MOBILE_APP_STATE_HELP : undefined}
    />
  )
}
