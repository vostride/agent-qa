import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  Settings,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Info,
  Trash2,
  Plus,
  Pencil,
} from "lucide-react"
import {
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { parseConfigNumberInput } from "@/components/config-manager/numeric-input"

import {
  updateSettings,
  fetchAuthStatus,
  fetchLLMProviders,
  testLLMConnection,
  saveCredential,
  startPluginAuth,
  pollPluginAuthResult,
  exchangePluginAuthCode,
  deleteAuthCredential,
  type AuthCredentialInfo,
  type LLMProviderMetadata,
  type LLMTestResult,
} from "@/lib/api"

export const LLM_PROVIDER_OPTIONS = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "anthropic-compatible", label: "Anthropic-compatible" },
  { value: "gemini", label: "Gemini" },
] as const

type CredentialSaveType = "api-key" | "bearer-token"

const PROVIDER_LABELS = Object.fromEntries(
  LLM_PROVIDER_OPTIONS.map((option) => [option.value, option.label]),
) as Record<string, string>

const COMPATIBLE_PROVIDERS = new Set<string>(["openai-compatible", "anthropic-compatible"])
const BASE_URL_HELPER = "Enter the exact endpoint base URL. agent-qa will not append paths."
const COMPATIBLE_UNAUTHENTICATED_COPY = "Testing without a saved credential."
const GEMINI_MISSING_COPY = "Save a Gemini API key for this config before testing."

function defaultProviderMetadata(): LLMProviderMetadata[] {
  return [
    {
      id: "openai-compatible",
      label: "OpenAI-compatible",
      auth: { kind: "api-key", credentialTypes: ["api-key"], optional: true },
      modelAdapter: "openai-responses",
    },
    {
      id: "anthropic-compatible",
      label: "Anthropic-compatible",
      auth: { kind: "api-key", credentialTypes: ["api-key", "bearer-token"], optional: true },
      modelAdapter: "anthropic-messages",
    },
    {
      id: "gemini",
      label: "Gemini",
      auth: { kind: "api-key", credentialTypes: ["api-key"] },
    },
  ]
}

function makeHeaderRow(key = "", value = "") {
  return {
    id: crypto.randomUUID(),
    key,
    value,
  }
}

interface ProviderHeaderRow {
  id: string
  key: string
  value: string
}

interface NamedLLMConfig {
  name: string
  provider: string
  model: string
  baseURL?: string
  providerHeaders?: Record<string, string>
  screenshotSize?: string
  effectiveResolution?: number
}

interface LlmSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

function formatProviderName(raw: string, providers: LLMProviderMetadata[] = []): string {
  return providers.find((provider) => provider.id === raw)?.label ?? PROVIDER_LABELS[raw] ?? raw
}

function formatExpiry(expires: number | null): string | null {
  if (expires === null) return null
  const now = Date.now()
  if (expires < now) return "Expired"
  const diff = expires - now
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  if (hours > 24) {
    const days = Math.floor(hours / 24)
    return `Expires in ${days}d`
  }
  if (hours > 0) return `Expires in ${hours}h ${minutes}m`
  return `Expires in ${minutes}m`
}

function getCredentialBadgeLabel(credential: AuthCredentialInfo): string {
  if (credential.type === "oauth") return "OAuth connected"
  if (credential.type === "bearer" || credential.type === "bearer-token") return "Saved bearer token"
  return "Saved API key"
}

function credentialMatchesConfigProvider(credential: AuthCredentialInfo, configName: string, provider: string): boolean {
  if (credential.configName !== configName) return false
  if (credential.type === "oauth") return credential.provider === provider
  if (credential.type === "bearer" || credential.type === "bearer-token") {
    return provider === "anthropic-compatible" && credential.provider === "anthropic-compatible"
  }
  return credential.provider === provider
}

function getCredentialForConfig(credentials: AuthCredentialInfo[], config: NamedLLMConfig): AuthCredentialInfo | undefined {
  return credentials.find((credential) => credentialMatchesConfigProvider(credential, config.name, config.provider))
}

