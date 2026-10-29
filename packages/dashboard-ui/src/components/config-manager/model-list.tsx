// A failed credential-status read shows every row Not connected, never a status it has not read.

import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { Plus, TriangleAlert } from "lucide-react"

import { AddModelRow, type AddFocusRequest, type AddModelLanding } from "@/components/config-manager/add-model-row"
import {
  ModelRow,
  credentialKeyType,
  modelStatus,
  providerFacts,
  type SavedModel,
} from "@/components/config-manager/model-row"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useConfigAutosaveContext, type ConfigFieldRef } from "@/hooks/use-config-autosave"
import { fetchAuthStatus, fetchLLMProviders, type AuthCredentialInfo, type LLMProviderMetadata } from "@/lib/api"
import { readAddModelDraft } from "@/lib/add-model-draft"
import { ADD_MODEL_LABEL, NO_DEFAULT_TEXT, NO_MODELS_TEXT } from "@/lib/config-copy"
import { CONNECTION_CHOICES, type ConnectionChoice } from "@/lib/config-tabs"

interface ModelListProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

interface WorkspaceReads {
  credentials: readonly AuthCredentialInfo[]
  providers: readonly LLMProviderMetadata[]
}

const LLMS_REF: ConfigFieldRef = { segments: ["registry", "llms"], tab: "models" }
const DEFAULT_REF: ConfigFieldRef = { segments: ["use", "llm"], tab: "models" }
const ADD_BUTTON = Symbol("add-model")

function withName(names: ReadonlySet<string>, name: string, present: boolean): ReadonlySet<string> {
  if (names.has(name) === present) return names
  const next = new Set(names)
  if (present) next.add(name)
  else next.delete(name)
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function savedModels(value: unknown): SavedModel[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is SavedModel =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      typeof entry.provider === "string" &&
      typeof entry.model === "string",
  )
}

function choiceParam(value: string | null): ConnectionChoice | undefined {
  return CONNECTION_CHOICES.find((choice) => choice === value)
}

interface AddRowState {
  initialChoice?: ConnectionChoice
  focus: AddFocusRequest | undefined
}

