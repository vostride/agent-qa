import { ChevronRight, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { RunArtifactResponse } from "@/lib/api"
import {
  couldNotRunOnLine,
  deviceDetail,
  DRAWER_COPY,
  droppedOnLine,
  isDroppedSessionKind,
  pluginLine,
  ranAgainstParts,
  ranHereLine,
  ranOnLine,
  sessionLink,
  type SessionLink,
} from "@/lib/drawer-view"
import { routes } from "@/lib/routes"
import { ArtifactAttributeRows } from "./artifact-attribute-rows"
import { formatArtifactValue, InspectorSection, isArtifactArray, isArtifactRecord, KeyValueRows, KeyValueTree, RawBlock } from "./artifact-renderers"

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

function stringAttributesFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return Object.fromEntries(entries)
}

function getRunAttributes(response: RunArtifactResponse): Record<string, string> {
  const direct = stringAttributesFrom(response.run.attributes)
  if (Object.keys(direct).length > 0) return direct

  const payload = response.artifact?.payload
  const metadata = recordAt(isArtifactRecord(payload) ? payload : null, "metadata")
  return stringAttributesFrom(recordAt(metadata, "attributes"))
}

interface PlaceLine {
  text: string
  // The remote refused the test or dropped its session.
  failed: boolean
  notes: string[]
  plugin: string | null
  link: SessionLink | null
}

function placeNotes(place: Record<string, unknown> | null): string[] {
  return arrayAt(place, "notes")
    .filter((note): note is string => typeof note === "string" && note.length > 0)
}

function placeLine(runtime: unknown): PlaceLine | null {
  const place = recordAt(isArtifactRecord(runtime) ? runtime : null, "place")
  const kind = textAt(place, "place")
  const notes = placeNotes(place)
  if (kind === "here") {
    return {
      text: ranHereLine(textAt(place, "deviceType")),
      failed: false,
      notes,
      plugin: null,
      link: null,
    }
  }
  const name = textAt(place, "name")
  if (kind !== "remote" || !name) return null
  const served = {
    plugin: pluginLine(valueAt(place, "plugin")),
    link: sessionLink(valueAt(place, "link")),
  }
  const protocol = textAt(place, "protocol")
  const where = [protocol, textAt(place, "origin")].filter(Boolean).join(" ")
  const version = protocol === "appium"
    ? deviceDetail(textAt(place, "appiumVersion"), textAt(place, "deviceType"))
    : textAt(place, "browserVersion")
  const failureKind = textAt(place, "failureKind")
  if (failureKind === null) {
    return { text: ranOnLine(name, where, version), failed: false, notes, ...served }
  }
  if (isDroppedSessionKind(failureKind)) {
    const text = droppedOnLine(name, where, version, failureKind)
    return { text, failed: true, notes, ...served }
  }
  return { text: couldNotRunOnLine(name, where, failureKind), failed: true, notes, ...served }
}

function placeClass(place: PlaceLine): string {
  return place.failed ? "text-destructive" : "text-foreground"
}

function PlaceServedBy({ place }: { place: PlaceLine }) {
  if (place.plugin === null && place.link === null) return null
  return (
    <div data-place-plugin className="flex flex-wrap gap-x-2 pb-1.5 text-xs text-muted-foreground">
      {place.plugin === null ? null : <span>{place.plugin}</span>}
      {place.link === null ? null : (
        <a
          data-place-link
          className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
          href={place.link.href}
          target={place.link.target}
          rel={place.link.rel}
        >
          {place.link.label}
          <ExternalLink className="size-3" aria-hidden="true" />
          <span className="sr-only">{` ${DRAWER_COPY.opensInNewTab}`}</span>
        </a>
      )}
    </div>
  )
}

function PlaceNotes({ notes }: { notes: string[] }) {
  return notes.map((note, index) => (
    <div key={index} data-place-note className="pb-1.5 text-xs text-muted-foreground">
      {note}
    </div>
  ))
}

function MemberConfig({ config }: { config: Record<string, unknown> }) {
  const runtime = valueAt(config, "runtime")
  const timeouts = valueAt(config, "timeouts")
  const model = valueAt(config, "model")
  const place = placeLine(runtime)
  return (
    <div data-member-config>
      {place ? (
        <>
          <div data-member-place className={`py-1.5 text-xs ${placeClass(place)}`}>
            {place.text}
          </div>
          <PlaceServedBy place={place} />
          <PlaceNotes notes={place.notes} />
        </>
      ) : null}
      {runtime == null ? null : <KeyValueTree label="runtime" value={runtime} />}
      {timeouts == null ? null : <KeyValueTree label="timeouts" value={timeouts} />}
      {model == null ? null : <KeyValueTree label="model" value={model} />}
    </div>
  )
}

