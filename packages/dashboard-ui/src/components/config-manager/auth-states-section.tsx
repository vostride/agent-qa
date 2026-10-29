// The login-state list has its own read; a failed read offers a reload of only that list.

import { useEffect, useState } from "react"

import { ConfigField } from "@/components/config-manager/config-field"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ConfigFieldParse } from "@/hooks/use-config-autosave"
import { fetchAuthStates, type AuthStateMetadata } from "@/lib/api"
import {
  LOGIN_STATES_DIR_PLACEHOLDER,
  LOGIN_STATES_DIR_REQUIRED_ERROR,
  LOGIN_STATES_FIELD_LABELS,
  LOGIN_STATES_LOADING_TEXT,
  LOGIN_STATES_LOAD_FAILED_TEXT,
  LOGIN_STATE_COLUMN_LABELS,
  NO_LOGIN_STATES_TEXT,
  RELOAD_LOGIN_STATES_LABEL,
} from "@/lib/config-copy"

interface AuthStatesSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

type LoginStatesRead =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; states: AuthStateMetadata[] }

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

const CELL_CLASS = "max-w-[220px] whitespace-normal font-mono text-xs [overflow-wrap:anywhere]"

function formatCapturedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return DATE_FORMAT.format(date)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function configuredDir(config: Record<string, unknown>): string | undefined {
  const services = config.services
  const authState = isRecord(services) ? services.authState : undefined
  const dir = isRecord(authState) ? authState.dir : undefined
  return typeof dir === "string" ? dir : undefined
}

export function AuthStatesSection({ config }: AuthStatesSectionProps) {
  const [read, setRead] = useState<LoginStatesRead>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)
  const dir = configuredDir(config)

  useEffect(() => {
    let active = true
    setRead({ kind: "loading" })
    fetchAuthStates()
      .then((result) => {
        if (active) setRead({ kind: "ready", states: result.authStates.filter((state) => state.kind === "web") })
      })
      .catch(() => {
        if (active) setRead({ kind: "error" })
      })
    return () => {
      active = false
    }
  }, [attempt, dir])

  // The folder is required once the block exists, so emptying a set folder stays a draft.
  function parseDir(raw: string): ConfigFieldParse {
    if (raw.trim() !== "") return { valid: true, value: raw.trim() }
    return dir === undefined ? { valid: true, unset: true } : { valid: false, error: LOGIN_STATES_DIR_REQUIRED_ERROR }
  }

  return (
    <div className="space-y-4">
      <ConfigField
        field={{ segments: ["services", "authState", "dir"], tab: "targets", pattern: "services.authState.dir" }}
        label={LOGIN_STATES_FIELD_LABELS.dir}
        kind="text"
        placeholder={LOGIN_STATES_DIR_PLACEHOLDER}
        parse={parseDir}
      />
      <div data-login-states={read.kind}>
        {read.kind === "loading" ? (
          <p className="text-sm text-muted-foreground">{LOGIN_STATES_LOADING_TEXT}</p>
        ) : read.kind === "error" ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{LOGIN_STATES_LOAD_FAILED_TEXT}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((count) => count + 1)}>
              {RELOAD_LOGIN_STATES_LABEL}
            </Button>
          </div>
        ) : read.states.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_LOGIN_STATES_TEXT}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{LOGIN_STATE_COLUMN_LABELS.target}</TableHead>
                <TableHead>{LOGIN_STATE_COLUMN_LABELS.name}</TableHead>
                <TableHead>{LOGIN_STATE_COLUMN_LABELS.captured}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {read.states.map((state) => (
                <TableRow key={`${state.target}:${state.name}`} data-login-state={`${state.target}:${state.name}`}>
                  <TableCell className={CELL_CLASS}>{state.target}</TableCell>
                  <TableCell className={CELL_CLASS}>{state.name}</TableCell>
                  <TableCell className={`${CELL_CLASS} text-muted-foreground`}>
                    <time dateTime={state.capturedAt} title={state.capturedAt}>
                      {formatCapturedAt(state.capturedAt)}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
