import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ExecutionLogEntry, LiveExecutionLogEntry } from "@/lib/api"
import { cn, formatDuration } from "@/lib/utils"

type HookDetailLog = ExecutionLogEntry | LiveExecutionLogEntry

export function HookDetailPanel({ log }: { log: HookDetailLog }) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{log.name}</span>
          <Badge className={cn(
            "px-1.5 py-0 text-[10px]",
            log.status === "passed"
              ? "border-emerald-500/20 bg-emerald-500/15 text-emerald-500"
              : log.status === "running"
                ? "border-blue-500/20 bg-blue-500/15 text-blue-500"
                : "border-red-500/20 bg-red-500/15 text-red-500",
          )}>
            {log.status}
          </Badge>
          <span className="ml-auto text-xs text-muted-foreground">{log.phase}</span>
          <span className="text-xs text-muted-foreground">{formatDuration(log.duration)}</span>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-4">
          {log.stdout && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">stdout</h4>
              <pre className="rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap break-all">{log.stdout}</pre>
            </div>
          )}
          {log.stderr && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">stderr</h4>
              <pre className="rounded-md bg-red-500/5 p-2 font-mono text-xs whitespace-pre-wrap break-all text-red-400">{log.stderr}</pre>
            </div>
          )}
          {log.variables && Object.keys(log.variables).length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">Emitted Variables</h4>
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(log.variables).map(([key, value]) => (
                    <tr key={key} className="border-b border-border/50">
                      <td className="px-2 py-1 font-mono text-xs text-muted-foreground">{key}</td>
                      <td className="px-2 py-1 font-mono text-xs break-all">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {log.returnData != null && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">Return Data</h4>
              <pre className="rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap break-all">
                {typeof log.returnData === "string" ? log.returnData : JSON.stringify(log.returnData, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