function SuiteMembers({
  source,
  kind,
}: {
  source: Record<string, unknown>
  kind: "suite" | "tests"
}) {
  const members = arrayAt(source, "members")
    .filter(isArtifactRecord)
    .sort((a, b) => {
      const aIndex = typeof a.index === "number" ? a.index : 0
      const bIndex = typeof b.index === "number" ? b.index : 0
      return aIndex - bIndex
    })

  return (
    <InspectorSection
      title={kind === "tests" ? DRAWER_COPY.runTests : DRAWER_COPY.suiteMembers}
      data-drawer-section={kind === "tests" ? "run-tests" : "suite-members"}
    >
      <div className="space-y-3">
        {members.length === 0 ? DRAWER_COPY.notCaptured : null}
        {members.map((member) => {
          const ref = recordAt(member, "ref")
          const index = typeof member.index === "number" ? member.index : 0
          const childRunId = textAt(member, "childRunId")
          const error = terminalErrorMessage(valueAt(member, "error"))
          const config = recordAt(member, "config")
          const ranAgainst = config ? ranAgainstParts(config).join(" · ") : ""

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
                  ...(config ? [{ label: "Ran against", value: ranAgainst || DRAWER_COPY.notCaptured }] : []),
                ]}
              />
              <Collapsible>
                <CollapsibleTrigger className="group mt-2 flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                  Member snapshots
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-2">
                  <RawBlock label={kind === "tests" ? "Raw test YAML" : "Raw member YAML"} content={textAt(member, "rawYaml")} />
                  {valueAt(member, "resolvedDefinition") !== undefined ? (
                    <KeyValueTree label="resolvedDefinition" value={valueAt(member, "resolvedDefinition")} />
                  ) : null}
                  {config ? <MemberConfig config={config} /> : null}
                </CollapsibleContent>
              </Collapsible>
            </div>
          )
        })}
      </div>
    </InspectorSection>
  )
}

export function ArtifactTestTab({ response }: { response: RunArtifactResponse }) {
  const payload = response.artifact?.payload
  const payloadRecord = isArtifactRecord(payload) ? payload : null
  const source = recordAt(payloadRecord, "source")
  const capturedSource = response.missingSections.includes("source") ? null : source
  const kind = textAt(source, "kind")
  const rawYaml = textAt(capturedSource, "rawYaml")
  const definition = valueAt(capturedSource, "resolvedDefinition")
  const attributes = getRunAttributes(response)
  const runConfig = response.missingSections.includes("config") ? null : recordAt(payloadRecord, "config")
  // A run of several tests files each test's place on its own member.
  const runPlace = kind === "tests" ? null : placeLine(valueAt(runConfig, "runtime"))

  return (
    <div className="space-y-4">
      {runPlace ? (
        <div>
          <div data-run-place className={`py-1.5 text-xs ${placeClass(runPlace)}`}>
            {runPlace.text}
          </div>
          <PlaceServedBy place={runPlace} />
          <PlaceNotes notes={runPlace.notes} />
        </div>
      ) : null}
      {kind === "tests" ? null : (
        <>
          <InspectorSection title={DRAWER_COPY.testAsWritten} data-drawer-section="test-as-written">
            {rawYaml ? <RawBlock label={kind === "suite" ? "Raw suite YAML" : "Raw test YAML"} content={rawYaml} /> : DRAWER_COPY.notCaptured}
          </InspectorSection>
          <InspectorSection title={DRAWER_COPY.resolvedDefinition} data-drawer-section="resolved-definition">
            {definition == null ? DRAWER_COPY.notCaptured : <KeyValueTree label="resolvedDefinition" value={definition} />}
          </InspectorSection>
        </>
      )}
      {kind === "suite" || kind === "tests" ? <SuiteMembers source={capturedSource ?? {}} kind={kind} /> : null}
      {Object.keys(attributes).length > 0 ? (
        <InspectorSection title={DRAWER_COPY.runAttributes} data-drawer-section="run-attributes">
          <ArtifactAttributeRows attributes={attributes} />
        </InspectorSection>
      ) : null}
    </div>
  )
}