function getMissingCredentialLabel(config: NamedLLMConfig): string {
  if (COMPATIBLE_PROVIDERS.has(config.provider)) return "No credential"
  return "Missing credential"
}

function normalizeProviderHeaders(rows: ProviderHeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (!key && !value) continue
    if (!key) continue
    headers[key] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function getDuplicateHeaderKeys(rows: ProviderHeaderRow[]): Set<string> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = row.key.trim().toLowerCase()
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key))
}

function getConnectionFailureCopy(result: LLMTestResult): string {
  if (result.error === "missing_credential" && result.message) return result.message
  if (result.error === "auth_error") return "Authentication failed. Check the saved credential for this config."
  if (result.error === "model_not_found") return "Model not found. Check the model name."
  if (result.error === "network_error") return "Network error. Check the exact base URL and try again."
  if (result.error === "invalid_request" && result.message) return `Connection failed. ${result.message}`
  if (result.message) return result.message.startsWith("Connection failed.")
    ? result.message
    : `Connection failed. ${result.message}`
  return "Connection failed. Provider returned an error."
}

export function LlmSection({ config, onConfigChange }: LlmSectionProps) {
  const activeLlm = ((config.use as Record<string, unknown> | undefined)?.llm as string | undefined) ?? null
  const [llmConfigs, setLlmConfigs] = useState<NamedLLMConfig[]>([])
  const [authCredentials, setAuthCredentials] = useState<AuthCredentialInfo[]>([])
  const [llmProviders, setLlmProviders] = useState<LLMProviderMetadata[]>(defaultProviderMetadata())
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingConfig, setEditingConfig] = useState<NamedLLMConfig | null>(null)
  const [deleteConfirmName, setDeleteConfirmName] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        setLoading(true)
        const registryBlock = (config?.registry ?? {}) as Record<string, unknown>
        const llms = (registryBlock.llms ?? []) as NamedLLMConfig[]
        setLlmConfigs(llms)

        const [authRes, providerRes] = await Promise.all([
          fetchAuthStatus(),
          fetchLLMProviders().catch(() => ({ providers: defaultProviderMetadata() })),
        ])
        setAuthCredentials(authRes.credentials ?? [])
        setLlmProviders(providerRes.providers.length ? providerRes.providers : defaultProviderMetadata())
      } catch {
        toast.error("Failed to load LLM configuration. Refresh and try again.")
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [config])

  async function refreshCredentials() {
    const authRes = await fetchAuthStatus()
    setAuthCredentials(authRes.credentials ?? [])
  }

  async function handleDelete(name: string) {
    if (name === activeLlm) {
      toast.error("Cannot delete the active default configuration. Switch the default in Execution Defaults first.")
      return
    }
    const newConfigs = llmConfigs.filter((c) => c.name !== name)
    const prevConfigs = llmConfigs
    setLlmConfigs(newConfigs)
    try {
      await updateSettings({ "registry.llms": newConfigs })
      toast.success(`Configuration ${name} deleted`)
      onConfigChange()
    } catch {
      setLlmConfigs(prevConfigs)
      toast.error("Failed to delete configuration")
    }
  }

  async function handleSaveConfig(cfg: NamedLLMConfig) {
    const isEdit = editingConfig !== null
    const newConfigs = isEdit
      ? llmConfigs.map((c) => (c.name === cfg.name ? cfg : c))
      : [...llmConfigs, cfg]

    try {
      await updateSettings({ "registry.llms": newConfigs })
      setLlmConfigs(newConfigs)
      toast.success("Changes saved")
      setModalOpen(false)
      setEditingConfig(null)
      onConfigChange()
      await refreshCredentials()
    } catch {
      toast.error("Failed to save configuration. Check the fields and try again.")
    }
  }

  function renderCredentialBadge(cfg: NamedLLMConfig) {
    const credential = getCredentialForConfig(authCredentials, cfg)
    if (!credential) {
      return <Badge variant="secondary">{getMissingCredentialLabel(cfg)}</Badge>
    }
    const expiry = formatExpiry(credential.expires)
    const isExpired = credential.expires !== null && credential.expires < Date.now()
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{getCredentialBadgeLabel(credential)}</Badge>
        {expiry && (
          <Badge variant={isExpired ? "destructive" : "outline"} className="text-xs">
            {expiry}
          </Badge>
        )}
      </div>
    )
  }

  const columns = useMemo<ColumnDef<NamedLLMConfig>[]>(() => [
    {
      accessorKey: "name",
      header: "Name",
      size: 140,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="max-w-[220px] truncate font-mono">{row.original.name}</span>
          {row.original.name === activeLlm ? (
            <Badge variant="outline" className="text-[11px]">Default</Badge>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: "provider",
      header: "Provider",
      size: 160,
      cell: ({ row }) => (
        <span className="block min-w-0 max-w-[220px] truncate">
          {formatProviderName(row.original.provider, llmProviders)}
        </span>
      ),
    },
    {
      accessorKey: "model",
      header: "Model",
      cell: ({ row }) => (
        <span className="block min-w-0 max-w-[280px] truncate">
          {row.original.model}
        </span>
      ),
    },
    {
      id: "credential",
      header: "Credential",
      cell: ({ row }) => renderCredentialBadge(row.original),
    },
    {
      id: "actions",
      header: "",
      size: 80,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              setEditingConfig(row.original)
              setModalOpen(true)
            }}
            title="Edit configuration"
            aria-label="Edit configuration"
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              if (row.original.name === activeLlm) return
              setDeleteConfirmName(row.original.name)
            }}
            title={row.original.name === activeLlm ? "Switch the default in Execution Defaults before deleting" : "Delete configuration"}
            aria-label="Delete configuration"
            disabled={row.original.name === activeLlm}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ], [activeLlm, authCredentials, llmProviders])

  const table = useReactTable({
    data: llmConfigs,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <>
      <ConfigSectionShell>
        <ConfigSectionHeader>
          <h2 className="text-base font-semibold">LLM Configurations</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Named model configurations for test runs. Choose the active default in Use / Execution Defaults.
          </p>
        </ConfigSectionHeader>
        <ConfigSectionBody>
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full rounded-none bg-muted" />
              <Skeleton className="h-10 w-full rounded-none bg-muted" />
              <Skeleton className="h-10 w-full rounded-none bg-muted" />
            </div>
          ) : llmConfigs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Settings className="size-10 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No LLM configurations</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Add an LLM configuration to start running tests.
              </p>
              <Button
                className="mt-4"
                onClick={() => {
                  setEditingConfig(null)
                  setModalOpen(true)
                }}
              >
                <Plus className="size-4" />
                Add Configuration
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingConfig(null)
                    setModalOpen(true)
                  }}
                >
                  <Plus className="size-4" />
                  Add Configuration
                </Button>
              </div>
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <TableHead
                          key={header.id}
                          style={header.column.getSize() !== 150 ? { width: header.column.getSize() } : undefined}
                          className="min-w-0"
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="min-w-0">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </ConfigSectionBody>
      </ConfigSectionShell>

      <LlmConfigModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open)
          if (!open) setEditingConfig(null)
        }}
        config={editingConfig}
        existingNames={llmConfigs.map((c) => c.name)}
        onSave={handleSaveConfig}
        onAuthChange={refreshCredentials}
        authCredentials={authCredentials}
        providerMetadata={llmProviders}
      />

      <Dialog open={deleteConfirmName !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmName(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Configuration</DialogTitle>
            <DialogDescription>
              Delete <span className="font-mono font-semibold">{deleteConfirmName}</span>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmName(null)}>Keep Configuration</Button>
            <Button variant="destructive" onClick={() => {
              if (deleteConfirmName) {
                handleDelete(deleteConfirmName)
                setDeleteConfirmName(null)
              }
            }}>Delete Configuration</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface LlmConfigModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: NamedLLMConfig | null
  existingNames: string[]
  onSave: (config: NamedLLMConfig) => void | Promise<void>
  onAuthChange: () => void | Promise<void>
  authCredentials: AuthCredentialInfo[]
  providerMetadata: LLMProviderMetadata[]
}

