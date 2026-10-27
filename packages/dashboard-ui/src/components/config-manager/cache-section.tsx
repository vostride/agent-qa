import { ConfigField } from "@/components/config-manager/config-field"
import { CACHE_FIELD_LABELS } from "@/lib/config-copy"
import { REQUIRED_SIBLING_BLOCKS } from "@/lib/config-fields"

const CACHE_DEFAULTS = REQUIRED_SIBLING_BLOCKS["services.cache"]

export function CacheSection() {
  return (
    <>
      <ConfigField
        field={{ segments: ["use", "cache"], tab: "execution", pattern: "use.cache" }}
        label={CACHE_FIELD_LABELS.enabled}
        kind="switch"
        defaultChecked
      />
      <ConfigField
        field={{ segments: ["services", "cache", "dir"], tab: "execution", pattern: "services.cache.dir" }}
        label={CACHE_FIELD_LABELS.dir}
        kind="text"
        placeholder={CACHE_DEFAULTS.dir}
      />
    </>
  )
}
