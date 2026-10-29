// THE ADD ROW (429-25, 429-26 · D-13..D-17, research A3, A8 · UI-SPEC S5, E5 · PXH-CONF-03).
//
// How you connect comes first, then only that choice's fields, then the name, then Connect. The
// connect door tests the draft with the typed credential and writes it only on a pass, or on the
// explicit Save without testing a failure offers; this row never writes the config itself. The
// typed key and header values live in this component's state only; every other field persists in
// the add-row draft store, so a reload restores the row with its secrets empty.
//
// A sign-in choice signs the draft name in straight away and then tests by itself. A name that
// already holds this provider's credential on this machine only tests; a name holding another
// provider's credential is refused before anything starts. A sign-in this draft created follows a
// rename and goes with Discard; a credential that existed before the draft is never moved or removed.

import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { CircleAlert, LoaderCircle, Plus } from "lucide-react"

import { providerFacts } from "@/components/config-manager/model-row"
import { ConnectionLine } from "@/components/config-manager/connection-line"
import { SignInButton, SignInProgress, signInActive, signInLine } from "@/components/config-manager/sign-in-progress"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  configFieldControlId,
  externalDraftFieldKey,
  useConfigAutosaveContext,
} from "@/hooks/use-config-autosave"
import { useSignInFlow, type SignInCompletion } from "@/hooks/use-sign-in-flow"
import {
  clearAddModelDraft,
  readAddModelDraft,
  suggestModelName,
  writeAddModelDraft,
  type AddModelDraft,
  type AddModelKeyType,
} from "@/lib/add-model-draft"
import {
  connectLLM,
  deleteAuthCredential,
  fetchAuthStatus,
  fetchLiveModelCatalog,
  fetchModelCatalog,
  moveCredential,
  type AuthCredentialInfo,
  type LLMProviderMetadata,
  type ModelCatalogEntry,
} from "@/lib/api"
import {
  ADD_FLOW_FIELD_LABELS,
  ADD_HEADER_LABEL,
  BASE_URL_HELP,
  BASE_URL_REQUIRED_ERROR,
  CONNECTING_LABEL,
  CONNECT_REFUSAL_COPY,
  CONNECTION_CHOICE_HINTS,
  CONNECTION_CHOICE_LABELS,
  CONNECT_FORM_LEGEND,
  CONNECT_LABEL,
  DISCARD_DRAFT_LABEL,
  DISCARD_HEADER_LABEL,
  HEADER_FIELD_LABELS,
  KEY_OPTIONAL_HELP,
  KEY_REQUIRED_ERROR,
  KEY_TYPE_LABELS,
  MODEL_REQUIRED_ERROR,
  NAME_RULE_ERROR,
  NEW_MODEL_ROW_TITLE,
  REPLACE_KEY_LABEL,
  SAVE_WITHOUT_TESTING_LABEL,
  connectRefusalSentence,
  existingCredentialLine,
  nameCredentialConflictError,
  nameTakenError,
  providerErrorSentence,
  signInPluginMissingText,
} from "@/lib/config-copy"
import {
  CONNECTION_CHOICES,
  CONNECTION_CHOICE_PROVIDERS,
  type ConnectionChoice,
  type TestResult,
} from "@/lib/config-tabs"
import { cn } from "@/lib/utils"

const NAME_RULE = /^[a-z0-9][a-z0-9.-]*$/

/** the name rule, then a model already holding the name. */
export function validateModelName(name: string, existingNames: readonly string[]): string | undefined {
  if (!NAME_RULE.test(name)) return NAME_RULE_ERROR
  if (existingNames.includes(name)) return nameTakenError(name)
  return undefined
}

export type AddState = "choosing" | "editing" | "connecting" | "signing-in" | "failed"

/** What the list shows once the draft is saved: the new row, open, with its line. */
export interface AddModelLanding {
  name: string
  becameDefault: boolean
  withoutTest: boolean
}

export interface AddFocusRequest {
  seq: number
  /** The connection choice, or the first field of the chosen connection (a deep link naming it). */
  target: "choice" | "field"
}

