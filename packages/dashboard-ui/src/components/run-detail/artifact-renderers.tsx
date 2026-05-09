import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

type ArtifactRecord = Record<string, unknown>

export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isArtifactArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

export function formatArtifactValue(value: unknown, missingLabel = "Not captured"): string {
  if (value === undefined) return missingLabel
  if (value === null) return "None"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None"
  if (typeof value === "string") return value.length > 0 ? value : "None"
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`
  if (isArtifactRecord(value)) return `${Object.keys(value).length} ${Object.keys(value).length === 1 ? "field" : "fields"}`
  return String(value)
}

export function MissingSection({ section }: { section: string }) {
  return (
    <div className="rounded-[2px] border border-border px-4 py-4 text-sm text-muted-foreground">
      {section} was not captured for this run.
    </div>
  )
}

export function InspectorSection({
  title,
  badges = [],
  children,
  className,
}: {
  title: string
  badges?: string[]
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("rounded-[2px] border border-border bg-transparent", className)}>
      <header className="flex min-w-0 items-center gap-2 border-b px-4 py-3">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</h3>
        {badges.map((badge) => (
          <Badge key={badge} variant="outline" className="text-[10px]">
            {badge}
          </Badge>
        ))}
      </header>
      <div className="space-y-3 px-4 py-4">{children}</div>
    </section>
  )
}

export function KeyValueRows({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode; mono?: boolean }>
}) {
  return (
    <div className="divide-y divide-border/50">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid gap-1 py-1.5 text-xs sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-3"
        >
          <dt className="font-medium text-muted-foreground">{row.label}</dt>
          <dd className={cn("min-w-0 break-words text-foreground", row.mono && "break-all font-mono")}>
            {row.value}
          </dd>
        </div>
      ))}
    </div>
  )
}

function ScalarValue({ value }: { value: unknown }) {
  const isScalarCode =
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"

  return (
    <span
      className={cn(
        "break-words",
        isScalarCode && "font-mono text-[11px]",
        value === null || value === undefined ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {formatArtifactValue(value)}
    </span>
  )
}

export function KeyValueTree({
  value,
  label = "root",
  level = 0,
}: {
  value: unknown
  label?: string
  level?: number
}) {
  if (isArtifactArray(value)) {
    return (
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 py-1.5 text-left text-xs hover:text-foreground">
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="min-w-0 truncate font-medium text-muted-foreground">{label}</span>
          <span className="font-mono text-[11px] text-foreground">
            {value.length} {value.length === 1 ? "item" : "items"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-3 border-l border-border pl-3">
            {value.length === 0 ? (
              <div className="py-1.5 text-xs text-muted-foreground">None</div>
            ) : (
              value.map((item, index) => (
                <KeyValueTree key={`${label}-${index}`} label={`${index}`} value={item} level={level + 1} />
              ))
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  if (isArtifactRecord(value)) {
    const entries = Object.entries(value)
    return (
      <Collapsible defaultOpen={level === 0}>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 py-1.5 text-left text-xs hover:text-foreground">
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="min-w-0 truncate font-medium text-muted-foreground">{label}</span>
          <span className="font-mono text-[11px] text-foreground">
            {entries.length} {entries.length === 1 ? "field" : "fields"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-3 border-l border-border pl-3">
            {entries.length === 0 ? (
              <div className="py-1.5 text-xs text-muted-foreground">None</div>
            ) : (
              entries.map(([key, child]) => (
                <KeyValueTree key={key} label={key} value={child} level={level + 1} />
              ))
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <div className="grid gap-1 py-1.5 text-xs sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-3">
      <span className="min-w-0 break-words font-medium text-muted-foreground">{label}</span>
      <ScalarValue value={value} />
    </div>
  )
}

export function RawBlock({
  label,
  content,
}: {
  label: string
  content: string | null | undefined
}) {
  if (!content) return null

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-[2px] py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-80 overflow-x-auto overflow-y-auto rounded-[2px] border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground">
          {content}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
