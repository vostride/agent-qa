import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import { BROWSER_FIELD_LABELS, BROWSER_NAME_LABELS, HEADLESS_HELP } from "@/lib/config-copy"
import { REQUIRED_SIBLING_BLOCKS } from "@/lib/config-fields"

function browserField(...leaf: string[]): ConfigFieldTarget {
  const segments = ["use", "browser", ...leaf]
  return { segments, tab: "execution", pattern: segments.join(".") }
}

function browserOptions() {
  return Object.entries(BROWSER_NAME_LABELS).map(([value, label]) => ({ value, label }))
}

const BROWSER_DEFAULTS = REQUIRED_SIBLING_BLOCKS["use.browser"]
const VIEWPORT_DEFAULTS = REQUIRED_SIBLING_BLOCKS["use.browser.viewport"]
const VIEWPORT_RULES = { min: 1, integer: true } as const

export function BrowserSection() {
  return (
    <>
      <ConfigField
        field={browserField("name")}
        label={BROWSER_FIELD_LABELS.name}
        kind="select"
        options={browserOptions()}
        placeholder={BROWSER_NAME_LABELS[BROWSER_DEFAULTS.name]}
      />
      <ConfigField
        field={browserField("headless")}
        label={BROWSER_FIELD_LABELS.headless}
        kind="switch"
        help={HEADLESS_HELP()}
        defaultChecked={BROWSER_DEFAULTS.headless}
      />
      <ConfigField
        field={browserField("viewport", "width")}
        label={BROWSER_FIELD_LABELS.viewportWidth}
        kind="number"
        number={VIEWPORT_RULES}
        placeholder={String(VIEWPORT_DEFAULTS.width)}
      />
      <ConfigField
        field={browserField("viewport", "height")}
        label={BROWSER_FIELD_LABELS.viewportHeight}
        kind="number"
        number={VIEWPORT_RULES}
        placeholder={String(VIEWPORT_DEFAULTS.height)}
      />
    </>
  )
}
