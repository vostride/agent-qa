// ONE SAVED MODEL (429-23, 429-24, 429-26 · D-10, D-11, D-12, D-17, D-23, D-24 · UI-SPEC S4, S6, E6).
//
// The closed row is its disclosure button: the name, the Default badge, the model line and one
// status word derived from the credential-status read. The open panel sits inside the same row
// and holds the connection test, whose line lives only while the row stays open, Make default,
// the credential actions, the row's settings and Delete model. Deleting, signing out and removing
// a key act at once and offer Undo; none asks first. The default model offers no delete. Settings
// autosave by leaf; a key and a header value are typed into this component only and save through
// their own buttons, never as drafts. A sign-in model that is not connected or whose sign-in expired
// offers Sign in again, the add row's sign-in flow for the saved name, and its test runs after.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { ChevronRight, CircleAlert, CircleCheck, LoaderCircle, LogOut, Plus, Trash2, TriangleAlert } from "lucide-react"
import type { ConfigChange, ConfigPathSegment } from "@vostride/agent-qa-schema"

import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import { ConnectionLine } from "@/components/config-manager/connection-line"
import { SignInButton, SignInProgress, signInActive, signInLine } from "@/components/config-manager/sign-in-progress"
import { SecretValue } from "@/components/config-manager/secret-value"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useConfigAutosaveContext, type ConfigFieldParse } from "@/hooks/use-config-autosave"
import { useSignInFlow } from "@/hooks/use-sign-in-flow"
import {
  deleteAuthCredential,
  saveCredential,
  testLLMConnection,
  type AuthCredentialInfo,
  type LLMProviderMetadata,
  type LLMTestResult,
} from "@/lib/api"
import {
  ADD_FLOW_FIELD_LABELS,
  ADD_HEADER_LABEL,
  BASE_URL_HELP,
  BECAME_DEFAULT_TEXT,
  BASE_URL_REQUIRED_ERROR,
  DEFAULT_BADGE,
  DEFAULT_CANNOT_DELETE_LINE,
  DELETE_MODEL_LABEL,
  DISCARD_HEADER_LABEL,
  FIXED_CONNECTION_LABELS,
  HEADER_FIELD_LABELS,
  HEADER_NAME_REQUIRED_ERROR,
  KEEP_CURRENT_KEY_LABEL,
  MAKE_DEFAULT_LABEL,
  MODEL_REQUIRED_ERROR,
  MODEL_SETTING_HELP,
  MODEL_SETTING_LABELS,
  MODEL_STATUS_WORDS,
  NEW_KEY_LABEL,
  PROVIDER_FALLBACK_LABELS,
  REMOVE_KEY_LABEL,
  REPLACE_KEY_LABEL,
  SAVED_WITHOUT_TEST_TEXT,
  SAVE_HEADER_LABEL,
  SAVE_KEY_AND_TEST_LABEL,
  SETTLE_DELAY_MS,
  SIGN_IN_AGAIN_LABEL,
  SIGN_OUT_LABEL,
  SUBSCRIPTION_PLAN_NAMES,
  TEST_CONNECTION_LABEL,
  connectedSavedText,
  connectionSentence,
  fixedFactsLine,
  headerNameFieldName,
  headerNameTakenError,
  modelHeaderLabel,
  modelLine,
  providerErrorSentence,
  type CredentialKeyType,
} from "@/lib/config-copy"
import type { ModelStatus, TestResult } from "@/lib/config-tabs"
import { modelFieldSegments } from "@/lib/model-workspace"
import { cn } from "@/lib/utils"

export interface SavedModel {
  name: string
  provider: string
  model: string
  baseURL?: string
  providerHeaders?: Record<string, string>
  vision?: boolean
  contextWindow?: string
}

function isBearer(credential: AuthCredentialInfo): boolean {
  return credential.type === "bearer" || credential.type === "bearer-token"
}

function credentialMatches(credential: AuthCredentialInfo, model: SavedModel): boolean {
  if (credential.configName !== model.name) return false
  if (credential.type === "oauth") return credential.provider === model.provider
  if (isBearer(credential)) return model.provider === "anthropic-compatible" && credential.provider === "anthropic-compatible"
  return credential.provider === model.provider
}