function LlmConfigModal({ open, onOpenChange, config, existingNames, onSave, onAuthChange, authCredentials, providerMetadata }: LlmConfigModalProps) {
  const isEdit = config !== null

  const [name, setName] = useState("")
  const [provider, setProvider] = useState("openai-compatible")
  const [model, setModel] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [providerHeaderRows, setProviderHeaderRows] = useState<ProviderHeaderRow[]>([])
  const [credentialType, setCredentialType] = useState<CredentialSaveType>("api-key")
  const [credentialSecret, setCredentialSecret] = useState("")
  const [screenshotSize, setScreenshotSize] = useState("")
  const [effectiveResolution, setEffectiveResolution] = useState("")
  const [tokenPasteInput, setTokenPasteInput] = useState("")
  const [exchanging, setExchanging] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [oauthSession, setOauthSession] = useState<{ provider: string; sessionId: string; mode: "browser-poll" | "manual-code" } | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LLMTestResult | null>(null)
  const [nameError, setNameError] = useState("")
  const [baseUrlError, setBaseUrlError] = useState("")
  const [savingCredential, setSavingCredential] = useState(false)
  const [credentialDeleteConfirm, setCredentialDeleteConfirm] = useState<string | null>(null)

  const effectiveProviderMetadata = providerMetadata.length ? providerMetadata : defaultProviderMetadata()
  const providerOptions = useMemo(() => {
    const mapped = effectiveProviderMetadata.map((option) => ({ value: option.id, label: option.label }))
    if (provider && !mapped.some((option) => option.value === provider)) {
      mapped.push({ value: provider, label: formatProviderName(provider, effectiveProviderMetadata) })
    }
    return mapped
  }, [effectiveProviderMetadata, provider])
  const providerInfo = effectiveProviderMetadata.find((item) => item.id === provider)
  const hasSavedCredential = authCredentials.some((credential) => credentialMatchesConfigProvider(credential, name, provider))
  const isCompatible = COMPATIBLE_PROVIDERS.has(provider)
  const isAnthropicCompatible = provider === "anthropic-compatible"
  const showBaseURL = isCompatible
  const showCredentialSave = providerInfo?.auth.kind === "api-key"
  const duplicateHeaderKeys = getDuplicateHeaderKeys(providerHeaderRows)
  const hasDuplicateHeaders = duplicateHeaderKeys.size > 0

  useEffect(() => {
    if (!open) return
    setTestResult(null)
    setNameError("")
    setBaseUrlError("")
    setCredentialSecret("")
    setTokenPasteInput("")
    setOauthSession(null)
    setCredentialDeleteConfirm(null)

    if (config) {
      const nextProvider = config.provider || "openai-compatible"
      setName(config.name)
      setProvider(nextProvider)
      setModel(config.model)
      setBaseURL(config.baseURL ?? "")
      setProviderHeaderRows(
        nextProvider === "anthropic-compatible"
          ? Object.entries(config.providerHeaders ?? {}).map(([key, value]) => makeHeaderRow(key, value)).concat(
            Object.keys(config.providerHeaders ?? {}).length === 0 ? [makeHeaderRow()] : [],
          )
          : [],
      )
      setCredentialType(nextProvider === "anthropic-compatible" ? "bearer-token" : "api-key")
      setScreenshotSize(config.screenshotSize ?? "")
      setEffectiveResolution(config.effectiveResolution != null ? String(config.effectiveResolution) : "")
    } else {
      const defaultProvider = providerMetadata.find((item) => item.id === "openai-compatible")?.id
        ?? providerMetadata[0]?.id
        ?? "openai-compatible"
      setName("")
      setProvider(defaultProvider)
      setModel("")
      setBaseURL("")
      setProviderHeaderRows([])
      setCredentialType("api-key")
      setScreenshotSize("")
      setEffectiveResolution("")
    }
  }, [open, config, providerMetadata])

  function validateName(value: string): string {
    if (!value) return ""
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      return "Name must be lowercase letters, numbers, and hyphens, starting with a letter or number"
    }
    const others = existingNames.filter((n) => n !== config?.name)
    if (others.includes(value)) {
      return "A configuration with this name already exists"
    }
    return ""
  }

  function handleProviderChange(newProvider: string) {
    setProvider(newProvider)
    setTestResult(null)
    setBaseUrlError("")
    setOauthSession(null)
    setCredentialSecret("")
    setTokenPasteInput("")
    setCredentialType(newProvider === "anthropic-compatible" ? "bearer-token" : "api-key")
    setBaseURL("")
    setProviderHeaderRows(newProvider === "anthropic-compatible" ? [makeHeaderRow()] : [])
  }

  function updateHeaderRow(id: string, field: "key" | "value", value: string) {
    setProviderHeaderRows((rows) => rows.map((row) => row.id === id ? { ...row, [field]: value } : row))
  }

  async function handleTestConnection() {
    if (hasDuplicateHeaders) {
      toast.error("Duplicate provider header names are not allowed")
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const headers = isAnthropicCompatible ? normalizeProviderHeaders(providerHeaderRows) : undefined
      const result = await testLLMConnection({
        provider,
        model,
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
        ...(headers ? { providerHeaders: headers } : {}),
        configName: name || undefined,
      })
      setTestResult(result)
    } catch {
      setTestResult({
        success: false,
        error: "network_error",
        message: "Network error. Check the exact base URL and try again.",
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSubmit() {
    const err = validateName(name)
    if (err) {
      setNameError(err)
      return
    }
    if (!name || !provider || !model) return
    if (showBaseURL && baseURL.trim() === "") {
      setBaseUrlError("Base URL is required for compatible providers.")
      return
    }
    if (hasDuplicateHeaders) {
      toast.error("Duplicate provider header names are not allowed")
      return
    }

    const parsedEffectiveResolution = parseConfigNumberInput(effectiveResolution, {
      label: "Effective resolution",
      min: 1,
      integer: true,
      allowEmpty: true,
      errorMessage: "Effective resolution must be a positive integer",
    })
    if (parsedEffectiveResolution.error) {
      toast.error(parsedEffectiveResolution.error)
      return
    }

    setSaving(true)
    try {
      const normalizedHeaders = isAnthropicCompatible ? normalizeProviderHeaders(providerHeaderRows) : undefined
      await onSave({
        name,
        provider,
        model,
        baseURL: baseURL.trim() || undefined,
        ...(normalizedHeaders ? { providerHeaders: normalizedHeaders } : {}),
        screenshotSize: screenshotSize || undefined,
        effectiveResolution: parsedEffectiveResolution.value,
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save configuration")
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveCredential() {
    if (!credentialSecret.trim() || !name || !showCredentialSave) return
    setSavingCredential(true)
    try {
      const type: CredentialSaveType = isAnthropicCompatible ? credentialType : "api-key"
      await saveCredential(name, provider, type, credentialSecret.trim())
      toast.success(type === "bearer-token" ? "Bearer token saved" : "API key saved")
      setCredentialSecret("")
      await onAuthChange()
    } catch {
      toast.error("Failed to save credential")
    } finally {
      setSavingCredential(false)
    }
  }

  async function confirmCredentialDelete() {
    if (!credentialDeleteConfirm) return
    try {
      await deleteAuthCredential(credentialDeleteConfirm)
      await onAuthChange()
      toast.success("Credential deleted")
    } catch {
      toast.error("Failed to delete credential")
    } finally {
      setCredentialDeleteConfirm(null)
    }
  }

  const canSave = name.trim() !== "" && model.trim() !== "" && !nameError

  function renderCredentialSaveControls() {
    if (!showCredentialSave) return null
    return (
      <div className="space-y-3">
        {isCompatible && (
          <p className="text-xs text-muted-foreground">
            Credentials are optional for this config. Unauthenticated endpoints can still be tested.
          </p>
        )}
        {provider === "gemini" && (
          <p className="text-xs text-muted-foreground">{GEMINI_MISSING_COPY}</p>
        )}
        {isAnthropicCompatible && (
          <div className="space-y-2">
            <Label>Credential Type</Label>
            <p className="text-xs text-muted-foreground">
              Save an API key or Bearer token for this config.
            </p>
            <Select value={credentialType} onValueChange={(value) => setCredentialType(value as CredentialSaveType)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="api-key">API key</SelectItem>
                <SelectItem value="bearer-token">Bearer token</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Input
            type="password"
            placeholder="secret-value"
            value={credentialSecret}
            onChange={(event) => setCredentialSecret(event.target.value)}
            className="min-w-[180px] flex-1"
          />
          <Button
            size="sm"
            onClick={handleSaveCredential}
            disabled={savingCredential || !credentialSecret.trim() || !name || Boolean(nameError)}
          >
            {savingCredential ? <Loader2 className="size-4 animate-spin" /> : null}
            Save Credential
          </Button>
        </div>
      </div>
    )
  }

  function renderSubscriptionControls() {
    if (providerInfo?.auth.kind !== "oauth-plugin") return null
    const activeSession = oauthSession?.provider === provider ? oauthSession : null
    const providerName = providerInfo.label
    const buttonLabel = providerInfo.auth.buttonLabel ?? `Login with ${providerName}`

    async function handleStartOAuth() {
      setOauthLoading(true)
      setTokenPasteInput("")
      try {
        const started = await startPluginAuth(provider, name)
        const nextSession = { provider, sessionId: started.sessionId, mode: started.mode }
        setOauthSession(nextSession)
        window.open(started.authorizeUrl, "_blank")

        if (started.mode === "browser-poll") {
          const pollInterval = window.setInterval(async () => {
            try {
              const result = await pollPluginAuthResult(provider, started.sessionId)
              if (result.status === "completed") {
                window.clearInterval(pollInterval)
                toast.success(`${providerName} authenticated`)
                setOauthLoading(false)
                setOauthSession(null)
                await onAuthChange()
              } else if (result.status === "error") {
                window.clearInterval(pollInterval)
                toast.error(result.error || `${providerName} authentication failed`)
                setOauthLoading(false)
              }
            } catch {
              // Keep polling while the plugin auth flow is pending.
            }
          }, 2000)

          window.setTimeout(() => {
            window.clearInterval(pollInterval)
            setOauthLoading(false)
          }, 5 * 60 * 1000)
        } else {
          setOauthLoading(false)
        }
      } catch {
        toast.error(`Failed to start ${providerName} authentication`)
        setOauthLoading(false)
      }
    }

    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Login with {providerName} for this config before testing.
        </p>
        {providerInfo.auth.mode === "manual-code" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm">Open authorization page</Label>
              <Button
                variant="outline"
                size="sm"
                disabled={oauthLoading || !name || Boolean(nameError)}
                onClick={handleStartOAuth}
              >
                <ExternalLink className="size-4" />
                {buttonLabel}
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Paste authorization code</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  type="password"
                  placeholder="authorization-code"
                  value={tokenPasteInput}
                  onChange={(event) => setTokenPasteInput(event.target.value)}
                  disabled={!activeSession}
                  className="min-w-[180px] flex-1"
                />
                <Button
                  size="sm"
                  disabled={!tokenPasteInput.trim() || !activeSession || exchanging}
                  onClick={async () => {
                    if (!activeSession) return
                    setExchanging(true)
                    try {
                      await exchangePluginAuthCode(provider, activeSession.sessionId, tokenPasteInput.trim())
                      toast.success(`${providerName} authenticated`)
                      setTokenPasteInput("")
                      setOauthSession(null)
                      await onAuthChange()
                    } catch {
                      toast.error("Failed to exchange code")
                    } finally {
                      setExchanging(false)
                    }
                  }}
                >
                  {exchanging ? <Loader2 className="size-4 animate-spin" /> : null}
                  Connect
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Button
              variant="outline"
              size="sm"
              disabled={oauthLoading || !name || Boolean(nameError)}
              onClick={handleStartOAuth}
            >
              {oauthLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ExternalLink className="size-4" />
              )}
              {oauthLoading ? "Authenticating..." : buttonLabel}
            </Button>
          </div>
        )}
      </div>
    )
  }

  function renderSavedCredentials() {
    const credentials = authCredentials.filter((credential) => credential.configName === name)
    if (credentials.length === 0) return null
    return (
      <div className="space-y-2">
        {credentials.map((credential) => {
          const expiry = formatExpiry(credential.expires)
          const isExpired = credential.expires !== null && credential.expires < Date.now()
          return (
            <div
              key={`${credential.configName}-${credential.type}-${credential.provider}`}
              className="flex min-w-0 flex-wrap items-center gap-3 rounded-none border border-border bg-transparent p-3 text-sm"
            >
              <Badge variant="secondary" className="text-xs">
                {getCredentialBadgeLabel(credential)}
              </Badge>
              <span className="min-w-0 break-words font-medium">
                {formatProviderName(credential.provider, effectiveProviderMetadata)}
              </span>
              {expiry && (
                <Badge
                  variant={isExpired ? "destructive" : "outline"}
                  className="text-xs"
                >
                  {expiry}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-8 w-8 p-0 text-destructive hover:text-destructive"
                onClick={() => setCredentialDeleteConfirm(credential.configName)}
                aria-label="Delete credential"
                title="Delete credential"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          )
        })}
      </div>
    )
  }

  function renderConnectionState() {
    if (testing) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          <span>Testing connection...</span>
        </div>
      )
    }

    if (!testResult) return null

    if (testResult.success) {
      if (testResult.unauthenticated) {
        return (
          <div className="text-sm text-muted-foreground" role="status">
            {testResult.authMessage || testResult.message || COMPATIBLE_UNAUTHENTICATED_COPY}
          </div>
        )
      }
      return (
        <div className="flex items-center gap-2 text-sm text-success" role="status">
          <CheckCircle2 className="size-4" />
          <span>Connection successful</span>
          {testResult.responseTime != null && (
            <span className="text-muted-foreground">
              {testResult.responseTime}ms
            </span>
          )}
        </div>
      )
    }

    return (
      <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <XCircle className="size-4" />
        <span>{getConnectionFailureCopy(testResult)}</span>
      </div>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit ${config.name}` : "Add Configuration"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Update provider, model, and credentials for this configuration."
                : "Create a named LLM configuration with its own provider, model, and credentials."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="config-name">Name</Label>
              <Input
                id="config-name"
                placeholder="e.g., claude-fast, gpt-cheap"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  if (nameError) setNameError("")
                }}
                onBlur={() => {
                  if (name) setNameError(validateName(name))
                }}
                disabled={isEdit}
                className={isEdit ? "bg-muted" : ""}
                aria-describedby={nameError ? "name-error" : undefined}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase alphanumeric and hyphens (e.g., claude-fast, gpt-cheap)
              </p>
              {nameError && (
                <p id="name-error" className="text-sm text-destructive">{nameError}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={handleProviderChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="config-model">Model</Label>
              <Input
                id="config-model"
                placeholder="model-name"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </div>

            {showBaseURL && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="config-base-url">Base URL</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Compatible endpoint help"
                          className="inline-flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-help"
                        >
                          <Info className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[250px]">
                        {BASE_URL_HELPER}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Input
                  id="config-base-url"
                  placeholder={provider === "openai-compatible" ? "https://openrouter.ai/api/v1" : "https://anthropic-proxy.example/messages"}
                  value={baseURL}
                  onChange={(event) => {
                    setBaseURL(event.target.value)
                    if (baseUrlError) setBaseUrlError("")
                  }}
                  aria-invalid={baseUrlError ? true : undefined}
                  aria-describedby={baseUrlError ? "base-url-error" : undefined}
                />
                <p className="text-xs text-muted-foreground">{BASE_URL_HELPER}</p>
                {baseUrlError && (
                  <p id="base-url-error" className="text-sm text-destructive">
                    {baseUrlError}
                  </p>
                )}
              </div>
            )}

            {isAnthropicCompatible && (
              <div className="space-y-2">
                <div>
                  <Label>Provider Headers</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Optional non-secret headers sent with this Anthropic-compatible endpoint.
                  </p>
                </div>
                <div className="space-y-2">
                  {providerHeaderRows.map((row) => {
                    const normalizedKey = row.key.trim().toLowerCase()
                    const isDuplicate = normalizedKey !== "" && duplicateHeaderKeys.has(normalizedKey)
                    return (
                      <div key={row.id} className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            placeholder="header-name"
                            value={row.key}
                            onChange={(event) => updateHeaderRow(row.id, "key", event.target.value)}
                            className="min-w-[160px] flex-1"
                          />
                          <Input
                            placeholder="header-value"
                            value={row.value}
                            onChange={(event) => updateHeaderRow(row.id, "value", event.target.value)}
                            className="min-w-[180px] flex-1"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                            aria-label="Remove header"
                            title="Remove header"
                            onClick={() => setProviderHeaderRows((rows) => rows.filter((item) => item.id !== row.id))}
                            disabled={providerHeaderRows.length === 1 && !row.key && !row.value}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                        {isDuplicate && (
                          <p className="text-xs text-destructive">Duplicate header names are not allowed.</p>
                        )}
                      </div>
                    )
                  })}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setProviderHeaderRows((rows) => [...rows, makeHeaderRow()])}
                >
                  <Plus className="size-4" />
                  Add Header
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <Label>Screenshot Size</Label>
              <Input
                placeholder='e.g., "1m", "512k" (empty = no compression)'
                value={screenshotSize}
                onChange={(event) => setScreenshotSize(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Maximum screenshot size for this model (e.g., "1m", "512k"). Empty = no compression.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="config-effective-resolution">Effective Resolution</Label>
              <Input
                id="config-effective-resolution"
                type="number"
                min={1}
                step={1}
                placeholder="e.g., 1568"
                value={effectiveResolution}
                onChange={(event) => setEffectiveResolution(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Maximum effective screenshot edge sent to the model. Use this with screenshot compression to control token cost.
              </p>
            </div>

            <Separator />

            <div className="space-y-4">
              <div>
                <h3 className="text-base font-semibold">Credentials</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Saved credentials are keyed by this named configuration.
                </p>
              </div>
              {renderCredentialSaveControls()}
              {renderSubscriptionControls()}

              {renderSavedCredentials()}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !provider || !model || hasDuplicateHeaders}
            >
              Test Connection
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={saving || !canSave || hasDuplicateHeaders}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>

          {isCompatible && !hasSavedCredential && !testing && !testResult && (
            <div className="text-sm text-muted-foreground" role="status">
              {COMPATIBLE_UNAUTHENTICATED_COPY}
            </div>
          )}
          {renderConnectionState()}
        </DialogContent>
      </Dialog>

      <Dialog open={credentialDeleteConfirm !== null} onOpenChange={(dialogOpen) => { if (!dialogOpen) setCredentialDeleteConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Credential</DialogTitle>
            <DialogDescription>
              Delete saved credential for {credentialDeleteConfirm}? Tests using this config may fail until a new credential is saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCredentialDeleteConfirm(null)}>
              Keep Credential
            </Button>
            <Button variant="destructive" onClick={confirmCredentialDelete}>
              Delete Credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
