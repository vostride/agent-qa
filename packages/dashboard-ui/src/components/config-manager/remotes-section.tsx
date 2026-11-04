// The default is picked here; a remote entry is written in the config file, never from this page.

import { NAME_SLUG_PATTERN, projectConfigRemotes } from "@vostride/agent-qa-schema"
import type { ReactNode } from "react"

import {
  ConfigField,
  type ConfigFieldOption,
  type ConfigFieldTarget,
} from "@/components/config-manager/config-field"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DEFAULT_BADGE,
  REMOTES_COPY,
  remoteChoiceLabel,
  remoteCredentialsLine,
  remoteNotListedParts,
} from "@/lib/config-copy"

interface RemotesSectionProps {
  config: Record<string, unknown>
}

interface RemoteRow {
  name: string
  protocol: string
  origin: string
}

const LOCAL_PLACE = "local"
const UNSET = { valid: true, unset: true } as const
const REMOTE_DEFAULT_FIELD: ConfigFieldTarget = {
  segments: ["use", "browser", "remote"],
  tab: "targets",
  pattern: "use.browser.remote",
}

const CELL_CLASS = "whitespace-normal font-mono text-xs [overflow-wrap:anywhere]"
const EXAMPLE_CLASS =
  "rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
const NOTE_CLASS = "text-xs text-muted-foreground"
const CODE_CLASS = "font-mono wrap-anywhere"
// Longest first, so a key path is set as code whole rather than by a shorter path it starts with.
const CODE_TERMS = [
  "use.browser.remote: <name>",
  "use.browser.remote",
  "registry.remotes",
  "workspace.secretsFile",
  "agent-qa.config.yaml",
  "{{secret:NAME}}",
]
const PICK_TERMS = [...CODE_TERMS, "local"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function withCode(line: string, terms: readonly string[] = CODE_TERMS, key = ""): ReactNode[] {
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`)
  return line.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <code key={`${key}${index}`} className={CODE_CLASS}>
        {part}
      </code>
    ) : (
      part
    ),
  )
}

// The remote name is the config's text, so only the sentence around it is read for key paths.
function withName(parts: readonly ReactNode[]): ReactNode[] {
  return parts.flatMap((part, index) =>
    typeof part === "string" ? withCode(part, CODE_TERMS, `${index}:`) : [part],
  )
}

function nameMark(name: string): ReactNode {
  return (
    <span key="name" className="font-medium">
      {name}
    </span>
  )
}

function text(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : REMOTES_COPY.missingValue
}

// The server already serves origins; projecting again keeps a path or query off the page regardless.
function remoteEntries(config: Record<string, unknown>): Record<string, unknown>[] {
  const registry = projectConfigRemotes(config).registry
  const remotes = isRecord(registry) ? registry.remotes : undefined
  if (!Array.isArray(remotes)) return []
  return remotes.map((entry) => (isRecord(entry) ? entry : {}))
}

function remotesOf(config: Record<string, unknown>): RemoteRow[] {
  return remoteEntries(config).map((remote) => ({
    name: text(remote.name),
    protocol: text(remote.protocol),
    origin: text(remote.url),
  }))
}

// Only a listed name can be the default, and a name the strict parse refuses is served as
// placeholder text; this machine is the absent key.
function defaultChoices(config: Record<string, unknown>): ConfigFieldOption[] {
  const choices: ConfigFieldOption[] = [{ value: LOCAL_PLACE, label: REMOTES_COPY.thisMachine }]
  for (const remote of remoteEntries(config)) {
    const { name, protocol } = remote
    if (typeof name !== "string" || !NAME_SLUG_PATTERN.test(name)) continue
    if (choices.some((choice) => choice.value === name)) continue
    const known = typeof protocol === "string" && protocol !== "" ? protocol : undefined
    choices.push({ value: name, label: remoteChoiceLabel(name, known) })
  }
  return choices
}

function defaultRemoteOf(config: Record<string, unknown>): string | undefined {
  const browser = isRecord(config.use) ? config.use.browser : undefined
  const remote = isRecord(browser) ? browser.remote : undefined
  return typeof remote === "string" && remote !== "" && remote !== LOCAL_PLACE ? remote : undefined
}

function secretsFileOf(config: Record<string, unknown>): string | undefined {
  const file = isRecord(config.workspace) ? config.workspace.secretsFile : undefined
  return typeof file === "string" && file !== "" ? file : undefined
}

export function RemoteDefaultField({ config }: RemotesSectionProps) {
  return (
    <ConfigField
      field={REMOTE_DEFAULT_FIELD}
      label={REMOTES_COPY.defaultLabel}
      help={REMOTES_COPY.inherit}
      kind="select"
      options={defaultChoices(config)}
      placeholder={REMOTES_COPY.thisMachine}
      parse={(raw) => (raw === LOCAL_PLACE ? UNSET : { valid: true, value: raw })}
    />
  )
}

export function RemotesSection({ config }: RemotesSectionProps) {
  const remotes = remotesOf(config)
  const pick = defaultRemoteOf(config)
  const unlisted = pick !== undefined && !remotes.some((remote) => remote.name === pick)
  return (
    <div data-remotes className="space-y-4">
      {unlisted ? (
        <p data-remote-unlisted className="text-sm text-destructive">
          {withName(remoteNotListedParts(nameMark(pick)))}
        </p>
      ) : null}
      {remotes.length === 0 ? (
        <div className="space-y-2">
          <p data-remotes-empty className="text-sm text-foreground">
            {withCode(REMOTES_COPY.empty)}
          </p>
          <pre data-remotes-example className={EXAMPLE_CLASS}>
            <code>{REMOTES_COPY.example}</code>
          </pre>
          <p data-remotes-credentials className={NOTE_CLASS}>
            {withCode(remoteCredentialsLine(secretsFileOf(config)))}
          </p>
          <p data-remotes-pick className={NOTE_CLASS}>
            {withCode(REMOTES_COPY.pick, PICK_TERMS)}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
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
          <p data-remotes-listed className={NOTE_CLASS}>
            {withCode(REMOTES_COPY.listed)}
          </p>
        </div>
      )}
    </div>
  )
}