export function ModelList(_props: ModelListProps) {
  const autosave = useConfigAutosaveContext()
  const [searchParams, setSearchParams] = useSearchParams()
  const addParam = searchParams.get("add")
  const configPath = autosave.load.kind === "ready" ? (autosave.load.answer.file?.path ?? "") : ""
  // A stored add draft (a reload mid-draft) re-opens the row; it takes focus only when asked.
  const [add, setAdd] = useState<AddRowState | undefined>(() =>
    readAddModelDraft(configPath) === undefined ? undefined : { focus: undefined },
  )
  const focusSeq = useRef(0)
  const [landing, setLanding] = useState<AddModelLanding | undefined>(undefined)
  const landingFocus = useRef<string | undefined>(undefined)
  const [reads, setReads] = useState<WorkspaceReads | undefined>(undefined)
  const [openName, setOpenName] = useState<string | undefined>(undefined)
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const [hiddenCredentials, setHiddenCredentials] = useState<ReadonlySet<string>>(new Set())
  const list = useRef<HTMLUListElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<string | typeof ADD_BUTTON | undefined>(undefined)
  const restored = autosave.restored
  // An Undo from before this list mounted (a tab change since) never moves focus.
  const seenSeq = useRef(restored?.seq)
  const models = savedModels(autosave.valueOf(LLMS_REF))
  const shown = models.filter((model) => !removing.has(model.name))
  const defaultValue = autosave.valueOf(DEFAULT_REF)
  const defaultName = typeof defaultValue === "string" ? defaultValue : undefined
  const hasDefault = models.some((model) => model.name === defaultName)

  function focusRow(name: string) {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("li[data-model-row]") ?? [])
    rows.find((row) => row.getAttribute("data-model-name") === name)?.querySelector<HTMLElement>("[data-model-row-toggle]")?.focus()
  }

  // The saved row appears once the re-read lands, so its focus waits until the row is there.
  useEffect(() => {
    const name = landingFocus.current
    if (name === undefined) return
    const toggle = Array.from(list.current?.querySelectorAll<HTMLElement>("li[data-model-row]") ?? [])
      .find((row) => row.getAttribute("data-model-name") === name)
      ?.querySelector<HTMLElement>("[data-model-row-toggle]")
    if (!toggle) return
    landingFocus.current = undefined
    toggle.focus()
  })

  useEffect(() => {
    const target = pendingFocus.current
    if (target === undefined) return
    pendingFocus.current = undefined
    if (target === ADD_BUTTON) addButton.current?.focus()
    else focusRow(target)
  })

  /** Reads the credential status again, and shows the named row's credential as the read says. */
  function refreshCredentials(name: string) {
    void fetchAuthStatus().then(
      (answer) => {
        setReads((current) => (current === undefined ? current : { ...current, credentials: answer.credentials ?? [] }))
        setHiddenCredentials((current) => withName(current, name, false))
      },
      () => setHiddenCredentials((current) => withName(current, name, false)),
    )
  }

  useEffect(() => {
    if (restored === undefined || restored.seq === seenSeq.current) return
    seenSeq.current = restored.seq
    if (restored.kind === "delete-model") focusRow(restored.name)
    else if (restored.kind === "sign-out" || restored.kind === "remove-key") refreshCredentials(restored.name)
  }, [restored])

  useEffect(() => {
    let active = true
    void Promise.all([
      fetchAuthStatus().then(
        (answer) => answer.credentials ?? [],
        () => [],
      ),
      fetchLLMProviders().then(
        (answer) => answer.providers ?? [],
        () => [],
      ),
    ]).then(([credentials, providers]) => {
      if (active) setReads({ credentials, providers })
    })
    return () => {
      active = false
    }
  }, [])

  function makeDefault(name: string) {
    autosave.edit(DEFAULT_REF, name, { valid: true, value: name })
    autosave.settle(DEFAULT_REF)
  }

  /** Opens the one add row, or focuses it when it is already open. */
  function openAdd(initialChoice: ConnectionChoice | undefined) {
    focusSeq.current += 1
    const seq = focusSeq.current
    setAdd((current) =>
      current === undefined
        ? { ...(initialChoice === undefined ? {} : { initialChoice }), focus: { seq, target: initialChoice ? "field" : "choice" } }
        : { ...current, focus: { seq, target: "choice" } },
    )
  }

  useEffect(() => {
    if (addParam === null) return
    openAdd(choiceParam(addParam))
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete("add")
        return next
      },
      { replace: true },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the link is applied once, then removed
  }, [addParam])

  function addModel() {
    openAdd(undefined)
  }

  function discardAdd() {
    pendingFocus.current = ADD_BUTTON
    setAdd(undefined)
  }

  function connected(next: AddModelLanding) {
    setAdd(undefined)
    setLanding(next)
    setOpenName(next.name)
    landingFocus.current = next.name
    autosave.refresh()
    refreshCredentials(next.name)
  }

  if (reads === undefined) {
    return (
      <div data-models-loading aria-busy="true" className="col-span-full space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  function removeStart(name: string) {
    const names = shown.map((model) => model.name)
    const index = names.indexOf(name)
    pendingFocus.current = names[index + 1] ?? names[index - 1] ?? ADD_BUTTON
    setRemoving((current) => withName(current, name, true))
  }

  if (shown.length === 0 && add === undefined) {
    return (
      <div data-models-empty className="col-span-full space-y-4 rounded-md border border-border px-4 py-8">
        <p className="text-sm">{NO_MODELS_TEXT}</p>
        <Button ref={addButton} type="button" onClick={addModel}>
          <Plus className="size-3.5" aria-hidden="true" />
          {ADD_MODEL_LABEL}
        </Button>
      </div>
    )
  }

  const now = Date.now()
  const credentials = reads.credentials.filter((credential) => !hiddenCredentials.has(credential.configName))
  return (
    <>
      <Button
        ref={addButton}
        type="button"
        variant="outline"
        size="sm"
        data-model-add
        className="justify-self-end"
        onClick={addModel}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {ADD_MODEL_LABEL}
      </Button>
      {/* use.llm is edited here: each row's Default badge or Make default. */}
      <div data-field-path="use.llm" className="col-span-full space-y-4">
        {hasDefault ? null : (
          <p data-no-default className="flex items-start gap-1 text-xs text-foreground">
            <span className="flex h-[1lh] shrink-0 items-center">
              <TriangleAlert className="size-3 text-amber-500" aria-hidden="true" />
            </span>
            {NO_DEFAULT_TEXT}
          </p>
        )}
        <ul
          ref={list}
          data-model-list
          data-field-list="registry.llms"
          className="divide-y divide-border rounded-md border border-border"
        >
          {add === undefined ? null : (
            <AddModelRow
              configPath={configPath}
              providers={reads.providers}
              existingNames={models.map((model) => model.name)}
              {...(add.initialChoice === undefined ? {} : { initialChoice: add.initialChoice })}
              {...(add.focus === undefined ? {} : { focusRequest: add.focus })}
              onConnected={connected}
              onDiscard={discardAdd}
            />
          )}
          {shown.map((model) => (
            <ModelRow
              key={model.name}
              model={model}
              status={modelStatus(credentials, model, now)}
              facts={providerFacts(reads.providers, model.provider)}
              keyType={credentialKeyType(credentials, model)}
              isDefault={model.name === defaultName}
              open={openName === model.name}
              landing={landing?.name === model.name ? landing : undefined}
              onToggle={() => {
                setLanding(undefined)
                setOpenName((current) => (current === model.name ? undefined : model.name))
              }}
              onMakeDefault={() => makeDefault(model.name)}
              onRemoveStart={() => removeStart(model.name)}
              onRemoveEnd={() => setRemoving((current) => withName(current, model.name, false))}
              onCredentialHidden={(hidden) => setHiddenCredentials((current) => withName(current, model.name, hidden))}
              onCredentialSaved={() => refreshCredentials(model.name)}
            />
          ))}
        </ul>
      </div>
    </>
  )
}
