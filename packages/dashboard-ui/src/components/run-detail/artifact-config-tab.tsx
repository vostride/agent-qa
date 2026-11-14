import type { RunArtifactResponse } from "@/lib/api"
import { DRAWER_COPY } from "@/lib/drawer-view"
import { InspectorSection, isArtifactArray, isArtifactRecord, KeyValueTree, RawBlock } from "./artifact-renderers"
import { t } from "@/lib/i18n"

function valueAt(record: Record<string, unknown> | null, key: string): unknown {
  return record ? record[key] : undefined
}

function textAt(record: Record<string, unknown> | null, key: string): string | null {
  const value = valueAt(record, key)
  return typeof value === "string" && value.length > 0 ? value : null
}

function recordAt(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = valueAt(record, key)
  return isArtifactRecord(value) ? value : null
}

function arrayAt(record: Record<string, unknown> | null, key: string): unknown[] {
  const value = valueAt(record, key)
  return isArtifactArray(value) ? value : []
}

function terminalErrorMessage(error: unknown): string | null {
  if (!isArtifactRecord(error)) return null
  const code = textAt(error, "code")
  const phase = textAt(error, "phase")
  const message = textAt(error, "message")
  return [code, phase, message].filter(Boolean).join(" - ") || null
}

export function ArtifactConfigTab({ response }: { response: RunArtifactResponse }) {
  const payload = response.artifact?.payload
  const payloadRecord = isArtifactRecord(payload) ? payload : null
  const config = response.missingSections.includes("config") ? null : recordAt(payloadRecord, "config")
  const effectiveConfig = valueAt(config, "effectiveConfig")
  const rawConfig = textAt(config, "rawConfigContent")
  const model = valueAt(config, "model")
  const runtime = valueAt(payloadRecord, "runtime")
  const errors = arrayAt(payloadRecord, "errors")

  return (
    <div className="space-y-4">
      <InspectorSection title={DRAWER_COPY.effectiveConfig} data-drawer-section="effective-config">
        {effectiveConfig == null ? DRAWER_COPY.notCaptured : <KeyValueTree label="effectiveConfig" value={effectiveConfig} />}
      </InspectorSection>
      <InspectorSection title={DRAWER_COPY.globalConfigAsWritten} data-drawer-section="global-config">
        {rawConfig ? <RawBlock label={t("Raw global config")} content={rawConfig} /> : DRAWER_COPY.notCaptured}
      </InspectorSection>
      <InspectorSection title={DRAWER_COPY.model} data-drawer-section="model">
        {model == null ? DRAWER_COPY.notCaptured : <KeyValueTree label="model" value={model} />}
      </InspectorSection>
      <InspectorSection title={DRAWER_COPY.runtime} data-drawer-section="runtime">
        {runtime == null ? DRAWER_COPY.notCaptured : <KeyValueTree label="runtime" value={runtime} />}
      </InspectorSection>
      <InspectorSection title={DRAWER_COPY.errors} data-drawer-section="errors">
        {errors.length > 0 ? (
          <div className="space-y-2">
            {errors.map((error, index) => (
              <div key={index} className="rounded-[2px] border border-red-500/20 bg-red-500/5 p-3 text-sm">
                {terminalErrorMessage(error) ?? JSON.stringify(error)}
              </div>
            ))}
          </div>
        ) : DRAWER_COPY.notCaptured}
      </InspectorSection>
    </div>
  )
}