interface AddModelRowProps {
  configPath: string
  providers: readonly LLMProviderMetadata[]
  existingNames: readonly string[]
  initialChoice?: ConnectionChoice
  focusRequest?: AddFocusRequest
  onConnected: (landing: AddModelLanding) => void
  onDiscard: () => void
}

type FieldName = "baseURL" | "model" | "key" | "name"
type FieldErrors = Partial<Record<FieldName, string>>

interface HeaderDraft {
  id: number
  name: string
  value: string
}

interface Line {
  state: TestResult
  sentence?: string
}

const SIGN_IN_CHOICES: readonly ConnectionChoice[] = ["chatgpt-sign-in", "claude-sign-in"]

function isSignIn(choice: ConnectionChoice | undefined): boolean {
  return choice !== undefined && SIGN_IN_CHOICES.includes(choice)
}

function providerOf(choice: ConnectionChoice): string {
  return CONNECTION_CHOICE_PROVIDERS[choice]
}

function defaultModelOf(providers: readonly LLMProviderMetadata[], choice: ConnectionChoice): string {
  if (!isSignIn(choice)) return ""
  return providers.find((provider) => provider.id === providerOf(choice))?.defaultModel ?? ""
}

function mergeCatalog(...lists: readonly (readonly ModelCatalogEntry[])[]): ModelCatalogEntry[] {
  const seen = new Set<string>()
  const merged: ModelCatalogEntry[] = []
  for (const entry of lists.flat()) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push(entry)
  }
  return merged
}

interface Initial {
  draft: AddModelDraft
  headers: HeaderDraft[]
}

/** A sign-in this draft completed: under which name, for which provider, and whether it created it. */
interface DraftSignIn {
  name: string
  provider: string
  created: boolean
}

/**
 * After a reload, a stored createdCredential means the sign-in under the stored name is this
 * draft's, unless that name is now a saved model: its Connect saved it and the answer was lost.
 * Answering undefined also drops createdCredential from storage on the row's first draft write.
 */
function restoredSignIn(draft: AddModelDraft, savedNames: readonly string[]): DraftSignIn | undefined {
  if (draft.createdCredential !== true || draft.choice === undefined || !isSignIn(draft.choice) || !draft.name) {
    return undefined
  }
  if (savedNames.includes(draft.name)) return undefined
  return { name: draft.name, provider: providerOf(draft.choice), created: true }
}

function initialState(
  stored: AddModelDraft | undefined,
  initialChoice: ConnectionChoice | undefined,
  providers: readonly LLMProviderMetadata[],
): Initial {
  if (initialChoice !== undefined && stored?.choice !== initialChoice) {
    const model = defaultModelOf(providers, initialChoice)
    return { draft: { choice: initialChoice, model, name: suggestModelName(model), nameEdited: false }, headers: [] }
  }
  const draft = stored ?? {}
  const headers = (draft.headerNames ?? []).map((name, index) => ({ id: index + 1, name, value: "" }))
  return { draft, headers }
}

interface Refusal {
  code?: string
  message?: string
  issues?: { message: string }[]
}

function issuesOf(raw: unknown): { message: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.flatMap((issue) => {
    const message = (issue as { message?: unknown } | null)?.message
    return typeof message === "string" ? [{ message }] : []
  })
}

function refusalOf(error: unknown): Refusal {
  const payload = (error as { payload?: Record<string, unknown> | null } | null)?.payload
  if (!payload) return {}
  const issues = issuesOf(payload.issues)
  return {
    ...(typeof payload.error === "string" ? { code: payload.error } : {}),
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    ...(issues === undefined ? {} : { issues }),
  }
}