/** The row's one status word: only what the credential-status read says, matched by name and provider. */
export function modelStatus(credentials: readonly AuthCredentialInfo[], model: SavedModel, now: number): ModelStatus {
  const credential = credentials.find((candidate) => credentialMatches(candidate, model))
  if (credential === undefined) return "not-connected"
  if (credential.type === "oauth") {
    return credential.expires !== null && credential.expires < now ? "sign-in-expired" : "signed-in"
  }
  return "key-saved"
}

/** The key type a Replace key saves: the saved credential's own, else an API key. */
export function credentialKeyType(credentials: readonly AuthCredentialInfo[], model: SavedModel): CredentialKeyType {
  const credential = credentials.find((candidate) => credentialMatches(candidate, model))
  return credential !== undefined && isBearer(credential) ? "bearer-token" : "api-key"
}

export interface ProviderFacts {
  label: string | undefined
  signIn: boolean
  keyOptional: boolean
  needsBaseURL: boolean
  /** The schema allows providerHeaders only on anthropic-compatible models. */
  headers: boolean
}

export function providerFacts(providers: readonly LLMProviderMetadata[], id: string): ProviderFacts {
  const metadata = providers.find((provider) => provider.id === id)
  const fallbackLabel = (PROVIDER_FALLBACK_LABELS as Record<string, string>)[id]
  const compatible = id === "openai-compatible" || id === "anthropic-compatible"
  const signIn = metadata ? metadata.auth.kind === "oauth-plugin" : id in SUBSCRIPTION_PLAN_NAMES
  const keyOptional = metadata ? metadata.auth.kind === "api-key" && metadata.auth.optional === true : compatible
  const needsBaseURL = metadata ? metadata.needsBaseURL === true : compatible
  return { label: metadata?.label ?? fallbackLabel, signIn, keyOptional, needsBaseURL, headers: id === "anthropic-compatible" }
}

function planName(provider: string, label: string | undefined): string {
  return (SUBSCRIPTION_PLAN_NAMES as Record<string, string>)[provider] ?? label ?? ""
}

interface TestLine {
  state: TestResult
  sentence?: string
}

function lineFor(result: LLMTestResult): TestLine {
  if (result.success) return { state: result.unauthenticated ? "connected-without-key" : "connected" }
  return { state: "failed", sentence: result.message ?? providerErrorSentence("network_error", "") }
}

function lineForError(error: unknown): TestLine {
  const payload = (error as { payload?: Record<string, unknown> | null } | null)?.payload
  const message = payload && typeof payload.message === "string" ? payload.message : undefined
  return { state: "failed", sentence: message ?? providerErrorSentence("network_error", "") }
}

const DECLARED_MARKER_OPENER = "[secret:"

// A header shown holding a declared marker is left out, so the server sends its saved value.
function sendableHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  const kept = Object.entries(headers).filter(([, value]) => !value.includes(DECLARED_MARKER_OPENER))
  return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

/** Runs the row's connection test; only the latest test started while the panel is open sets the line. */
function useConnectionTest(model: SavedModel) {
  const [line, setLine] = useState<TestLine | undefined>(undefined)
  const latest = useRef(0)

  useEffect(() => {
    return () => {
      latest.current = Number.NaN
    }
  }, [])

  async function run() {
    const id = latest.current + 1
    latest.current = id
    setLine({ state: "testing" })
    const headers = sendableHeaders(model.providerHeaders)
    let next: TestLine
    try {
      next = lineFor(
        await testLLMConnection({
          provider: model.provider,
          model: model.model,
          ...(model.baseURL ? { baseURL: model.baseURL } : {}),
          ...(headers ? { providerHeaders: headers } : {}),
          configName: model.name,
        }),
      )
    } catch (error) {
      next = lineForError(error)
    }
    if (latest.current === id) setLine(next)
  }

  return { line, run }
}

