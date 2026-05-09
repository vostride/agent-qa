import { ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { RunArtifactResponse } from "@/lib/api"
import { routes } from "@/lib/routes"
import {
  formatArtifactValue,
  InspectorSection,
  isArtifactArray,
  isArtifactRecord,
  KeyValueRows,
  KeyValueTree,
  MissingSection,
  RawBlock,
} from "./artifact-renderers"

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

function sourceKind(source: Record<string, unknown> | null): "test" | "suite" | "unknown" {
  const kind = textAt(source, "kind")
  if (kind === "test" || kind === "suite") return kind
  return "unknown"
}

function childRunIdForMember(
  member: Record<string, unknown>,
  response: RunArtifactResponse,
): string | null {
  const explicit = textAt(member, "childRunId")
  if (explicit) return explicit
  const testId = textAt(member, "testId")
  const name = textAt(member, "name")
  const child = response.children.find(({ run }) => {
    if (testId && run.testId === testId) return true
    if (name && run.name === name) return true
    return false
  })
  return child?.run.id ?? null
}

function ConfigSummary({ config }: { config: Record<string, unknown> }) {
  const envFile = recordAt(config, "envFile")
  const secretsFile = recordAt(config, "secretsFile")
  const hooks = arrayAt(config, "hooks")
  const model = recordAt(config, "model")
  const secretsPath = textAt(secretsFile, "path")
  const secretsStatus = textAt(secretsFile, "status")
  const secretsCount = typeof valueAt(secretsFile, "count") === "number"
    ? valueAt(secretsFile, "count") as number
    : null

  return (
    <KeyValueRows
      rows={[
        { label: "Raw config", value: textAt(config, "rawConfigContent") ? "Captured" : "Not captured" },
        { label: "Env file", value: formatArtifactValue(textAt(envFile, "path")) },
        {
          label: "Secrets file",
          value: secretsFile ? (
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="break-all font-mono text-xs">{formatArtifactValue(secretsPath)}</span>
              {secretsStatus ? <Badge variant="outline" className="text-[10px]">{secretsStatus}</Badge> : null}
              {secretsCount !== null ? <span className="text-xs text-muted-foreground">{secretsCount} secret{secretsCount === 1 ? "" : "s"}</span> : null}
            </span>
          ) : "Not captured",
        },
        { label: "CLI vars", value: formatArtifactValue(Object.keys(recordAt(config, "cliVars") ?? {}).length), mono: true },
        { label: "Inline vars", value: formatArtifactValue(Object.keys(recordAt(config, "inlineVars") ?? {}).length), mono: true },
        { label: "Hooks", value: formatArtifactValue(hooks.length), mono: true },
        { label: "Model", value: model ? <KeyValueTree label="model" value={model} /> : "Not captured" },
      ]}
    />
  )
}

function SourceSummary({ source }: { source: Record<string, unknown> }) {
  const kind = sourceKind(source)
  const error = terminalErrorMessage(valueAt(source, "error"))

  return (
    <KeyValueRows
      rows={[
        { label: "Kind", value: kind, mono: true },
        { label: "Name", value: formatArtifactValue(textAt(source, "name")) },
        {
          label: kind === "suite" ? "Suite ID" : "Test ID",
          value: formatArtifactValue(textAt(source, kind === "suite" ? "suiteId" : "testId")),
          mono: true,
        },
        { label: "Path", value: formatArtifactValue(textAt(source, "filePath")), mono: true },
        { label: "Load status", value: formatArtifactValue(textAt(source, "loadStatus")), mono: true },
        { label: "Error", value: error ?? "None" },
      ]}
    />
  )
}

function SuiteMembers({
  source,
  response,
}: {
  source: Record<string, unknown>
  response: RunArtifactResponse
}) {
  const members = arrayAt(source, "members")
    .filter(isArtifactRecord)
    .sort((a, b) => {
      const aIndex = typeof a.index === "number" ? a.index : 0
      const bIndex = typeof b.index === "number" ? b.index : 0
      return aIndex - bIndex
    })

  if (members.length === 0) return null

  return (
    <InspectorSection title="Suite Members" badges={[`${members.length} members`]}>
      <div className="space-y-3">
        {members.map((member) => {
          const ref = recordAt(member, "ref")
          const index = typeof member.index === "number" ? member.index : 0
          const childRunId = childRunIdForMember(member, response)
          const error = terminalErrorMessage(valueAt(member, "error"))

          return (
            <div
              key={`${index}-${textAt(member, "testId") ?? textAt(ref, "test") ?? "member"}`}
              data-suite-member-index={index}
              className="rounded-[2px] border border-border p-3"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[10px]">#{index + 1}</Badge>
                <span className="min-w-0 flex-1 break-words text-sm font-medium">
                  {textAt(member, "name") ?? textAt(ref, "test") ?? "Unnamed member"}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {formatArtifactValue(textAt(member, "loadStatus"))}
                </Badge>
              </div>
              <KeyValueRows
                rows={[
                  { label: "Test ID", value: formatArtifactValue(textAt(member, "testId")), mono: true },
                  { label: "Ref", value: formatArtifactValue(textAt(ref, "test")), mono: true },
                  { label: "Ref ID", value: formatArtifactValue(textAt(ref, "id")), mono: true },
                  { label: "Path", value: formatArtifactValue(textAt(member, "filePath")), mono: true },
                  { label: "Target", value: formatArtifactValue(textAt(member, "target")) },
                  {
                    label: "Child run",
                    value: childRunId ? (
                      <a className="break-all text-primary hover:underline" href={routes.runDetail(childRunId)}>
                        {childRunId}
                      </a>
                    ) : "Not captured",
                    mono: Boolean(childRunId),
                  },
                  { label: "Error", value: error ?? "None" },
                ]}
              />
              <Collapsible>
                <CollapsibleTrigger className="group mt-2 flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                  Member snapshots
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-2">
                  <RawBlock label="Raw member YAML" content={textAt(member, "rawYaml")} />
                  {valueAt(member, "resolvedDefinition") !== undefined ? (
                    <KeyValueTree label="resolvedDefinition" value={valueAt(member, "resolvedDefinition")} />
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            </div>
          )
        })}
      </div>
    </InspectorSection>
  )
}

export function ArtifactConfigTab({ response }: { response: RunArtifactResponse }) {
  const artifact = response.artifact
  const payload = artifact?.payload ?? { schemaVersion: 1 }
  const payloadRecord = isArtifactRecord(payload) ? payload : { schemaVersion: 1 }
  const config = recordAt(payloadRecord, "config")
  const source = recordAt(payloadRecord, "source")
  const runtime = recordAt(payloadRecord, "runtime")
  const errors = arrayAt(payloadRecord, "errors")
  const missingSections = new Set(response.missingSections)
  const kind = sourceKind(source)

  return (
    <div className="space-y-4">
      <InspectorSection title="Run Summary" badges={[artifact?.kind ?? "unknown"]}>
        <KeyValueRows
          rows={[
            { label: "Run", value: response.run.name },
            { label: "Run ID", value: response.run.id, mono: true },
            { label: "Artifact kind", value: artifact?.kind ?? "unknown", mono: true },
            { label: "Schema version", value: artifact?.schemaVersion ?? payloadRecord.schemaVersion ?? "Not captured", mono: true },
            { label: "Finalized", value: artifact?.finalizedAt ?? "Not finalized", mono: true },
            { label: "Test ID", value: formatArtifactValue(response.run.testId), mono: true },
            { label: "Suite ID", value: formatArtifactValue(response.run.suiteId), mono: true },
            { label: "Platform", value: formatArtifactValue(response.run.platform) },
            { label: "Target", value: formatArtifactValue(response.run.targetName) },
          ]}
        />
      </InspectorSection>

      <InspectorSection title="Global Config">
        {missingSections.has("config") || !config ? (
          <MissingSection section="Config" />
        ) : (
          <>
            <ConfigSummary config={config} />
            {valueAt(config, "parsedConfig") !== undefined ? (
              <KeyValueTree label="parsedConfig" value={valueAt(config, "parsedConfig")} />
            ) : null}
            <RawBlock label="Raw global config" content={textAt(config, "rawConfigContent")} />
          </>
        )}
      </InspectorSection>

      <InspectorSection title="Effective Config">
        {missingSections.has("config") || !config ? (
          <MissingSection section="Config" />
        ) : (
          <KeyValueTree label="effectiveConfig" value={valueAt(config, "effectiveConfig")} />
        )}
      </InspectorSection>

      <InspectorSection title="Source Snapshot" badges={[kind]}>
        {missingSections.has("source") || !source ? (
          <MissingSection section="Source" />
        ) : (
          <>
            <SourceSummary source={source} />
            <RawBlock label={kind === "suite" ? "Raw suite YAML" : "Raw test YAML"} content={textAt(source, "rawYaml")} />
            {valueAt(source, "resolvedDefinition") !== undefined ? (
              <KeyValueTree label="resolvedDefinition" value={valueAt(source, "resolvedDefinition")} />
            ) : null}
          </>
        )}
      </InspectorSection>

      {source ? <SuiteMembers source={source} response={response} /> : null}

      {(runtime || errors.length > 0) ? (
        <InspectorSection title="Runtime and Errors" badges={errors.length > 0 ? [`${errors.length} errors`] : []}>
          {runtime ? <KeyValueTree label="runtime" value={runtime} /> : null}
          {errors.length > 0 ? (
            <div className="space-y-2">
              {errors.map((error, index) => (
                <div key={index} className="rounded-[2px] border border-red-500/20 bg-red-500/5 p-3 text-sm">
                  {terminalErrorMessage(error) ?? JSON.stringify(error)}
                </div>
              ))}
            </div>
          ) : null}
        </InspectorSection>
      ) : null}
    </div>
  )
}
