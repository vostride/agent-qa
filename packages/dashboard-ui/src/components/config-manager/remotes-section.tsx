// Read-only: a remote is written in the config file, never from this page.

import { projectConfigRemotes } from "@vostride/agent-qa-schema"

import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DEFAULT_BADGE, REMOTES_COPY, remoteDefaultLine, remoteNotListedLine } from "@/lib/config-copy"

interface RemotesSectionProps {
  config: Record<string, unknown>
}

interface RemoteRow {
  name: string
  protocol: string
  origin: string
}

const CELL_CLASS = "whitespace-normal font-mono text-xs [overflow-wrap:anywhere]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : REMOTES_COPY.missingValue
}

// The server already serves origins; projecting again keeps a path or query off the page regardless.
function remotesOf(config: Record<string, unknown>): RemoteRow[] {
  const registry = projectConfigRemotes(config).registry
  const remotes = isRecord(registry) ? registry.remotes : undefined
  if (!Array.isArray(remotes)) return []
  return remotes.map((entry) => {
    const remote = isRecord(entry) ? entry : {}
    return { name: text(remote.name), protocol: text(remote.protocol), origin: text(remote.url) }
  })
}

function defaultRemoteOf(config: Record<string, unknown>): string | undefined {
  const browser = isRecord(config.use) ? config.use.browser : undefined
  const remote = isRecord(browser) ? browser.remote : undefined
  return typeof remote === "string" && remote !== "" && remote !== "local" ? remote : undefined
}

export function RemotesSection({ config }: RemotesSectionProps) {
  const remotes = remotesOf(config)
  const pick = defaultRemoteOf(config)
  const unlisted = pick !== undefined && !remotes.some((remote) => remote.name === pick)
  return (
    <div data-remotes className="space-y-4">
      <p data-remote-default={pick ?? "local"} className="text-sm">
        {pick === undefined ? REMOTES_COPY.runsHere : remoteDefaultLine(pick)}
      </p>
      {unlisted ? (
        <p data-remote-unlisted className="text-sm text-destructive">
          {remoteNotListedLine(pick)}
        </p>
      ) : null}
      {remotes.length === 0 ? (
        <p data-remotes-empty className="text-sm text-muted-foreground">
          {REMOTES_COPY.empty}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{REMOTES_COPY.columns.name}</TableHead>
              <TableHead>{REMOTES_COPY.columns.protocol}</TableHead>
              <TableHead>{REMOTES_COPY.columns.origin}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {remotes.map((remote, index) => (
              <TableRow key={`${index}:${remote.name}`} data-remote={remote.name}>
                <TableCell className={CELL_CLASS}>
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span>{remote.name}</span>
                    {remote.name === pick ? (
                      <Badge variant="outline" data-remote-default-badge>
                        {DEFAULT_BADGE}
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className={CELL_CLASS}>{remote.protocol}</TableCell>
                <TableCell className={CELL_CLASS}>{remote.origin}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
