import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Badge } from "@/components/ui/badge"
import { ChevronRight, CheckCircle2, XCircle } from "lucide-react"
import { cn, formatDuration } from "@/lib/utils"
import type { StepRow, ExecutionLogEntry, LiveExecutionLogEntry } from "@/lib/api"

interface TabEnvProps {
  step: Pick<StepRow, "variableSnapshot">
  executionLogs?: Array<ExecutionLogEntry | LiveExecutionLogEntry>
}

function sourceColor(source: string): string {
  switch (source) {
    case 'env': return 'bg-blue-500/15 text-blue-400 border-blue-500/20'
    case 'capture': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20'
    case 'cli': return 'bg-purple-500/15 text-purple-400 border-purple-500/20'
    case 'inline': return 'bg-amber-500/15 text-amber-400 border-amber-500/20'
    case 'suite': return 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20'
    case 'test': return 'bg-pink-500/15 text-pink-400 border-pink-500/20'
    case 'hook': return 'bg-orange-500/15 text-orange-400 border-orange-500/20'
    case 'step': return 'bg-teal-500/15 text-teal-400 border-teal-500/20'
    default: return 'bg-muted text-muted-foreground'
  }
}

function SectionHeader({ title, count, defaultOpen, children }: {
  title: string
  count: number
  defaultOpen: boolean
  children: React.ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
        <ChevronRight className="h-3 w-3 transition-transform duration-200 [[data-state=open]>&]:rotate-90" />
        {title}
        <span className="text-[10px] text-muted-foreground/60">({count})</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

function EmptySection({ message }: { message: string }) {
  return (
    <div className="px-4 py-3 text-xs text-muted-foreground/60 italic">
      {message}
    </div>
  )
}

export function TabEnv({ step, executionLogs = [] }: TabEnvProps) {
  const snapshot = step.variableSnapshot
  const envEntries = snapshot ? Object.entries(snapshot) : []

  const runjsLogs = executionLogs.filter(l => l.type === 'runjs')
  const hookLogs = executionLogs.filter(l => l.type === 'hook')

  return (
    <div className="py-1">
      <SectionHeader title="Env" count={envEntries.length} defaultOpen={envEntries.length > 0}>
        {envEntries.length === 0 ? (
          <EmptySection message="No variables at this step" />
        ) : (
          <div className="px-3 pb-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-1.5 px-2 text-xs font-medium text-muted-foreground">Variable</th>
                  <th className="text-left py-1.5 px-2 text-xs font-medium text-muted-foreground">Value</th>
                  <th className="text-left py-1.5 px-2 text-xs font-medium text-muted-foreground">Source</th>
                </tr>
              </thead>
              <tbody>
                {envEntries.map(([key, meta]) => (
                  <tr key={key} className="border-b border-border/50">
                    <td className="py-1.5 px-2 font-mono text-xs text-muted-foreground">{key}</td>
                    <td className="py-1.5 px-2 font-mono text-xs break-all">{meta.value}</td>
                    <td className="py-1.5 px-2">
                      <Badge className={cn("text-[10px] px-1.5 py-0 border", sourceColor(meta.source))}>
                        {meta.source}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionHeader>

      <SectionHeader title="runJS" count={runjsLogs.length} defaultOpen={runjsLogs.length > 0}>
        {runjsLogs.length === 0 ? (
          <EmptySection message="No runJS executions for this step" />
        ) : (
          <div className="px-3 pb-2 space-y-2">
            {runjsLogs.map((log) => (
              <div key={log.id} className="rounded-md border border-border/50 p-2 text-xs">
                <div className="flex items-center gap-2 mb-1.5">
                  {log.status === 'passed' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                  )}
                  <span className="font-medium truncate">{log.name}</span>
                  <span className="text-muted-foreground ml-auto shrink-0">{formatDuration(log.duration)}</span>
                </div>
                {log.stdout && (
                  <pre className="mt-1 p-1.5 rounded bg-muted/50 font-mono text-[11px] whitespace-pre-wrap break-all overflow-hidden">{log.stdout}</pre>
                )}
                {log.returnData != null && (
                  <div className="mt-1 p-1.5 rounded bg-muted/50">
                    <span className="text-muted-foreground">Return: </span>
                    <span className="font-mono text-[11px]">{typeof log.returnData === 'string' ? log.returnData : JSON.stringify(log.returnData)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionHeader>

      <SectionHeader title="Hooks" count={hookLogs.length} defaultOpen={hookLogs.length > 0}>
        {hookLogs.length === 0 ? (
          <EmptySection message="No hooks ran for this step" />
        ) : (
          <div className="px-3 pb-2 space-y-2">
            {hookLogs.map((log) => (
              <div key={log.id} className="rounded-md border border-border/50 p-2 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  {log.status === 'passed' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                  )}
                  <span className="font-medium truncate">{log.name}</span>
                  <span className="text-muted-foreground ml-auto shrink-0">{formatDuration(log.duration)}</span>
                </div>
                {log.variables && Object.keys(log.variables).length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    <span className="text-muted-foreground text-[10px]">Emitted variables:</span>
                    {Object.entries(log.variables).map(([k, v]) => (
                      <div key={k} className="flex gap-2 pl-2 font-mono text-[11px]">
                        <span className="text-muted-foreground">{k}:</span>
                        <span className="break-all">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
                {log.stdout && (
                  <pre className="mt-1 p-1.5 rounded bg-muted/50 font-mono text-[11px] whitespace-pre-wrap break-all overflow-hidden max-h-24 overflow-y-auto">{log.stdout}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionHeader>
    </div>
  )
}