interface DraftFieldProps {
  id: string
  name: FieldName | "keyType" | "headers"
  label: string
  help?: string
  error?: string
  pattern?: string
  children: (aria: { "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode
}

/** The ConfigField look for a draft field: label, control, help and error line, never autosaved. */
function DraftField({ id, name, label, help, error, pattern, children }: DraftFieldProps) {
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const describedBy = [help === undefined ? null : helpId, error === undefined ? null : errorId]
    .filter((item): item is string => item !== null)
    .join(" ")
  return (
    <div
      data-add-field={name}
      data-field-path={pattern}
      data-field-state={error === undefined ? "clean" : "draft"}
      className="space-y-2"
    >
      <Label htmlFor={id}>{label}</Label>
      {children({
        ...(error === undefined ? {} : { "aria-invalid": true as const }),
        ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
      })}
      {help === undefined ? null : (
        <p id={helpId} data-field-help className="text-xs text-muted-foreground break-words">
          {help}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} data-field-error className="flex items-start gap-1 text-xs text-destructive break-words">
          <span className="flex h-[1lh] shrink-0 items-center">
            <CircleAlert className="size-3" aria-hidden="true" />
          </span>
          {error}
        </p>
      )}
    </div>
  )
}

export function AddModelRow({
  configPath,
  providers,
  existingNames,
  initialChoice,
  focusRequest,
  onConnected,
  onDiscard,
}: AddModelRowProps) {
  const autosave = useConfigAutosaveContext()
  const baseId = useId()
  const [initial] = useState(() => initialState(readAddModelDraft(configPath), initialChoice, providers))
  const [choice, setChoice] = useState<ConnectionChoice | undefined>(initial.draft.choice)
  const [baseURL, setBaseURL] = useState(initial.draft.baseURL ?? "")
  const [model, setModel] = useState(initial.draft.model ?? "")
  const [name, setName] = useState(initial.draft.name ?? "")
  const [nameEdited, setNameEdited] = useState(initial.draft.nameEdited ?? false)
  const [keyType, setKeyType] = useState<AddModelKeyType>(initial.draft.keyType ?? "api-key")
  const [headers, setHeaders] = useState<HeaderDraft[]>(initial.headers)
  const [secret, setSecret] = useState("")
  const [errors, setErrors] = useState<FieldErrors>({})
  const [connecting, setConnecting] = useState(false)
  const [line, setLine] = useState<Line | undefined>(undefined)
  const [offerSkip, setOfferSkip] = useState(false)
  const [catalog, setCatalog] = useState<Record<string, ModelCatalogEntry[]>>({})
  const [liveCatalog, setLiveCatalog] = useState<ModelCatalogEntry[]>([])
  const [heldCredentials, setHeldCredentials] = useState<readonly AuthCredentialInfo[]>([])
  const [signedIn, setSignedIn] = useState<DraftSignIn | undefined>(() => restoredSignIn(initial.draft, existingNames))
  const [replaceKey, setReplaceKey] = useState(false)
  const focusKeyNext = useRef(false)
  const flow = useSignInFlow({ onCompleted: signInCompleted })
  const choiceRefs = useRef(new Map<ConnectionChoice, HTMLButtonElement>())
  const fieldRefs = useRef(new Map<FieldName, HTMLInputElement>())
  const nextHeaderId = useRef(initial.headers.length + 1)
  const mounted = useRef(true)
  const setExternalDraft = autosave.setExternalDraft

  const provider = choice === undefined ? undefined : providerOf(choice)
  const facts = provider === undefined ? undefined : providerFacts(providers, provider)
  const signIn = isSignIn(choice)
  const pluginMissing = signIn && provider !== undefined && !providers.some((item) => item.id === provider)
  const keyMode = choice !== undefined && !signIn
  const needsBaseURL = keyMode && facts?.needsBaseURL === true
  const keyOptional = keyMode && facts?.keyOptional === true
  const anthropic = choice === "anthropic-compatible-key"
  const signingIn = signInActive(flow)
  const busy = connecting || signingIn
  const existing = choice !== undefined && !pluginMissing && holdsCredential(name)
  const usingExistingKey = keyMode && existing && !replaceKey
  const existingSignIn = signIn && existing
  const shownLine = signInLine(flow) ?? line
  const liveCapable =
    choice === "openai-compatible-key" ||
    (provider !== undefined && providers.find((item) => item.id === provider)?.modelAdapter === "openai-responses")
  const addState: AddState = connecting
    ? "connecting"
    : signingIn
      ? "signing-in"
      : shownLine?.state === "failed"
        ? "failed"
        : choice === undefined
          ? "choosing"
          : "editing"
  const headerNames = headers.map((header) => header.name)
  const headerNamesKey = JSON.stringify(headerNames)
  const suggestions = mergeCatalog(provider === undefined ? [] : (catalog[provider] ?? []), liveCatalog)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setExternalDraft("models", true)
    return () => setExternalDraft("models", false)
  }, [setExternalDraft])

  useEffect(() => {
    let active = true
    fetchModelCatalog().then(
      (answer) => {
        if (active) setCatalog(answer.catalog ?? {})
      },
      () => {
        // Suggestions are optional; the field takes any model id.
      },
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    fetchAuthStatus().then(
      (answer) => {
        if (active) setHeldCredentials(answer.credentials ?? [])
      },
      () => {
        // Without the read, the server's own refusals still guard another provider's credential.
      },
    )
    return () => {
      active = false
    }
  }, [])

  const createdCredential = signedIn?.created === true
  useEffect(() => {
    writeAddModelDraft(configPath, {
      ...(choice === undefined ? {} : { choice }),
      baseURL,
      model,
      name,
      nameEdited,
      keyType,
      headerNames: JSON.parse(headerNamesKey) as string[],
      ...(createdCredential ? { createdCredential: true } : {}),
    })
  }, [configPath, choice, baseURL, model, name, nameEdited, keyType, headerNamesKey, createdCredential])

  useEffect(() => {
    if (!replaceKey || !focusKeyNext.current) return
    focusKeyNext.current = false
    fieldRefs.current.get("key")?.focus()
  }, [replaceKey])

  useEffect(() => {
    if (focusRequest === undefined) return
    if (focusRequest.target === "field" && choice !== undefined) {
      const first = (["baseURL", "model", "key", "name"] as const).map((field) => fieldRefs.current.get(field)).find(Boolean)
      if (first) {
        first.focus()
        return
      }
    }
    const target = (choice === undefined ? undefined : choiceRefs.current.get(choice)) ?? choiceRefs.current.get(CONNECTION_CHOICES[0])
    target?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request moves focus
  }, [focusRequest?.seq])

  function heldUnder(candidate: string): AuthCredentialInfo | undefined {
    return heldCredentials.find((credential) => credential.configName === candidate)
  }

  /** the name already holds this choice's credential on this machine, so Connect only tests. */
  function holdsCredential(candidate: string): boolean {
    if (provider === undefined || candidate === "") return false
    if (signedIn?.name === candidate) return signedIn.provider === provider
    return heldUnder(candidate)?.provider === provider
  }

  /** Claude's Discretion "Name collision": another provider's credential under the name is never overwritten. */
  function credentialConflict(candidate: string, held: readonly AuthCredentialInfo[] = heldCredentials): string | undefined {
    if (provider === undefined || candidate === "") return undefined
    const holder =
      signedIn?.name === candidate
        ? signedIn.provider
        : held.find((credential) => credential.configName === candidate)?.provider
    if (holder === undefined || holder === provider) return undefined
    return nameCredentialConflictError(candidate, providerFacts(providers, holder).label ?? holder)
  }

  function validate(field: FieldName, overrides: Partial<Record<FieldName, string>> = {}): string | undefined {
    const value = (key: FieldName, fallback: string) => overrides[key] ?? fallback
    switch (field) {
      case "baseURL":
        return needsBaseURL && value("baseURL", baseURL).trim() === "" ? BASE_URL_REQUIRED_ERROR : undefined
      case "model":
        return value("model", model).trim() === "" ? MODEL_REQUIRED_ERROR : undefined
      case "key":
        return keyMode && !keyOptional && !usingExistingKey && value("key", secret) === "" ? KEY_REQUIRED_ERROR : undefined
      case "name": {
        const candidate = value("name", name)
        return validateModelName(candidate, existingNames) ?? credentialConflict(candidate)
      }
    }
  }

  /** Shows every invalid field's error and focuses the first; true when all are valid. */
  function validateFields(order: readonly FieldName[]): boolean {
    const found: FieldErrors = {}
    for (const field of order) {
      const error = validate(field)
      if (error !== undefined) found[field] = error
    }
    setErrors(found)
    const firstInvalid = order.find((field) => found[field] !== undefined)
    if (firstInvalid === undefined) return true
    fieldRefs.current.get(firstInvalid)?.focus()
    return false
  }

  function showError(field: FieldName, error: string | undefined) {
    setErrors((current) => {
      if (current[field] === error) return current
      const next = { ...current }
      if (error === undefined) delete next[field]
      else next[field] = error
      return next
    })
  }

  /** A field that already shows an error re-checks as it changes, so the error leaves once fixed. */
  function recheck(field: FieldName, raw: string) {
    if (errors[field] !== undefined) showError(field, validate(field, { [field]: raw }))
  }

  function changeChoice(value: string) {
    const next = CONNECTION_CHOICES.find((item) => item === value)
    if (next === undefined || next === choice || busy) return
    const nextModel = defaultModelOf(providers, next)
    flow.cancel()
    setReplaceKey(false)
    setChoice(next)
    setBaseURL("")
    setModel(nextModel)
    setSecret("")
    setKeyType("api-key")
    setHeaders([])
    setLiveCatalog([])
    setErrors({})
    setLine(undefined)
    setOfferSkip(false)
    if (!nameEdited) setName(suggestModelName(nextModel))
  }

  function changeModel(raw: string) {
    setModel(raw)
    recheck("model", raw)
    if (!nameEdited) {
      const suggested = suggestModelName(raw)
      setName(suggested)
      if (errors.name !== undefined) showError("name", validate("name", { name: suggested }))
    }
  }

  function changeName(raw: string) {
    setName(raw)
    setNameEdited(true)
    recheck("name", raw)
  }

  function sendableHeaders(): Record<string, string> | undefined {
    if (!anthropic) return undefined
    const entries = headers
      .map((header) => [header.name.trim(), header.value] as const)
      .filter(([key, value]) => key !== "" && value !== "")
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  async function loadLiveModels() {
    const url = baseURL.trim()
    if (!liveCapable || url === "") return
    try {
      const answer = await fetchLiveModelCatalog({ baseURL: url })
      if (mounted.current) setLiveCatalog(answer.models ?? [])
    } catch {
      // The catalog suggestions stay when the endpoint can't list its models.
    }
  }

  async function connect(skipTest: boolean) {
    if (connecting || choice === undefined || provider === undefined) return
    if (!validateFields(["baseURL", "model", "key", "name"])) return
    if (flow.state === "failed" || flow.state === "timed-out") flow.cancel()
    const providerHeaders = sendableHeaders()
    const request = {
      name,
      provider,
      model: model.trim(),
      ...(needsBaseURL || baseURL.trim() !== "" ? { baseURL: baseURL.trim() } : {}),
      ...(providerHeaders ? { providerHeaders } : {}),
      ...(keyMode && !usingExistingKey && secret !== "" ? { credential: { type: anthropic ? keyType : "api-key", secret } } : {}),
      ...(skipTest ? { skipTest: true } : {}),
    }
    setConnecting(true)
    setLine(skipTest ? undefined : { state: "testing" })
    let result: Awaited<ReturnType<typeof connectLLM>>
    try {
      result = await connectLLM(request)
    } catch (error) {
      if (!mounted.current) return
      setConnecting(false)
      const refusal = refusalOf(error)
      if (refusal.code === "name_taken" || refusal.code === "name_invalid") {
        setLine(undefined)
        showError("name", refusal.code === "name_taken" ? nameTakenError(name) : NAME_RULE_ERROR)
        fieldRefs.current.get("name")?.focus()
        return
      }
      if (refusal.code === "credential_missing") {
        setLine(undefined)
        showError("key", KEY_REQUIRED_ERROR)
        fieldRefs.current.get("key")?.focus()
        return
      }
      if (refusal.code === "credential_provider_conflict") {
        setLine(undefined)
        await showServerConflict(request.name)
        return
      }
      setLine({ state: "failed", sentence: refusal.message ?? connectRefusalSentence(refusal.code, refusal.issues) })
      return
    }
    if (!mounted.current) return
    if (result.success) {
      clearAddModelDraft(configPath)
      onConnected({ name, becameDefault: result.becameDefault, withoutTest: skipTest })
      return
    }
    setConnecting(false)
    setLine({ state: "failed", sentence: result.message })
    setOfferSkip(true)
  }

  /** The server saw another provider's credential under the name; re-read who holds it to say so. */
  async function showServerConflict(candidate: string) {
    let held = heldCredentials
    try {
      held = (await fetchAuthStatus()).credentials ?? held
    } catch {
      // The generic conflict sentence still names the fix.
    }
    if (!mounted.current) return
    setHeldCredentials(held)
    showError("name", credentialConflict(candidate, held) ?? CONNECT_REFUSAL_COPY.credential_provider_conflict)
    fieldRefs.current.get("name")?.focus()
  }

  /** the sign-in finished for the draft name, so the test runs by itself, with no key. */
  function signInCompleted(completion: SignInCompletion) {
    const createdBefore = signedIn?.name === completion.name && signedIn.created
    setSignedIn({ name: completion.name, provider: completion.provider, created: completion.created || createdBefore })
    void connect(false)
  }

  function startSignIn() {
    // A manual-code sign-in may be started again, for a provider page that was closed.
    if (connecting || flow.state === "waiting" || flow.exchanging || provider === undefined) return
    if (!validateFields(["model", "name"])) return
    setLine(undefined)
    setOfferSkip(false)
    void flow.start(provider, name)
  }

  /** Research A3: a sign-in this draft created follows the name; one that existed before never moves. */
  async function settleName() {
    const error = validate("name")
    showError("name", error)
    const own = signedIn
    const to = name
    if (error !== undefined || own === undefined || !own.created || own.name === to || own.provider !== provider) return
    if (heldUnder(to) !== undefined) return
    try {
      await moveCredential(own.name, to, own.provider)
    } catch (failure) {
      if (!mounted.current) return
      const refusal = refusalOf(failure)
      if (refusal.code !== "credential_exists") {
        showError("name", refusal.message ?? providerErrorSentence("network_error", ""))
      }
      return
    }
    if (mounted.current) setSignedIn({ ...own, name: to })
  }

  function discard() {
    flow.cancel()
    // Claude's Discretion "Discarded draft": only a credential this draft created goes with it,
    // and never one a saved model now uses.
    if (signedIn?.created === true && !existingNames.includes(signedIn.name)) {
      deleteAuthCredential(signedIn.name).catch(() => {
        // The draft is gone either way; the credential stays until signed out from a saved row.
      })
    }
    clearAddModelDraft(configPath)
    onDiscard()
  }

  function replaceSavedKey() {
    focusKeyNext.current = true
    setReplaceKey(true)
  }

  function inputRef(field: FieldName) {
    return (element: HTMLInputElement | null) => {
      if (element) fieldRefs.current.set(field, element)
      else fieldRefs.current.delete(field)
    }
  }

  const keyLabel = anthropic
    ? keyType === "bearer-token"
      ? ADD_FLOW_FIELD_LABELS.token
      : ADD_FLOW_FIELD_LABELS.key
    : ADD_FLOW_FIELD_LABELS.apiKey
  const listId = `${baseId}-models`

  return (
    <li data-model-row data-model-draft data-add-state={addState}>
      <div className="grid min-h-12 grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-x-2 px-4 py-2">
        {/* Not saved lands here while the add row is the tab's draft. */}
        <span
          id={configFieldControlId(externalDraftFieldKey("models"))}
          tabIndex={-1}
          className="col-start-2 rounded-sm text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {NEW_MODEL_ROW_TITLE}
        </span>
        <Button type="button" variant="ghost" size="sm" data-discard-draft onClick={discard}>
          {DISCARD_DRAFT_LABEL}
        </Button>
      </div>
      <div className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2 bg-muted/40 px-4 py-4">
        <div className="col-start-2 min-w-0 space-y-4">
          <fieldset data-add-step="connect" className="space-y-2">
            <legend className="text-sm font-medium">{CONNECT_FORM_LEGEND}</legend>
            <RadioGroup className="gap-2" value={choice ?? ""} onValueChange={changeChoice} disabled={busy}>
              {CONNECTION_CHOICES.map((item) => {
                const itemId = `${baseId}-${item}`
                const hintId = `${itemId}-hint`
                return (
                  <Label key={item} htmlFor={itemId} data-connection-choice={item} className="items-start font-normal">
                    <RadioGroupItem
                      ref={(element) => {
                        if (element) choiceRefs.current.set(item, element)
                        else choiceRefs.current.delete(item)
                      }}
                      id={itemId}
                      value={item}
                      aria-describedby={hintId}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 space-y-1">
                      <span className="block text-sm font-medium leading-normal">{CONNECTION_CHOICE_LABELS[item]}</span>
                      <span id={hintId} className="block text-xs text-muted-foreground break-words">
                        {CONNECTION_CHOICE_HINTS[item]}
                      </span>
                    </span>
                  </Label>
                )
              })}
            </RadioGroup>
          </fieldset>

          {choice === undefined ? null : (
            <>
              <div data-add-step="fields" className="space-y-4">
                {needsBaseURL ? (
                  <DraftField
                    id={`${baseId}-base-url`}
                    name="baseURL"
                    pattern="registry.llms[].baseURL"
                    label={ADD_FLOW_FIELD_LABELS.baseUrl}
                    help={BASE_URL_HELP}
                    error={errors.baseURL}
                  >
                    {(aria) => (
                      <Input
                        ref={inputRef("baseURL")}
                        id={`${baseId}-base-url`}
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        placeholder={providers.find((item) => item.id === provider)?.baseURLPlaceholder}
                        readOnly={busy}
                        value={baseURL}
                        onChange={(event) => {
                          setBaseURL(event.target.value)
                          recheck("baseURL", event.target.value)
                        }}
                        onBlur={() => {
                          showError("baseURL", validate("baseURL"))
                          void loadLiveModels()
                        }}
                        className="w-full max-w-md font-mono"
                        {...aria}
                      />
                    )}
                  </DraftField>
                ) : null}
                <DraftField
                  id={`${baseId}-model`}
                  name="model"
                  pattern="registry.llms[].model"
                  label={ADD_FLOW_FIELD_LABELS.model}
                  error={errors.model}
                >
                  {(aria) => (
                    <>
                      <Input
                        ref={inputRef("model")}
                        id={`${baseId}-model`}
                        type="text"
                        autoComplete="off"
                        list={suggestions.length > 0 ? listId : undefined}
                        readOnly={busy}
                        value={model}
                        onChange={(event) => changeModel(event.target.value)}
                        onBlur={() => showError("model", validate("model"))}
                        className="w-full max-w-md font-mono"
                        {...aria}
                      />
                      {suggestions.length > 0 ? (
                        <datalist id={listId}>
                          {suggestions.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.label}
                            </option>
                          ))}
                        </datalist>
                      ) : null}
                    </>
                  )}
                </DraftField>
                {anthropic ? (
                  <DraftField id={`${baseId}-key-type`} name="keyType" label={ADD_FLOW_FIELD_LABELS.keyType}>
                    {() => (
                      <RadioGroup
                        id={`${baseId}-key-type`}
                        className="flex flex-wrap gap-4"
                        value={keyType}
                        disabled={busy}
                        onValueChange={(value) => {
                          if (value === "api-key" || value === "bearer-token") setKeyType(value)
                        }}
                      >
                        {(["api-key", "bearer-token"] as const).map((type) => (
                          <Label key={type} htmlFor={`${baseId}-key-type-${type}`} className="font-normal">
                            <RadioGroupItem id={`${baseId}-key-type-${type}`} value={type} />
                            {KEY_TYPE_LABELS[type]}
                          </Label>
                        ))}
                      </RadioGroup>
                    )}
                  </DraftField>
                ) : null}
                {usingExistingKey ? (
                  <div data-existing-credential className="space-y-1">
                    <p className="text-xs text-muted-foreground break-words">{existingCredentialLine("key", name)}</p>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0 text-xs"
                      onClick={replaceSavedKey}
                    >
                      {REPLACE_KEY_LABEL}
                    </Button>
                  </div>
                ) : keyMode ? (
                  <DraftField
                    id={`${baseId}-key`}
                    name="key"
                    label={keyLabel}
                    help={keyOptional ? KEY_OPTIONAL_HELP : undefined}
                    error={errors.key}
                  >
                    {(aria) => (
                      <Input
                        ref={inputRef("key")}
                        id={`${baseId}-key`}
                        type="password"
                        autoComplete="off"
                        readOnly={busy}
                        value={secret}
                        onChange={(event) => {
                          setSecret(event.target.value)
                          recheck("key", event.target.value)
                        }}
                        onBlur={() => showError("key", validate("key"))}
                        className="w-full max-w-md font-mono"
                        {...aria}
                      />
                    )}
                  </DraftField>
                ) : null}
                {anthropic ? (
                  <fieldset data-add-headers className="space-y-2">
                    <legend className="text-sm font-medium">{ADD_FLOW_FIELD_LABELS.headers}</legend>
                    {headers.map((header) => (
                      <div
                        key={header.id}
                        data-add-header
                        className="grid gap-2 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_auto] sm:items-center"
                      >
                        <Input
                          type="text"
                          aria-label={HEADER_FIELD_LABELS.name}
                          autoComplete="off"
                          readOnly={busy}
                          value={header.name}
                          onChange={(event) =>
                            setHeaders((current) =>
                              current.map((item) => (item.id === header.id ? { ...item, name: event.target.value } : item)),
                            )
                          }
                          className="h-8 font-mono"
                        />
                        <Input
                          type="password"
                          aria-label={HEADER_FIELD_LABELS.value}
                          autoComplete="off"
                          readOnly={busy}
                          value={header.value}
                          onChange={(event) =>
                            setHeaders((current) =>
                              current.map((item) => (item.id === header.id ? { ...item, value: event.target.value } : item)),
                            )
                          }
                          className="h-8 font-mono"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => setHeaders((current) => current.filter((item) => item.id !== header.id))}
                        >
                          {DISCARD_HEADER_LABEL}
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        const id = nextHeaderId.current++
                        setHeaders((current) => [...current, { id, name: "", value: "" }])
                      }}
                    >
                      <Plus className="size-3" aria-hidden="true" />
                      {ADD_HEADER_LABEL}
                    </Button>
                  </fieldset>
                ) : null}
              </div>

              <div data-add-step="name" className="space-y-4">
                <DraftField
                  id={`${baseId}-name`}
                  name="name"
                  pattern="registry.llms[].name"
                  label={ADD_FLOW_FIELD_LABELS.name}
                  error={errors.name}
                >
                  {(aria) => (
                    <Input
                      ref={inputRef("name")}
                      id={`${baseId}-name`}
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      readOnly={busy}
                      value={name}
                      onChange={(event) => changeName(event.target.value)}
                      onBlur={() => void settleName()}
                      className="w-full max-w-md font-mono"
                      {...aria}
                    />
                  )}
                </DraftField>
              </div>

              <div data-add-actions className="space-y-2">
                {pluginMissing ? (
                  <p data-sign-in-plugin-missing className="text-xs text-muted-foreground break-words">
                    {signInPluginMissingText(CONNECTION_CHOICE_LABELS[choice])}
                  </p>
                ) : keyMode || existingSignIn ? (
                  <>
                    {existingSignIn ? (
                      <p data-existing-credential className="text-xs text-muted-foreground break-words">
                        {existingCredentialLine("sign-in", name)}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        data-add-connect
                        aria-disabled={connecting ? true : undefined}
                        onClick={() => void connect(false)}
                      >
                        {connecting ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : null}
                        {connecting ? CONNECTING_LABEL : CONNECT_LABEL}
                      </Button>
                    </div>
                  </>
                ) : signIn ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <SignInButton
                        data-add-sign-in
                        flow={flow}
                        label={CONNECTION_CHOICE_LABELS[choice]}
                        variant="default"
                        size="default"
                        onStart={startSignIn}
                      />
                    </div>
                    <SignInProgress flow={flow} />
                  </>
                ) : null}
                {shownLine === undefined ? null : <ConnectionLine state={shownLine.state} sentence={shownLine.sentence} />}
                {offerSkip && !busy ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    data-save-without-test
                    className={cn("h-auto px-0 text-muted-foreground")}
                    onClick={() => void connect(true)}
                  >
                    {SAVE_WITHOUT_TESTING_LABEL}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  )
}
