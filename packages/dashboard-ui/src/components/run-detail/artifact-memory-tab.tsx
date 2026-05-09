import { ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { RunArtifactResponse } from "@/lib/api"
import { formatTokens } from "@/lib/format"
import { cn, formatDuration } from "@/lib/utils"
import {
  formatArtifactValue,
  InspectorSection,
  isArtifactArray,
  isArtifactRecord,
  KeyValueRows,
} from "./artifact-renderers"

type MemoryAction = "add" | "confirm" | "deprecate" | "delete"
type MemoryTier = "products" | "suites" | "tests"

interface ObservationSnapshot {
  id: string
  title: string
  content: string
  trust: number
  last_confirmed: string
  confirmed_count: number
  contradicted_count: number
  source_test: string
}

interface MemoryDelta {
  action: MemoryAction
  tier: MemoryTier
  scope: string
  observationId: string
  reasoning: string
  before: ObservationSnapshot | null
  after: ObservationSnapshot | null
  error?: string
}

const GROUPS: Array<{ action: MemoryAction; title: string; className: string }> = [
  { action: "add", title: "Added", className: "border-emerald-500/20 bg-emerald-500/5 text-emerald-500" },
  { action: "confirm", title: "Updated/Confirmed", className: "border-blue-500/20 bg-blue-500/5 text-blue-500" },
  { action: "deprecate", title: "Deprecated", className: "border-amber-500/25 bg-amber-500/5 text-amber-500" },
  { action: "delete", title: "Deleted", className: "border-red-500/20 bg-red-500/5 text-red-500" },
]

function valueAt(record: Record<string, unknown> | null, key: string): unknown {
  return record ? record[key] : undefined
}

function textAt(record: Record<string, unknown> | null, key: string): string | null {
  const value = valueAt(record, key)
  return typeof value === "string" && value.length > 0 ? value : null
}

function numberAt(record: Record<string, unknown> | null, key: string): number | null {
  const value = valueAt(record, key)
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function observationFrom(value: unknown): ObservationSnapshot | null {
  if (!isArtifactRecord(value)) return null
  const id = textAt(value, "id")
  const title = textAt(value, "title")
  const content = textAt(value, "content")
  const trust = numberAt(value, "trust")
  const confirmed = numberAt(value, "confirmed_count")
  const contradicted = numberAt(value, "contradicted_count")
  if (!id || !title || !content || trust === null || confirmed === null || contradicted === null) {
    return null
  }
  return {
    id,
    title,
    content,
    trust,
    last_confirmed: textAt(value, "last_confirmed") ?? "Not captured",
    confirmed_count: confirmed,
    contradicted_count: contradicted,
    source_test: textAt(value, "source_test") ?? "Not captured",
  }
}

function deltaFrom(value: unknown): MemoryDelta | null {
  if (!isArtifactRecord(value)) return null
  const action = textAt(value, "action")
  if (action !== "add" && action !== "confirm" && action !== "deprecate" && action !== "delete") return null
  const tier = textAt(value, "tier")
  if (tier !== "products" && tier !== "suites" && tier !== "tests") return null
  return {
    action,
    tier,
    scope: textAt(value, "scope") ?? "unknown",
    observationId: textAt(value, "observationId") ?? observationFrom(valueAt(value, "after"))?.id ?? observationFrom(valueAt(value, "before"))?.id ?? "unknown",
    reasoning: textAt(value, "reasoning") ?? "No curator reasoning captured.",
    before: observationFrom(valueAt(value, "before")),
    after: observationFrom(valueAt(value, "after")),
    error: textAt(value, "error") ?? undefined,
  }
}

function memoryLogFrom(response: RunArtifactResponse): Record<string, unknown> | null {
  const payload = response.artifact?.payload
  if (!isArtifactRecord(payload)) return null
  const memory = valueAt(payload, "memory")
  if (!isArtifactRecord(memory)) return null
  const log = valueAt(memory, "log")
  return isArtifactRecord(log) ? log : null
}

function deltasFrom(log: Record<string, unknown>): MemoryDelta[] {
  const deltas = valueAt(log, "deltas")
  if (!isArtifactArray(deltas)) return []
  return deltas.map(deltaFrom).filter((delta): delta is MemoryDelta => Boolean(delta))
}

function groupDeltas(deltas: MemoryDelta[]) {
  return Object.fromEntries(
    GROUPS.map((group) => [group.action, deltas.filter((delta) => delta.action === group.action)]),
  ) as Record<MemoryAction, MemoryDelta[]>
}

function countFor(log: Record<string, unknown>, action: MemoryAction, fallback: number): number {
  const key = action === "confirm" ? "confirmed" : action === "add" ? "added" : action === "deprecate" ? "deprecated" : "deleted"
  return numberAt(log, key) ?? fallback
}

function countDelta(before: number | null | undefined, after: number | null | undefined): string | null {
  if (before == null || after == null) return null
  const delta = Math.round((after - before) * 1000) / 1000
  if (delta === 0) return "0"
  return delta > 0 ? `+${delta}` : String(delta)
}

function changedFields(before: ObservationSnapshot | null, after: ObservationSnapshot | null): string[] {
  if (!before || !after) return []
  const fields: Array<keyof ObservationSnapshot> = [
    "title",
    "content",
    "trust",
    "confirmed_count",
    "contradicted_count",
    "last_confirmed",
    "source_test",
  ]
  return fields.filter((field) => before[field] !== after[field])
}

function MemorySummary({
  log,
  counts,
}: {
  log: Record<string, unknown>
  counts: Record<MemoryAction, number>
}) {
  const tokenUsage = valueAt(log, "tokenUsage")
  const curatorDuration = numberAt(log, "curatorDuration")
  const promptTokens = isArtifactRecord(tokenUsage) ? numberAt(tokenUsage, "promptTokens") : null
  const completionTokens = isArtifactRecord(tokenUsage) ? numberAt(tokenUsage, "completionTokens") : null
  const totalTokens = isArtifactRecord(tokenUsage) ? numberAt(tokenUsage, "totalTokens") : null

  return (
    <section className="rounded-[2px] border border-border">
      <div className="grid grid-cols-2 divide-x divide-y divide-border/50 sm:grid-cols-4 sm:divide-y-0">
        {GROUPS.map((group) => (
          <div key={group.action} className="px-3 py-3">
            <div className="text-[11px] font-medium text-muted-foreground">{group.title}</div>
            <div className="mt-1 font-mono text-lg text-foreground">{counts[group.action]}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>Curator duration: {curatorDuration == null ? "Not captured" : formatDuration(curatorDuration)}</span>
        <span>
          Tokens: {totalTokens == null
            ? "Not captured"
            : `${formatTokens(promptTokens ?? 0)} / ${formatTokens(completionTokens ?? 0)} / ${formatTokens(totalTokens)}`}
        </span>
      </div>
    </section>
  )
}

function ObservationBlock({
  label,
  observation,
  tone,
}: {
  label: "Before" | "After"
  observation: ObservationSnapshot | null
  tone: "before" | "after"
}) {
  if (!observation) return null
  return (
    <div
      className={cn(
        "rounded-[2px] border border-border border-l-2 p-3",
        tone === "before" ? "border-l-red-500/60 bg-red-500/5" : "border-l-emerald-500/60 bg-emerald-500/5",
      )}
    >
      <div className="mb-2 text-[11px] font-semibold text-muted-foreground">{label}</div>
      <KeyValueRows
        rows={[
          { label: "Title", value: observation.title },
          { label: "ID", value: observation.id, mono: true },
          { label: "Trust", value: observation.trust, mono: true },
          { label: "Confirmed", value: observation.confirmed_count, mono: true },
          { label: "Contradicted", value: observation.contradicted_count, mono: true },
          { label: "Source test", value: observation.source_test, mono: true },
          { label: "Last confirmed", value: observation.last_confirmed, mono: true },
        ]}
      />
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
        {observation.content}
      </p>
    </div>
  )
}

function MemoryDeltaCard({ delta, groupClassName }: { delta: MemoryDelta; groupClassName: string }) {
  const title = delta.after?.title ?? delta.before?.title ?? delta.observationId
  const trustDelta = countDelta(delta.before?.trust, delta.after?.trust)
  const confirmedDelta = countDelta(delta.before?.confirmed_count, delta.after?.confirmed_count)
  const contradictedDelta = countDelta(delta.before?.contradicted_count, delta.after?.contradicted_count)
  const fields = changedFields(delta.before, delta.after)

  return (
    <Collapsible>
      <div className="rounded-[2px] border border-border p-3">
        <CollapsibleTrigger className="group flex w-full min-w-0 items-start gap-2 text-left">
          <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h4 className="min-w-0 flex-1 break-words text-sm font-medium text-foreground">{title}</h4>
              <Badge variant="outline" className={cn("text-[10px]", groupClassName)}>
                {GROUPS.find((group) => group.action === delta.action)?.title ?? delta.action}
              </Badge>
              <Badge variant="outline" className="max-w-full whitespace-normal break-all text-left text-[10px]">
                {delta.tier}/{delta.scope}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
              <span className="break-all">{delta.observationId}</span>
              {trustDelta ? <span>trust {trustDelta}</span> : null}
              {confirmedDelta ? <span>confirmed {confirmedDelta}</span> : null}
              {contradictedDelta ? <span>contradicted {contradictedDelta}</span> : null}
            </div>
            <p className="mt-2 line-clamp-2 break-words text-xs text-muted-foreground">{delta.reasoning}</p>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          {fields.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              Changed fields: <span className="font-mono text-foreground">{fields.join(", ")}</span>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">Changed fields: None captured</div>
          )}
          {delta.error ? <div className="text-xs text-red-500">Error: {delta.error}</div> : null}
          {delta.action === "add" ? (
            <ObservationBlock label="After" observation={delta.after} tone="after" />
          ) : delta.action === "delete" ? (
            <ObservationBlock label="Before" observation={delta.before} tone="before" />
          ) : (
            <>
              <ObservationBlock label="Before" observation={delta.before} tone="before" />
              <ObservationBlock label="After" observation={delta.after} tone="after" />
            </>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function ArtifactMemoryTab({ response }: { response: RunArtifactResponse }) {
  const log = memoryLogFrom(response)
  if (response.missingSections.includes("memory") || !log) {
    return (
      <div className="rounded-[2px] border border-border px-4 py-4 text-sm text-muted-foreground">
        Memory was not captured for this run.
      </div>
    )
  }

  const deltas = deltasFrom(log)
  const grouped = groupDeltas(deltas)
  const counts: Record<MemoryAction, number> = {
    add: countFor(log, "add", grouped.add.length),
    confirm: countFor(log, "confirm", grouped.confirm.length),
    deprecate: countFor(log, "deprecate", grouped.deprecate.length),
    delete: countFor(log, "delete", grouped.delete.length),
  }
  const totalChanges = counts.add + counts.confirm + counts.deprecate + counts.delete

  return (
    <div className="space-y-4">
      <MemorySummary log={log} counts={counts} />

      {totalChanges === 0 ? (
        <div className="rounded-[2px] border border-border px-4 py-4">
          <h3 className="text-sm font-medium text-foreground">No memory changes</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Memory completed without adding, updating, deprecating, or deleting observations.
          </p>
        </div>
      ) : null}

      {GROUPS.map((group) => {
        const items = grouped[group.action]
        return (
          <InspectorSection key={group.action} title={group.title} badges={[`${counts[group.action]} changes`]} className="scroll-mt-4">
            <div data-memory-group={group.title} className="space-y-3">
              {items.length === 0 ? (
                <div className="text-sm text-muted-foreground">No {group.title.toLowerCase()} changes.</div>
              ) : (
                items.map((delta) => (
                  <MemoryDeltaCard key={`${delta.action}-${delta.observationId}`} delta={delta} groupClassName={group.className} />
                ))
              )}
            </div>
          </InspectorSection>
        )
      })}

      {isArtifactArray(valueAt(log, "errors")) && (valueAt(log, "errors") as unknown[]).length > 0 ? (
        <InspectorSection title="Memory Errors" badges={[`${(valueAt(log, "errors") as unknown[]).length} errors`]}>
          <div className="space-y-2">
            {(valueAt(log, "errors") as unknown[]).map((error, index) => (
              <div key={index} className="rounded-[2px] border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-500">
                {formatArtifactValue(error)}
              </div>
            ))}
          </div>
        </InspectorSection>
      ) : null}
    </div>
  )
}