/** What the list does around a row's explicit actions: hiding the row or its credential, and focus. */
export interface ModelRowActions {
  /** The row is being deleted: the list hides it and moves focus to its neighbour. */
  onRemoveStart: () => void
  /** The delete settled: a landed write already dropped the row, a failed one shows it again. */
  onRemoveEnd: () => void
  /** The row's credential reads as gone (true) or back (false) until the next credential read. */
  onCredentialHidden: (hidden: boolean) => void
  /** A key was saved server-side: the list reads the credential status again. */
  onCredentialSaved: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredText(error: string) {
  return (raw: string): ConfigFieldParse => (raw.trim() === "" ? { valid: false, error } : { valid: true, value: raw })
}

function sameHeader(names: readonly string[], name: string): boolean {
  return names.some((other) => other.toLowerCase() === name.toLowerCase())
}

/** Replace key's inline group: the typed key lives here only and is sent once, to the credential door. */
function ReplaceKeyGroup({ onSave, onKeep }: { onSave: (secret: string) => Promise<boolean>; onKeep: () => void }) {
  const inputId = useId()
  const [typed, setTyped] = useState("")
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  async function save() {
    if (typed === "" || saving) return
    setSaving(true)
    if (await onSave(typed)) return
    setSaving(false)
  }

  function keep() {
    setTyped("")
    onKeep()
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      void save()
    } else if (event.key === "Escape") {
      event.preventDefault()
      keep()
    }
  }

  return (
    <div data-replace-key className="space-y-2">
      <Label htmlFor={inputId}>{NEW_KEY_LABEL}</Label>
      <Input
        ref={input}
        id={inputId}
        type="password"
        autoComplete="off"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={keyDown}
        className="w-full max-w-md font-mono"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={typed === "" || saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : null}
          {SAVE_KEY_AND_TEST_LABEL}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={keep}>
          {KEEP_CURRENT_KEY_LABEL}
        </Button>
      </div>
    </div>
  )
}

interface HeaderRowProps {
  segments: readonly ConfigPathSegment[]
  header: string
  masked: string
  others: readonly string[]
}

