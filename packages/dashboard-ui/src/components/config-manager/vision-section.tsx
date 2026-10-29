import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import { VISION_FIELD_HELP, VISION_FIELD_LABELS } from "@/lib/config-copy"

type VisionLeaf = keyof typeof VISION_FIELD_LABELS

function visionField(leaf: VisionLeaf): ConfigFieldTarget {
  return { segments: ["services", "vision", leaf], tab: "models", pattern: `services.vision.${leaf}` }
}

/** The one screenshot-size budget every vision model shares. */
export function VisionSection() {
  return (
    <>
      <ConfigField
        field={visionField("screenshotSize")}
        label={VISION_FIELD_LABELS.screenshotSize}
        help={VISION_FIELD_HELP.screenshotSize}
        kind="text"
        placeholder="256k"
      />
      <ConfigField
        field={visionField("effectiveResolution")}
        label={VISION_FIELD_LABELS.effectiveResolution}
        help={VISION_FIELD_HELP.effectiveResolution}
        kind="number"
        placeholder="768"
        number={{ min: 1, integer: true }}
      />
    </>
  )
}
