import { ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { RunArtifactResponse } from "@/lib/api"
import { formatTokens } from "@/lib/format"
import { cn, formatDuration } from "@/lib/utils"
import {
  formatArtifactValue,
  isArtifactArray,
  isArtifactRecord,
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

type ArtifactRecord = Record<string, unknown>

const GROUPS: Array<{
  action: MemoryAction
  title: string
  className: string
  railClassName: string
  surfaceClassName: string
}> = [
  {
    action: "add",
    title: "Added",
    className: "border-emerald-500/20 bg-emerald-500/5 text-emerald-500",
    railClassName: "border-l-emerald-500/80",
    surfaceClassName: "bg-emerald-500/[0.04]",
  },
  {
    action: "confirm",
    title: "Updated/Confirmed",
    className: "border-blue-500/20 bg-blue-500/5 text-blue-500",
    railClassName: "border-l-blue-500/80",
    surfaceClassName: "bg-blue-500/[0.04]",
  },
  {
    action: "deprecate",
    title: "Deprecated",
    className: "border-amber-500/25 bg-amber-500/5 text-amber-500",
    railClassName: "border-l-amber-500/80",
    surfaceClassName: "bg-amber-500/[0.04]",
  },
  {
    action: "delete",
    title: "Deleted",
    className: "border-red-500/20 bg-red-500/5 text-red-500",
    railClassName: "border-l-red-500/80",
    surfaceClassName: "bg-red-500/[0.04]",
  },
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

function isMemoryLogRecord(value: unknown): value is ArtifactRecord {
  if (!isArtifactRecord(value)) return false
  return ["added", "confirmed", "deprecated", "deleted", "deltas", "errors", "curatorDuration", "tokenUsage"]
    .some((key) => key in value)
}

function memoryLogFromArtifact(artifact: RunArtifactResponse["artifact"]): ArtifactRecord | null {
  const payload = artifact?.payload
  if (!isArtifactRecord(payload)) return null
  const memory = valueAt(payload, "memory")
  if (!isArtifactRecord(memory)) return null
  const log = valueAt(memory, "log")
  return isMemoryLogRecord(log) ? log : null
}

function memoryLogFromRunJson(memoryLog: string | null | undefined): ArtifactRecord | null {
  if (!memoryLog) return null
  try {
    const parsed = JSON.parse(memoryLog)
    return isMemoryLogRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function childMemoryLogsFrom(response: RunArtifactResponse): ArtifactRecord[] {
  const logs: ArtifactRecord[] = []
  for (const child of response.children) {
    const artifactLog = memoryLogFromArtifact(child.artifact)
    if (artifactLog) {
      logs.push(artifactLog)
      continue
    }
    const runLog = memoryLogFromRunJson(child.run.memoryLog)
    if (runLog) logs.push(runLog)
  }
  return logs
}

function sumNumber(logs: ArtifactRecord[], key: string): number {
  return logs.reduce((sum, log) => sum + (numberAt(log, key) ?? 0), 0)
}

function mergeTokenUsage(logs: ArtifactRecord[]): Record<string, number> | undefined {
  let sawUsage = false
  const tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  for (const log of logs) {
    const usage = valueAt(log, "tokenUsage")
    if (!isArtifactRecord(usage)) continue
    sawUsage = true
    tokenUsage.promptTokens += numberAt(usage, "promptTokens") ?? 0
    tokenUsage.completionTokens += numberAt(usage, "completionTokens") ?? 0
    tokenUsage.totalTokens += numberAt(usage, "totalTokens") ?? 0
  }
  return sawUsage ? tokenUsage : undefined
}

function mergeMemoryLogs(logs: ArtifactRecord[]): ArtifactRecord | null {
  if (logs.length === 0) return null
  const deltas = logs.flatMap((log) => {
    const value = valueAt(log, "deltas")
    return isArtifactArray(value) ? value : []
  })
  const errors = logs.flatMap((log) => {
    const value = valueAt(log, "errors")
    return isArtifactArray(value) ? value : []
  })
  const merged: ArtifactRecord = {
    added: sumNumber(logs, "added"),
    confirmed: sumNumber(logs, "confirmed"),
    deprecated: sumNumber(logs, "deprecated"),
    deleted: sumNumber(logs, "deleted"),
    errors,
    curatorDuration: sumNumber(logs, "curatorDuration"),
    deltas,
  }
  const tokenUsage = mergeTokenUsage(logs)
  if (tokenUsage) merged.tokenUsage = tokenUsage
  return merged
}

function memoryLogFrom(response: RunArtifactResponse): ArtifactRecord | null {
  const directLog = memoryLogFromArtifact(response.artifact)
  if (directLog) return directLog
  const childLogs = childMemoryLogsFrom(response)
  if (childLogs.length > 0) return mergeMemoryLogs(childLogs)
  return memoryLogFromRunJson(response.run.memoryLog)
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
    <section className="rounded-[2px] border border-border/60 bg-muted/20 px-3 py-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {GROUPS.map((group) => (
          <div key={group.action}>
            <div className="text-[11px] font-medium text-muted-foreground">{group.title}</div>
            <div className="mt-1 font-mono text-lg text-foreground">{counts[group.action]}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
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
}: {
  label: "Before" | "After"
  observation: ObservationSnapshot | null
}) {
  if (!observation) return null
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="min-w-0 break-words">Title <span className="text-foreground">{observation.title}</span></span>
        <span className="font-mono">Trust {observation.trust}</span>
        <span className="font-mono">Confirmed {observation.confirmed_count}</span>
        <span className="font-mono">Contradicted {observation.contradicted_count}</span>
        <span className="min-w-0 break-all font-mono">ID {observation.id}</span>
        <span className="min-w-0 break-all font-mono">Source {observation.source_test}</span>
        <span className="font-mono">Last {observation.last_confirmed}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
        {observation.content}
      </p>
    </div>
  )
}

function MemoryDeltaCard({
  delta,
  group,
}: {
  delta: MemoryDelta
  group: (typeof GROUPS)[number]
}) {
  const title = delta.after?.title ?? delta.before?.title ?? delta.observationId
  const trustDelta = countDelta(delta.before?.trust, delta.after?.trust)
  const confirmedDelta = countDelta(delta.before?.confirmed_count, delta.after?.confirmed_count)
  const contradictedDelta = countDelta(delta.before?.contradicted_count, delta.after?.contradicted_count)
  const fields = changedFields(delta.before, delta.after)

  return (
    <Collapsible>
      <div className={cn("border-y border-l-2 border-border/55 px-4 py-3", group.railClassName, group.surfaceClassName)}>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-start gap-2 text-left">
          <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h4 className="min-w-0 flex-1 break-words text-sm font-medium text-foreground">{title}</h4>
              <Badge variant="outline" className={cn("text-[10px]", group.className)}>
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
            <ObservationBlock label="After" observation={delta.after} />
          ) : delta.action === "delete" ? (
            <ObservationBlock label="Before" observation={delta.before} />
          ) : (
            <>
              <ObservationBlock label="Before" observation={delta.before} />
              <ObservationBlock label="After" observation={delta.after} />
            </>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function ArtifactMemoryTab({ response }: { response: RunArtifactResponse }) {
  const log = memoryLogFrom(response)
  if (!log) {
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
          <section key={group.action} className="scroll-mt-4 space-y-3">
            <header className="flex min-w-0 items-center gap-2 px-1">
              <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{group.title}</h3>
              <Badge variant="outline" className="text-[10px]">
                {counts[group.action]} changes
              </Badge>
            </header>
            <div data-memory-group={group.title} className="space-y-3">
              {items.length === 0 ? (
                <div className="px-1 text-sm text-muted-foreground">No {group.title.toLowerCase()} changes.</div>
              ) : (
                items.map((delta) => (
                  <MemoryDeltaCard key={`${delta.action}-${delta.observationId}`} delta={delta} group={group} />
                ))
              )}
            </div>
          </section>
        )
      })}

      {isArtifactArray(valueAt(log, "errors")) && (valueAt(log, "errors") as unknown[]).length > 0 ? (
        <section className="space-y-3">
          <header className="flex min-w-0 items-center gap-2 px-1">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">Memory Errors</h3>
            <Badge variant="outline" className="text-[10px]">
              {(valueAt(log, "errors") as unknown[]).length} errors
            </Badge>
          </header>
          <div className="space-y-2">
            {(valueAt(log, "errors") as unknown[]).map((error, index) => (
              <div key={index} className="rounded-[2px] border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-500">
                {formatArtifactValue(error)}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
