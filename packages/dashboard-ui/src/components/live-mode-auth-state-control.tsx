import { useEffect, useMemo, useState, type FormEvent } from "react"
import { AlertTriangle, ChevronDown, KeyRound, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { AuthStateMetadata } from "@/lib/api"
import { cn } from "@/lib/utils"

const AUTH_STATE_NAME_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/

export interface LiveModeAuthStateCaptureConfig {
  sessionId: string
  targetName: string
  initialName?: string | null
  authStates: AuthStateMetadata[]
  isSaving?: boolean
  error?: string | null
  onSave: (input: { name: string; replace: boolean }) => Promise<void> | void
}

interface LiveModeAuthStateControlProps {
  capture: LiveModeAuthStateCaptureConfig
  disabled?: boolean
}

function safeInitialName(value: string | null | undefined): string {
  const candidate = value?.trim() ?? ""
  return AUTH_STATE_NAME_PATTERN.test(candidate) ? candidate : ""
}

export function LiveModeAuthStateControl({
  capture,
  disabled = false,
}: LiveModeAuthStateControlProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(() => safeInitialName(capture.initialName))
  const [localError, setLocalError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const targetName = capture.targetName
  const trimmedName = name.trim()
  const busy = disabled || saving || capture.isSaving === true

  useEffect(() => {
    if (open) {
      setName(safeInitialName(capture.initialName))
      setLocalError(null)
    }
  }, [capture.initialName, open])

  const savedForTarget = useMemo(
    () => capture.authStates.filter((state) => state.target === targetName),
    [capture.authStates, targetName],
  )
  const replacing = savedForTarget.some((state) => state.name === trimmedName)
  const visibleError = localError ?? capture.error ?? null

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return

    if (!AUTH_STATE_NAME_PATTERN.test(trimmedName)) {
      setLocalError("Auth state name must be a lowercase slug.")
      return
    }

    setLocalError(null)
    setSaving(true)
    try {
      await capture.onSave({ name: trimmedName, replace: replacing })
      setOpen(false)
    } catch {
      setLocalError(`Could not save auth state "${trimmedName}" for target "${targetName}".`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <div className="flex shrink-0 items-center gap-0.5">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-r-sm"
            disabled={busy}
            onClick={() => setOpen(true)}
          >
            <KeyRound className="size-3.5" />
            Save auth state
          </Button>
        </PopoverTrigger>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="rounded-l-sm px-2"
            disabled={busy}
            aria-label="Open auth state save form"
            onClick={() => setOpen(true)}
          >
            {busy && capture.isSaving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </Button>
        </PopoverTrigger>
      </div>
      <PopoverContent align="end" className="w-[360px] max-w-[calc(100vw-32px)] space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Save auth state</h3>
          <p className="text-sm text-muted-foreground">
            Capture the current browser session for this target.
          </p>
        </div>

        <div className="rounded-md border bg-muted/30 px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground">Target</div>
          <div className="mt-1 min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{targetName}</div>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="auth-state-name">Auth state name</Label>
            <Input
              id="auth-state-name"
              name="authStateName"
              value={name}
              placeholder="admin"
              onChange={(event) => {
                setName(event.target.value)
                setLocalError(null)
              }}
              aria-invalid={visibleError ? "true" : undefined}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">Use lowercase letters, numbers, and hyphens.</p>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Saved for this target</div>
            {savedForTarget.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {savedForTarget.map((state) => (
                  <Badge
                    key={`${state.target}:${state.name}`}
                    variant={state.name === trimmedName ? "secondary" : "outline"}
                    className="font-mono text-[10px]"
                  >
                    {state.name}
                  </Badge>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                No auth states saved for this target.
              </div>
            )}
          </div>

          {replacing && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>Existing auth state will be replaced.</span>
            </div>
          )}

          {visibleError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-2 text-xs text-destructive">
              {visibleError}
            </div>
          )}

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={busy} className={cn(replacing && "bg-primary")}>
              {saving || capture.isSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {replacing ? "Replace auth state" : "Save auth state"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
