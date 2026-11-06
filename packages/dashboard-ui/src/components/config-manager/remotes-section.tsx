// The default is picked here; a remote or plugins entry is written in the config file, never from
// this page.

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
  pluginRemoteText,
  REMOTES_COPY,
  remoteChoiceParts,
  remoteCredentialsLine,
  remoteNotListedParts,
  remoteUnlistedChoiceParts,
} from "@/lib/config-copy"

interface RemotesSectionProps {
  config: Record<string, unknown>
}

interface RemoteRow {
  name: string
  protocol: string
  origin: string
}

interface PluginRow {
  name: string
  source: string
}

const LOCAL_PLACE = "local"
const UNSET = { valid: true, unset: true } as const
const REMOTE_DEFAULT_FIELD: ConfigFieldTarget = {
  segments: ["use", "browser", "remote"],
  tab: "targets",
  pattern: "use.browser.remote",
}

// Only an origin is long enough to break anywhere; a name or protocol stays whole.
const CELL_CLASS = "font-mono text-xs"
const ORIGIN_CELL_CLASS = "whitespace-normal font-mono text-xs [overflow-wrap:anywhere]"
const EXAMPLE_CLASS =
  "rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
const NOTE_CLASS = "text-xs text-muted-foreground"
const CODE_CLASS = "font-mono wrap-anywhere"
// Longest first, so a key path is set as code whole rather than by a shorter path it starts with.
const CODE_TERMS = [
  "use.browser.remote: <name>",
  "use.browser.remote",
  "registry.remotes",
  "plugins",
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

// One style for a remote name wherever it appears: the table's, in the sentences and the selects too.
export function RemoteName({ name }: { name: string }) {
  return (
    <span data-remote-name className="font-mono">
      {name}
    </span>
  )
}

export function RemoteChoice({ name, protocol }: { name: string; protocol?: string }) {
  const [mark, rest] = remoteChoiceParts(<RemoteName name={name} />, protocol)
  return (
    <>
      {mark}
      {rest}
    </>
  )
}

// A pick no listed name matches still shows in its select, marked, rather than as an empty box.
export function RemoteUnlistedChoice({ name }: { name: string }) {
  const [mark, rest] = remoteUnlistedChoiceParts(<RemoteName name={name} />)
  return (
    <>
      {mark}
      {rest}
    </>
  )
}

function nameMark(name: string): ReactNode {
  return <RemoteName key="name" name={name} />
}

function text(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : REMOTES_COPY.missingValue
}

function records(list: unknown): Record<string, unknown>[] {
  if (!Array.isArray(list)) return []
  return list.map((entry) => (isRecord(entry) ? entry : {}))
}

// The server already serves origins and drops plugin options; projecting again keeps a path, query
// or option off the page regardless.
function remoteEntries(config: Record<string, unknown>): Record<string, unknown>[] {
  const registry = projectConfigRemotes(config).registry
  return records(isRecord(registry) ? registry.remotes : undefined)
}

function pluginsOf(config: Record<string, unknown>): PluginRow[] {
  return records(projectConfigRemotes(config).plugins).map((entry) => ({
    name: text(entry.name),
    source: text(entry.package ?? entry.path),
  }))
}

function pluginEntryOf(remote: Record<string, unknown>): string | undefined {
  return typeof remote.plugin === "string" && remote.plugin !== "" ? remote.plugin : undefined
}

function remotesOf(config: Record<string, unknown>): RemoteRow[] {
  return remoteEntries(config).map((remote) => {
    const entry = pluginEntryOf(remote)
    return {
      name: text(remote.name),
      protocol: entry === undefined ? text(remote.protocol) : pluginRemoteText(entry),
      origin: text(remote.url),
    }
  })
}

// Only a listed browser remote can be the default, and a name the strict parse refuses is served
// as placeholder text; this machine is the absent key. An appium remote serves devices.
function defaultChoices(config: Record<string, unknown>): ConfigFieldOption[] {
  const choices: ConfigFieldOption[] = [{ value: LOCAL_PLACE, label: REMOTES_COPY.thisMachine }]
  for (const remote of remoteEntries(config)) {
    const { name, protocol } = remote
    if (typeof name !== "string" || !NAME_SLUG_PATTERN.test(name)) continue
    if (protocol === "appium") continue
    if (choices.some((choice) => choice.value === name)) continue
    const entry = pluginEntryOf(remote)
    const known =
      entry !== undefined
        ? pluginRemoteText(entry)
        : typeof protocol === "string" && protocol !== ""
          ? protocol
          : undefined
    choices.push({ value: name, label: <RemoteChoice name={name} protocol={known} /> })
  }
  const pick = defaultRemoteOf(config)
  if (pick !== undefined && !choices.some((choice) => choice.value === pick)) {
    choices.push({ value: pick, label: <RemoteUnlistedChoice name={pick} /> })
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

function PluginsList({ plugins }: { plugins: PluginRow[] }) {
  return (
    <div data-plugins className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{REMOTES_COPY.pluginsTitle}</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{REMOTES_COPY.pluginColumns.name}</TableHead>
            <TableHead>{REMOTES_COPY.pluginColumns.source}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plugins.map((plugin, index) => (
            <TableRow key={`${index}:${plugin.name}`} data-plugin={plugin.name}>
              <TableCell className={CELL_CLASS}>{plugin.name}</TableCell>
              <TableCell className={ORIGIN_CELL_CLASS}>{plugin.source}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p data-plugins-listed className={NOTE_CLASS}>
        {withCode(REMOTES_COPY.pluginsListed)}
      </p>
    </div>
  )
}

export function RemotesSection({ config }: RemotesSectionProps) {
  const remotes = remotesOf(config)
  const plugins = pluginsOf(config)
  const pick = defaultRemoteOf(config)
  const unlisted = pick !== undefined && !remotes.some((remote) => remote.name === pick)
  return (
    <div data-remotes className="space-y-4">
      {plugins.length === 0 ? null : <PluginsList plugins={plugins} />}
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
                      <RemoteName name={remote.name} />
                      {remote.name === pick ? (
                        <Badge variant="outline" data-remote-default-badge>
                          {DEFAULT_BADGE}
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className={CELL_CLASS}>{remote.protocol}</TableCell>
                  <TableCell className={ORIGIN_CELL_CLASS}>{remote.origin}</TableCell>
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