/** A rename is one server-side move, so the value never reaches the page. */
function HeaderRow({ segments, header, masked, others }: HeaderRowProps) {
  const autosave = useConfigAutosaveContext()
  const inputId = useId()
  const errorId = `${inputId}-error`
  const [name, setName] = useState(header)
  const [error, setError] = useState<string | undefined>(undefined)
  const typed = useRef(header)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const renaming = useRef(false)

  useEffect(() => () => clearTimeout(timer.current), [])

  function restore() {
    typed.current = header
    setName(header)
  }

  async function rename(next: string) {
    renaming.current = true
    try {
      const landed = await autosave.runExplicit([
        { op: "move", from: [...segments, header], path: [...segments, next] },
      ])
      if (!landed) restore()
    } catch (failure) {
      autosave.failExplicit(failure)
      restore()
    } finally {
      renaming.current = false
    }
  }

  function settle() {
    clearTimeout(timer.current)
    timer.current = undefined
    const next = typed.current.trim()
    if (renaming.current || next === header) {
      setError(undefined)
      return
    }
    if (next === "") return setError(HEADER_NAME_REQUIRED_ERROR)
    if (sameHeader(others, next)) return setError(headerNameTakenError(next))
    setError(undefined)
    void rename(next)
  }

  function change(raw: string) {
    typed.current = raw
    setName(raw)
    clearTimeout(timer.current)
    timer.current = setTimeout(settle, SETTLE_DELAY_MS)
  }

  return (
    <div data-model-header={header} className="grid gap-2 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)] sm:items-start">
      <div data-field-path="registry.llms[].providerHeaders" className="space-y-1">
        <Input
          id={inputId}
          type="text"
          aria-label={headerNameFieldName(header)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          value={name}
          onChange={(event) => change(event.target.value)}
          onBlur={settle}
          onKeyDown={(event) => {
            if (event.key === "Enter") settle()
          }}
          className="h-8 font-mono"
        />
        {error === undefined ? null : (
          <p id={errorId} data-field-error className="flex items-start gap-1 text-xs text-destructive break-words">
            <span className="flex h-[1lh] shrink-0 items-center">
              <CircleAlert className="size-3" aria-hidden="true" />
            </span>
            {error}
          </p>
        )}
      </div>
      <SecretValue
        field={{ segments: [...segments, header], pattern: "registry.llms[].providerHeaders.*" }}
        label={modelHeaderLabel(header)}
        maskedText={masked}
      />
    </div>
  )
}

/** A new header: its name and value are typed here only and save together through Save header. */
function HeaderDraft({
  segments,
  others,
  onClose,
}: {
  segments: readonly ConfigPathSegment[]
  others: readonly string[]
  onClose: () => void
}) {
  const autosave = useConfigAutosaveContext()
  const nameId = useId()
  const valueId = useId()
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInput.current?.focus()
  }, [])

  async function save() {
    const next = name.trim()
    if (next === "") return setError(HEADER_NAME_REQUIRED_ERROR)
    if (sameHeader(others, next)) return setError(headerNameTakenError(next))
    if (value === "" || saving) return
    setError(undefined)
    setSaving(true)
    if (await autosave.runExplicit([{ op: "set", path: [...segments, next], value }])) {
      onClose()
      return
    }
    setSaving(false)
  }

  return (
    <div data-header-draft className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
        <div className="space-y-1">
          <Label htmlFor={nameId}>{HEADER_FIELD_LABELS.name}</Label>
          <Input
            ref={nameInput}
            id={nameId}
            type="text"
            aria-invalid={error === undefined ? undefined : true}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={valueId}>{HEADER_FIELD_LABELS.value}</Label>
          <Input
            id={valueId}
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="h-8 font-mono"
          />
        </div>
      </div>
      {error === undefined ? null : (
        <p data-field-error className="flex items-start gap-1 text-xs text-destructive break-words">
          <span className="flex h-[1lh] shrink-0 items-center">
            <CircleAlert className="size-3" aria-hidden="true" />
          </span>
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={name.trim() === "" || value === "" || saving}
          onClick={() => void save()}
        >
          {SAVE_HEADER_LABEL}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {DISCARD_HEADER_LABEL}
        </Button>
      </div>
    </div>
  )
}

function ModelHeaders({ model }: { model: SavedModel }) {
  const autosave = useConfigAutosaveContext()
  const segments = modelFieldSegments(model.name, "providerHeaders")
  const value = autosave.valueOf({ segments, tab: "models" })
  const headers = isRecord(value)
    ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : []
  const names = headers.map(([name]) => name)
  const [adding, setAdding] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const focusAddNext = useRef(false)

  useEffect(() => {
    if (!adding && focusAddNext.current) {
      focusAddNext.current = false
      addButton.current?.focus()
    }
  }, [adding])

  return (
    <fieldset data-model-headers className="space-y-2">
      <legend className="text-sm font-medium">{ADD_FLOW_FIELD_LABELS.headers}</legend>
      {headers.map(([name, masked]) => (
        <HeaderRow
          key={name}
          segments={segments}
          header={name}
          masked={masked}
          others={names.filter((other) => other !== name)}
        />
      ))}
      {adding ? (
        <HeaderDraft
          segments={segments}
          others={names}
          onClose={() => {
            focusAddNext.current = true
            setAdding(false)
          }}
        />
      ) : (
        <Button ref={addButton} type="button" variant="ghost" size="xs" onClick={() => setAdding(true)}>
          <Plus className="size-3" aria-hidden="true" />
          {ADD_HEADER_LABEL}
        </Button>
      )}
    </fieldset>
  )
}

/** The row's settings (UI-SPEC S4 item 2), each a leaf that autosaves; name and provider are fixed facts. */
function ModelSettings({ model, facts }: { model: SavedModel; facts: ProviderFacts }) {
  const target = (key: string): ConfigFieldTarget => ({
    segments: modelFieldSegments(model.name, key),
    tab: "models",
    pattern: `registry.llms[].${key}`,
  })
  return (
    <div data-model-settings className="space-y-4">
      <ConfigField
        field={target("model")}
        label={ADD_FLOW_FIELD_LABELS.model}
        kind="text"
        parse={requiredText(MODEL_REQUIRED_ERROR)}
      />
      {facts.needsBaseURL ? (
        <ConfigField
          field={target("baseURL")}
          label={ADD_FLOW_FIELD_LABELS.baseUrl}
          help={BASE_URL_HELP}
          kind="text"
          parse={requiredText(BASE_URL_REQUIRED_ERROR)}
        />
      ) : null}
      {facts.headers ? <ModelHeaders model={model} /> : null}
      <ConfigField
        field={target("vision")}
        label={MODEL_SETTING_LABELS.vision}
        help={MODEL_SETTING_HELP.vision}
        kind="switch"
        defaultChecked
      />
      <ConfigField
        field={target("contextWindow")}
        label={MODEL_SETTING_LABELS.contextWindow}
        help={MODEL_SETTING_HELP.contextWindow}
        kind="text"
        placeholder="256k"
      />
    </div>
  )
}

/** How a model the add row just saved lands: its line until a test runs here or the row closes. */
export interface ModelLanding {
  becameDefault: boolean
  withoutTest: boolean
}

function LandingLine({
  name,
  landing,
  isDefault,
  onMakeDefault,
}: {
  name: string
  landing: ModelLanding
  isDefault: boolean
  onMakeDefault: () => void
}) {
  const saved = landing.withoutTest ? SAVED_WITHOUT_TEST_TEXT : connectedSavedText(name)
  return (
    <div
      data-model-landing
      data-test-result={landing.withoutTest ? undefined : "connected"}
      role="status"
      aria-live="polite"
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-sm"
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <CircleCheck
          className={cn("size-3.5", landing.withoutTest ? "text-muted-foreground" : "text-emerald-500")}
          aria-hidden="true"
        />
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <p className="break-words text-foreground">
          {landing.becameDefault ? `${saved} ${BECAME_DEFAULT_TEXT}` : saved}
        </p>
        {landing.becameDefault || isDefault ? null : (
          <Button type="button" variant="outline" size="xs" onClick={onMakeDefault}>
            {MAKE_DEFAULT_LABEL}
          </Button>
        )}
      </div>
    </div>
  )
}

interface ModelPanelProps extends ModelRowActions {
  id: string
  model: SavedModel
  status: ModelStatus
  facts: ProviderFacts
  keyType: CredentialKeyType
  isDefault: boolean
  onMakeDefault: () => void
  header: RefObject<HTMLButtonElement | null>
  landing?: ModelLanding
}

function ModelPanel({
  id,
  model,
  status,
  facts,
  keyType,
  isDefault,
  onMakeDefault,
  header,
  landing,
  onRemoveStart,
  onRemoveEnd,
  onCredentialHidden,
  onCredentialSaved,
}: ModelPanelProps) {
  const autosave = useConfigAutosaveContext()
  const test = useConnectionTest(model)
  const testing = test.line?.state === "testing"
  const connection = (FIXED_CONNECTION_LABELS as Record<string, string>)[model.provider] ?? facts.label
  const signedIn = facts.signIn && status !== "not-connected"
  const keySaved = !facts.signIn && status === "key-saved"
  const [replacing, setReplacing] = useState(false)
  const replaceButton = useRef<HTMLButtonElement>(null)
  const focusReplaceNext = useRef(false)
  // D-17: Sign in again is the add row's sign-in for the saved name; the test runs once it completes.
  const signInFlow = useSignInFlow({
    onCompleted: () => {
      onCredentialSaved()
      void test.run()
    },
  })
  const signInOffered =
    signInActive(signInFlow) || (facts.signIn && (status === "not-connected" || status === "sign-in-expired"))
  const shownLine = signInLine(signInFlow) ?? test.line

  useEffect(() => {
    if (!replacing && focusReplaceNext.current) {
      focusReplaceNext.current = false
      replaceButton.current?.focus()
    }
  }, [replacing])

  function closeReplace() {
    focusReplaceNext.current = true
    setReplacing(false)
  }

  async function saveKey(secret: string): Promise<boolean> {
    try {
      await saveCredential(model.name, model.provider, keyType, secret)
    } catch (error) {
      autosave.failExplicit(error)
      return false
    }
    closeReplace()
    onCredentialSaved()
    void test.run()
    return true
  }

  async function removeCredential(kind: "sign-out" | "remove-key") {
    onCredentialHidden(true)
    header.current?.focus()
    try {
      const answer = await deleteAuthCredential(model.name)
      if (answer.undo) autosave.offerUndo(answer.undo, { kind, name: model.name })
    } catch (error) {
      onCredentialHidden(false)
      autosave.failExplicit(error)
    }
  }

  // Computed from the freshest config and recomputed once on field_changed (D-22). Once the delete
  // settles, Retry computes nothing: a refused delete is not sent again (UI-SPEC E2).
  async function deleteModel() {
    let settled = false
    const compute = (): ConfigChange[] =>
      settled ? [] : [{ op: "unset", path: ["registry", "llms", { name: model.name }] }]
    onRemoveStart()
    await autosave.runComputed(compute, { kind: "delete-model", name: model.name })
    settled = true
    onRemoveEnd()
  }

  return (
    <div id={id} data-model-panel className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2 bg-muted/40 px-4 py-4">
      <div className="col-start-2 min-w-0 space-y-4">
        <div data-model-connection className="space-y-2">
          <p className="text-sm">
            {connectionSentence(status, planName(model.provider, facts.label), {
              signIn: facts.signIn,
              keyOptional: facts.keyOptional,
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={testing ? true : undefined}
              onClick={() => {
                if (!testing) void test.run()
              }}
            >
              {testing ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {TEST_CONNECTION_LABEL}
            </Button>
            {isDefault ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onMakeDefault()
                  header.current?.focus()
                }}
              >
                {MAKE_DEFAULT_LABEL}
              </Button>
            )}
            {facts.signIn || replacing ? null : (
              <Button ref={replaceButton} type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
                {REPLACE_KEY_LABEL}
              </Button>
            )}
            {signInOffered ? (
              <SignInButton
                data-sign-in-again
                flow={signInFlow}
                label={SIGN_IN_AGAIN_LABEL}
                variant="outline"
                size="sm"
                onStart={() => void signInFlow.start(model.provider, model.name)}
              />
            ) : null}
            {keySaved ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void removeCredential("remove-key")}>
                {REMOVE_KEY_LABEL}
              </Button>
            ) : null}
            {signedIn ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void removeCredential("sign-out")}>
                <LogOut className="size-3.5" aria-hidden="true" />
                {SIGN_OUT_LABEL}
              </Button>
            ) : null}
          </div>
          {replacing ? <ReplaceKeyGroup onSave={saveKey} onKeep={closeReplace} /> : null}
          <SignInProgress flow={signInFlow} />
          {shownLine === undefined && landing !== undefined ? (
            <LandingLine
              name={model.name}
              landing={landing}
              isDefault={isDefault}
              onMakeDefault={() => {
                onMakeDefault()
                header.current?.focus()
              }}
            />
          ) : null}
          {shownLine === undefined ? null : <ConnectionLine state={shownLine.state} sentence={shownLine.sentence} />}
        </div>
        <ModelSettings model={model} facts={facts} />
        {connection === undefined ? null : (
          <p data-model-fixed className="text-xs text-muted-foreground">
            {fixedFactsLine(connection)}
          </p>
        )}
        <div data-model-footer>
          {isDefault ? (
            <p data-model-default-line className="text-xs text-muted-foreground">
              {DEFAULT_CANNOT_DELETE_LINE}
            </p>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => void deleteModel()}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {DELETE_MODEL_LABEL}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

interface ModelRowProps extends ModelRowActions {
  model: SavedModel
  status: ModelStatus
  facts: ProviderFacts
  keyType: CredentialKeyType
  isDefault: boolean
  open: boolean
  onToggle: () => void
  onMakeDefault: () => void
  /** Set on the row the add row just saved, while it stays open. */
  landing?: ModelLanding
}

export function ModelRow({
  model,
  status,
  facts,
  keyType,
  isDefault,
  open,
  onToggle,
  onMakeDefault,
  landing,
  ...actions
}: ModelRowProps) {
  const panelId = useId()
  const header = useRef<HTMLButtonElement>(null)
  const line = facts.label === undefined ? model.model : modelLine(model.model, facts.label)
  const expired = status === "sign-in-expired"

  return (
    <li
      data-model-row
      data-model-name={model.name}
      data-model-status={status}
      data-model-default={isDefault ? "true" : undefined}
      data-model-open={open ? "true" : "false"}
    >
      <button
        ref={header}
        type="button"
        data-model-row-toggle
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="group grid min-h-12 w-full grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-4 py-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight
          className="row-span-2 size-3 text-muted-foreground group-aria-expanded:rotate-90"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span data-model-row-name className="font-mono text-sm font-medium wrap-anywhere">
            {model.name}
          </span>
          {isDefault ? (
            <Badge variant="outline" data-model-default-badge>
              {DEFAULT_BADGE}
            </Badge>
          ) : null}
        </span>
        <span
          data-model-row-status
          className={cn(
            "row-span-2 flex items-center gap-1 text-xs",
            expired ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {expired ? <TriangleAlert className="size-3 text-amber-500" aria-hidden="true" /> : null}
          {MODEL_STATUS_WORDS[status]}
        </span>
        <span data-model-row-model className="col-start-2 truncate text-xs text-muted-foreground" title={line}>
          {line}
        </span>
      </button>
      {open ? (
        <ModelPanel
          id={panelId}
          model={model}
          status={status}
          facts={facts}
          keyType={keyType}
          isDefault={isDefault}
          onMakeDefault={onMakeDefault}
          header={header}
          landing={landing}
          {...actions}
        />
      ) : null}
    </li>
  )
}
