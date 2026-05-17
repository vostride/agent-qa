import { useEffect, useState } from "react"

import {
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fetchAuthStates, type AuthStateMetadata } from "@/lib/api"

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function formatCapturedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return DATE_FORMAT.format(date)
}

export function AuthStatesSection() {
  const [authStates, setAuthStates] = useState<AuthStateMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let active = true

    async function loadAuthStates() {
      setLoading(true)
      try {
        const result = await fetchAuthStates()
        if (!active) return
        setAuthStates(result.authStates.filter((state) => state.kind === "web"))
        setLoadFailed(false)
      } catch {
        if (!active) return
        setAuthStates([])
        setLoadFailed(true)
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    loadAuthStates()

    return () => {
      active = false
    }
  }, [])

  return (
    <ConfigSectionShell>
      <ConfigSectionHeader>
        <h2 className="text-base font-semibold">Auth States</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review saved web auth states by target and logical name.
        </p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading auth states...</p>
        ) : loadFailed ? (
          <div role="alert" className="border border-destructive/30 px-4 py-3 text-sm text-destructive">
            Could not load saved auth states.
          </div>
        ) : authStates.length === 0 ? (
          <div className="space-y-2 py-8 text-center">
            <h3 className="text-sm font-semibold">No auth states saved</h3>
            <p className="text-sm text-muted-foreground">
              Save auth state from a connected web Live Mode session.
            </p>
          </div>
        ) : (
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Target</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Captured</TableHead>
                  <TableHead>Kind</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {authStates.map((state) => (
                  <TableRow key={`${state.target}:${state.name}`}>
                    <TableCell className="max-w-[220px] whitespace-normal font-mono text-xs [overflow-wrap:anywhere]">
                      {state.target}
                    </TableCell>
                    <TableCell className="max-w-[220px] whitespace-normal font-mono text-xs [overflow-wrap:anywhere]">
                      {state.name}
                    </TableCell>
                    <TableCell className="max-w-[220px] whitespace-normal font-mono text-xs text-muted-foreground">
                      <time dateTime={state.capturedAt} title={state.capturedAt}>
                        {formatCapturedAt(state.capturedAt)}
                      </time>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{state.kind}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
